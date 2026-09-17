#!/usr/bin/env node
// SB01 LR-2D — REAL (Stripe TEST + WSTERA LAB billing_core_staging) webhook durability +
// reconciliation vertical slice through the Core HTTP boundary + live `stripe listen` forward.
//
// TEST-gated: refuses to run unless STRIPE_SECRET_KEY is a real sk_test_ key,
// STRIPE_WEBHOOK_SECRET is a real whsec_ secret, and BILLING_DATABASE_URL is set. Credentials
// are read from the worker environment only; no secret value is ever printed, logged, or
// persisted. All object ids in output are masked.
//
// Fixture route (documented, see docs/platform/billing-core/EVIDENCE-SB01-LR-2D-CLAUDE-2026-09-17.md
// section 4): Stripe's Test backend API has no payer-side completion route for a card Checkout
// session (proven at LR-2C). A *paid* subscription therefore cannot be produced through the Core
// checkout path alone. This harness creates the provider-side subscription directly against the
// Stripe TEST API for the real customer the Core HTTP boundary created (pinned profile price +
// correct wstera_* metadata), so real Stripe webhooks fire through the live listener into the
// Core webhook route exactly as they would from a payer completing checkout. This simulates the
// external provider world; it does not relax any Core authority rule.
//
// Run: node scripts/run-sb01-lr2d-reconcile-slice.mjs   (from platform/runtime)
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
// Config
// ---------------------------------------------------------------------------
const SCHEMA = 'billing_core_staging';
const PORT = 8787;
const PS01_PRODUCT_ID = ps01TestProfile.productId;
const PS01_PINNED_PRICE = 'price_1UDCxyHB4GRCffd9RyaDWZ1c';
const LK01_FOREIGN_PRICE = 'price_1UDCxzHB4GRCffd9a0rUipHY'; // valid Stripe Test price, NOT mapped under PS01 profile
const RUN_TAG = crypto.randomUUID().slice(0, 8);
const ACCOUNT_MAIN = `acc_ps01_lr2d_${RUN_TAG}`;
const RUN_ACCOUNTS = [ACCOUNT_MAIN];
const PS01_TOKEN = `wstera-lr2d-ps01-${crypto.randomUUID()}`;
const PS01_ASSERTION_SECRET = crypto.randomUUID() + crypto.randomUUID();
const PS01_KEY_ID = `sb01-lr2d-ps01-${RUN_TAG}`;
const RETURN_URLS = {
  [PS01_PRODUCT_ID]: {
    success: { default: 'https://pawstia.app/checkout/success' },
    cancel: { default: 'https://pawstia.app/checkout/cancel' },
    portal: { default: 'https://pawstia.app/portal/return' },
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

async function countRowsByAccounts(table, accountIds) {
  const rows = await sql`
    select count(*)::int as n from ${sql(`${SCHEMA}.${table}`)} where account_id = any(${accountIds})
  `;
  return rows[0].n;
}
async function getCustomerRow(accountId) {
  const rows = await sql`
    select provider_customer_id, state, profile_version::int as profile_version
    from ${sql(`${SCHEMA}.runtime_provider_customers`)}
    where environment = 'test' and account_id = ${accountId} and provider = 'stripe' limit 1
  `;
  return rows[0] ?? null;
}
async function getEventRowByObjectId(providerObjectId, eventType) {
  const rows = await sql`
    select id::text as db_id, provider_event_id::text as pid, status::text as status,
           environment::text as env, account_id::text as acc, event_type::text as event_type
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
    select id::text as id, status::text as status, completed_at, attempt_count::int as attempts
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
async function getReconciliationRow(providerSubscriptionId) {
  const rows = await sql`
    select provider_status::text as status, price_id, amount_minor::int as amount_minor, currency,
           provider_product_id, reconciliation_version::int as version
    from ${sql(`${SCHEMA}.runtime_reconciliation_state`)}
    where environment = 'test' and provider_subscription_id = ${providerSubscriptionId} limit 1
  `;
  return rows[0] ?? null;
}
async function getEntitlementSinkRow(accountId) {
  const rows = await sql`
    select plan_id, transition_type, entitlement_keys, latest_transition_version::int as version
    from ${sql(`${SCHEMA}.runtime_entitlement_test_sink`)}
    where environment = 'test' and account_id = ${accountId} limit 1
  `;
  return rows[0] ?? null;
}
async function countTransitionsByIdempotencyPrefix(accountId) {
  const rows = await sql`
    select count(*)::int as n from ${sql(`${SCHEMA}.runtime_entitlement_transitions`)}
    where account_id = ${accountId}
  `;
  return rows[0].n;
}

// Real Stripe subscription lifecycle actions fan out into several webhook deliveries beyond the
// subscription event itself (invoice.*, payment_intent.*, payment_method.attached, …) — each
// mapped delivery enqueues its own reconcile job. A real worker drains the whole queue rather
// than assuming exactly one job is pending; this harness does the same, then asserts against the
// specific job it cares about (by dedupe key) rather than trusting a single lease's outcome.
async function drainAllJobs(runtime, workerId, maxIterations = 20) {
  const outcomes = [];
  for (let i = 0; i < maxIterations; i += 1) {
    const outcome = await runtime.processOneJob(`${workerId}-${i}`);
    if (outcome === 'idle') break;
    outcomes.push(outcome);
  }
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

// ---------------------------------------------------------------------------
// Raw-body capture for /webhooks/stripe deliveries (keyed by event id), used to build a
// byte-faithful duplicate-delivery replay (§3 item 5/6) — same JSON body the live listener
// actually forwarded, re-signed with a fresh timestamp using the real whsec_, exactly as a
// Stripe retry delivery would carry the same event content under a new signature.
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
            } catch { /* not JSON — ignore, denial-path synthetic calls don't need capture */ }
          }
          return result;
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Cleanup — scoped to this run's account id / key id / created provider objects
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
    'runtime_entitlement_test_sink',
    'runtime_entitlement_transitions',
    'runtime_outbox_jobs',
    'runtime_provider_events',
    'runtime_reconciliation_state',
    'runtime_audit_events',
    'runtime_provider_customers',
    'runtime_operations',
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
    const result = await sql`delete from ${sql(`${SCHEMA}.runtime_credential_bindings`)} where credential_key_id = ${PS01_KEY_ID}`;
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
async function main() {
  console.log('=== SB01 LR-2D REAL WEBHOOK DURABILITY + RECONCILIATION VERTICAL SLICE ===');
  console.log(`run tag: ${RUN_TAG}`);
  console.log(`stripe key: PRESENT prefix=${STRIPE_SECRET_KEY.slice(0, 8)}… len=${STRIPE_SECRET_KEY.length} (sk_test_ gate passed)`);
  console.log(`webhook secret: PRESENT prefix=whsec_… len=${STRIPE_WEBHOOK_SECRET.length}`);
  console.log(`db url: PRESENT host=${new URL(BILLING_DATABASE_URL).host}`);

  const createdSubscriptionIds = [];
  const createdCustomerIds = [];
  let cleanupDone = false;
  process.on('unhandledRejection', (error) => { console.error(`UNHANDLED REJECTION: ${String(error)}`); });
  process.on('SIGINT', () => { void end(1); });
  process.on('SIGTERM', () => { void end(1); });

  async function end(exitCode) {
    if (cleanupDone) return;
    cleanupDone = true;
    try { await cleanup(createdSubscriptionIds, createdCustomerIds); } catch { /* already logged */ }
    try { server?.close(); } catch { /* ignore */ }
    try { await runtime?.close(); } catch { /* ignore */ }
    try { await sql.end({ timeout: 5 }); } catch { /* ignore */ }
    process.exit(exitCode);
  }
  emergencyEnd = end;

  // ---- Phase 0: baseline ----------------------------------------------------
  const [dbReady] = await sql`select 1 as ok`;
  record('WSTERA LAB billing_core_staging reachable (select 1)', dbReady?.ok === 1);

  const registry = new ProductBillingProfileRegistry();
  registry.register(ps01TestProfile);

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
    ],
    assertionKeys: [
      { keyId: `${PS01_KEY_ID}-assertion`, productId: PS01_PRODUCT_ID, environment: 'test', secret: PS01_ASSERTION_SECRET },
    ],
    returnUrls: RETURN_URLS,
    entitlementSigningKeys: [
      { keyId: `${PS01_KEY_ID}-entitlement`, productId: PS01_PRODUCT_ID, environment: 'test', secret: crypto.randomUUID() + crypto.randomUUID() },
    ],
    profileRegistry: registry,
    logger,
  });
  await runtime.initialize();
  record('runtime.initialize() PASS (db ping + credential bindings against WSTERA LAB)', true);

  let drained = 0;
  for (let i = 0; i < 20; i += 1) {
    const outcome = await runtime.processOneJob(`sb01-lr2d-drain-${RUN_TAG}`);
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
  async function buildHeaders(accountId, operationId, action) {
    const now = Math.floor(Date.now() / 1000);
    const assertion = await signAccountAssertion({
      iss: PS01_PRODUCT_ID, aud: 'wstera-billing-core', key_id: `${PS01_KEY_ID}-assertion`,
      product_id: PS01_PRODUCT_ID, environment: 'test', account_id: accountId, action,
      operation_id: operationId, nonce: crypto.randomUUID(), iat: now, exp: now + 240,
    }, PS01_ASSERTION_SECRET);
    return { 'content-type': 'application/json', authorization: `Bearer ${PS01_TOKEN}`, 'x-wstera-account-assertion': assertion };
  }

  // ---- Phase 1: real PS01 checkout via Core HTTP boundary → real customer mapping ----------
  console.log('--- Phase 1: real PS01 Test checkout via Core HTTP boundary (customer mapping setup) ---');
  const opId = `op_lr2d_${RUN_TAG}`;
  const checkoutRes = await callCore('/v1/checkout', {
    method: 'POST',
    headers: await buildHeaders(ACCOUNT_MAIN, opId, 'checkout'),
    body: JSON.stringify({
      account_id: ACCOUNT_MAIN, plan_id: 'founding-c2', operation_id: opId,
      success_return_ref: 'default', cancel_return_ref: 'default',
    }),
  });
  record('real PS01 Test checkout via Core HTTP boundary returned 201', checkoutRes.status === 201,
    `status=${checkoutRes.status} code=${checkoutRes.json?.error ?? ''}`);
  const customerRow = await getCustomerRow(ACCOUNT_MAIN);
  record('WSTERA LAB runtime_provider_customers row ready with real provider mapping',
    Boolean(customerRow?.provider_customer_id?.startsWith('cus_')) && customerRow?.state === 'ready',
    `customer=${maskId(customerRow?.provider_customer_id ?? '')} state=${customerRow?.state ?? 'missing'}`);
  if (!customerRow?.provider_customer_id) { await end(1); return; }
  createdCustomerIds.push(customerRow.provider_customer_id);
  const providerCustomerId = customerRow.provider_customer_id;

  // ---- Phase 2: fixture-route setup — attach a real Test payment method -------------------
  console.log('--- Phase 2: fixture-route setup (harness-side Stripe TEST API, see §4) ---');
  const attachedPm = await stripePost(`/payment_methods/pm_card_visa/attach`, new URLSearchParams({ customer: providerCustomerId }));
  record('Test payment method attached to real customer (harness setup)', typeof attachedPm?.id === 'string' && attachedPm.id.startsWith('pm_'),
    `pm=${maskId(attachedPm?.id ?? '')}`);
  const defaultPmId = attachedPm.id;

  // ---- Phase 3: real subscription creation (mapped) → real webhook chain ------------------
  console.log('--- Phase 3: real Stripe Test subscription creation (pinned price+metadata, mapped) ---');
  const sub1Params = new URLSearchParams();
  sub1Params.set('customer', providerCustomerId);
  sub1Params.set('items[0][price]', PS01_PINNED_PRICE);
  sub1Params.set('default_payment_method', defaultPmId);
  sub1Params.set('payment_behavior', 'error_if_incomplete');
  sub1Params.set('metadata[wstera_product_id]', PS01_PRODUCT_ID);
  sub1Params.set('metadata[account_id]', ACCOUNT_MAIN);
  sub1Params.set('metadata[profile_version]', '1');
  sub1Params.set('metadata[plan_id]', 'founding-c2');
  const sub1 = await stripePost('/subscriptions', sub1Params);
  record('real Stripe Test subscription created (sub_…, mapped customer, pinned price)',
    typeof sub1?.id === 'string' && sub1.id.startsWith('sub_') && sub1.livemode === false,
    `subscription=${maskId(sub1?.id ?? '')} status=${String(sub1?.status)}`);
  if (typeof sub1?.id !== 'string') { await end(1); return; }
  createdSubscriptionIds.push(sub1.id);

  // §3 item 1: real event reaches Core webhook route, real HMAC validation, durable claim
  // before processing.
  const claimedEvent1 = await waitFor(() => getEventRowByObjectId(sub1.id, 'customer.subscription.created'), 45_000, 1_000);
  record('real customer.subscription.created event durably claimed via live stripe listen → Core webhook route',
    Boolean(claimedEvent1) && claimedEvent1.env === 'test' && claimedEvent1.acc === ACCOUNT_MAIN,
    `event=${maskId(claimedEvent1?.pid ?? '')} status=${claimedEvent1?.status ?? 'missing'}`);
  if (!claimedEvent1) { await end(1); return; }

  // §3 item 2: mapped event drives the outbox — reconcile job enqueued.
  const dedupeKey1 = `stripe:${claimedEvent1.pid}:reconcile`;
  const job1Before = await waitFor(() => getOutboxJobByDedupeKey(dedupeKey1), 15_000, 500);
  record('mapped webhook claim enqueued a reconcile outbox job (pending, pre-processing)',
    Boolean(job1Before) && job1Before.status === 'pending', `status=${job1Before?.status ?? 'missing'}`);

  // §3 item 3: job leased + processed, reconciliation uses provider truth (retrieveSubscription).
  // A single real subscription-create action fans out into several mapped webhook deliveries
  // (invoice.*, payment_method.attached, …) beyond customer.subscription.created itself, each
  // enqueuing its own reconcile job — drain the whole queue like a real worker would, then check
  // the specific dedupe-keyed job this phase cares about.
  const drainOutcomes1 = await drainAllJobs(runtime, `sb01-lr2d-reconcile-${RUN_TAG}`);
  console.log(`reconcile-phase job drain outcomes: ${JSON.stringify(drainOutcomes1)}`);
  const job1Final = await getOutboxJobByDedupeKey(dedupeKey1);
  record('reconcile job for the real customer.subscription.created event completed against provider truth',
    job1Final?.status === 'completed', `status=${job1Final?.status ?? 'missing'}`);
  const reconcile1 = await getReconciliationRow(sub1.id);
  record('reconciliation_state matches real Stripe subscription (price/product/amount/currency)',
    Boolean(reconcile1) && reconcile1.price_id === PS01_PINNED_PRICE
      && reconcile1.amount_minor === 99000 && reconcile1.currency === 'THB' && reconcile1.version === 1,
    `price=${maskId(reconcile1?.price_id ?? '')} amount=${reconcile1?.amount_minor} currency=${reconcile1?.currency} version=${reconcile1?.version} status=${reconcile1?.status}`);
  const sink1 = await getEntitlementSinkRow(ACCOUNT_MAIN);
  record('§3 item 7: entitlement delivered to test sink, version 1, grant, correct keys',
    Boolean(sink1) && sink1.transition_type === 'grant' && sink1.version === 1
      && JSON.stringify(sink1.entitlement_keys) === JSON.stringify(['commercial_access']),
    `type=${sink1?.transition_type} version=${sink1?.version} keys=${JSON.stringify(sink1?.entitlement_keys)}`);

  // ---- Phase 4: §3 item 5 + item 6 — duplicate delivery is idempotent; a completed job is ---
  // NOT resurrected by a later duplicate/stale enqueue (the LR-2D defect fixed at 0f85b6e2).
  console.log('--- Phase 4: duplicate delivery replay (raw-body-faithful, real whsec_) ---');
  const rawBody1 = capturedWebhookBodies.get(claimedEvent1.pid);
  record('raw webhook body captured for the real delivered event (duplicate-replay source)', Boolean(rawBody1),
    `captured=${Boolean(rawBody1)}`);
  const jobAfterCompletion = await getOutboxJobByDedupeKey(dedupeKey1);
  record('reconcile outbox job reached completed status before duplicate replay',
    jobAfterCompletion?.status === 'completed' && jobAfterCompletion?.completed_at !== null,
    `status=${jobAfterCompletion?.status} completed_at=${jobAfterCompletion?.completed_at !== null}`);
  if (rawBody1) {
    const duplicateRes = await callCore('/webhooks/stripe', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': stripeSignatureHeader(rawBody1, Math.floor(Date.now() / 1000)) },
      body: rawBody1,
    });
    record('duplicate delivery accepted 200 and flagged duplicate=true (real whsec_ signature)',
      duplicateRes.status === 200 && duplicateRes.json?.duplicate === true,
      `status=${duplicateRes.status} duplicate=${String(duplicateRes.json?.duplicate)}`);
  }
  const eventRowCountAfterDup = await countEventRows(claimedEvent1.pid);
  record('duplicate delivery created no second provider-event row', eventRowCountAfterDup === 1, `rows=${eventRowCountAfterDup}`);
  const outboxCountAfterDup = await countOutboxByDedupeKey(dedupeKey1);
  record('duplicate delivery created no second outbox job (same dedupe key)', outboxCountAfterDup === 1, `rows=${outboxCountAfterDup}`);
  const jobAfterDup = await getOutboxJobByDedupeKey(dedupeKey1);
  record('§3 item 6: completed job NOT resurrected to pending by duplicate/stale conflict (real execution, 0f85b6e2 fix)',
    jobAfterDup?.status === 'completed', `status=${jobAfterDup?.status ?? 'missing'}`);
  const sinkAfterDup = await getEntitlementSinkRow(ACCOUNT_MAIN);
  record('duplicate delivery produced no second entitlement transition/sink version', sinkAfterDup?.version === 1,
    `version=${sinkAfterDup?.version}`);
  const transitionCountAfterDup = await countTransitionsByIdempotencyPrefix(ACCOUNT_MAIN);
  record('exactly one entitlement transition row exists after duplicate replay', transitionCountAfterDup === 1,
    `rows=${transitionCountAfterDup}`);

  // ---- Phase 5: §3 item 4 — provider-truth mismatch rejected, no billing-state mutation -----
  console.log('--- Phase 5: provider-truth mismatch (foreign price, real Stripe object) ---');
  const sub2Params = new URLSearchParams();
  sub2Params.set('customer', providerCustomerId);
  sub2Params.set('items[0][price]', LK01_FOREIGN_PRICE);
  sub2Params.set('default_payment_method', defaultPmId);
  sub2Params.set('payment_behavior', 'error_if_incomplete');
  sub2Params.set('metadata[wstera_product_id]', PS01_PRODUCT_ID);
  sub2Params.set('metadata[account_id]', ACCOUNT_MAIN);
  sub2Params.set('metadata[profile_version]', '1');
  const sub2 = await stripePost('/subscriptions', sub2Params);
  record('real Stripe Test subscription #2 created (foreign price, real object)',
    typeof sub2?.id === 'string' && sub2.id.startsWith('sub_'), `subscription=${maskId(sub2?.id ?? '')}`);
  if (typeof sub2?.id === 'string') createdSubscriptionIds.push(sub2.id);
  const claimedEvent2 = await waitFor(() => getEventRowByObjectId(sub2.id, 'customer.subscription.created'), 45_000, 1_000);
  record('mismatch-fixture event durably claimed (mapped, before processing)', Boolean(claimedEvent2),
    `event=${maskId(claimedEvent2?.pid ?? '')}`);
  const dedupeKey2 = `stripe:${claimedEvent2?.pid}:reconcile`;
  const drainOutcomes2 = await drainAllJobs(runtime, `sb01-lr2d-reconcile-mismatch-${RUN_TAG}`);
  console.log(`mismatch-phase job drain outcomes: ${JSON.stringify(drainOutcomes2)}`);
  const jobRow2 = await sql`
    select status, last_error_code, dedupe_key from ${sql(`${SCHEMA}.runtime_outbox_jobs`)}
    where dedupe_key = ${dedupeKey2} limit 1
  `;
  record('§3 item 4: reconcile job on provider-truth mismatch does NOT complete',
    jobRow2[0]?.status !== 'completed', `status=${jobRow2[0]?.status ?? 'missing'}`);
  record('rejected with RECONCILE_PRICE_MISMATCH (real Stripe price truth vs. pinned profile)',
    jobRow2[0]?.last_error_code === 'RECONCILE_PRICE_MISMATCH', `code=${jobRow2[0]?.last_error_code ?? 'missing'}`);
  const reconcile2 = await getReconciliationRow(sub2.id);
  record('mismatch left no billing-state mutation (no reconciliation_state row)', reconcile2 === null,
    `row=${reconcile2 ? 'present' : 'absent'}`);
  const sinkAfterMismatch = await getEntitlementSinkRow(ACCOUNT_MAIN);
  record('mismatch did not disturb the existing entitlement sink version', sinkAfterMismatch?.version === 1,
    `version=${sinkAfterMismatch?.version}`);

  // ---- Phase 6: §3 item 2 (second half) — unmapped event skipped, no outbox job -------------
  console.log('--- Phase 6: unmapped webhook intake via stripe fixture trigger (durable, side-effect-free) ---');
  let stripeExe = null;
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const whereRes = await promisify(execFile)('where.exe', ['stripe'], { timeout: 10_000 });
    stripeExe = whereRes.stdout.trim().split(/\r?\n/)[0] || null;
  } catch { stripeExe = null; }
  let unmappedEventRow = null;
  if (stripeExe) {
    const beforeTrigger = new Set((await sql`
      select provider_event_id::text as id from ${sql(`${SCHEMA}.runtime_provider_events`)}
    `).map((r) => r.id));
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      await promisify(execFile)(stripeExe, ['trigger', 'customer.subscription.updated'], { timeout: 30_000 });
      console.log('stripe trigger customer.subscription.updated: ok');
    } catch (error) {
      console.log(`stripe trigger failed (non-fatal): ${String(error?.message ?? error).slice(0, 120)}`);
    }
    unmappedEventRow = await waitFor(async () => {
      const rows = await sql`
        select provider_event_id::text as pid, status::text as status, account_id::text as acc
        from ${sql(`${SCHEMA}.runtime_provider_events`)}
        where provider = 'stripe' and provider_event_id <> all(${[...beforeTrigger]})
        order by received_at desc limit 1
      `;
      return rows[0] ?? null;
    }, 45_000, 1_000);
  } else {
    console.log('stripe CLI not found on PATH; unmapped fixture trigger unavailable');
  }
  record('unmapped fixture event durably claimed with status=skipped', unmappedEventRow?.status === 'skipped',
    `status=${unmappedEventRow?.status ?? 'missing (stripe CLI unavailable)'}`);
  if (unmappedEventRow) {
    const unmappedOutbox = await countOutboxByDedupeKey(`stripe:${unmappedEventRow.pid}:reconcile`);
    record('unmapped event enqueued no reconcile outbox job', unmappedOutbox === 0, `rows=${unmappedOutbox}`);
  }

  // ---- Phase 7: §3 item 7 (monotonic version) — real cancellation → revoke transition -------
  console.log('--- Phase 7: real subscription cancellation → revoke transition, monotonic version ---');
  const canceled = await stripeDelete(`/subscriptions/${sub1.id}`);
  record('real Stripe Test subscription canceled (harness lifecycle action)', canceled?.status === 'canceled',
    `status=${String(canceled?.status)}`);
  const claimedEvent3 = await waitFor(() => getEventRowByObjectId(sub1.id, 'customer.subscription.deleted'), 45_000, 1_000);
  record('real customer.subscription.deleted event durably claimed', Boolean(claimedEvent3),
    `event=${maskId(claimedEvent3?.pid ?? '')}`);
  if (claimedEvent3) {
    const dedupeKey3 = `stripe:${claimedEvent3.pid}:reconcile`;
    const drainOutcomes3 = await drainAllJobs(runtime, `sb01-lr2d-reconcile-cancel-${RUN_TAG}`);
    console.log(`cancellation-phase job drain outcomes: ${JSON.stringify(drainOutcomes3)}`);
    const job3Final = await getOutboxJobByDedupeKey(dedupeKey3);
    record('cancellation reconcile job completed against real provider truth', job3Final?.status === 'completed',
      `status=${job3Final?.status ?? 'missing'}`);
    const reconcile3 = await getReconciliationRow(sub1.id);
    record('reconciliation_state reflects real canceled status, version incremented',
      reconcile3?.status === 'canceled' && reconcile3?.version === 2, `status=${reconcile3?.status} version=${reconcile3?.version}`);
    const sink3 = await getEntitlementSinkRow(ACCOUNT_MAIN);
    record('entitlement sink shows revoke transition with monotonically increasing version (2 > 1)',
      sink3?.transition_type === 'revoke' && sink3?.version === 2 && JSON.stringify(sink3?.entitlement_keys) === JSON.stringify([]),
      `type=${sink3?.transition_type} version=${sink3?.version} keys=${JSON.stringify(sink3?.entitlement_keys)}`);
  }

  // ---- Summary + cleanup -----------------------------------------------------
  const failed = results.filter((result) => !result.ok);
  console.log('=== SUMMARY ===');
  console.log(JSON.stringify({
    run_tag: RUN_TAG,
    total_checks: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    account_id: ACCOUNT_MAIN,
    provider_customer: maskId(providerCustomerId),
    subscriptions: createdSubscriptionIds.map((id) => maskId(id)),
  }, null, 2));
  for (const item of failed) console.log(`FAILED CHECK: ${item.name} :: ${item.detail}`);

  const cleanupCounts = await cleanup(createdSubscriptionIds, createdCustomerIds);
  console.log(`FINAL CLEANUP COUNTS: ${JSON.stringify(cleanupCounts)}`);
  cleanupDone = true;
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
