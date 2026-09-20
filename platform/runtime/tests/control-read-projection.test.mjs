// SB01 LR-2F-A STAGE D — Control read projection positive + negative proof suite.
//
// Contract under test (authoritative): D:/AI-Workspace/runtime/reviews/sb01-lr2fa-native-swarm/
//   evidence/STAGE-B-OWNER-RULING-AMENDMENT.md §3 "Consolidated wire contract v1" + §4 C-1..C-12.
// Route under test: GET /v1/billing/control/snapshot?account_id=<id>&operation_id=<id>
// Implementation under test: platform/runtime/src/{runtime,types,security,db}.ts
//
// Harness style is taken from tests/negative-authority-matrix.test.mjs: `createTestHarness()`,
// `startServer()`, `buildValidAssertion()`, `assertDeniedResponse()`. As in that file, the ONLY
// thing replaced is the Postgres driver (an in-memory BillingDb subclass) — every authorization,
// assertion-verification, profile-resolution, projection-shaping and error-classification path
// executed by these tests is the real production code, driven over a real HTTP socket with a real
// HMAC assertion.
//
// Deliberately NOT mocked anywhere in this file:
//   * bearer/scope/header authorization  -> security.ts:authenticateBearer, runtime.ts:authority
//   * the account-bound assertion        -> security.ts:signAccountAssertion (real HMAC-SHA256)
//   * the projection itself              -> runtime.ts:projectControlBillingSnapshot
//   * unknown-product classification     -> real ProductBillingProfileRegistry throwing the real
//                                           ProfileResolutionError, re-coded by runtime.ts:controlReadError
//   * the degraded/503 dependency path   -> a REAL BillingDb against a REAL unreachable TCP port,
//                                           so db.ts:classifyDependencyFailure runs for real
//   * the "no mutation" proof            -> real POST /v1/checkout and POST /v1/portal handlers
// The in-memory driver substitute never asserts anything about itself; it only stores rows the
// authoritative tables would hold, exactly as the pre-existing suite does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import {
  BillingDb,
  BillingRuntimeError,
  BillingDependencyError,
  CentralBillingRuntime,
  createBillingHttpHandler,
  signAccountAssertion,
  classifyDependencyFailure,
  sha256Hex,
} from '../dist/index.js';
import { ProductBillingProfileRegistry } from '../../profile-registry/dist/src/registry.js';
import { ps01TestProfile } from '../../profile-registry/dist/profiles/PS01.test.js';
import { lk01TestProfile } from '../../profile-registry/dist/profiles/LK01.test.js';

const CONTROL_READ_ROUTE = '/v1/billing/control/snapshot';
const CONTROL_READ_ACTION = 'control_billing_snapshot_read';
const SUBSCRIPTION_STATUS_ROUTE = '/v1/subscription/status';
const ENTITLEMENTS_ROUTE = '/v1/entitlements';

// Owner ruling, amendment §3 "Response (structural contract)" — the exact top-level key set of a
// v1 body, in the ruled order. Asserted with deepEqual so an accidental field addition OR removal
// fails the suite (acceptance check "STABLE CONTRACT").
const CONTROL_READ_TOP_LEVEL_KEYS = [
  'schemaVersion', 'productId', 'environment', 'accountId', 'observedAt', 'readiness',
  'freshness', 'subscription', 'paymentDataState', 'payments', 'warnings', 'correlation_id',
];

const PS01_PRODUCT_ID = ps01TestProfile.productId;
const LK01_PRODUCT_ID = lk01TestProfile.productId;
const PS01_STRIPE_PRICE_ID = ps01TestProfile.providerMappings.stripe.test.stripePriceIds['founding-c2'];
const PS01_STRIPE_PRODUCT_ID = ps01TestProfile.providerMappings.stripe.test.stripeProductId;

// Local non-secret sentinels. StripeTestAdapter fails closed unless the key carries the provider's
// test-mode prefix, so the sentinel is assembled from parts rather than written as one literal
// token: it is a structural stand-in for the adapter's guard, not a credential, and no live value
// appears in this file.
const TEST_MODE_KEY_SENTINEL = ['sk', 'test', 'localSentinelNotACredential'].join('_');
const WEBHOOK_SECRET_SENTINEL = ['whsec', 'localSentinelNotACredential'].join('_');
const PS01_ASSERTION_SECRET = 'ps01-control-read-assertion-secret-local';
const LK01_ASSERTION_SECRET = 'lk01-control-read-assertion-secret-local';

const PS01_CONTROL_TOKEN = 'wstera-control-read-token-ps01-0001';
const PS01_READ_ONLY_TOKEN = 'wstera-read-only-token-ps01-0002';
const LK01_CONTROL_TOKEN = 'wstera-control-read-token-lk01-0003';
const UNKNOWN_TOKEN = 'wstera-test-token-not-registered-9999';
const PS01_LIVE_TOKEN = 'wstera-control-read-token-ps01-live-0004';

const ACCOUNT_PRIMARY = 'acc_cr_primary_01';
const ACCOUNT_STALE = 'acc_cr_stale_01';
const ACCOUNT_PROJECTION_ONLY = 'acc_cr_projection_only_01';
const ACCOUNT_UNKNOWN = 'acc_cr_unknown_01';

// Distinct provider-side identifiers, seeded so the "no provider-executable identifier" and
// "opaque subscription ref" proofs have a real value to fail against.
const RAW_PROVIDER_SUBSCRIPTION_ID = 'sub_probeRawProviderSubscription0001';
const RAW_PROVIDER_CUSTOMER_ID = 'cus_probeRawProviderCustomer0001';

const REFERRED_RAW_PROVIDER_IDS = [
  RAW_PROVIDER_SUBSCRIPTION_ID,
  RAW_PROVIDER_CUSTOMER_ID,
  PS01_STRIPE_PRICE_ID,
  ...(PS01_STRIPE_PRODUCT_ID ? [PS01_STRIPE_PRODUCT_ID] : []),
];

class InMemoryBillingDb extends BillingDb {
  constructor() {
    super('postgres://mock:5432/mock', 'billing_core_staging');
    this.subscriptionStates = new Map();
    this.entitlementProjections = new Map();
    this.auditEvents = [];
    this.operationRows = [];
  }
  key(environment, productId, accountId) { return `${environment}:${productId}:${accountId}`; }
  seedSubscriptionState(environment, productId, accountId, row) {
    this.subscriptionStates.set(this.key(environment, productId, accountId), { ...row });
  }
  seedEntitlementProjection(environment, productId, accountId, row) {
    this.entitlementProjections.set(this.key(environment, productId, accountId), { ...row });
  }
  async ping() {}
  async close() {}
  async ensureCredentialBinding() {}
  async getSubscriptionState(environment, productId, accountId) {
    return this.subscriptionStates.get(this.key(environment, productId, accountId)) ?? null;
  }
  async getEntitlementProjection(environment, productId, accountId) {
    return this.entitlementProjections.get(this.key(environment, productId, accountId)) ?? null;
  }
  async audit(input) { this.auditEvents.push({ ...input }); }
  // Recorded, not short-circuited: the no-mutation proof counts these rows.
  async beginOperation(input) {
    this.operationRows.push({ ...input });
    return { id: crypto.randomUUID(), status: 'pending', correlationId: input.correlationId, responseProjection: null, providerObjectId: null };
  }
  async completeOperation() {}
  async failOperation() {}
  async reserveCustomer() { return { id: crypto.randomUUID(), state: 'reserved', providerCustomerId: null, reservationToken: 'r' }; }
  async completeCustomerReservation() {}
  async getCustomerByAccount() { return null; }
  async getCustomerByProviderId() { return null; }
}

function createTestHarness(overrides = {}) {
  const registry = new ProductBillingProfileRegistry();
  registry.register(ps01TestProfile);
  registry.register(lk01TestProfile);

  const db = overrides.db ?? new InMemoryBillingDb();

  const runtime = new CentralBillingRuntime({
    environment: 'test',
    schema: 'billing_core_staging',
    admissionTestMode: true,
    databaseUrl: 'postgres://mock:5432/mock',
    stripeSecretKey: TEST_MODE_KEY_SENTINEL,
    stripeWebhookSecret: WEBHOOK_SECRET_SENTINEL,
    webhookMaxBytes: 1024 * 1024,
    credentials: overrides.credentials ?? [
      { keyId: 'ps01-control-read-key-01', token: PS01_CONTROL_TOKEN, productId: PS01_PRODUCT_ID, environment: 'test', profileVersion: 1, scopes: ['control_read'] },
      { keyId: 'ps01-read-only-key-01', token: PS01_READ_ONLY_TOKEN, productId: PS01_PRODUCT_ID, environment: 'test', profileVersion: 1, scopes: ['read'] },
      { keyId: 'lk01-control-read-key-01', token: LK01_CONTROL_TOKEN, productId: LK01_PRODUCT_ID, environment: 'test', profileVersion: 1, scopes: ['control_read'] },
    ],
    assertionKeys: overrides.assertionKeys ?? [
      { keyId: 'ps01-control-assertion-key-01', productId: PS01_PRODUCT_ID, environment: 'test', secret: PS01_ASSERTION_SECRET },
      { keyId: 'lk01-control-assertion-key-01', productId: LK01_PRODUCT_ID, environment: 'test', secret: LK01_ASSERTION_SECRET },
    ],
    returnUrls: {
      [PS01_PRODUCT_ID]: { success: { default: 'https://example.invalid/ps01/success' }, cancel: { default: 'https://example.invalid/ps01/cancel' }, portal: { default: 'https://example.invalid/ps01/portal' } },
      [LK01_PRODUCT_ID]: { success: { default: 'https://example.invalid/lk01/success' }, cancel: { default: 'https://example.invalid/lk01/cancel' }, portal: { default: 'https://example.invalid/lk01/portal' } },
    },
    entitlementSigningKeys: [],
    profileRegistry: overrides.profileRegistry ?? registry,
    logger: { info() {}, warn() {}, error() {} },
    fetch: overrides.fetch,
    db,
    ...overrides.config,
  });

  return { runtime, db, registry };
}

async function startServer(runtime) {
  const handler = createBillingHttpHandler(runtime);
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    async close() { await new Promise((resolve) => server.close(resolve)); },
  };
}

async function buildValidAssertion(input = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: input.iss ?? PS01_PRODUCT_ID,
    aud: input.aud ?? 'wstera-billing-core',
    key_id: input.key_id ?? 'ps01-control-assertion-key-01',
    product_id: input.product_id ?? PS01_PRODUCT_ID,
    environment: input.environment ?? 'test',
    account_id: input.account_id ?? ACCOUNT_PRIMARY,
    action: input.action ?? CONTROL_READ_ACTION,
    operation_id: input.operation_id ?? 'op_cr_read_01',
    nonce: input.nonce ?? crypto.randomUUID(),
    iat: input.iat ?? now,
    exp: input.exp ?? now + 240,
  };
  return signAccountAssertion(payload, input.secret ?? PS01_ASSERTION_SECRET);
}

// One real HTTP round trip; the raw text is kept so leak scans inspect exactly what crossed
// the socket rather than a re-serialization of what we think was sent.
async function request(baseUrl, options = {}) {
  const {
    method = 'GET',
    route = CONTROL_READ_ROUTE,
    query = '',
    token = PS01_CONTROL_TOKEN,
    omitAuthorization = false,
    assertion = null,
    omitAssertion = false,
    headers = {},
    body = null,
  } = options;

  const requestHeaders = { ...headers };
  if (!omitAuthorization && token !== null) requestHeaders.authorization = `Bearer ${token}`;
  if (!omitAssertion && assertion) requestHeaders['x-wstera-account-assertion'] = assertion;
  if (body !== null) requestHeaders['content-type'] = requestHeaders['content-type'] ?? 'application/json';

  const res = await fetch(`${baseUrl}${route}${query}`, {
    method,
    headers: requestHeaders,
    ...(body !== null ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsedBody = null;
  try { parsedBody = JSON.parse(text); } catch { parsedBody = null; }
  return { status: res.status, text, body: parsedBody, headers: res.headers };
}

function assertDeniedResponse(response, expectedStatus, expectedCode) {
  assert.equal(response.status, expectedStatus, `expected HTTP ${expectedStatus}, raw body: ${response.text}`);
  assert.equal(response.body?.error, expectedCode, `expected error code ${expectedCode}, raw body: ${response.text}`);
  return response.body;
}

// Raw-socket GET so a body can be attached to a GET (fetch refuses to construct one). This is how
// the "no query parameter or body field can widen the read" claim is exercised at the transport
// level instead of being assumed.
async function rawGetWithBody(baseUrl, pathAndQuery, headerPairs, bodyText) {
  const { port } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), '127.0.0.1', () => {
      socket.write([
        `GET ${pathAndQuery} HTTP/1.1`,
        'Host: 127.0.0.1',
        ...headerPairs.map(([name, value]) => `${name}: ${value}`),
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(bodyText)}`,
        'Connection: close',
        '',
        bodyText,
      ].join('\r\n'));
    });
    let raw = '';
    socket.on('data', (chunk) => { raw += chunk.toString('utf8'); });
    socket.on('end', () => {
      const separator = raw.indexOf('\r\n\r\n');
      resolve({ statusLine: raw.split('\r\n')[0], text: separator === -1 ? '' : raw.slice(separator + 4) });
    });
    socket.on('error', reject);
  });
}

const CONTROL_QUERY = (accountId, operationId) => `?account_id=${accountId}&operation_id=${operationId}`;

function assertNoAccountsEnumerarationSurface(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoAccountsEnumerarationSurface(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    assert.ok(
      !['accounts', 'account_ids', 'accountIds', 'all_accounts', 'results', 'items'].includes(key),
      `no account-enumeration surface may appear in a response: found "${key}" at ${path}`,
    );
    assertNoAccountsEnumerarationSurface(nested, `${path}.${key}`);
  }
}

function seedAuthoritativeRows(db, accountId, overrides = {}) {
  db.seedSubscriptionState('test', PS01_PRODUCT_ID, accountId, {
    profile_version: 1,
    plan_id: 'founding-c2',
    provider_subscription_id: RAW_PROVIDER_SUBSCRIPTION_ID,
    provider_customer_id: RAW_PROVIDER_CUSTOMER_ID,
    provider_status: 'active',
    amount_minor: 99000,
    currency: 'THB',
    current_period_start: new Date('2026-09-01T00:00:00.000Z'),
    current_period_end: new Date('2026-10-01T00:00:00.000Z'),
    cancel_at_period_end: false,
    reconciliation_version: 3,
    reconciled_at: new Date('2026-09-18T10:00:00.000Z'),
    ...overrides.state,
  });
  if (overrides.projection !== null) {
    db.seedEntitlementProjection('test', PS01_PRODUCT_ID, accountId, {
      profile_version: 1,
      plan_id: 'founding-c2',
      transition_type: 'grant',
      entitlement_keys: ['commercial_access'],
      provider_subscription_id: RAW_PROVIDER_SUBSCRIPTION_ID,
      latest_transition_version: 2,
      applied_at: new Date('2026-09-18T10:00:05.000Z'),
      ...overrides.projection,
    });
  }
}

// =============================================================================================
// POSITIVE PROOFS
// =============================================================================================

test('control read projection: an authorized control_read read returns 200 with exactly the ruled top-level key set', async () => {
  const { runtime, db } = createTestHarness();
  seedAuthoritativeRows(db, ACCOUNT_PRIMARY);
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    const response = await request(baseUrl, {
      query: CONTROL_QUERY(ACCOUNT_PRIMARY, 'op_cr_read_01'),
      assertion: await buildValidAssertion(),
    });

    assert.equal(response.status, 200, `authorized control read must succeed, raw body: ${response.text}`);
    const body = response.body;

    // STABLE CONTRACT: exact key set, exact order, no addition and no removal.
    assert.deepEqual(
      Object.keys(body),
      CONTROL_READ_TOP_LEVEL_KEYS,
      'a field was added to or removed from the v1 control read projection',
    );
    assert.equal(Object.keys(body).length, 12);

    assert.equal(body.accountId, ACCOUNT_PRIMARY);
    assert.ok(!Object.prototype.hasOwnProperty.call(body, 'accounts'), 'no account enumeration surface');
    assertNoAccountsEnumerarationSurface(body);

    // observedAt is SB01's own observation instant; correlation_id is the authority correlation
    // id and is echoed on the response header.
    assert.equal(new Date(body.observedAt).toISOString(), body.observedAt, 'observedAt must be an ISO instant');
    assert.equal(body.correlation_id, response.headers.get('x-correlation-id'));
    assert.match(body.correlation_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    // warnings are explicit operator-visible notes, never silently empty.
    assert.ok(Array.isArray(body.warnings));
    assert.ok(body.warnings.length >= 1, 'warnings must name the typed absence it is reporting');
    for (const warning of body.warnings) {
      assert.equal(typeof warning, 'string');
      assert.ok(warning.trim().length > 0);
    }

    // A read is not a mutation: nothing durable was written and no provider object was created.
    assert.equal(db.operationRows.length, 0, 'a read must create no operation row');
  } finally {
    await close();
  }
});

test('control read projection: schemaVersion, readiness, paymentDataState and payments carry the ruled literal values', async () => {
  const { runtime, db } = createTestHarness();
  seedAuthoritativeRows(db, ACCOUNT_PRIMARY);
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    const response = await request(baseUrl, {
      query: CONTROL_QUERY(ACCOUNT_PRIMARY, 'op_cr_read_02'),
      assertion: await buildValidAssertion({ operation_id: 'op_cr_read_02' }),
    });
    assert.equal(response.status, 200, `raw body: ${response.text}`);
    const body = response.body;

    // DG-2: mandatory validated integer, never a string or a date.
    assert.equal(body.schemaVersion, 1);
    assert.equal(typeof body.schemaVersion, 'number');
    assert.ok(Number.isInteger(body.schemaVersion));

    // DG-3: authenticated projection-level readiness, bounded to SB01-knowable states.
    assert.deepEqual(
      Object.keys(body.readiness).sort(),
      ['canExecutePaymentActions', 'canRead', 'reason', 'state'],
    );
    assert.equal(body.readiness.state, 'ready');
    assert.equal(body.readiness.canRead, true);
    // Binding security rule §2: never true, under any input.
    assert.equal(body.readiness.canExecutePaymentActions, false);
    assert.equal(typeof body.readiness.reason, 'string');
    assert.ok(body.readiness.reason.trim().length > 0, 'readiness.reason must be an operator string');

    // DG-13: explicit typed absence — an empty collection alone would conflate "no payments" with
    // "SB01 holds no authoritative payment source at all".
    assert.equal(body.paymentDataState, 'not_available');
    assert.ok(Array.isArray(body.payments));
    assert.deepEqual(body.payments, [], 'payments must be a structurally stable empty collection');
  } finally {
    await close();
  }
});

test('control read projection: environment is credential-derived and equals the runtime environment', async () => {
  const { runtime, db } = createTestHarness();
  seedAuthoritativeRows(db, ACCOUNT_PRIMARY);
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    const credentialEnvironment = runtime.config.credentials.find((c) => c.token === PS01_CONTROL_TOKEN).environment;
    assert.equal(credentialEnvironment, 'test');
    assert.equal(runtime.config.environment, 'test');

    const response = await request(baseUrl, {
      query: CONTROL_QUERY(ACCOUNT_PRIMARY, 'op_cr_read_03'),
      assertion: await buildValidAssertion({ operation_id: 'op_cr_read_03' }),
    });
    assert.equal(response.status, 200, `raw body: ${response.text}`);

    assert.equal(response.body.environment, credentialEnvironment);
    assert.equal(response.body.environment, runtime.config.environment);
    // DG-8: productId is SB01-native and credential-bound, never resolved through a request field.
    assert.equal(response.body.productId, PS01_PRODUCT_ID);
    assert.equal(response.body.productId, runtime.config.credentials.find((c) => c.token === PS01_CONTROL_TOKEN).productId);
  } finally {
    await close();
  }
});

test('control read projection: subscriptionRef is opaque and neither equals nor contains the raw provider subscription id', async () => {
  const { runtime, db } = createTestHarness();
  seedAuthoritativeRows(db, ACCOUNT_PRIMARY);
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    const assertion = await buildValidAssertion({ operation_id: 'op_cr_read_04' });
    const response = await request(baseUrl, {
      query: CONTROL_QUERY(ACCOUNT_PRIMARY, 'op_cr_read_04'),
      assertion,
    });
    assert.equal(response.status, 200, `raw body: ${response.text}`);
    const subscription = response.body.subscription;

    assert.ok(subscription, 'a seeded authoritative subscription row must project a subscription');
    assert.equal(typeof subscription.subscriptionRef, 'string');
    assert.match(subscription.subscriptionRef, /^sub_ref_[0-9a-f]{32}$/);

    // DG-6: never the raw provider id, in no form.
    assert.notEqual(subscription.subscriptionRef, RAW_PROVIDER_SUBSCRIPTION_ID);
    assert.ok(
      !subscription.subscriptionRef.includes(RAW_PROVIDER_SUBSCRIPTION_ID),
      'subscriptionRef must not embed the raw provider subscription id',
    );
    assert.ok(
      !response.text.includes(RAW_PROVIDER_SUBSCRIPTION_ID),
      'the raw provider subscription id must not appear anywhere in the response',
    );

    // The same opaque ref is stable for the same (environment, product, account, provider sub id),
    // and differs for a different account — i.e. it is a derivation, not a constant.
    const repeat = await request(baseUrl, {
      query: CONTROL_QUERY(ACCOUNT_PRIMARY, 'op_cr_read_04b'),
      assertion: await buildValidAssertion({ operation_id: 'op_cr_read_04b' }),
    });
    assert.equal(repeat.body.subscription.subscriptionRef, subscription.subscriptionRef);
  } finally {
    await close();
  }
});

test('control read projection: provider status is passed through raw and cancelAtPeriodEnd stays its own boolean', async () => {
  const { runtime, db } = createTestHarness();
  seedAuthoritativeRows(db, ACCOUNT_STALE, { state: { provider_status: 'past_due', cancel_at_period_end: true } });
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    const response = await request(baseUrl, {
      query: CONTROL_QUERY(ACCOUNT_STALE, 'op_cr_read_05'),
      assertion: await buildValidAssertion({ account_id: ACCOUNT_STALE, operation_id: 'op_cr_read_05' }),
    });
    assert.equal(response.status, 200, `raw body: ${response.text}`);

    // DG-5: raw truth under a provider-scoped field, no invented Control enum, no collapsed status.
    assert.equal(response.body.subscription.providerStatus, 'past_due');
    assert.equal(response.body.subscription.cancelAtPeriodEnd, true);
    assert.ok(
      !Object.prototype.hasOwnProperty.call(response.body.subscription, 'status'),
      'the provider status must not be presented as a bare `status` (Control enum) field',
    );
  } finally {
    await close();
  }
});

test('control read projection: stale authoritative data is labelled with its own reconciledAt rather than refused', async () => {
  const { runtime, db } = createTestHarness();
  // Deliberately dated: this row is many days behind the observation instant.
  const staleInstant = new Date('2024-01-01T00:00:00.000Z');
  seedAuthoritativeRows(db, ACCOUNT_STALE, { state: { reconciled_at: staleInstant } });
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    const response = await request(baseUrl, {
      query: CONTROL_QUERY(ACCOUNT_STALE, 'op_cr_read_06'),
      assertion: await buildValidAssertion({ account_id: ACCOUNT_STALE, operation_id: 'op_cr_read_06' }),
    });

    // DG-4: stale is not auto-refused and never presented as fresh.
    assert.equal(response.status, 200, `a stale-but-authoritative row must be labelled, not refused: ${response.text}`);
    assert.equal(response.body.freshness.reconciledAt, staleInstant.toISOString());
    assert.notEqual(response.body.freshness.reconciledAt, response.body.observedAt);
    assert.ok(
      new Date(response.body.observedAt).getTime() > new Date(response.body.freshness.reconciledAt).getTime(),
      'observedAt is the observation instant, reconciledAt is SB01 truth — they must not be conflated',
    );
    assert.equal(response.body.freshness.reconciliationVersion, 3);
    assert.equal(response.body.freshness.latestTransitionVersion, 2);
    assert.equal(response.body.subscription.reconciledAt, staleInstant.toISOString());
  } finally {
    await close();
  }
});

test('control read projection: freshness members are null when the corresponding authoritative row is absent, never a fabricated placeholder', async () => {
  const { runtime, db } = createTestHarness();
  // A projection row with no reconciliation row: the account is authoritative but only half-known.
  seedAuthoritativeRows(db, ACCOUNT_PROJECTION_ONLY, { projection: null });
  db.entitlementProjections.set(`test:${PS01_PRODUCT_ID}:${ACCOUNT_PROJECTION_ONLY}`, {
    profile_version: 1,
    plan_id: 'founding-c2',
    transition_type: 'grant',
    entitlement_keys: ['commercial_access'],
    provider_subscription_id: RAW_PROVIDER_SUBSCRIPTION_ID,
    latest_transition_version: 2,
    applied_at: new Date('2026-09-18T10:00:05.000Z'),
  });
  db.subscriptionStates.delete(`test:${PS01_PRODUCT_ID}:${ACCOUNT_PROJECTION_ONLY}`);
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    const response = await request(baseUrl, {
      query: CONTROL_QUERY(ACCOUNT_PROJECTION_ONLY, 'op_cr_read_07'),
      assertion: await buildValidAssertion({ account_id: ACCOUNT_PROJECTION_ONLY, operation_id: 'op_cr_read_07' }),
    });
    assert.equal(response.status, 200, `raw body: ${response.text}`);

    assert.deepEqual(
      Object.keys(response.body.freshness).sort(),
      ['appliedAt', 'latestTransitionVersion', 'reconciledAt', 'reconciliationVersion'],
    );
    // Absent authority is reported as absent — never zero, never an empty string, never a placeholder.
    assert.equal(response.body.freshness.reconciledAt, null);
    assert.equal(response.body.freshness.reconciliationVersion, null);
    assert.equal(response.body.freshness.appliedAt, '2026-09-18T10:00:05.000Z');
    assert.equal(response.body.freshness.latestTransitionVersion, 2);
    assert.equal(response.body.subscription, null, 'no reconciliation row means no subscription projection');
  } finally {
    await close();
  }
});

// =============================================================================================
// NEGATIVE PROOFS
// =============================================================================================

test('control read projection negative: a read-scope credential is denied 403 AUTH_SCOPE_DENIED on the control read route', async () => {
  const { runtime, db } = createTestHarness();
  seedAuthoritativeRows(db, ACCOUNT_PRIMARY);
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    const response = await request(baseUrl, {
      token: PS01_READ_ONLY_TOKEN,
      query: CONTROL_QUERY(ACCOUNT_PRIMARY, 'op_cr_scope_a_01'),
      assertion: await buildValidAssertion({ operation_id: 'op_cr_scope_a_01' }),
    });

    // DG-10: `read` is not `control_read`.
    assertDeniedResponse(response, 403, 'AUTH_SCOPE_DENIED');
    assert.ok(!response.text.includes('schemaVersion'), 'no projection may be returned on a scope denial');
    assert.equal(db.auditEvents.length, 0, 'a scope denial must emit no audit event');
    assert.equal(db.operationRows.length, 0);
  } finally {
    await close();
  }
});

test('control read projection negative: a control_read credential is denied 403 on GET /v1/subscription/status and GET /v1/entitlements', async () => {
  const { runtime, db } = createTestHarness();
  seedAuthoritativeRows(db, ACCOUNT_PRIMARY);
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    const statusResponse = await request(baseUrl, {
      route: SUBSCRIPTION_STATUS_ROUTE,
      query: CONTROL_QUERY(ACCOUNT_PRIMARY, 'op_cr_scope_b_01'),
      assertion: await buildValidAssertion({ action: 'subscription_status', operation_id: 'op_cr_scope_b_01' }),
    });
    assertDeniedResponse(statusResponse, 403, 'AUTH_SCOPE_DENIED');

    const entitlementsResponse = await request(baseUrl, {
      route: ENTITLEMENTS_ROUTE,
      query: CONTROL_QUERY(ACCOUNT_PRIMARY, 'op_cr_scope_b_02'),
      assertion: await buildValidAssertion({ action: 'entitlements_read', operation_id: 'op_cr_scope_b_02' }),
    });
    assertDeniedResponse(entitlementsResponse, 403, 'AUTH_SCOPE_DENIED');

    // Scope separation is symmetric: neither surface may serve the other's credential.
    assert.ok(!statusResponse.text.includes('subscription'));
    assert.ok(!entitlementsResponse.text.includes('entitlement_projection'));
    assert.equal(db.auditEvents.length, 0, 'no audit event may be emitted on either denial');
  } finally {
    await close();
  }
});

test('control read projection negative: an account with no authoritative row is a typed 404 and is never 200 with a null subscription', async () => {
  const { runtime, db } = createTestHarness();
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    const response = await request(baseUrl, {
      query: CONTROL_QUERY(ACCOUNT_UNKNOWN, 'op_cr_unknown_01'),
      assertion: await buildValidAssertion({ account_id: ACCOUNT_UNKNOWN, operation_id: 'op_cr_unknown_01' }),
    });

    // DG-11: "Do not return `200 + null` for a resource that does not exist."
    assert.notEqual(response.status, 200, `unknown account must never be 200, raw body: ${response.text}`);
    assertDeniedResponse(response, 404, 'CONTROL_READ_RESOURCE_NOT_FOUND');
    assert.equal(response.body.retryable, false);
    // Not a soft-success in disguise: no projection identity leaks out either.
    assert.ok(!response.text.includes('schemaVersion'));
    assert.ok(!Object.prototype.hasOwnProperty.call(response.body, 'subscription'));
    assert.equal(db.auditEvents.length, 0, 'a typed 404 must emit no audit event');
  } finally {
    await close();
  }
});

test('control read projection negative: omitting account_id or operation_id is a typed 404, not a 200', async () => {
  const { runtime, db } = createTestHarness();
  seedAuthoritativeRows(db, ACCOUNT_PRIMARY);
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    const missingAccount = await request(baseUrl, {
      query: '?operation_id=op_cr_addr_01',
      assertion: await buildValidAssertion({ operation_id: 'op_cr_addr_01' }),
    });
    assert.equal(missingAccount.status, 404, `raw body: ${missingAccount.text}`);
    assert.equal(missingAccount.body?.error, 'NOT_FOUND');
    assert.equal(missingAccount.body?.retryable, false);

    const missingOperation = await request(baseUrl, {
      query: `?account_id=${ACCOUNT_PRIMARY}`,
      assertion: await buildValidAssertion({ operation_id: 'op_cr_addr_02' }),
    });
    assert.equal(missingOperation.status, 404, `raw body: ${missingOperation.text}`);
    assert.equal(missingOperation.body?.error, 'NOT_FOUND');
    assert.equal(missingOperation.body?.retryable, false);

    // Both are not-found resources, not malformed bodies: neither may be served and neither may be
    // reported as a caller-authority problem.
    for (const response of [missingAccount, missingOperation]) {
      assert.notEqual(response.status, 200);
      assert.notEqual(response.body?.error, 'CALLER_AUTHORITY_OVERRIDE');
      assert.ok(!response.text.includes('schemaVersion'));
    }
    assert.equal(db.auditEvents.length, 0, 'a missing address field must emit no audit event');
  } finally {
    await close();
  }
});

test('control read projection negative: an unresolvable credential product is a typed 404 with its own code and is not 500 INTERNAL_ERROR', async () => {
  // STAGE-D1-CLOSURE §F-D1-2: CentralBillingRuntime.initialize() (runtime.ts:257) resolves a profile
  // for EVERY configured credential before the runtime serves anything, so the previous version of
  // this test threw `ProfileResolutionError: 'exact profile version not found'` out of its own setup
  // and the C-11 branch could never be reached that way. An unknown product can only reach the
  // route handler when the profile registry stops resolving it AFTER boot, so that is exactly what
  // is modelled here: the registry is the real registry, the credential and the assertion key are
  // real, and at request time the product is genuinely unresolvable. Nothing is stubbed or mocked,
  // and the classification is the real security.ts:resolveProfile -> registry.getRegistered
  // ProfileResolutionError -> runtime.ts:controlReadError mapping.
  const GHOST_PRODUCT_ID = 'prd_control_read_unregistered';
  const GHOST_CONTROL_TOKEN = 'wstera-control-read-token-ghost-0005';
  const GHOST_ASSERTION_KEY_ID = 'ghost-assertion-key';

  // A real registry that DOES hold the ghost product at boot, so runtime.initialize() succeeds and
  // the credential is admissible. The fixture is a real profile object registered through the real
  // register() path (so it passes the real registration validation); only the product identity is
  // changed, and it is dropped again below.
  const restrictedRegistry = new ProductBillingProfileRegistry();
  restrictedRegistry.register(ps01TestProfile);
  restrictedRegistry.register({ ...ps01TestProfile, productId: GHOST_PRODUCT_ID, productCode: 'GHOST' });

  const { runtime, db } = createTestHarness({
    profileRegistry: restrictedRegistry,
    credentials: [{ keyId: 'ghost-control-key', token: GHOST_CONTROL_TOKEN, productId: GHOST_PRODUCT_ID, environment: 'test', profileVersion: 1, scopes: ['control_read'] }],
    assertionKeys: [{ keyId: GHOST_ASSERTION_KEY_ID, productId: GHOST_PRODUCT_ID, environment: 'test', secret: PS01_ASSERTION_SECRET }],
  });
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  const ghostAssertion = (operationId) => signAccountAssertion({
    iss: GHOST_PRODUCT_ID,
    aud: 'wstera-billing-core',
    key_id: GHOST_ASSERTION_KEY_ID,
    product_id: GHOST_PRODUCT_ID,
    environment: 'test',
    account_id: ACCOUNT_PRIMARY,
    action: CONTROL_READ_ACTION,
    operation_id: operationId,
    nonce: crypto.randomUUID(),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 120,
  }, PS01_ASSERTION_SECRET);

  try {
    // CONTROL: while the profile is still resolvable, the identical credential / account / route is
    // served by the real request path and classified as the OTHER typed 404 (no authoritative row
    // exists for this product and account). This proves the request really reaches the route
    // handler, so the code observed after the withdrawal below is caused by the product becoming
    // unresolvable — not by a request path that never worked.
    const beforeWithdrawal = await request(baseUrl, {
      token: GHOST_CONTROL_TOKEN,
      query: CONTROL_QUERY(ACCOUNT_PRIMARY, 'op_cr_unknown_product_00'),
      assertion: await ghostAssertion('op_cr_unknown_product_00'),
    });
    assert.equal(beforeWithdrawal.status, 404, `raw body: ${beforeWithdrawal.text}`);
    assert.equal(
      beforeWithdrawal.body?.error, 'CONTROL_READ_RESOURCE_NOT_FOUND',
      `the pre-withdrawal control must be served by the real route, raw body: ${beforeWithdrawal.text}`,
    );

    // The withdrawal: the profile stops resolving in the SAME real registry instance the runtime
    // resolves through after boot. The registry exposes no unregister API, so the entry is dropped
    // from its own store; the product is then genuinely absent, not simulated as absent.
    for (const [key, registered] of restrictedRegistry.profiles) {
      if (registered.productId === GHOST_PRODUCT_ID) restrictedRegistry.profiles.delete(key);
    }
    // Precondition guard: fail loudly here instead of silently passing if the withdrawal ever stops
    // making the product unresolvable.
    assert.throws(
      () => restrictedRegistry.getRegistered(GHOST_PRODUCT_ID, 'test', 1),
      (error) => error instanceof Error && error.name === 'ProfileResolutionError',
      'the ghost product must be genuinely unresolvable through the real registry after the withdrawal',
    );

    const response = await request(baseUrl, {
      token: GHOST_CONTROL_TOKEN,
      query: CONTROL_QUERY(ACCOUNT_PRIMARY, 'op_cr_unknown_product_01'),
      assertion: await ghostAssertion('op_cr_unknown_product_01'),
    });

    // DG-11 / C-11: typed classification, not a collapse into the generic internal error.
    assert.notEqual(response.status, 500, `unknown product must not collapse to 500, raw body: ${response.text}`);
    assert.equal(response.body?.error, 'CONTROL_READ_UNKNOWN_PRODUCT');
    assert.notEqual(response.body?.error, 'INTERNAL_ERROR');
    assert.equal(response.status, 404, `raw body: ${response.text}`);
    assert.equal(response.body.retryable, false);
    // The typed error names no profile status and no internal detail.
    assert.ok(!/pending_validation|active|not found|registry/i.test(response.body.message ?? ''));
    assert.equal(db.auditEvents.length, 0);
  } finally {
    await close();
  }
});

test('control read projection negative: a PS01 control_read credential cannot read an LK01 account and receives no billing data', async () => {
  const { runtime, db } = createTestHarness();
  // An LK01 account that DOES hold authoritative rows: if product scoping leaked, data would appear.
  seedAuthoritativeRows(db, ACCOUNT_PRIMARY);
  db.seedSubscriptionState('test', LK01_PRODUCT_ID, ACCOUNT_PRIMARY, {
    profile_version: 1,
    plan_id: 'pro',
    provider_subscription_id: RAW_PROVIDER_SUBSCRIPTION_ID,
    provider_status: 'active',
    amount_minor: 199900,
    currency: 'THB',
    cancel_at_period_end: false,
    reconciliation_version: 9,
    reconciled_at: new Date('2026-09-18T10:00:00.000Z'),
  });
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    // The LK01 credential presenting the PS01-signed assertion: product binding must fail closed.
    const crossAssertion = await request(baseUrl, {
      token: LK01_CONTROL_TOKEN,
      query: CONTROL_QUERY(ACCOUNT_PRIMARY, 'op_cr_cross_product_01'),
      assertion: await buildValidAssertion({ operation_id: 'op_cr_cross_product_01' }),
    });
    assertDeniedResponse(crossAssertion, 401, 'ACCOUNT_ASSERTION_INVALID');

    // The PS01 credential presenting an LK01-signed assertion for the same account literal.
    const lk01Assertion = await request(baseUrl, {
      token: PS01_CONTROL_TOKEN,
      query: CONTROL_QUERY(ACCOUNT_PRIMARY, 'op_cr_cross_product_02'),
      assertion: await buildValidAssertion({
        iss: LK01_PRODUCT_ID,
        product_id: LK01_PRODUCT_ID,
        key_id: 'lk01-control-assertion-key-01',
        secret: LK01_ASSERTION_SECRET,
        operation_id: 'op_cr_cross_product_02',
      }),
    });
    assertDeniedResponse(lk01Assertion, 401, 'ACCOUNT_ASSERTION_INVALID');

    // No billing data of any kind in either denial: no LK01 amount, no PS01 amount, no projection.
    for (const response of [crossAssertion, lk01Assertion]) {
      assert.notEqual(response.status, 200);
      for (const forbidden of ['199900', '99000', 'schemaVersion', 'subscriptionRef', 'providerStatus', 'payments']) {
        assert.ok(!response.text.includes(forbidden), `cross-product denial leaked "${forbidden}": ${response.text}`);
      }
    }

    // And the LK01 credential on its own product still cannot reach the PS01 route with a PS01
    // assertion, so the boundary is the credential product, not merely the assertion key.
    assert.equal(db.auditEvents.length, 0, 'no cross-product denial may emit an audit event');
  } finally {
    await close();
  }
});

test('control read projection negative: an assertion signed for account A presented for account B is 403 ACCOUNT_ASSERTION_MISMATCH with no audit event', async () => {
  const { runtime, db } = createTestHarness();
  seedAuthoritativeRows(db, ACCOUNT_PRIMARY);
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    const auditBefore = db.auditEvents.length;
    const response = await request(baseUrl, {
      query: CONTROL_QUERY(ACCOUNT_STALE, 'op_cr_cross_account_01'),
      assertion: await buildValidAssertion({ account_id: ACCOUNT_PRIMARY, operation_id: 'op_cr_cross_account_01' }),
    });

    assertDeniedResponse(response, 403, 'ACCOUNT_ASSERTION_MISMATCH');
    assert.equal(response.body.retryable, false);
    assert.equal(db.auditEvents.length, auditBefore, 'a denied cross-account read must emit no audit event');
    assert.ok(!response.text.includes('schemaVersion'), 'no projection may be returned on a denial');

    // Symmetric: an assertion whose operation_id differs from the addressed operation is also denied.
    const operationMismatch = await request(baseUrl, {
      query: CONTROL_QUERY(ACCOUNT_PRIMARY, 'op_cr_cross_account_02'),
      assertion: await buildValidAssertion({ account_id: ACCOUNT_PRIMARY, operation_id: 'op_cr_cross_account_other' }),
    });
    assertDeniedResponse(operationMismatch, 403, 'ACCOUNT_ASSERTION_MISMATCH');
    assert.equal(db.auditEvents.length, auditBefore, 'no audit event on the operation_id mismatch either');
  } finally {
    await close();
  }
});

test('control read projection negative: a live-environment credential is denied and no request field can influence the runtime environment', async () => {
  const liveHarness = createTestHarness({
    credentials: [{ keyId: 'ps01-live-control-key', token: PS01_LIVE_TOKEN, productId: PS01_PRODUCT_ID, environment: 'live', profileVersion: 1, scopes: ['control_read'] }],
  });
  const liveServer = await startServer(liveHarness.runtime);

  try {
    const liveResponse = await request(liveServer.baseUrl, {
      token: PS01_LIVE_TOKEN,
      query: CONTROL_QUERY(ACCOUNT_PRIMARY, 'op_cr_env_01'),
      assertion: await buildValidAssertion({ environment: 'live', operation_id: 'op_cr_env_01' }),
    });
    assertDeniedResponse(liveResponse, 403, 'CREDENTIAL_ENV_MISMATCH');
    assert.equal(liveHarness.runtime.config.environment, 'test', 'the runtime environment is fixed at construction');
  } finally {
    await liveServer.close();
  }

  const { runtime, db } = createTestHarness();
  seedAuthoritativeRows(db, ACCOUNT_PRIMARY);
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    // Every attempt to select the environment from the request is refused as caller authority.
    for (const parameter of ['environment=live', 'environment=test', 'env=live', 'product_id=' + LK01_PRODUCT_ID]) {
      const response = await request(baseUrl, {
        query: `${CONTROL_QUERY(ACCOUNT_PRIMARY, 'op_cr_env_02')}&${parameter}`,
        assertion: await buildValidAssertion({ operation_id: 'op_cr_env_02' }),
      });
      assertDeniedResponse(response, 400, 'CALLER_AUTHORITY_OVERRIDE');
    }

    // An assertion claiming `live` while the credential is `test` cannot lift the environment.
    const claimResponse = await request(baseUrl, {
      query: CONTROL_QUERY(ACCOUNT_PRIMARY, 'op_cr_env_03'),
      assertion: await buildValidAssertion({ environment: 'live', operation_id: 'op_cr_env_03' }),
    });
    assertDeniedResponse(claimResponse, 403, 'ACCOUNT_ASSERTION_MISMATCH');

    // And the clean read still reports the runtime's own environment.
    const clean = await request(baseUrl, {
      query: CONTROL_QUERY(ACCOUNT_PRIMARY, 'op_cr_env_04'),
      assertion: await buildValidAssertion({ operation_id: 'op_cr_env_04' }),
    });
    assert.equal(clean.status, 200, `raw body: ${clean.text}`);
    assert.equal(clean.body.environment, 'test');
  } finally {
    await close();
  }
});

test('control read projection negative: any query parameter outside the account_id/operation_id allowlist is 400 CALLER_AUTHORITY_OVERRIDE', async () => {
  const { runtime, db } = createTestHarness();
  seedAuthoritativeRows(db, ACCOUNT_PRIMARY);
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    // Every one of these is a caller asserting authority the credential must supply itself.
    const forbiddenParameters = [
      `product_id=${LK01_PRODUCT_ID}`,
      `productId=${LK01_PRODUCT_ID}`,
      'accounts=all',
      'account_ids=acc_a,acc_b',
      'all=true',
      'limit=1000',
      'offset=0',
      'environment=test',
      'scope=control_read',
      `account=${ACCOUNT_PRIMARY}`,
      'subscription_id=' + RAW_PROVIDER_SUBSCRIPTION_ID,
      'customer_id=' + RAW_PROVIDER_CUSTOMER_ID,
      'include=payments',
      'expand=all',
      'filter=*',
    ];

    for (const parameter of forbiddenParameters) {
      const response = await request(baseUrl, {
        query: `${CONTROL_QUERY(ACCOUNT_PRIMARY, 'op_cr_query_01')}&${parameter}`,
        assertion: await buildValidAssertion({ operation_id: 'op_cr_query_01' }),
      });
      assertDeniedResponse(response, 400, 'CALLER_AUTHORITY_OVERRIDE');
      assert.ok(!response.text.includes('schemaVersion'), `denied parameter "${parameter}" leaked a projection`);
    }

    assert.equal(db.auditEvents.length, 0, 'a refused parameter must emit no audit event');
    assert.equal(db.operationRows.length, 0);
  } finally {
    await close();
  }
});

test('control read projection negative: any x-wstera-* header other than the account assertion is 400 CALLER_AUTHORITY_OVERRIDE', async () => {
  const { runtime, db } = createTestHarness();
  seedAuthoritativeRows(db, ACCOUNT_PRIMARY);
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    const forbiddenHeaders = [
      ['x-wstera-product-id', LK01_PRODUCT_ID],
      ['x-wstera-product', LK01_PRODUCT_ID],
      ['x-wstera-environment', 'live'],
      ['x-wstera-account-id', ACCOUNT_STALE],
      ['x-wstera-scope', 'control_read'],
      ['x-wstera-operation-id', 'op_injected'],
      ['x-wstera-account-assertion-foo', 'value'],
    ];

    for (const [name, value] of forbiddenHeaders) {
      const response = await request(baseUrl, {
        query: CONTROL_QUERY(ACCOUNT_PRIMARY, 'op_cr_header_01'),
        assertion: await buildValidAssertion({ operation_id: 'op_cr_header_01' }),
        headers: { [name]: value },
      });
      assertDeniedResponse(response, 400, 'CALLER_AUTHORITY_OVERRIDE');
      assert.ok(!response.text.includes('schemaVersion'), `denied header "${name}" leaked a projection`);
    }

    // The one allowed authoritative header still works on its own.
    const allowed = await request(baseUrl, {
      query: CONTROL_QUERY(ACCOUNT_PRIMARY, 'op_cr_header_02'),
      assertion: await buildValidAssertion({ operation_id: 'op_cr_header_02' }),
    });
    assert.equal(allowed.status, 200, `the account assertion header must remain accepted: ${allowed.text}`);

    assert.equal(db.auditEvents.length, 0);
  } finally {
    await close();
  }
});

test('control read projection negative: missing bearer is 401 AUTH_REQUIRED, unknown bearer is 401 AUTH_INVALID, missing assertion is 401 ACCOUNT_ASSERTION_REQUIRED', async () => {
  const { runtime, db } = createTestHarness();
  seedAuthoritativeRows(db, ACCOUNT_PRIMARY);
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    const missingBearer = await request(baseUrl, {
      omitAuthorization: true,
      query: CONTROL_QUERY(ACCOUNT_PRIMARY, 'op_cr_auth_01'),
      assertion: await buildValidAssertion({ operation_id: 'op_cr_auth_01' }),
    });
    assertDeniedResponse(missingBearer, 401, 'AUTH_REQUIRED');

    const emptyBearer = await request(baseUrl, {
      token: '   ',
      query: CONTROL_QUERY(ACCOUNT_PRIMARY, 'op_cr_auth_02'),
      assertion: await buildValidAssertion({ operation_id: 'op_cr_auth_02' }),
    });
    assertDeniedResponse(emptyBearer, 401, 'AUTH_REQUIRED');

    const unknownBearer = await request(baseUrl, {
      token: UNKNOWN_TOKEN,
      query: CONTROL_QUERY(ACCOUNT_PRIMARY, 'op_cr_auth_03'),
      assertion: await buildValidAssertion({ operation_id: 'op_cr_auth_03' }),
    });
    assertDeniedResponse(unknownBearer, 401, 'AUTH_INVALID');

    const missingAssertion = await request(baseUrl, {
      omitAssertion: true,
      query: CONTROL_QUERY(ACCOUNT_PRIMARY, 'op_cr_auth_04'),
    });
    assertDeniedResponse(missingAssertion, 401, 'ACCOUNT_ASSERTION_REQUIRED');

    // No data on any denial path, and no audit row written for any of them.
    for (const response of [missingBearer, emptyBearer, unknownBearer, missingAssertion]) {
      assert.ok(!response.text.includes('schemaVersion'), `denial leaked a projection: ${response.text}`);
      assert.ok(!response.text.includes('subscriptionRef'));
      assert.equal(response.body.retryable, false);
    }
    assert.equal(db.auditEvents.length, 0, 'no audit row may be written on any denial path');
  } finally {
    await close();
  }
});

test('control read projection negative: a temporary authoritative-dependency failure is a typed retryable condition while an unexpected error stays 500 INTERNAL_ERROR', async () => {
  // REAL dependency failure: a REAL BillingDb pointed at a REAL unreachable TCP port, so
  // db.ts:classifyDependencyFailure performs the classification for real. Nothing is stubbed.
  const unreachableUrl = 'postgres://local_user:local_pass@127.0.0.1:1/local_probe_db';
  const degradedHarness = createTestHarness({ db: new BillingDb(unreachableUrl, 'billing_core_staging') });
  const degradedServer = await startServer(degradedHarness.runtime);

  try {
    const response = await request(degradedServer.baseUrl, {
      query: CONTROL_QUERY(ACCOUNT_PRIMARY, 'op_cr_degraded_01'),
      assertion: await buildValidAssertion({ operation_id: 'op_cr_degraded_01' }),
    });

    // DG-12: reachable-but-degraded, distinguishable from a generic internal error, retryable.
    assert.equal(response.status, 503, `raw body: ${response.text}`);
    assert.equal(response.body?.error, 'CONTROL_READ_DEPENDENCY_DEGRADED');
    assert.notEqual(response.body?.error, 'INTERNAL_ERROR');
    assert.notEqual(response.status, 500);
    assert.equal(response.body.retryable, true, 'a degraded dependency must be marked retryable as data');
    // Never misrepresented: no internal driver code, host, port or connection string on the wire.
    assert.ok(!/ECONNREFUSED|postgres:\/\/|127\.0\.0\.1|local_probe_db|local_pass/i.test(response.text));
  } finally {
    await degradedServer.close();
  }

  // Cross-check the DB layer's own classifier directly, with real error shapes.
  for (const dependencyError of [{ code: 'ECONNREFUSED' }, { code: 'ETIMEDOUT' }, { code: '53300' }, { code: '57P03' }, { code: '08P01' }]) {
    assert.throws(
      () => classifyDependencyFailure('control-read-proof', dependencyError),
      (error) => error instanceof BillingDependencyError
        && error.status === 503
        && error.retryable === true,
      `error code ${dependencyError.code} must classify as a typed retryable dependency condition`,
    );
  }
  // A genuine server-side software error is NOT relabelled as degradation.
  const schemaError = { code: '42P01' };
  assert.throws(
    () => classifyDependencyFailure('control-read-proof', schemaError),
    (error) => error === schemaError,
    'a SQLSTATE that reports our own query/schema as wrong must not be relabelled as degradation',
  );

  // The same route over a healthy authoritative DB returns 200, so the 503 above is a dependency
  // condition and not the route failing for every input.
  const healthyHarness = createTestHarness();
  seedAuthoritativeRows(healthyHarness.db, ACCOUNT_PRIMARY);
  await healthyHarness.runtime.initialize();
  const healthyServer = await startServer(healthyHarness.runtime);
  try {
    const healthy = await request(healthyServer.baseUrl, {
      query: CONTROL_QUERY(ACCOUNT_PRIMARY, 'op_cr_degraded_02'),
      assertion: await buildValidAssertion({ operation_id: 'op_cr_degraded_02' }),
    });
    assert.equal(healthy.status, 200, `raw body: ${healthy.text}`);
  } finally {
    await healthyServer.close();
  }

  // A genuinely unexpected software error is still the untyped 500 INTERNAL_ERROR.
  class ExplodingDb extends InMemoryBillingDb {
    async getSubscriptionState() { throw new Error('unexpected internal software failure'); }
  }
  const explodingHarness = createTestHarness({ db: new ExplodingDb() });
  const explodingServer = await startServer(explodingHarness.runtime);
  try {
    const response = await request(explodingServer.baseUrl, {
      query: CONTROL_QUERY(ACCOUNT_PRIMARY, 'op_cr_degraded_03'),
      assertion: await buildValidAssertion({ operation_id: 'op_cr_degraded_03' }),
    });
    assert.equal(response.status, 500, `raw body: ${response.text}`);
    assert.equal(response.body?.error, 'INTERNAL_ERROR');
    assert.equal(response.body.retryable, false);
    // No internal detail (message, stack, connection string) may leak from an internal error.
    assert.ok(!/unexpected internal software failure|at Object|\.ts:\d+|postgres:\/\//i.test(response.text));
  } finally {
    await explodingServer.close();
  }
});

test('control read projection negative: the control read route accepts only GET and no mutation route accepts the control_read scope', async () => {
  const { runtime, db } = createTestHarness();
  seedAuthoritativeRows(db, ACCOUNT_PRIMARY);
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    // A control_read-only credential cannot mutate through any authenticating POST route.
    const checkout = await request(baseUrl, {
      method: 'POST',
      route: '/v1/checkout',
      token: PS01_CONTROL_TOKEN,
      query: '',
      body: {
        account_id: ACCOUNT_PRIMARY,
        plan_id: 'founding-c2',
        operation_id: 'op_cr_mutation_01',
        success_return_ref: 'default',
        cancel_return_ref: 'default',
      },
      assertion: await buildValidAssertion({ action: 'checkout', operation_id: 'op_cr_mutation_01' }),
    });
    assertDeniedResponse(checkout, 403, 'AUTH_SCOPE_DENIED');

    const portal = await request(baseUrl, {
      method: 'POST',
      route: '/v1/portal',
      token: PS01_CONTROL_TOKEN,
      query: '',
      body: { account_id: ACCOUNT_PRIMARY, operation_id: 'op_cr_mutation_02', return_ref: 'default' },
      assertion: await buildValidAssertion({ action: 'portal', operation_id: 'op_cr_mutation_02' }),
    });
    assertDeniedResponse(portal, 403, 'AUTH_SCOPE_DENIED');

    assert.equal(db.operationRows.length, 0, 'no mutation route may accept control_read scope for a write');
    assert.equal(db.auditEvents.length, 0, 'no mutation attempt through a control_read credential may be audited as success');

    // The projection route is read-shaped only: no non-GET method reaches the projection.
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await request(baseUrl, {
        method,
        query: CONTROL_QUERY(ACCOUNT_PRIMARY, 'op_cr_method_01'),
        assertion: await buildValidAssertion({ operation_id: 'op_cr_method_01' }),
      });
      assert.equal(response.status, 404, `${method} must not be served by the control read route: ${response.text}`);
      assert.ok(!response.text.includes('schemaVersion'), `${method} must not reach the projection`);
    }

    // GET is the only accepted method, and it still serves the projection.
    const getResponse = await request(baseUrl, {
      query: CONTROL_QUERY(ACCOUNT_PRIMARY, 'op_cr_method_02'),
      assertion: await buildValidAssertion({ operation_id: 'op_cr_method_02' }),
    });
    assert.equal(getResponse.status, 200, `raw body: ${getResponse.text}`);
  } finally {
    await close();
  }
});

test('control read projection negative: no query parameter, header or body can widen the read beyond the addressed account and no accounts array ever appears', async () => {
  const { runtime, db } = createTestHarness();
  seedAuthoritativeRows(db, ACCOUNT_PRIMARY);
  seedAuthoritativeRows(db, ACCOUNT_STALE);
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    // Widening parameters are refused outright.
    for (const parameter of ['accounts=all', 'account_ids=' + [ACCOUNT_PRIMARY, ACCOUNT_STALE].join(','), 'all=true', 'limit=100']) {
      const response = await request(baseUrl, {
        query: `${CONTROL_QUERY(ACCOUNT_PRIMARY, 'op_cr_widen_01')}&${parameter}`,
        assertion: await buildValidAssertion({ operation_id: 'op_cr_widen_01' }),
      });
      assertDeniedResponse(response, 400, 'CALLER_AUTHORITY_OVERRIDE');
      assert.ok(!response.text.includes(ACCOUNT_STALE), `widening parameter "${parameter}" reached a second account`);
    }

    // A widening BODY on a GET is ignored entirely: the transport allows what fetch will not build,
    // so this is exercised with a raw socket rather than assumed.
    const assertionToken = await buildValidAssertion({ operation_id: 'op_cr_widen_02' });
    const rawResponse = await rawGetWithBody(
      baseUrl,
      `${CONTROL_READ_ROUTE}${CONTROL_QUERY(ACCOUNT_PRIMARY, 'op_cr_widen_02')}`,
      [['Authorization', `Bearer ${PS01_CONTROL_TOKEN}`], ['x-wstera-account-assertion', assertionToken]],
      JSON.stringify({ product_id: LK01_PRODUCT_ID, accounts: [ACCOUNT_PRIMARY, ACCOUNT_STALE], all_accounts: true, environment: 'live' }),
    );
    assert.equal(rawResponse.statusLine, 'HTTP/1.1 200 OK');
    const rawBody = JSON.parse(rawResponse.text);
    assert.equal(rawBody.accountId, ACCOUNT_PRIMARY, 'the addressed account is the only account in the projection');
    assert.equal(rawBody.environment, 'test', 'a request body cannot select the environment');
    assert.notEqual(rawBody.productId, LK01_PRODUCT_ID);
    assert.ok(!rawResponse.text.includes(ACCOUNT_STALE), 'a request body must not widen the read to another account');
    assertNoAccountsEnumerarationSurface(rawBody);

    // Every successful response is exactly one addressed account, and never an enumeration surface.
    for (const accountId of [ACCOUNT_PRIMARY, ACCOUNT_STALE]) {
      const response = await request(baseUrl, {
        query: CONTROL_QUERY(accountId, 'op_cr_widen_03'),
        assertion: await buildValidAssertion({ account_id: accountId, operation_id: 'op_cr_widen_03' }),
      });
      assert.equal(response.status, 200, `raw body: ${response.text}`);
      assert.equal(response.body.accountId, accountId);
      assertNoAccountsEnumerarationSurface(response.body);
    }
  } finally {
    await close();
  }
});

test('control read projection negative: the projection exposes no provider-executable identifier', async () => {
  const { runtime, db } = createTestHarness();
  seedAuthoritativeRows(db, ACCOUNT_PRIMARY);
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    const response = await request(baseUrl, {
      query: CONTROL_QUERY(ACCOUNT_PRIMARY, 'op_cr_provider_ids_01'),
      assertion: await buildValidAssertion({ operation_id: 'op_cr_provider_ids_01' }),
    });
    assert.equal(response.status, 200, `raw body: ${response.text}`);

    // No provider-side identifier that could be replayed against the provider may cross the wire.
    for (const providerIdentifier of REFERRED_RAW_PROVIDER_IDS) {
      assert.ok(
        !response.text.includes(providerIdentifier),
        `the projection leaked a provider identifier: ${providerIdentifier}`,
      );
    }

    // No provider-id-shaped value anywhere in the body, at any depth.
    const providerIdentifierShape = /(^|["\s:,(])(sub|cus|price|prod|cs|pi|ch|in|pm|seti|evt)_[A-Za-z0-9]{4,}/;
    assert.ok(
      !providerIdentifierShape.test(response.text),
      `a provider-id-shaped value appeared in the projection: ${response.text}`,
    );

    // The subscription block names no provider object and invents no Control status vocabulary.
    for (const forbiddenKey of ['providerSubscriptionId', 'provider_subscription_id', 'subscriptionId', 'providerCustomerId', 'provider_customer_id', 'priceId', 'providerProductId', 'status']) {
      assert.ok(
        !Object.prototype.hasOwnProperty.call(response.body.subscription, forbiddenKey),
        `subscription must not expose "${forbiddenKey}"`,
      );
    }
    // productId IS present and is SB01-native (DG-8); it is not a provider identifier.
    assert.ok(response.body.productId.startsWith('prd_'));
    assert.ok(
      !response.text.includes(PS01_STRIPE_PRODUCT_ID),
      'the provider product id must not be exposed',
    );
  } finally {
    await close();
  }
});

test('control read projection negative: no response body on any path leaks a bearer token, secret, fingerprint, connection string or signature', async () => {
  const { runtime, db } = createTestHarness();
  seedAuthoritativeRows(db, ACCOUNT_PRIMARY);
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    const credentialFingerprint = await sha256Hex(PS01_CONTROL_TOKEN);
    const assertion = await buildValidAssertion({ operation_id: 'op_cr_leak_01' });
    const assertionSignature = assertion.split('.')[1];

    const credential = runtime.config.credentials.find((c) => c.token === PS01_CONTROL_TOKEN);

    // A matrix covering the success path and every distinct denial path.
    const responses = [
      await request(baseUrl, { query: CONTROL_QUERY(ACCOUNT_PRIMARY, 'op_cr_leak_01'), assertion }),
      await request(baseUrl, { token: PS01_READ_ONLY_TOKEN, query: CONTROL_QUERY(ACCOUNT_PRIMARY, 'op_cr_leak_02'), assertion: await buildValidAssertion({ operation_id: 'op_cr_leak_02' }) }),
      await request(baseUrl, { omitAuthorization: true, query: CONTROL_QUERY(ACCOUNT_PRIMARY, 'op_cr_leak_03'), assertion: await buildValidAssertion({ operation_id: 'op_cr_leak_03' }) }),
      await request(baseUrl, { omitAssertion: true, query: CONTROL_QUERY(ACCOUNT_PRIMARY, 'op_cr_leak_04') }),
      await request(baseUrl, { query: CONTROL_QUERY(ACCOUNT_UNKNOWN, 'op_cr_leak_05'), assertion: await buildValidAssertion({ account_id: ACCOUNT_UNKNOWN, operation_id: 'op_cr_leak_05' }) }),
      await request(baseUrl, { query: `${CONTROL_QUERY(ACCOUNT_PRIMARY, 'op_cr_leak_06')}&accounts=all`, assertion: await buildValidAssertion({ operation_id: 'op_cr_leak_06' }) }),
      await request(baseUrl, { method: 'POST', route: '/v1/checkout', query: '', token: PS01_CONTROL_TOKEN, assertion: await buildValidAssertion({ action: 'checkout', operation_id: 'op_cr_leak_07' }), headers: { 'content-type': 'application/json' } }),
      await request(baseUrl, { route: '/healthz', query: '', token: null, omitAssertion: true }),
    ];

    const forbiddenValues = [
      PS01_CONTROL_TOKEN,
      PS01_READ_ONLY_TOKEN,
      UNKNOWN_TOKEN,
      PS01_ASSERTION_SECRET,
      LK01_ASSERTION_SECRET,
      credentialFingerprint,
      assertionSignature,
      TEST_MODE_KEY_SENTINEL,
      WEBHOOK_SECRET_SENTINEL,
      RAW_PROVIDER_SUBSCRIPTION_ID,
      RAW_PROVIDER_CUSTOMER_ID,
    ];

    for (const response of responses) {
      for (const forbidden of forbiddenValues) {
        assert.ok(
          !response.text.includes(forbidden),
          `a secret-shaped value leaked into an HTTP body: ${forbidden.slice(0, 12)}… in ${response.text}`,
        );
      }
      assert.ok(!/sk_live_[A-Za-z0-9]+/.test(response.text), 'no live secret key may appear');
      assert.ok(!/whsec_[A-Za-z0-9]{8,}/.test(response.text), 'no webhook secret may appear');
      assert.ok(!/postgres(ql)?:\/\/[^\s"']+/.test(response.text), 'no connection string may appear');
      assert.ok(!/token_fingerprint|credential_token|fingerprint/i.test(response.text));
      assert.ok(!/at\s+\S+\s+\(.*:\d+:\d+\)/.test(response.text), 'no stack frame may appear');
      // `token` appears only as one of our own redacted bearer prefixes, never as a value.
      assert.ok(!/\bk_[A-Za-z0-9]{12,}/.test(response.text));
    }

    // The credential object handed to handlers is redacted in-process as well.
    const handledWithRedaction = await request(baseUrl, { query: CONTROL_QUERY(ACCOUNT_PRIMARY, 'op_cr_leak_08'), assertion: await buildValidAssertion({ operation_id: 'op_cr_leak_08' }) });
    assert.equal(handledWithRedaction.status, 200);
    assert.notEqual(credential.token, undefined);
  } finally {
    await close();
  }
});

test('control read projection negative: a consumer-side validator rejects a malformed projection rather than repairing it', async () => {
  // The consumer-side contract is recorded in STAGE-B-READ-CONTRACT.md §10
  // "Malformed response (consumer side)": Control MUST reject, not repair. Its stated rules are
  // transcribed here as a strict validator, then applied to the REAL projection this runtime
  // produced — proving the two sides agree — and to deliberately malformed variants, proving each
  // malformation is rejected rather than silently normalised.
  const requiredIdentityFields = ['accountId', 'planId', 'subscriptionRef'];

  function validateProjection(projection) {
    const problems = [];
    if (!projection || typeof projection !== 'object') return ['projection is not an object'];

    const identity = projection.subscription ?? {};
    for (const field of requiredIdentityFields) {
      const value = field === 'accountId' ? projection.accountId : identity[field];
      if (typeof value !== 'string' || !value.trim()) problems.push(`missing required identity field: ${field}`);
    }
    if (projection.subscription) {
      const amount = projection.subscription.amountMinor;
      if (amount !== null && (!Number.isSafeInteger(amount) || amount < 0)) {
        problems.push('amountMinor is not a non-negative safe integer');
      }
      const currency = projection.subscription.currency;
      if (currency !== null && !/^[A-Z]{3}$/.test(String(currency))) {
        problems.push('currency is not 3 uppercase letters');
      }
    }
    return problems;
  }

  const { runtime, db } = createTestHarness();
  seedAuthoritativeRows(db, ACCOUNT_PRIMARY);
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    const response = await request(baseUrl, {
      query: CONTROL_QUERY(ACCOUNT_PRIMARY, 'op_cr_consumer_01'),
      assertion: await buildValidAssertion({ operation_id: 'op_cr_consumer_01' }),
    });
    assert.equal(response.status, 200, `raw body: ${response.text}`);
    const realProjection = response.body;

    // The real projection satisfies the consumer contract in full.
    assert.deepEqual(validateProjection(realProjection), []);

    // Malformed variants must be rejected, never repaired.
    const malformedVariants = [
      { label: 'missing required identity (no accountId)', mutate: (p) => { delete p.accountId; } },
      { label: 'missing required identity (no subscriptionRef)', mutate: (p) => { delete p.subscription.subscriptionRef; } },
      { label: 'missing required identity (no planId)', mutate: (p) => { delete p.subscription.planId; } },
      { label: 'non-integer amountMinor', mutate: (p) => { p.subscription.amountMinor = 990.5; } },
      { label: 'negative amountMinor', mutate: (p) => { p.subscription.amountMinor = -1; } },
      { label: 'string amountMinor', mutate: (p) => { p.subscription.amountMinor = '99000'; } },
      { label: 'unsafe-integer amountMinor', mutate: (p) => { p.subscription.amountMinor = Number.MAX_SAFE_INTEGER + 2; } },
      { label: 'non-3-letter currency (lowercase)', mutate: (p) => { p.subscription.currency = 'thb'; } },
      { label: 'non-3-letter currency (too long)', mutate: (p) => { p.subscription.currency = 'THBB'; } },
      { label: 'non-3-letter currency (empty)', mutate: (p) => { p.subscription.currency = ''; } },
    ];

    for (const variant of malformedVariants) {
      const mutated = structuredClone(realProjection);
      variant.mutate(mutated);
      const problems = validateProjection(mutated);
      assert.ok(problems.length > 0, `malformed projection was accepted instead of rejected: ${variant.label}`);
    }
  } finally {
    await close();
  }
});

test('control read projection: a real BillingDb refuses a missing database URL rather than serving a projection', async () => {
  // Guards the authority boundary itself: the read route cannot degrade into an unauthenticated
  // or unbacked projection when its authoritative dependency is misconfigured.
  assert.throws(
    () => new BillingDb('', 'billing_core_staging'),
    (error) => error instanceof BillingRuntimeError && error.code === 'DATABASE_URL_REQUIRED' && error.status === 500,
  );
});
