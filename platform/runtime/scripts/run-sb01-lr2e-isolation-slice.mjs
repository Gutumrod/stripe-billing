#!/usr/bin/env node
// SB01 LR-2E — REAL (Stripe TEST + WSTERA LAB billing_core_staging) multi-product isolation
// vertical slice through the Core HTTP boundary + live `stripe listen` forward.
//
// Proves PS01 and LK01 (real, registered product profiles) serve the SAME literal account_id
// through the real Core webhook + subscription/entitlement HTTP routes with no cross-product
// contamination: provider customer mapping, reconciliation state, entitlement projection,
// credential/assertion scope, and grant->revoke monotonicity are all independent per product.
//
// TEST-gated: refuses to run unless STRIPE_SECRET_KEY is a real sk_test_ key,
// STRIPE_WEBHOOK_SECRET is a real whsec_ secret, and BILLING_DATABASE_URL is set. Credentials
// are read from the worker environment only; no secret value is ever printed, logged, or
// persisted. All object ids in output are masked. Bounded: a hard watchdog forces cleanup+exit
// if the run somehow exceeds ~9 minutes.
//
// Fixture route (same honest rationale as LR-2D, see
// docs/platform/billing-core/EVIDENCE-SB01-LR-2E-CLAUDE-2026-09-17.md section 4): Stripe's Test
// backend has no payer-side completion route for a card Checkout session, so this harness
// creates provider-side subscriptions directly against the Stripe TEST API for real Test
// customers the Core HTTP boundary already mapped, using the pinned profile prices and correct
// wstera_* metadata — one subscription per product — so real customer.subscription.* webhooks
// fire through the live listener into the Core webhook route exactly as a payer completion
// would. This simulates external provider state only; no Core authority rule is relaxed for it.
//
// Out-of-order (lower) transition_version rejection is NOT re-exercised here: runtime.ts derives
// transition_version from reconciliation.version, which processReconcileJob always recomputes
// from live provider truth (retrieveSubscription), never from event arrival order — the real path
// is architecturally self-correcting and cannot produce a genuine lower-version replay via actual
// Stripe delivery timing. That invariant is proven instead by direct real-Postgres + real-HMAC
// execution in tests/sb01-lr2e-isolation-real-db.test.mjs (already 7/7 passing), which hand-signs
// envelopes to construct the out-of-order case honestly rather than faking it here.
//
// Run: node scripts/run-sb01-lr2e-isolation-slice.mjs   (from platform/runtime)
// Requires: npm run build (dist present); port 8787 free (the live `stripe listen`
// forwards to http://127.0.0.1:8787/webhooks/stripe).

import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(runtimeRoot, '..', '..');

const { CentralBillingRuntime, signAccountAssertion, createBillingHttpHandler } = require(
  path.join(runtimeRoot, 'dist'),
);
const { ProductBillingProfileRegistry } = require(
  path.join(repoRoot, 'platform', 'profile-registry', 'dist', 'src', 'registry'),
);
const { ps01TestProfile } = require(
  path.join(repoRoot, 'platform', 'profile-registry', 'dist', 'profiles', 'PS01.test'),
);
const { lk01TestProfile } = require(
  path.join(repoRoot, 'platform', 'profile-registry', 'dist', 'profiles', 'LK01.test'),
);
const postgres = require('postgres');

// ---------------------------------------------------------------------------
// TEST-only gates
// ---------------------------------------------------------------------------
function fail(message) {
  console.error(`FATAL: ${message}`);
  process.exit(1);
}

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? '';
const BILLING_DATABASE_URL = process.env.BILLING_DATABASE_URL ?? '';

if (!STRIPE_SECRET_KEY) fail('STRIPE_SECRET_KEY is not set in the worker environment');
if (!STRIPE_SECRET_KEY.startsWith('sk_test_')) {
  fail('STRIPE_SECRET_KEY must be a Stripe TEST key (sk_test_...); refusing to run');
}
if (!STRIPE_WEBHOOK_SECRET) fail('STRIPE_WEBHOOK_SECRET is not set in the worker environment');
if (!STRIPE_WEBHOOK_SECRET.startsWith('whsec_')) {
  fail('STRIPE_WEBHOOK_SECRET must be a whsec_... webhook signing secret');
}
if (!BILLING_DATABASE_URL) fail('BILLING_DATABASE_URL is not set in the worker environment');

function maskId(value) {
  if (typeof value !== 'string' || value.length < 16) return `<masked:${String(value).length}>`;
  return `${value.slice(0, 12)}…${value.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Check recorder
// ---------------------------------------------------------------------------
const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` :: ${detail}` : ''}`);
  return Boolean(ok);
}

// ---------------------------------------------------------------------------
// Config — two real, registered product profiles, one shared account_id literal
// ---------------------------------------------------------------------------
const SCHEMA = 'billing_core_staging';
const PORT = 8787;
const PS01_PRODUCT_ID = ps01TestProfile.productId; // prd_c3a024781f4e4079815b2399cfe330e0
const LK01_PRODUCT_ID = lk01TestProfile.productId; // prd_f4be6d1a9b544632a527e0e15e485622
const PS01_PINNED_PRICE = 'price_1UDCxyHB4GRCffd9RyaDWZ1c'; // founding-c2, 99000 THB
const LK01_PINNED_PRICE = 'price_1UDCxzHB4GRCffd9a0rUipHY'; // pro, 19900 THB
const RUN_TAG = crypto.randomUUID().slice(0, 8);
// SAME literal account_id string used for BOTH products — the entire point of this slice.
const ACCOUNT_MAIN = `acc_lr2e_shared_${RUN_TAG}`;
const RUN_ACCOUNTS = [ACCOUNT_MAIN];

const PS01_TOKEN = `wstera-lr2e-ps01-${crypto.randomUUID()}`;
const LK01_TOKEN = `wstera-lr2e-lk01-${crypto.randomUUID()}`;
const PS01_ASSERTION_SECRET = crypto.randomUUID() + crypto.randomUUID();
const LK01_ASSERTION_SECRET = crypto.randomUUID() + crypto.randomUUID();
const PS01_KEY_ID = `sb01-lr2e-ps01-${RUN_TAG}`;
const LK01_KEY_ID = `sb01-lr2e-lk01-${RUN_TAG}`;
const ENTITLEMENT_KEY_PS01 = { keyId: `${PS01_KEY_ID}-entitlement`, productId: PS01_PRODUCT_ID, environment: 'test', secret: crypto.randomUUID() + crypto.randomUUID() };
const ENTITLEMENT_KEY_LK01 = { keyId: `${LK01_KEY_ID}-entitlement`, productId: LK01_PRODUCT_ID, environment: 'test', secret: crypto.randomUUID() + crypto.randomUUID() };
const RETURN_URLS = {
  [PS01_PRODUCT_ID]: {
    success: { default: 'https://pawstia.app/checkout/success' },
    cancel: { default: 'https://pawstia.app/checkout/cancel' },
    portal: { default: 'https://pawstia.app/portal/return' },
  },
  [LK01_PRODUCT_ID]: {
    success: { default: 'https://link.wstera.com/checkout/success' },
    cancel: { default: 'https://link.wstera.com/checkout/cancel' },
    portal: { default: 'https://link.wstera.com/portal/return' },
  },
};

const logger = {
  info(event, fields) { console.log(JSON.stringify({ level: 'info', event, ...fields })); },
  warn(event, fields) { console.warn(JSON.stringify({ level: 'warn', event, ...fields })); },
  error(event, fields) { console.error(JSON.stringify({ level: 'error', event, ...fields })); },
};

// ---------------------------------------------------------------------------
// Stripe Test REST helpers (harness-side only)
// ---------------------------------------------------------------------------
async function stripeGet(stripePath) {
  const response = await fetch(`https://api.stripe.com/v1${stripePath}`, {
    headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Stripe GET ${stripePath} failed: ${JSON.stringify(body.error ?? body)}`);
  return body;
}
async function stripePost(stripePath, params) {
  const response = await fetch(`https://api.stripe.com/v1${stripePath}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Stripe POST ${stripePath} failed: ${JSON.stringify(body.error ?? body)}`);
  return body;
}
async function stripeDelete(stripePath) {
  const response = await fetch(`https://api.stripe.com/v1${stripePath}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` },
  });
  return response.json().catch(() => null);
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------
const sql = postgres(BILLING_DATABASE_URL, { max: 3, idle_timeout: 5, connect_timeout: 15, prepare: false });

async function getCustomerRow(productId, accountId) {
  const rows = await sql`
    select provider_customer_id, state, profile_version::int as profile_version
    from ${sql(`${SCHEMA}.runtime_provider_customers`)}
    where environment = 'test' and product_id = ${productId} and account_id = ${accountId} and provider = 'stripe' limit 1
  `;
  return rows[0] ?? null;
}
async function getEventRowByObjectId(providerObjectId, eventType) {
  const rows = await sql`
    select id::text as db_id, provider_event_id::text as pid, status::text as status,
           environment::text as env, product_id::text as product_id, account_id::text as acc, event_type::text as event_type
    from ${sql(`${SCHEMA}.runtime_provider_events`)}
    where provider = 'stripe' and provider_object_id = ${providerObjectId} and event_type = ${eventType}
    order by received_at desc limit 1
  `;
  return rows[0] ?? null;
}
async function countEventRows(providerEventId) {
  const rows = await sql`
    select count(*)::int as n from ${sql(`${SCHEMA}.runtime_provider_events`)}
    where provider = 'stripe' and provider_event_id = ${providerEventId}
  `;
  return rows[0].n;
}
async function getOutboxJobByDedupeKey(dedupeKey) {
  const rows = await sql`
    select id::text as id, status::text as status, completed_at
    from ${sql(`${SCHEMA}.runtime_outbox_jobs`)}
    where dedupe_key = ${dedupeKey} limit 1
  `;
  return rows[0] ?? null;
}
async function countOutboxByDedupeKey(dedupeKey) {
  const rows = await sql`
    select count(*)::int as n from ${sql(`${SCHEMA}.runtime_outbox_jobs`)} where dedupe_key = ${dedupeKey}
  `;
  return rows[0].n;
}
async function getReconciliationRow(productId, providerSubscriptionId) {
  const rows = await sql`
    select provider_status::text as status, price_id, amount_minor::int as amount_minor, currency,
           reconciliation_version::int as version
    from ${sql(`${SCHEMA}.runtime_reconciliation_state`)}
    where environment = 'test' and product_id = ${productId} and provider_subscription_id = ${providerSubscriptionId} limit 1
  `;
  return rows[0] ?? null;
}
async function getEntitlementSinkRows(accountId) {
  return sql`
    select product_id::text as product_id, plan_id, transition_type::text as transition_type,
           entitlement_keys, latest_transition_version::int as version
    from ${sql(`${SCHEMA}.runtime_entitlement_test_sink`)}
    where environment = 'test' and account_id = ${accountId} order by product_id
  `;
}

// Two real subscriptions (PS01 + LK01) each fan out into several mapped-but-unusable webhook
// deliveries beyond the subscription event itself (invoice.*, payment_method.attached, …), each
// enqueuing its own reconcile job that fails closed (REQUEST_FIELD_REQUIRED — see LR-2D's
// documented residual gap) rather than retrying immediately (exponential backoff). A real run
// observed ~60 such distinct jobs before both entitlement_test_sink delivery jobs were reached in
// FIFO order; the cap is set well above that so a real drain always reaches 'idle' rather than
// stopping mid-queue and leaving downstream assertions reading a pre-delivery DB state.
async function drainAllJobs(runtime, workerId, maxIterations = 150) {
  const outcomes = [];
  for (let i = 0; i < maxIterations; i += 1) {
    const outcome = await runtime.processOneJob(`${workerId}-${i}`);
    if (outcome === 'idle') return outcomes;
    outcomes.push(outcome);
  }
  console.warn(`WARNING: drainAllJobs(${workerId}) hit its ${maxIterations}-iteration cap without reaching idle — queue may still hold undrained jobs`);
  return outcomes;
}

async function waitFor(predicate, timeoutMs = 45_000, stepMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Stripe signature helper (real whsec_)
// ---------------------------------------------------------------------------
function stripeSignatureHeader(payload, timestampSeconds) {
  const signedPayload = `${timestampSeconds}.${payload}`;
  const mac = crypto.createHmac('sha256', STRIPE_WEBHOOK_SECRET).update(signedPayload).digest('hex');
  return `t=${timestampSeconds},v1=${mac}`;
}

// Raw-body capture keyed by event id, for a byte-faithful duplicate-delivery replay.
const capturedWebhookBodies = new Map();
function wrapAndCapture(req) {
  const chunks = [];
  const originalIterator = req[Symbol.asyncIterator].bind(req);
  return {
    headers: req.headers,
    url: req.url,
    method: req.method,
    [Symbol.asyncIterator]() {
      const it = originalIterator();
      return {
        async next() {
          const result = await it.next();
          if (!result.done && result.value) chunks.push(Buffer.from(result.value));
          if (result.done && req.method === 'POST' && req.url === '/webhooks/stripe') {
            try {
              const raw = Buffer.concat(chunks).toString('utf8');
              const parsed = JSON.parse(raw);
              if (parsed && typeof parsed.id === 'string') capturedWebhookBodies.set(parsed.id, raw);
            } catch { /* not JSON — ignore */ }
          }
          return result;
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Cleanup — scoped to this run's account id / key ids / created provider objects
// ---------------------------------------------------------------------------
async function cleanup(createdSubscriptionIds, createdCustomerIds) {
  console.log('--- cleanup: Stripe Test objects + scoped WSTERA LAB rows ---');
  const cleanupCounts = { subscriptions_deleted: 0, customers_deleted: 0, db_rows_deleted: 0 };
  for (const subscriptionId of createdSubscriptionIds) {
    try {
      const deleted = await stripeDelete(`/subscriptions/${subscriptionId}`);
      cleanupCounts.subscriptions_deleted += 1;
      console.log(`stripe subscription deleted: ${maskId(subscriptionId)} status=${String(deleted?.status)}`);
    } catch (error) {
      console.log(`stripe subscription delete failed (non-fatal): ${maskId(subscriptionId)} :: ${String(error.message).slice(0, 120)}`);
    }
  }
  for (const customerId of createdCustomerIds) {
    try {
      const deleted = await stripeDelete(`/customers/${customerId}`);
      cleanupCounts.customers_deleted += 1;
      console.log(`stripe customer deleted: ${maskId(customerId)} deleted=${String(deleted?.deleted)}`);
    } catch (error) {
      console.log(`stripe customer delete failed (non-fatal): ${maskId(customerId)} :: ${String(error.message).slice(0, 120)}`);
    }
  }
  const tables = [
    'runtime_entitlement_test_sink', 'runtime_entitlement_transitions', 'runtime_outbox_jobs',
    'runtime_provider_events', 'runtime_reconciliation_state', 'runtime_audit_events',
    'runtime_provider_customers', 'runtime_operations',
  ];
  for (const table of tables) {
    try {
      const result = await sql`delete from ${sql(`${SCHEMA}.${table}`)} where account_id = any(${RUN_ACCOUNTS})`;
      cleanupCounts.db_rows_deleted += result.count;
      console.log(`db cleanup ${table}: ${result.count} row(s) deleted`);
    } catch (error) {
      console.log(`db cleanup ${table} FAILED (non-fatal): ${String(error.message).slice(0, 160)}`);
    }
  }
  try {
    const result = await sql`delete from ${sql(`${SCHEMA}.runtime_credential_bindings`)} where credential_key_id in (${PS01_KEY_ID}, ${LK01_KEY_ID})`;
    cleanupCounts.db_rows_deleted += result.count;
    console.log(`db cleanup runtime_credential_bindings: ${result.count} row(s) deleted`);
  } catch (error) {
    console.log(`db cleanup runtime_credential_bindings FAILED (non-fatal): ${String(error.message).slice(0, 160)}`);
  }
  console.log(`SCOPED CLEANUP COUNTS: ${JSON.stringify(cleanupCounts)}`);
  return cleanupCounts;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
let emergencyEnd = null;
let watchdog = null;
async function main() {
  console.log('=== SB01 LR-2E REAL MULTI-PRODUCT (PS01 + LK01) ISOLATION VERTICAL SLICE ===');
  console.log(`run tag: ${RUN_TAG}`);
  console.log(`stripe key: PRESENT prefix=${STRIPE_SECRET_KEY.slice(0, 8)}… len=${STRIPE_SECRET_KEY.length} (sk_test_ gate passed)`);
  console.log(`webhook secret: PRESENT prefix=whsec_… len=${STRIPE_WEBHOOK_SECRET.length}`);
  console.log(`db url: PRESENT host=${new URL(BILLING_DATABASE_URL).host}`);
  console.log(`shared account_id under test (both products): ${ACCOUNT_MAIN}`);

  const createdSubscriptionIds = [];
  const createdCustomerIds = [];
  let cleanupDone = false;
  process.on('unhandledRejection', (error) => { console.error(`UNHANDLED REJECTION: ${String(error)}`); });
  process.on('SIGINT', () => { void end(1); });
  process.on('SIGTERM', () => { void end(1); });

  async function end(exitCode) {
    if (cleanupDone) return;
    cleanupDone = true;
    if (watchdog) clearTimeout(watchdog);
    try { await cleanup(createdSubscriptionIds, createdCustomerIds); } catch { /* already logged */ }
    try { server?.close(); } catch { /* ignore */ }
    try { await runtime?.close(); } catch { /* ignore */ }
    try { await sql.end({ timeout: 5 }); } catch { /* ignore */ }
    process.exit(exitCode);
  }
  emergencyEnd = end;
  // Bounded run: force cleanup+exit if this somehow runs past ~9 minutes.
  watchdog = setTimeout(() => {
    console.error('WATCHDOG: hard 9-minute timeout exceeded — forcing cleanup and exit(1)');
    void end(1);
  }, 9 * 60_000);

  // ---- Phase 0: baseline ----------------------------------------------------
  const [dbReady] = await sql`select 1 as ok`;
  record('WSTERA LAB billing_core_staging reachable (select 1)', dbReady?.ok === 1);

  const registry = new ProductBillingProfileRegistry();
  registry.register(ps01TestProfile);
  registry.register(lk01TestProfile);

  const runtime = new CentralBillingRuntime({
    environment: 'test',
    schema: SCHEMA,
    admissionTestMode: true,
    databaseUrl: BILLING_DATABASE_URL,
    stripeSecretKey: STRIPE_SECRET_KEY,
    stripeWebhookSecret: STRIPE_WEBHOOK_SECRET,
    webhookMaxBytes: 1024 * 1024,
    credentials: [
      { keyId: PS01_KEY_ID, token: PS01_TOKEN, productId: PS01_PRODUCT_ID, environment: 'test', profileVersion: 1, scopes: ['checkout', 'read', 'portal'] },
      { keyId: LK01_KEY_ID, token: LK01_TOKEN, productId: LK01_PRODUCT_ID, environment: 'test', profileVersion: 1, scopes: ['checkout', 'read', 'portal'] },
    ],
    assertionKeys: [
      { keyId: `${PS01_KEY_ID}-assertion`, productId: PS01_PRODUCT_ID, environment: 'test', secret: PS01_ASSERTION_SECRET },
      { keyId: `${LK01_KEY_ID}-assertion`, productId: LK01_PRODUCT_ID, environment: 'test', secret: LK01_ASSERTION_SECRET },
    ],
    returnUrls: RETURN_URLS,
    entitlementSigningKeys: [ENTITLEMENT_KEY_PS01, ENTITLEMENT_KEY_LK01],
    profileRegistry: registry,
    logger,
  });
  await runtime.initialize();
  record('runtime.initialize() PASS (db ping + both products\' credential bindings against WSTERA LAB)', true);

  let drained = 0;
  for (let i = 0; i < 20; i += 1) {
    const outcome = await runtime.processOneJob(`sb01-lr2e-predrain-${RUN_TAG}`);
    if (outcome === 'idle') break;
    drained += 1;
  }
  console.log(`pre-existing outbox jobs drained: ${drained}`);

  // ---- Start Core HTTP boundary on 8787 (live stripe listen forwards here) --
  let server;
  const handler = createBillingHttpHandler(runtime);
  await new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      void handler(wrapAndCapture(req), res).catch(() => { /* adapter already handled */ });
    });
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', resolve);
  });
  console.log(`Core HTTP boundary listening on http://127.0.0.1:${PORT} (stripe listen forwards /webhooks/stripe here)`);

  async function callCore(route, init) {
    const response = await fetch(`http://127.0.0.1:${PORT}${route}`, init);
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: response.status, json, correlationId: response.headers.get('x-correlation-id') };
  }
  async function buildHeaders(productId, keyId, secret, token, accountId, operationId, action) {
    const now = Math.floor(Date.now() / 1000);
    const assertion = await signAccountAssertion({
      iss: productId, aud: 'wstera-billing-core', key_id: `${keyId}-assertion`,
      product_id: productId, environment: 'test', account_id: accountId, action,
      operation_id: operationId, nonce: crypto.randomUUID(), iat: now, exp: now + 240,
    }, secret);
    return { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-wstera-account-assertion': assertion };
  }

  // ---- Phase 1: real PS01 + LK01 checkout for the SAME account_id -----------
  console.log('--- Phase 1: real PS01 + LK01 Test checkout via Core HTTP boundary, shared account_id ---');
  const opPs01Checkout = `op_lr2e_ps01_checkout_${RUN_TAG}`;
  const ps01CheckoutRes = await callCore('/v1/checkout', {
    method: 'POST',
    headers: await buildHeaders(PS01_PRODUCT_ID, PS01_KEY_ID, PS01_ASSERTION_SECRET, PS01_TOKEN, ACCOUNT_MAIN, opPs01Checkout, 'checkout'),
    body: JSON.stringify({ account_id: ACCOUNT_MAIN, plan_id: 'founding-c2', operation_id: opPs01Checkout, success_return_ref: 'default', cancel_return_ref: 'default' }),
  });
  record('real PS01 Test checkout via Core HTTP boundary returned 201', ps01CheckoutRes.status === 201,
    `status=${ps01CheckoutRes.status} code=${ps01CheckoutRes.json?.error ?? ''}`);

  const opLk01Checkout = `op_lr2e_lk01_checkout_${RUN_TAG}`;
  const lk01CheckoutRes = await callCore('/v1/checkout', {
    method: 'POST',
    headers: await buildHeaders(LK01_PRODUCT_ID, LK01_KEY_ID, LK01_ASSERTION_SECRET, LK01_TOKEN, ACCOUNT_MAIN, opLk01Checkout, 'checkout'),
    body: JSON.stringify({ account_id: ACCOUNT_MAIN, plan_id: 'pro', operation_id: opLk01Checkout, success_return_ref: 'default', cancel_return_ref: 'default' }),
  });
  record('real LK01 Test checkout via Core HTTP boundary returned 201, SAME account_id as PS01', lk01CheckoutRes.status === 201,
    `status=${lk01CheckoutRes.status} code=${lk01CheckoutRes.json?.error ?? ''}`);

  const ps01CustomerRow = await getCustomerRow(PS01_PRODUCT_ID, ACCOUNT_MAIN);
  const lk01CustomerRow = await getCustomerRow(LK01_PRODUCT_ID, ACCOUNT_MAIN);
  record('WSTERA LAB runtime_provider_customers ready for PS01 (real provider mapping)',
    Boolean(ps01CustomerRow?.provider_customer_id?.startsWith('cus_')) && ps01CustomerRow?.state === 'ready',
    `customer=${maskId(ps01CustomerRow?.provider_customer_id ?? '')} state=${ps01CustomerRow?.state ?? 'missing'}`);
  record('WSTERA LAB runtime_provider_customers ready for LK01 (real provider mapping, same account_id)',
    Boolean(lk01CustomerRow?.provider_customer_id?.startsWith('cus_')) && lk01CustomerRow?.state === 'ready',
    `customer=${maskId(lk01CustomerRow?.provider_customer_id ?? '')} state=${lk01CustomerRow?.state ?? 'missing'}`);
  if (!ps01CustomerRow?.provider_customer_id || !lk01CustomerRow?.provider_customer_id) { await end(1); return; }
  record('PS01 and LK01 got DISTINCT real Stripe customers for the identical account_id literal',
    ps01CustomerRow.provider_customer_id !== lk01CustomerRow.provider_customer_id,
    `ps01=${maskId(ps01CustomerRow.provider_customer_id)} lk01=${maskId(lk01CustomerRow.provider_customer_id)}`);
  createdCustomerIds.push(ps01CustomerRow.provider_customer_id, lk01CustomerRow.provider_customer_id);
  const ps01CustomerId = ps01CustomerRow.provider_customer_id;
  const lk01CustomerId = lk01CustomerRow.provider_customer_id;

  // ---- Phase 2: fixture-route setup — real Test payment methods -------------
  console.log('--- Phase 2: fixture-route setup (harness-side Stripe TEST API, see script header) ---');
  const ps01Pm = await stripePost(`/payment_methods/pm_card_visa/attach`, new URLSearchParams({ customer: ps01CustomerId }));
  const lk01Pm = await stripePost(`/payment_methods/pm_card_visa/attach`, new URLSearchParams({ customer: lk01CustomerId }));
  record('Test payment method attached to real PS01 customer', typeof ps01Pm?.id === 'string' && ps01Pm.id.startsWith('pm_'), `pm=${maskId(ps01Pm?.id ?? '')}`);
  record('Test payment method attached to real LK01 customer', typeof lk01Pm?.id === 'string' && lk01Pm.id.startsWith('pm_'), `pm=${maskId(lk01Pm?.id ?? '')}`);

  // ---- Phase 3: real subscription creation per product ----------------------
  console.log('--- Phase 3: real Stripe Test subscription creation, one per product, shared account_id ---');
  const ps01Params = new URLSearchParams();
  ps01Params.set('customer', ps01CustomerId);
  ps01Params.set('items[0][price]', PS01_PINNED_PRICE);
  ps01Params.set('default_payment_method', ps01Pm.id);
  ps01Params.set('payment_behavior', 'error_if_incomplete');
  ps01Params.set('metadata[wstera_product_id]', PS01_PRODUCT_ID);
  ps01Params.set('metadata[account_id]', ACCOUNT_MAIN);
  ps01Params.set('metadata[profile_version]', '1');
  ps01Params.set('metadata[plan_id]', 'founding-c2');
  const ps01Sub = await stripePost('/subscriptions', ps01Params);
  record('real PS01 Stripe Test subscription created (mapped customer, pinned price)',
    typeof ps01Sub?.id === 'string' && ps01Sub.id.startsWith('sub_') && ps01Sub.livemode === false,
    `subscription=${maskId(ps01Sub?.id ?? '')} status=${String(ps01Sub?.status)}`);
  if (typeof ps01Sub?.id === 'string') createdSubscriptionIds.push(ps01Sub.id);

  const lk01Params = new URLSearchParams();
  lk01Params.set('customer', lk01CustomerId);
  lk01Params.set('items[0][price]', LK01_PINNED_PRICE);
  lk01Params.set('default_payment_method', lk01Pm.id);
  lk01Params.set('payment_behavior', 'error_if_incomplete');
  lk01Params.set('metadata[wstera_product_id]', LK01_PRODUCT_ID);
  lk01Params.set('metadata[account_id]', ACCOUNT_MAIN);
  lk01Params.set('metadata[profile_version]', '1');
  lk01Params.set('metadata[plan_id]', 'pro');
  const lk01Sub = await stripePost('/subscriptions', lk01Params);
  record('real LK01 Stripe Test subscription created (mapped customer, pinned price, SAME account_id)',
    typeof lk01Sub?.id === 'string' && lk01Sub.id.startsWith('sub_') && lk01Sub.livemode === false,
    `subscription=${maskId(lk01Sub?.id ?? '')} status=${String(lk01Sub?.status)}`);
  if (typeof lk01Sub?.id === 'string') createdSubscriptionIds.push(lk01Sub.id);
  if (typeof ps01Sub?.id !== 'string' || typeof lk01Sub?.id !== 'string') { await end(1); return; }

  const ps01Created = await waitFor(() => getEventRowByObjectId(ps01Sub.id, 'customer.subscription.created'), 45_000, 1_000);
  const lk01Created = await waitFor(() => getEventRowByObjectId(lk01Sub.id, 'customer.subscription.created'), 45_000, 1_000);
  record('real PS01 customer.subscription.created event durably claimed via live stripe listen',
    Boolean(ps01Created) && ps01Created.product_id === PS01_PRODUCT_ID && ps01Created.acc === ACCOUNT_MAIN,
    `event=${maskId(ps01Created?.pid ?? '')} status=${ps01Created?.status ?? 'missing'}`);
  record('real LK01 customer.subscription.created event durably claimed via live stripe listen (same account_id)',
    Boolean(lk01Created) && lk01Created.product_id === LK01_PRODUCT_ID && lk01Created.acc === ACCOUNT_MAIN,
    `event=${maskId(lk01Created?.pid ?? '')} status=${lk01Created?.status ?? 'missing'}`);
  if (!ps01Created || !lk01Created) { await end(1); return; }

  const ps01DedupeKey = `stripe:${ps01Created.pid}:reconcile`;
  const lk01DedupeKey = `stripe:${lk01Created.pid}:reconcile`;
  const drainOutcomes = await drainAllJobs(runtime, `sb01-lr2e-reconcile-${RUN_TAG}`);
  console.log(`reconcile-phase job drain outcomes: ${JSON.stringify(drainOutcomes)}`);

  const ps01Job = await getOutboxJobByDedupeKey(ps01DedupeKey);
  const lk01Job = await getOutboxJobByDedupeKey(lk01DedupeKey);
  record('PS01 reconcile job completed against real provider truth', ps01Job?.status === 'completed', `status=${ps01Job?.status ?? 'missing'}`);
  record('LK01 reconcile job completed against real provider truth', lk01Job?.status === 'completed', `status=${lk01Job?.status ?? 'missing'}`);
  record('PS01 and LK01 reconcile jobs used DISTINCT dedupe_key literals (real event ids, product-scoped)', ps01DedupeKey !== lk01DedupeKey, `ps01=${ps01DedupeKey.slice(0, 20)} lk01=${lk01DedupeKey.slice(0, 20)}`);

  // ---- Phase 4: reconciliation + entitlement isolation for the shared account_id ------------
  console.log('--- Phase 4: reconciliation_state + entitlement sink isolation, shared account_id ---');
  const ps01Reconcile = await getReconciliationRow(PS01_PRODUCT_ID, ps01Sub.id);
  const lk01Reconcile = await getReconciliationRow(LK01_PRODUCT_ID, lk01Sub.id);
  record('PS01 reconciliation_state matches real Stripe subscription (price/amount/currency), v1',
    Boolean(ps01Reconcile) && ps01Reconcile.price_id === PS01_PINNED_PRICE && ps01Reconcile.amount_minor === 99000 && ps01Reconcile.currency === 'THB' && ps01Reconcile.version === 1,
    `amount=${ps01Reconcile?.amount_minor} currency=${ps01Reconcile?.currency} version=${ps01Reconcile?.version} status=${ps01Reconcile?.status}`);
  record('LK01 reconciliation_state matches real Stripe subscription (price/amount/currency), v1, independent of PS01',
    Boolean(lk01Reconcile) && lk01Reconcile.price_id === LK01_PINNED_PRICE && lk01Reconcile.amount_minor === 19900 && lk01Reconcile.currency === 'THB' && lk01Reconcile.version === 1,
    `amount=${lk01Reconcile?.amount_minor} currency=${lk01Reconcile?.currency} version=${lk01Reconcile?.version} status=${lk01Reconcile?.status}`);

  const sinkRowsAfterGrant = await getEntitlementSinkRows(ACCOUNT_MAIN);
  record('exactly two independent entitlement sink rows exist for the shared account_id (one per product)', sinkRowsAfterGrant.length === 2, `rows=${sinkRowsAfterGrant.length}`);
  const ps01Sink = sinkRowsAfterGrant.find((r) => r.product_id === PS01_PRODUCT_ID);
  const lk01Sink = sinkRowsAfterGrant.find((r) => r.product_id === LK01_PRODUCT_ID);
  record('PS01 entitlement sink: grant v1, commercial_access, no cross-contamination from LK01',
    ps01Sink?.transition_type === 'grant' && ps01Sink?.version === 1 && JSON.stringify(ps01Sink?.entitlement_keys) === JSON.stringify(['commercial_access']),
    `type=${ps01Sink?.transition_type} version=${ps01Sink?.version} keys=${JSON.stringify(ps01Sink?.entitlement_keys)}`);
  record('LK01 entitlement sink: grant v1, links.pro, no cross-contamination from PS01',
    lk01Sink?.transition_type === 'grant' && lk01Sink?.version === 1 && JSON.stringify(lk01Sink?.entitlement_keys) === JSON.stringify(['links.pro']),
    `type=${lk01Sink?.transition_type} version=${lk01Sink?.version} keys=${JSON.stringify(lk01Sink?.entitlement_keys)}`);

  // ---- Phase 5: real HTTP route isolation — status + entitlements, shared account_id --------
  console.log('--- Phase 5: real GET routes never leak the other product\'s data for the same account_id ---');
  const ps01StatusOp = `op_lr2e_ps01_status_${RUN_TAG}`;
  const ps01StatusHeaders = await buildHeaders(PS01_PRODUCT_ID, PS01_KEY_ID, PS01_ASSERTION_SECRET, PS01_TOKEN, ACCOUNT_MAIN, ps01StatusOp, 'subscription_status');
  const ps01Status = await callCore(`/v1/subscription/status?account_id=${ACCOUNT_MAIN}&operation_id=${ps01StatusOp}`, { headers: ps01StatusHeaders });
  record('PS01 credential reads PS01\'s own subscription plan via real route', ps01Status.status === 200 && ps01Status.json?.subscription?.plan_id === 'founding-c2',
    `status=${ps01Status.status} plan=${ps01Status.json?.subscription?.plan_id}`);
  record('PS01 route response never carries LK01\'s plan_id for the same account_id', ps01Status.json?.subscription?.plan_id !== 'pro', `plan=${ps01Status.json?.subscription?.plan_id}`);

  const lk01StatusOp = `op_lr2e_lk01_status_${RUN_TAG}`;
  const lk01StatusHeaders = await buildHeaders(LK01_PRODUCT_ID, LK01_KEY_ID, LK01_ASSERTION_SECRET, LK01_TOKEN, ACCOUNT_MAIN, lk01StatusOp, 'subscription_status');
  const lk01Status = await callCore(`/v1/subscription/status?account_id=${ACCOUNT_MAIN}&operation_id=${lk01StatusOp}`, { headers: lk01StatusHeaders });
  record('LK01 credential reads LK01\'s own subscription plan via real route (same account_id as PS01)', lk01Status.status === 200 && lk01Status.json?.subscription?.plan_id === 'pro',
    `status=${lk01Status.status} plan=${lk01Status.json?.subscription?.plan_id}`);

  const ps01EntOp = `op_lr2e_ps01_ent_${RUN_TAG}`;
  const ps01EntHeaders = await buildHeaders(PS01_PRODUCT_ID, PS01_KEY_ID, PS01_ASSERTION_SECRET, PS01_TOKEN, ACCOUNT_MAIN, ps01EntOp, 'entitlements_read');
  const ps01Ent = await callCore(`/v1/entitlements?account_id=${ACCOUNT_MAIN}&operation_id=${ps01EntOp}`, { headers: ps01EntHeaders });
  record('PS01 entitlements route returns only commercial_access', JSON.stringify(ps01Ent.json?.entitlement_projection?.entitlement_keys) === JSON.stringify(['commercial_access']),
    `keys=${JSON.stringify(ps01Ent.json?.entitlement_projection?.entitlement_keys)}`);

  const lk01EntOp = `op_lr2e_lk01_ent_${RUN_TAG}`;
  const lk01EntHeaders = await buildHeaders(LK01_PRODUCT_ID, LK01_KEY_ID, LK01_ASSERTION_SECRET, LK01_TOKEN, ACCOUNT_MAIN, lk01EntOp, 'entitlements_read');
  const lk01Ent = await callCore(`/v1/entitlements?account_id=${ACCOUNT_MAIN}&operation_id=${lk01EntOp}`, { headers: lk01EntHeaders });
  record('LK01 entitlements route returns only links.pro', JSON.stringify(lk01Ent.json?.entitlement_projection?.entitlement_keys) === JSON.stringify(['links.pro']),
    `keys=${JSON.stringify(lk01Ent.json?.entitlement_projection?.entitlement_keys)}`);

  // Cross-credential denial: an assertion minted for PS01's key set, presented against LK01's
  // credential token, for the identical account_id/action/operation_id.
  const crossOp = `op_lr2e_cross_${RUN_TAG}`;
  const ps01AssertionForCross = await (async () => {
    const now = Math.floor(Date.now() / 1000);
    return signAccountAssertion({
      iss: PS01_PRODUCT_ID, aud: 'wstera-billing-core', key_id: `${PS01_KEY_ID}-assertion`,
      product_id: PS01_PRODUCT_ID, environment: 'test', account_id: ACCOUNT_MAIN, action: 'subscription_status',
      operation_id: crossOp, nonce: crypto.randomUUID(), iat: now, exp: now + 240,
    }, PS01_ASSERTION_SECRET);
  })();
  const crossRes = await callCore(`/v1/subscription/status?account_id=${ACCOUNT_MAIN}&operation_id=${crossOp}`, {
    headers: { authorization: `Bearer ${LK01_TOKEN}`, 'x-wstera-account-assertion': ps01AssertionForCross },
  });
  record('a PS01-signed assertion is rejected against the LK01 credential for the SAME account_id (fail-closed, no data returned)',
    crossRes.status === 401 && crossRes.json?.error === 'ACCOUNT_ASSERTION_INVALID',
    `status=${crossRes.status} error=${crossRes.json?.error}`);

  // ---- Phase 6: duplicate delivery replay (PS01 event, byte-faithful, real whsec_) -----------
  console.log('--- Phase 6: duplicate delivery replay (real whsec_, byte-faithful) ---');
  const rawBodyPs01 = capturedWebhookBodies.get(ps01Created.pid);
  record('raw webhook body captured for the real delivered PS01 event (duplicate-replay source)', Boolean(rawBodyPs01), `captured=${Boolean(rawBodyPs01)}`);
  if (rawBodyPs01) {
    const duplicateRes = await callCore('/webhooks/stripe', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': stripeSignatureHeader(rawBodyPs01, Math.floor(Date.now() / 1000)) },
      body: rawBodyPs01,
    });
    record('duplicate PS01 delivery accepted 200 and flagged duplicate=true', duplicateRes.status === 200 && duplicateRes.json?.duplicate === true,
      `status=${duplicateRes.status} duplicate=${String(duplicateRes.json?.duplicate)}`);
  }
  const ps01EventCountAfterDup = await countEventRows(ps01Created.pid);
  record('duplicate PS01 delivery created no second provider-event row', ps01EventCountAfterDup === 1, `rows=${ps01EventCountAfterDup}`);
  const ps01OutboxCountAfterDup = await countOutboxByDedupeKey(ps01DedupeKey);
  record('duplicate PS01 delivery created no second outbox job', ps01OutboxCountAfterDup === 1, `rows=${ps01OutboxCountAfterDup}`);
  const sinkRowsAfterDup = await getEntitlementSinkRows(ACCOUNT_MAIN);
  const ps01SinkAfterDup = sinkRowsAfterDup.find((r) => r.product_id === PS01_PRODUCT_ID);
  const lk01SinkAfterDup = sinkRowsAfterDup.find((r) => r.product_id === LK01_PRODUCT_ID);
  record('duplicate PS01 delivery produced no second entitlement transition/sink version (still v1)', ps01SinkAfterDup?.version === 1, `version=${ps01SinkAfterDup?.version}`);
  record('duplicate PS01 delivery left LK01\'s sink completely untouched (still v1, grant)', lk01SinkAfterDup?.version === 1 && lk01SinkAfterDup?.transition_type === 'grant',
    `version=${lk01SinkAfterDup?.version} type=${lk01SinkAfterDup?.transition_type}`);

  // ---- Phase 7: grant v1 -> revoke v2 monotonicity PER PRODUCT, no cross-contamination -------
  console.log('--- Phase 7: real cancellation of PS01 only -> revoke v2, LK01 untouched ---');
  const canceled = await stripeDelete(`/subscriptions/${ps01Sub.id}`);
  record('real Stripe Test PS01 subscription canceled (harness lifecycle action)', canceled?.status === 'canceled', `status=${String(canceled?.status)}`);
  const ps01Deleted = await waitFor(() => getEventRowByObjectId(ps01Sub.id, 'customer.subscription.deleted'), 45_000, 1_000);
  record('real PS01 customer.subscription.deleted event durably claimed', Boolean(ps01Deleted), `event=${maskId(ps01Deleted?.pid ?? '')}`);
  if (ps01Deleted) {
    const ps01CancelDedupeKey = `stripe:${ps01Deleted.pid}:reconcile`;
    const cancelDrainOutcomes = await drainAllJobs(runtime, `sb01-lr2e-cancel-${RUN_TAG}`);
    console.log(`cancellation-phase job drain outcomes: ${JSON.stringify(cancelDrainOutcomes)}`);
    const ps01CancelJob = await getOutboxJobByDedupeKey(ps01CancelDedupeKey);
    record('PS01 cancellation reconcile job completed against real provider truth', ps01CancelJob?.status === 'completed', `status=${ps01CancelJob?.status ?? 'missing'}`);
    const ps01ReconcileAfterCancel = await getReconciliationRow(PS01_PRODUCT_ID, ps01Sub.id);
    record('PS01 reconciliation_state reflects real canceled status, version incremented to 2', ps01ReconcileAfterCancel?.status === 'canceled' && ps01ReconcileAfterCancel?.version === 2,
      `status=${ps01ReconcileAfterCancel?.status} version=${ps01ReconcileAfterCancel?.version}`);
    const lk01ReconcileAfterCancel = await getReconciliationRow(LK01_PRODUCT_ID, lk01Sub.id);
    record('LK01 reconciliation_state UNCHANGED by PS01\'s cancellation (still active, v1)', lk01ReconcileAfterCancel?.status === 'active' && lk01ReconcileAfterCancel?.version === 1,
      `status=${lk01ReconcileAfterCancel?.status} version=${lk01ReconcileAfterCancel?.version}`);
    const sinkRowsAfterCancel = await getEntitlementSinkRows(ACCOUNT_MAIN);
    const ps01SinkAfterCancel = sinkRowsAfterCancel.find((r) => r.product_id === PS01_PRODUCT_ID);
    const lk01SinkAfterCancel = sinkRowsAfterCancel.find((r) => r.product_id === LK01_PRODUCT_ID);
    record('PS01 entitlement sink: revoke, version 2 (monotonic grant v1 -> revoke v2), keys cleared',
      ps01SinkAfterCancel?.transition_type === 'revoke' && ps01SinkAfterCancel?.version === 2 && JSON.stringify(ps01SinkAfterCancel?.entitlement_keys) === JSON.stringify([]),
      `type=${ps01SinkAfterCancel?.transition_type} version=${ps01SinkAfterCancel?.version} keys=${JSON.stringify(ps01SinkAfterCancel?.entitlement_keys)}`);
    record('LK01 entitlement sink UNTOUCHED by PS01\'s revoke (still grant, v1, links.pro) — no cross-contamination',
      lk01SinkAfterCancel?.transition_type === 'grant' && lk01SinkAfterCancel?.version === 1 && JSON.stringify(lk01SinkAfterCancel?.entitlement_keys) === JSON.stringify(['links.pro']),
      `type=${lk01SinkAfterCancel?.transition_type} version=${lk01SinkAfterCancel?.version} keys=${JSON.stringify(lk01SinkAfterCancel?.entitlement_keys)}`);
  }

  // ---- Summary + cleanup -----------------------------------------------------
  const failed = results.filter((result) => !result.ok);
  console.log('=== SUMMARY ===');
  console.log(JSON.stringify({
    run_tag: RUN_TAG,
    total_checks: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    shared_account_id: ACCOUNT_MAIN,
    ps01_customer: maskId(ps01CustomerId),
    lk01_customer: maskId(lk01CustomerId),
    subscriptions: createdSubscriptionIds.map((id) => maskId(id)),
  }, null, 2));
  for (const item of failed) console.log(`FAILED CHECK: ${item.name} :: ${item.detail}`);

  const cleanupCounts = await cleanup(createdSubscriptionIds, createdCustomerIds);
  console.log(`FINAL CLEANUP COUNTS: ${JSON.stringify(cleanupCounts)}`);
  cleanupDone = true;
  if (watchdog) clearTimeout(watchdog);
  server.close();
  await runtime.close();
  await sql.end({ timeout: 5 });
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(`FATAL: ${String(error?.stack ?? error).slice(0, 800)}`);
  try { if (emergencyEnd) await emergencyEnd(1); } catch { /* cleanup already logged */ }
  process.exit(1);
});
