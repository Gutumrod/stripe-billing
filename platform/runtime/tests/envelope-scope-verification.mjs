// LR2F-A WU-G3 — envelope-scope verification probe (evidence runner, not a contract suite).
//
// Proves the four properties this repair is bounded by, over real HTTP against the real
// production code in ../dist (only the Postgres driver is substituted, as in the two contract
// suites):
//   1. the SHARED catch-all envelope of the request dispatcher returns exactly [error, message]
//      for a pre-existing route, including for a TYPED RETRYABLE error (503 + retryable=true on
//      the error object) — so `retryable` is never exposed from the shared envelope;
//   2. the Control read route still projects `retryable` on the wire at its own boundary
//      (DG-12), and the typed degraded 503 still returns retryable=true;
//   3. the failure log line still carries `retryable` (STAGE-B-READ-CONTRACT.md:627);
//   4. no product-wide read / accounts[] surface is introduced.
//
// Run: node tests/envelope-scope-verification.mjs   (after npm run build)

import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import {
  BillingDb,
  CentralBillingRuntime,
  createBillingHttpHandler,
  signAccountAssertion,
} from '../dist/index.js';
import { ProductBillingProfileRegistry } from '../../profile-registry/dist/src/registry.js';
import { ps01TestProfile } from '../../profile-registry/dist/profiles/PS01.test.js';

const PS01_PRODUCT_ID = ps01TestProfile.productId;
const CONTROL_READ_ROUTE = '/v1/billing/control/snapshot';
const CONTROL_READ_ACTION = 'control_billing_snapshot_read';
const ACCOUNT = 'acc_envelope_scope_01';
const ACCOUNT_UNKNOWN = 'acc_envelope_scope_unknown_01';

const TEST_KEY = ['sk', 'test', 'localSentinelNotACredential'].join('_');
const WEBHOOK_SECRET = ['whsec', 'localSentinelNotACredential'].join('_');
const ASSERTION_SECRET = 'ps01-envelope-probe-assertion-secret';
const CONTROL_TOKEN = 'wstera-envelope-probe-control-token-0001';
const PREEXISTING_TOKEN = 'wstera-envelope-probe-preexisting-token-0002';

const capturedLogs = [];

class ProbeDb extends BillingDb {
  constructor() {
    super('postgres://mock:5432/mock', 'billing_core_staging');
    this.rows = new Map();
  }
  key(environment, productId, accountId) { return `${environment}:${productId}:${accountId}`; }
  seed(environment, productId, accountId, row) { this.rows.set(this.key(environment, productId, accountId), { ...row }); }
  async ping() {}
  async close() {}
  async ensureCredentialBinding() {}
  async getSubscriptionState(environment, productId, accountId) {
    return this.rows.get(this.key(environment, productId, accountId)) ?? null;
  }
  async getEntitlementProjection() { return null; }
  // POST /v1/checkout: an operation row in `pending` state so the handler proceeds to the provider.
  async beginOperation(input) {
    return { id: crypto.randomUUID(), status: 'pending', correlationId: input.correlationId, responseProjection: null, providerObjectId: null };
  }
  async completeOperation() {}
  async failOperation() {}
  // POST /v1/checkout: a customer mapping that already holds a provider id, so the handler skips
  // customer creation and reaches the provider call — which this harness makes fail with a TYPED
  // RETRYABLE 503 (STRIPE_NETWORK_ERROR). That is the crux case: retryable=true on the error
  // object, retryable absent from the shared envelope, retryable present in the log line.
  async reserveCustomer(input) {
    return {
      id: crypto.randomUUID(),
      environment: input.environment,
      productId: input.productId,
      accountId: input.accountId,
      profileVersion: input.profileVersion,
      providerCustomerId: 'cus_probeEnvelopeMapping0001',
      state: 'ready',
      reservationToken: null,
    };
  }
  async completeCustomerReservation() {}
  async getCustomerByAccount(environment, productId, accountId) {
    return {
      id: crypto.randomUUID(), environment, productId, accountId, profileVersion: 1,
      providerCustomerId: 'cus_probeEnvelopeMapping0001', state: 'ready', reservationToken: null,
    };
  }
  async getCustomerByProviderId() { return null; }
  // POST /v1/portal: a TYPED RETRYABLE error (409, retryable=true) from inside the shared
  // envelope's coverage, so its wire body shape can be compared with the checkout case.
  async createPortalProbeFailure() { return null; }
  async audit() {}
}

function buildRuntime(overrides = {}) {
  const registry = new ProductBillingProfileRegistry();
  registry.register(ps01TestProfile);
  return new CentralBillingRuntime({
    environment: 'test',
    schema: 'billing_core_staging',
    admissionTestMode: true,
    databaseUrl: 'postgres://mock:5432/mock',
    stripeSecretKey: TEST_KEY,
    stripeWebhookSecret: WEBHOOK_SECRET,
    webhookMaxBytes: 1024 * 1024,
    credentials: [
      { keyId: 'probe-preexisting-key-01', token: PREEXISTING_TOKEN, productId: PS01_PRODUCT_ID, environment: 'test', profileVersion: 1, scopes: ['checkout', 'read', 'portal'] },
      { keyId: 'probe-control-key-01', token: CONTROL_TOKEN, productId: PS01_PRODUCT_ID, environment: 'test', profileVersion: 1, scopes: ['control_read'] },
    ],
    assertionKeys: [
      { keyId: 'probe-assertion-key-01', productId: PS01_PRODUCT_ID, environment: 'test', secret: ASSERTION_SECRET },
    ],
    returnUrls: {
      [PS01_PRODUCT_ID]: {
        success: { default: 'https://example.invalid/probe/success' },
        cancel: { default: 'https://example.invalid/probe/cancel' },
        portal: { default: 'https://example.invalid/probe/portal' },
      },
    },
    entitlementSigningKeys: [],
    profileRegistry: registry,
    logger: {
      info() {}, warn() {},
      error(event, details) { capturedLogs.push({ event, details }); },
    },
    fetch: async () => { throw new TypeError('probe: provider transport failure'); },
    db: overrides.db ?? new ProbeDb(),
    ...overrides.config,
  });
}

async function startServer(runtime) {
  const server = http.createServer(createBillingHttpHandler(runtime));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => { await new Promise((resolve) => server.close(resolve)); },
  };
}

async function assertion(input = {}) {
  const now = Math.floor(Date.now() / 1000);
  return signAccountAssertion({
    iss: PS01_PRODUCT_ID,
    aud: 'wstera-billing-core',
    key_id: 'probe-assertion-key-01',
    product_id: PS01_PRODUCT_ID,
    environment: 'test',
    account_id: input.account_id ?? ACCOUNT,
    action: input.action ?? CONTROL_READ_ACTION,
    operation_id: input.operation_id ?? 'op_probe_01',
    nonce: crypto.randomUUID(),
    iat: now,
    exp: now + 240,
  }, ASSERTION_SECRET);
}

async function request(baseUrl, options = {}) {
  const { method = 'GET', route = CONTROL_READ_ROUTE, query = '', token = CONTROL_TOKEN, assertion: signed = null, headers = {}, body = null } = options;
  const requestHeaders = { ...headers };
  if (token) requestHeaders.authorization = `Bearer ${token}`;
  if (signed) requestHeaders['x-wstera-account-assertion'] = signed;
  if (body !== null) requestHeaders['content-type'] = 'application/json';
  const res = await fetch(`${baseUrl}${route}${query}`, {
    method, headers: requestHeaders, ...(body !== null ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { status: res.status, text, body: parsed };
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name} :: ${detail}`);
}

// The types module is imported lazily inside ProbeDb.reserveCustomer via a global set below.
const typesModule = await import('../dist/types.js');
globalThis.__probeTypes = typesModule;
const { BillingRuntimeError } = typesModule;

// ---------------------------------------------------------------------------------------------
// 1. Pre-existing route, non-retryable typed error -> exactly [error, message]
// ---------------------------------------------------------------------------------------------
{
  const runtime = buildRuntime();
  const server = await startServer(runtime);
  try {
    // An authoritative x-wstera-* header is refused with a typed 400 on a pre-existing read route.
    const response = await request(server.baseUrl, {
      route: '/v1/subscription/status',
      query: `?account_id=${ACCOUNT}&operation_id=op_probe_preexisting_01`,
      token: PREEXISTING_TOKEN,
      headers: { 'x-wstera-product': 'caller-asserted' },
    });
    const keys = response.body ? Object.keys(response.body).sort() : null;
    record(
      'pre-existing route typed 400 -> keys exactly [error, message]',
      response.status === 400
        && response.body?.error === 'CALLER_AUTHORITY_OVERRIDE'
        && JSON.stringify(keys) === JSON.stringify(['error', 'message']),
      `status=${response.status} keys=${JSON.stringify(keys)} body=${response.text}`,
    );
  } finally {
    await server.close();
  }
}

// ---------------------------------------------------------------------------------------------
// 2. Pre-existing MUTATION route, TYPED RETRYABLE provider error (503) -> retryable still absent
//    This is the crux of the defect: the value is held on the error object and logged, and is NOT
//    returned by the shared envelope.
// ---------------------------------------------------------------------------------------------
{
  const runtime = buildRuntime();
  const server = await startServer(runtime);
  try {
    const response = await request(server.baseUrl, {
      method: 'POST',
      route: '/v1/checkout',
      token: PREEXISTING_TOKEN,
      assertion: await assertion({ action: 'checkout', operation_id: 'op_probe_checkout_01' }),
      body: {
        account_id: ACCOUNT,
        plan_id: 'founding-c2',
        operation_id: 'op_probe_checkout_01',
        success_return_ref: 'default',
        cancel_return_ref: 'default',
      },
    });
    const keys = response.body ? Object.keys(response.body).sort() : null;
    record(
      'POST /v1/checkout typed retryable 503 -> envelope keys exactly [error, message]',
      response.status === 503
        && response.body?.error === 'STRIPE_NETWORK_ERROR'
        && JSON.stringify(keys) === JSON.stringify(['error', 'message']),
      `status=${response.status} keys=${JSON.stringify(keys)} body=${response.text}`,
    );
    // The error object itself still carries retryable=true, and the log line still carries it.
    const log = capturedLogs.findLast((entry) => entry.event === 'billing.request.failed' && entry.details?.code === 'STRIPE_NETWORK_ERROR');
    record(
      'log line for that failure still carries retryable (contract requires it logged)',
      log !== undefined && log.details.retryable === true,
      `log=${JSON.stringify(log ?? null)}`,
    );
  } finally {
    await server.close();
  }
}

// ---------------------------------------------------------------------------------------------
// 3. Another pre-existing mutation route, TYPED RETRYABLE 503 -> same {error, message} envelope
// ---------------------------------------------------------------------------------------------
{
  const runtime = buildRuntime();
  const server = await startServer(runtime);
  try {
    const response = await request(server.baseUrl, {
      method: 'POST',
      route: '/v1/portal',
      token: PREEXISTING_TOKEN,
      assertion: await assertion({ action: 'portal', operation_id: 'op_probe_portal_01' }),
      body: { account_id: ACCOUNT, operation_id: 'op_probe_portal_01', return_ref: 'default' },
    });
    const keys = response.body ? Object.keys(response.body).sort() : null;
    record(
      'POST /v1/portal typed retryable 503 -> envelope keys exactly [error, message]',
      response.status === 503
        && response.body?.error === 'STRIPE_NETWORK_ERROR'
        && JSON.stringify(keys) === JSON.stringify(['error', 'message']),
      `status=${response.status} keys=${JSON.stringify(keys)} body=${response.text}`,
    );
  } finally {
    await server.close();
  }
}

// ---------------------------------------------------------------------------------------------
// 4. Webhook route error body shape unchanged -> keys exactly [error, message]
// ---------------------------------------------------------------------------------------------
{
  const runtime = buildRuntime();
  const server = await startServer(runtime);
  try {
    const response = await request(server.baseUrl, {
      method: 'POST', route: '/webhooks/stripe', token: null, body: { id: 'evt_probe', type: 'probe' },
    });
    const keys = response.body ? Object.keys(response.body).sort() : null;
    record(
      'POST /webhooks/stripe typed 400 -> envelope keys exactly [error, message]',
      response.status === 400
        && response.body?.error === 'WEBHOOK_SIGNATURE_REQUIRED'
        && JSON.stringify(keys) === JSON.stringify(['error', 'message']),
      `status=${response.status} keys=${JSON.stringify(keys)} body=${response.text}`,
    );
  } finally {
    await server.close();
  }
}

// ---------------------------------------------------------------------------------------------
// 5. Control read route: retryable IS projected at its own boundary
// ---------------------------------------------------------------------------------------------
{
  const db = new ProbeDb();
  db.seed('test', PS01_PRODUCT_ID, ACCOUNT, {
    profile_version: 1, plan_id: 'founding-c2', provider_subscription_id: 'sub_probeEnvelope0001',
    provider_status: 'active', amount_minor: 99000, currency: 'THB', cancel_at_period_end: false,
    reconciled_at: '2026-09-20T00:00:00.000Z', current_period_start: null, current_period_end: null,
    reconciliation_version: 1,
  });
  const runtime = buildRuntime({ db });
  await runtime.initialize();
  const server = await startServer(runtime);
  try {
    const ok = await request(server.baseUrl, {
      query: `?account_id=${ACCOUNT}&operation_id=op_probe_control_01`,
      assertion: await assertion({ operation_id: 'op_probe_control_01' }),
    });
    record(
      'control read 200 projects canExecutePaymentActions as the fixed literal false',
      ok.status === 200 && ok.body?.readiness?.canExecutePaymentActions === false
        && ok.body?.readiness?.canRead === true,
      `status=${ok.status} readiness=${JSON.stringify(ok.body?.readiness ?? null)}`,
    );

    const unknown = await request(server.baseUrl, {
      query: `?account_id=${ACCOUNT_UNKNOWN}&operation_id=op_probe_control_02`,
      assertion: await assertion({ account_id: ACCOUNT_UNKNOWN, operation_id: 'op_probe_control_02' }),
    });
    const unknownKeys = unknown.body ? Object.keys(unknown.body).sort() : null;
    record(
      'control read typed 404 carries retryable at the route boundary (R2-reviewed shape preserved)',
      unknown.status === 404
        && unknown.body?.error === 'CONTROL_READ_RESOURCE_NOT_FOUND'
        && JSON.stringify(unknownKeys) === JSON.stringify(['error', 'message', 'retryable'])
        && unknown.body?.retryable === false,
      `status=${unknown.status} keys=${JSON.stringify(unknownKeys)} body=${unknown.text}`,
    );

    // Product-wide read attempt must still be refused (no accounts[] surface).
    const productWide = await request(server.baseUrl, {
      query: `?account_id=${ACCOUNT}&operation_id=op_probe_control_03&accounts=all`,
      assertion: await assertion({ operation_id: 'op_probe_control_03' }),
    });
    record(
      'control read still refuses a product-wide read (no accounts[] surface)',
      productWide.status === 400 && productWide.body?.error === 'CALLER_AUTHORITY_OVERRIDE'
        && productWide.body !== null && !('accounts' in productWide.body)
        && JSON.stringify(Object.keys(productWide.body).sort())
           === JSON.stringify(['error', 'message', 'retryable']),
      `status=${productWide.status} keys=${JSON.stringify(productWide.body ? Object.keys(productWide.body).sort() : null)} body=${productWide.text}`,
    );
  } finally {
    await server.close();
  }
}

// ---------------------------------------------------------------------------------------------
// 6. Control read route: typed degraded dependency still 503 + retryable true (REAL unreachable DB)
// ---------------------------------------------------------------------------------------------
{
  const runtime = buildRuntime({ db: new BillingDb('postgres://local_user:local_pass@127.0.0.1:1/local_probe_db', 'billing_core_staging') });
  const server = await startServer(runtime);
  try {
    const response = await request(server.baseUrl, {
      query: `?account_id=${ACCOUNT}&operation_id=op_probe_control_degraded_01`,
      assertion: await assertion({ operation_id: 'op_probe_control_degraded_01' }),
    });
    record(
      'control read typed degraded dependency -> 503 with retryable true on the wire',
      response.status === 503
        && response.body?.error === 'CONTROL_READ_DEPENDENCY_DEGRADED'
        && response.body?.retryable === true,
      `status=${response.status} body=${response.text}`,
    );
    const log = capturedLogs.findLast((entry) => entry.event === 'billing.request.failed' && entry.details?.code === 'CONTROL_READ_DEPENDENCY_DEGRADED');
    record(
      'degraded failure log line carries retryable true',
      log !== undefined && log.details.retryable === true,
      `log=${JSON.stringify(log ?? null)}`,
    );
  } finally {
    await server.close();
  }
}

// ---------------------------------------------------------------------------------------------
// 7. Control read route: unexpected software error stays the untyped 500 INTERNAL_ERROR
// ---------------------------------------------------------------------------------------------
{
  class ExplodingDb extends ProbeDb {
    async getSubscriptionState() { throw new Error('probe: unexpected internal software failure'); }
  }
  const runtime = buildRuntime({ db: new ExplodingDb() });
  const server = await startServer(runtime);
  try {
    const response = await request(server.baseUrl, {
      query: `?account_id=${ACCOUNT}&operation_id=op_probe_control_explode_01`,
      assertion: await assertion({ operation_id: 'op_probe_control_explode_01' }),
    });
    record(
      'control read unexpected error -> 500 INTERNAL_ERROR, no internal detail leaked',
      response.status === 500 && response.body?.error === 'INTERNAL_ERROR'
        && !/unexpected internal software failure|at Object|\.ts:\d+/i.test(response.text),
      `status=${response.status} body=${response.text}`,
    );
  } finally {
    await server.close();
  }
}

// ---------------------------------------------------------------------------------------------
const failures = results.filter((entry) => !entry.ok);
console.log('');
console.log(`PROBE CHECKS: ${results.length}  failures: ${failures.length}`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  FAILED: ${failure.name} :: ${failure.detail}`);
}
process.exitCode = failures.length === 0 ? 0 : 1;

assert.ok(failures.length === 0);
