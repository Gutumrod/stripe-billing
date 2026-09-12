import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import {
  BillingDb,
  BillingRuntimeError,
  CentralBillingRuntime,
  createBillingHttpHandler,
  signAccountAssertion,
} from '../dist/index.js';
import { ProductBillingProfileRegistry } from '../../profile-registry/dist/src/registry.js';
import { ps01TestProfile } from '../../profile-registry/dist/profiles/PS01.test.js';
import { lk01TestProfile } from '../../profile-registry/dist/profiles/LK01.test.js';

class InMemoryBillingDb extends BillingDb {
  constructor() {
    super('postgres://mock:5432/mock', 'billing_core_staging');
    this.operations = new Map();
    this.customers = new Map();
    this.auditEvents = [];
    this.credentialBindings = new Map();
  }
  async ping() {}
  async close() {}
  async ensureCredentialBinding(binding, tokenFingerprint) {
    this.credentialBindings.set(`${binding.environment}:${binding.productId}:${binding.keyId}`, {
      binding,
      tokenFingerprint,
    });
  }
  async beginOperation(input) {
    const key = `${input.environment}:${input.productId}:${input.accountId}:${input.route}:${input.operationId}`;
    const existing = this.operations.get(key);
    if (existing) {
      if (existing.requestFingerprint !== input.requestFingerprint) {
        throw new BillingRuntimeError('IDEMPOTENCY_CONFLICT', 'Operation ID reused with different request', 409);
      }
      return {
        id: existing.id,
        status: existing.status,
        correlationId: existing.correlationId,
        responseProjection: existing.responseProjection,
        providerObjectId: existing.providerObjectId,
      };
    }
    const op = {
      id: crypto.randomUUID(),
      environment: input.environment,
      productId: input.productId,
      accountId: input.accountId,
      route: input.route,
      operationId: input.operationId,
      requestFingerprint: input.requestFingerprint,
      status: 'pending',
      correlationId: input.correlationId,
      responseProjection: null,
      providerObjectId: null,
    };
    this.operations.set(key, op);
    return {
      id: op.id,
      status: op.status,
      correlationId: op.correlationId,
      responseProjection: null,
      providerObjectId: null,
    };
  }
  async completeOperation(id, providerObjectId, response) {
    for (const op of this.operations.values()) {
      if (op.id === id) {
        op.status = 'completed';
        op.providerObjectId = providerObjectId;
        op.responseProjection = response;
        break;
      }
    }
  }
  async failOperation(id, errorCode) {
    for (const op of this.operations.values()) {
      if (op.id === id) {
        op.status = 'failed';
        op.errorCode = errorCode;
        break;
      }
    }
  }
  async reserveCustomer(input) {
    const key = `${input.environment}:${input.productId}:${input.accountId}`;
    const existing = this.customers.get(key);
    if (existing && existing.state === 'ready' && existing.providerCustomerId) {
      return { ...existing };
    }
    const mapping = {
      id: existing ? existing.id : crypto.randomUUID(),
      environment: input.environment,
      productId: input.productId,
      accountId: input.accountId,
      profileVersion: input.profileVersion,
      providerCustomerId: existing ? existing.providerCustomerId : null,
      state: existing ? existing.state : 'reserved',
      reservationToken: input.reservationToken,
    };
    this.customers.set(key, mapping);
    return { ...mapping };
  }
  async completeCustomerReservation(mappingId, reservationToken, providerCustomerId) {
    for (const mapping of this.customers.values()) {
      if (mapping.id === mappingId && mapping.reservationToken === reservationToken) {
        mapping.state = 'ready';
        mapping.providerCustomerId = providerCustomerId;
        mapping.reservationToken = null;
        return;
      }
    }
    throw new BillingRuntimeError('CUSTOMER_RESERVATION_LOST', 'Customer reservation ownership was lost', 409, true);
  }
  async getCustomerByAccount(environment, productId, accountId) {
    const key = `${environment}:${productId}:${accountId}`;
    const found = this.customers.get(key);
    return found && found.state === 'ready' ? { ...found } : null;
  }
  async getCustomerByProviderId(providerCustomerId) {
    for (const mapping of this.customers.values()) {
      if (mapping.providerCustomerId === providerCustomerId && mapping.state === 'ready') {
        return { ...mapping };
      }
    }
    return null;
  }
  async audit(input) {
    this.auditEvents.push({ ...input, timestamp: new Date() });
  }
}

function createStripeMock(state) {
  return async (url, options = {}) => {
    const parsedUrl = new URL(url);
    const method = options.method ?? 'GET';
    const path = parsedUrl.pathname;
    const auth = options.headers?.Authorization;
    if (!auth || !auth.startsWith('Bearer sk_test_')) {
      return new Response(JSON.stringify({ error: { message: 'Invalid API Key', type: 'invalid_request_error' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (method === 'POST' && path === '/v1/customers') {
      const params = options.body;
      const metadata = {};
      for (const [k, v] of params.entries()) {
        const match = k.match(/^metadata\[(.*)\]$/);
        if (match) metadata[match[1]] = v;
      }
      const customer = {
        id: `cus_test_${state.customerSeq++}`,
        object: 'customer',
        livemode: state.returnLiveMode === true,
        metadata,
      };
      state.customers.set(customer.id, customer);
      state.createdCustomers.push({ ...customer });
      return new Response(JSON.stringify(customer), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (method === 'POST' && path === '/v1/checkout/sessions') {
      const params = options.body;
      const customerId = params.get('customer');
      const priceId = params.get('line_items[0][price]');
      const successUrl = params.get('success_url');
      const cancelUrl = params.get('cancel_url');
      const mode = params.get('mode');
      const metadata = {};
      for (const [k, v] of params.entries()) {
        const match = k.match(/^metadata\[(.*)\]$/);
        if (match) metadata[match[1]] = v;
      }
      const sessionId = `cs_test_${state.sessionSeq++}`;
      const session = {
        id: sessionId,
        object: 'checkout.session',
        status: 'open',
        url: `https://checkout.stripe.com/c/pay/${sessionId}`,
        customer: customerId,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        mode,
        livemode: state.returnLiveMode === true,
        metadata,
      };
      state.sessions.set(session.id, session);
      state.createdSessions.push({ ...session });
      return new Response(JSON.stringify(session), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (method === 'GET' && path.startsWith('/v1/checkout/sessions/')) {
      const sessionId = decodeURIComponent(path.slice('/v1/checkout/sessions/'.length));
      const session = state.sessions.get(sessionId);
      if (!session) {
        return new Response(JSON.stringify({ error: { message: 'No such session', code: 'resource_missing' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      state.retrievedSessions.push(sessionId);
      return new Response(JSON.stringify(session), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: { message: 'Not Found' } }), { status: 404 });
  };
}

const TEST_SECRET_KEY = 'sk_test_wstera_central_billing_slice_test_key_01';
const TEST_ASSERTION_SECRET = 'super-secret-ps01-account-assertion-key-2026';
const LK01_ASSERTION_SECRET = 'super-secret-lk01-account-assertion-key-2026';
const PS01_PRODUCT_ID = ps01TestProfile.productId;
const LK01_PRODUCT_ID = lk01TestProfile.productId;

function createTestHarness(overrides = {}) {
  const stripeState = {
    customerSeq: 100,
    sessionSeq: 500,
    customers: new Map(),
    sessions: new Map(),
    createdCustomers: [],
    createdSessions: [],
    retrievedSessions: [],
    returnLiveMode: false,
    ...overrides.stripeState,
  };

  const registry = new ProductBillingProfileRegistry();
  registry.register(ps01TestProfile);
  registry.register(lk01TestProfile);

  const mockDb = new InMemoryBillingDb();

  const logger = {
    info() {},
    warn() {},
    error() {},
  };

  const runtime = new CentralBillingRuntime({
    environment: 'test',
    schema: 'billing_core_staging',
    admissionTestMode: true,
    databaseUrl: 'postgres://mock:5432/mock',
    stripeSecretKey: TEST_SECRET_KEY,
    stripeWebhookSecret: 'whsec_test_stripe_webhook_secret_01',
    webhookMaxBytes: 1024 * 1024,
    credentials: [
      {
        keyId: 'ps01-test-token-key-01',
        token: 'wstera-test-token-ps01-9999',
        productId: PS01_PRODUCT_ID,
        environment: 'test',
        profileVersion: 1,
        scopes: ['checkout', 'read', 'portal'],
      },
      {
        keyId: 'lk01-test-token-key-01',
        token: 'wstera-test-token-lk01-8888',
        productId: LK01_PRODUCT_ID,
        environment: 'test',
        profileVersion: 1,
        scopes: ['checkout', 'read', 'portal'],
      },
    ],
    assertionKeys: [
      {
        keyId: 'ps01-assertion-key-01',
        productId: PS01_PRODUCT_ID,
        environment: 'test',
        secret: TEST_ASSERTION_SECRET,
      },
      {
        keyId: 'lk01-assertion-key-01',
        productId: LK01_PRODUCT_ID,
        environment: 'test',
        secret: LK01_ASSERTION_SECRET,
      },
    ],
    returnUrls: {
      [PS01_PRODUCT_ID]: {
        success: { default: 'https://pawstia.app/checkout/success' },
        cancel: { default: 'https://pawstia.app/checkout/cancel' },
        portal: { default: 'https://pawstia.app/portal/return' },
      },
      [LK01_PRODUCT_ID]: {
        success: { default: 'https://linke.app/checkout/success' },
        cancel: { default: 'https://linke.app/checkout/cancel' },
        portal: { default: 'https://linke.app/portal/return' },
      },
    },
    entitlementSigningKeys: [
      {
        keyId: 'ps01-entitlement-key-01',
        productId: PS01_PRODUCT_ID,
        environment: 'test',
        secret: 'entitlement-signing-secret-ps01',
      },
    ],
    profileRegistry: registry,
    logger,
    fetch: createStripeMock(stripeState),
    db: mockDb,
    ...overrides.config,
  });

  return { runtime, mockDb, stripeState, registry };
}

async function startServer(runtime) {
  const handler = createBillingHttpHandler(runtime);
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    server,
    baseUrl,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function buildValidAssertion(input = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: input.iss ?? PS01_PRODUCT_ID,
    aud: input.aud ?? 'wstera-billing-core',
    key_id: input.key_id ?? 'ps01-assertion-key-01',
    product_id: input.product_id ?? PS01_PRODUCT_ID,
    environment: input.environment ?? 'test',
    account_id: input.account_id ?? 'acc_ps01_test_01',
    action: input.action ?? 'checkout',
    operation_id: input.operation_id ?? 'op_checkout_01',
    nonce: input.nonce ?? crypto.randomUUID(),
    iat: input.iat ?? now,
    exp: input.exp ?? now + 240,
  };
  const secret = input.secret ?? TEST_ASSERTION_SECRET;
  return signAccountAssertion(payload, secret);
}

async function postCheckout(baseUrl, { authorization, assertion, body, url = '/v1/checkout' }) {
  return fetch(`${baseUrl}${url}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization,
      'x-wstera-account-assertion': assertion,
    },
    body: JSON.stringify(body),
  });
}

const PS01_AUTH = 'Bearer wstera-test-token-ps01-9999';
const LK01_AUTH = 'Bearer wstera-test-token-lk01-8888';

function assertNoProviderObjects(state) {
  assert.equal(state.createdSessions.length, 0, 'no Stripe checkout session may be created');
  assert.equal(state.createdCustomers.length, 0, 'no Stripe customer may be created');
}

function assertNoDurableOperations(db) {
  assert.equal(db.operations.size, 0, 'no billing operation row may be persisted');
}

function assertNoPortalOrCustomerDbRows(db) {
  assert.equal(db.customers.size, 0, 'no customer mapping row may be persisted');
}

async function assertDeniedResponse(res, expectedStatus, expectedCode) {
  assert.equal(res.status, expectedStatus);
  const body = await res.json();
  assert.equal(body.error, expectedCode);
  return body;
}

test('negative authority: LK01 credential is pinned to LK01 profile and cannot reach PS01 checkout slice', async () => {
  const { runtime, mockDb, stripeState } = createTestHarness();
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    const assertionToken = await buildValidAssertion({
      iss: LK01_PRODUCT_ID,
      product_id: LK01_PRODUCT_ID,
      key_id: 'lk01-assertion-key-01',
      secret: LK01_ASSERTION_SECRET,
      account_id: 'acc_lk01_test_01',
      operation_id: 'op_lk01_checkout_01',
      action: 'checkout',
    });

    const res = await postCheckout(baseUrl, {
      authorization: LK01_AUTH,
      assertion: assertionToken,
      body: {
        account_id: 'acc_lk01_test_01',
        plan_id: 'pro',
        operation_id: 'op_lk01_checkout_01',
        success_return_ref: 'default',
        cancel_return_ref: 'default',
      },
    });

    assert.equal(res.status, 201);
    const data = await res.json();
    assert.ok(data.checkout_session_id.startsWith('cs_test_'));

    // Product identity is derived server-side from the LK01 credential binding.
    const session = stripeState.createdSessions[0];
    assert.equal(session.line_items[0].price, 'price_1UDCxzHB4GRCffd9a0rUipHY');
    assert.equal(session.metadata.wstera_product_id, LK01_PRODUCT_ID);
    assert.equal(session.metadata.wstera_product_code, 'LK01');

    const stripeCustomer = stripeState.createdCustomers[0];
    assert.equal(stripeCustomer.metadata.wstera_product_id, LK01_PRODUCT_ID);
    assert.equal(stripeCustomer.metadata.wstera_product_code, 'LK01');
    assert.equal(stripeCustomer.metadata.account_id, 'acc_lk01_test_01');

    // No PS01-scoped durable row may be created by the LK01 caller.
    assert.equal(mockDb.operations.has(`test:${PS01_PRODUCT_ID}:acc_lk01_test_01:/v1/checkout:op_lk01_checkout_01`), false);
    assert.equal(mockDb.customers.has(`test:${PS01_PRODUCT_ID}:acc_lk01_test_01`), false);
  } finally {
    await close();
  }
});

test('negative authority: caller cannot supply product_id in checkout request body', async () => {
  const { runtime, stripeState, mockDb } = createTestHarness();
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    const assertionToken = await buildValidAssertion({
      account_id: 'acc_ps01_test_01',
      operation_id: 'op_body_product_spoof',
      action: 'checkout',
    });

    const res = await postCheckout(baseUrl, {
      authorization: PS01_AUTH,
      assertion: assertionToken,
      body: {
        account_id: 'acc_ps01_test_01',
        plan_id: 'founding-c2',
        operation_id: 'op_body_product_spoof',
        success_return_ref: 'default',
        cancel_return_ref: 'default',
        product_id: LK01_PRODUCT_ID,
      },
    });

    await assertDeniedResponse(res, 400, 'CALLER_AUTHORITY_OVERRIDE');
    assertNoProviderObjects(stripeState);
    assertNoDurableOperations(mockDb);
  } finally {
    await close();
  }
});

test('negative authority: plan_id cannot select another product plan through the pinned profile', async () => {
  const { runtime, stripeState, mockDb } = createTestHarness();
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    const assertionToken = await buildValidAssertion({
      account_id: 'acc_ps01_test_01',
      operation_id: 'op_cross_product_plan',
      action: 'checkout',
    });

    const res = await postCheckout(baseUrl, {
      authorization: PS01_AUTH,
      assertion: assertionToken,
      body: {
        account_id: 'acc_ps01_test_01',
        plan_id: 'pro',
        operation_id: 'op_cross_product_plan',
        success_return_ref: 'default',
        cancel_return_ref: 'default',
      },
    });

    await assertDeniedResponse(res, 409, 'PLAN_NOT_CHECKOUT_ELIGIBLE');
    assertNoProviderObjects(stripeState);
    assertNoDurableOperations(mockDb);
  } finally {
    await close();
  }
});

test('negative authority: live-environment credential is denied by the Test-only runtime', async () => {
  const { runtime, stripeState, mockDb } = createTestHarness({
    config: {
      credentials: [
        {
          keyId: 'ps01-live-token-key-01',
          token: 'wstera-live-token-ps01-0001',
          productId: PS01_PRODUCT_ID,
          environment: 'live',
          profileVersion: 1,
          scopes: ['checkout'],
        },
      ],
    },
  });
  const { baseUrl, close } = await startServer(runtime);

  try {
    const assertionToken = await buildValidAssertion({
      account_id: 'acc_ps01_test_01',
      operation_id: 'op_live_credential',
      action: 'checkout',
    });

    const res = await postCheckout(baseUrl, {
      authorization: 'Bearer wstera-live-token-ps01-0001',
      assertion: assertionToken,
      body: {
        account_id: 'acc_ps01_test_01',
        plan_id: 'founding-c2',
        operation_id: 'op_live_credential',
        success_return_ref: 'default',
        cancel_return_ref: 'default',
      },
    });

    await assertDeniedResponse(res, 403, 'CREDENTIAL_ENV_MISMATCH');
    assertNoProviderObjects(stripeState);
    assertNoDurableOperations(mockDb);
  } finally {
    await close();
  }
});

test('negative authority: runtime constructor denies live environment and non-staging schema', () => {
  assert.throws(
    () => new CentralBillingRuntime({ environment: 'live', schema: 'billing_core_staging', databaseUrl: 'postgres://mock:5432/mock', stripeSecretKey: TEST_SECRET_KEY, stripeWebhookSecret: 'whsec_test_stripe_webhook_secret_01', webhookMaxBytes: 1024, credentials: [], assertionKeys: [], returnUrls: {}, entitlementSigningKeys: [], profileRegistry: new ProductBillingProfileRegistry(), logger: { info() {}, warn() {}, error() {} } }),
    (error) => error instanceof BillingRuntimeError && error.code === 'LIVE_RUNTIME_DENIED',
  );
  assert.throws(
    () => new CentralBillingRuntime({ environment: 'test', schema: 'billing_core', databaseUrl: 'postgres://mock:5432/mock', stripeSecretKey: TEST_SECRET_KEY, stripeWebhookSecret: 'whsec_test_stripe_webhook_secret_01', webhookMaxBytes: 1024, credentials: [], assertionKeys: [], returnUrls: {}, entitlementSigningKeys: [], profileRegistry: new ProductBillingProfileRegistry(), logger: { info() {}, warn() {}, error() {} } }),
    (error) => error instanceof BillingRuntimeError && error.code === 'PHASE2_SCHEMA_DENIED',
  );
});

test('negative authority: assertion environment claim cannot override credential environment', async () => {
  const { runtime, stripeState, mockDb } = createTestHarness();
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    const assertionToken = await buildValidAssertion({
      account_id: 'acc_ps01_test_01',
      operation_id: 'op_assertion_env_spoof',
      action: 'checkout',
      environment: 'live',
    });

    const res = await postCheckout(baseUrl, {
      authorization: PS01_AUTH,
      assertion: assertionToken,
      body: {
        account_id: 'acc_ps01_test_01',
        plan_id: 'founding-c2',
        operation_id: 'op_assertion_env_spoof',
        success_return_ref: 'default',
        cancel_return_ref: 'default',
      },
    });

    await assertDeniedResponse(res, 403, 'ACCOUNT_ASSERTION_MISMATCH');
    assertNoProviderObjects(stripeState);
    assertNoDurableOperations(mockDb);
  } finally {
    await close();
  }
});

test('negative authority: assertion account_id mismatch with request body fails closed', async () => {
  const { runtime, stripeState, mockDb } = createTestHarness();
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    const assertionToken = await buildValidAssertion({
      account_id: 'acc_victim_other',
      operation_id: 'op_account_spoof_01',
      action: 'checkout',
    });

    const res = await postCheckout(baseUrl, {
      authorization: PS01_AUTH,
      assertion: assertionToken,
      body: {
        account_id: 'acc_ps01_test_01',
        plan_id: 'founding-c2',
        operation_id: 'op_account_spoof_01',
        success_return_ref: 'default',
        cancel_return_ref: 'default',
      },
    });

    await assertDeniedResponse(res, 403, 'ACCOUNT_ASSERTION_MISMATCH');
    assertNoProviderObjects(stripeState);
    assertNoDurableOperations(mockDb);
    assertNoPortalOrCustomerDbRows(mockDb);
  } finally {
    await close();
  }
});

test('negative authority: assertion signed for a different action is denied on the checkout route', async () => {
  const { runtime, stripeState, mockDb } = createTestHarness();
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    const assertionToken = await buildValidAssertion({
      account_id: 'acc_ps01_test_01',
      operation_id: 'op_action_spoof_01',
      action: 'portal',
    });

    const res = await postCheckout(baseUrl, {
      authorization: PS01_AUTH,
      assertion: assertionToken,
      body: {
        account_id: 'acc_ps01_test_01',
        plan_id: 'founding-c2',
        operation_id: 'op_action_spoof_01',
        success_return_ref: 'default',
        cancel_return_ref: 'default',
      },
    });

    await assertDeniedResponse(res, 403, 'ACCOUNT_ASSERTION_MISMATCH');
    assertNoProviderObjects(stripeState);
    assertNoDurableOperations(mockDb);
    assertNoPortalOrCustomerDbRows(mockDb);
  } finally {
    await close();
  }
});

test('negative authority: assertion operation_id must match the requested operation', async () => {
  const { runtime, stripeState, mockDb } = createTestHarness();
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    const assertionToken = await buildValidAssertion({
      account_id: 'acc_ps01_test_01',
      operation_id: 'op_assertion_binding_01',
      action: 'checkout',
    });

    const res = await postCheckout(baseUrl, {
      authorization: PS01_AUTH,
      assertion: assertionToken,
      body: {
        account_id: 'acc_ps01_test_01',
        plan_id: 'founding-c2',
        operation_id: 'op_body_binding_02',
        success_return_ref: 'default',
        cancel_return_ref: 'default',
      },
    });

    await assertDeniedResponse(res, 403, 'ACCOUNT_ASSERTION_MISMATCH');
    assertNoProviderObjects(stripeState);
    assertNoDurableOperations(mockDb);
    assertNoPortalOrCustomerDbRows(mockDb);
  } finally {
    await close();
  }
});

test('negative authority: future-issued assertion and over-long assertion lifetime fail closed', async () => {
  const { runtime, stripeState, mockDb } = createTestHarness();
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    const now = Math.floor(Date.now() / 1000);

    const futureAssertion = await buildValidAssertion({
      account_id: 'acc_ps01_test_01',
      operation_id: 'op_future_assertion',
      action: 'checkout',
      iat: now + 120,
      exp: now + 360,
    });
    const futureRes = await postCheckout(baseUrl, {
      authorization: PS01_AUTH,
      assertion: futureAssertion,
      body: {
        account_id: 'acc_ps01_test_01',
        plan_id: 'founding-c2',
        operation_id: 'op_future_assertion',
        success_return_ref: 'default',
        cancel_return_ref: 'default',
      },
    });
    await assertDeniedResponse(futureRes, 401, 'ACCOUNT_ASSERTION_EXPIRED');

    const longAssertion = await buildValidAssertion({
      account_id: 'acc_ps01_test_01',
      operation_id: 'op_long_assertion',
      action: 'checkout',
      iat: now,
      exp: now + 400,
    });
    const longRes = await postCheckout(baseUrl, {
      authorization: PS01_AUTH,
      assertion: longAssertion,
      body: {
        account_id: 'acc_ps01_test_01',
        plan_id: 'founding-c2',
        operation_id: 'op_long_assertion',
        success_return_ref: 'default',
        cancel_return_ref: 'default',
      },
    });
    await assertDeniedResponse(longRes, 401, 'ACCOUNT_ASSERTION_INVALID');

    assertNoProviderObjects(stripeState);
    assertNoDurableOperations(mockDb);
    assertNoPortalOrCustomerDbRows(mockDb);
  } finally {
    await close();
  }
});

test('negative authority: read route denies assertion bound to a different account', async () => {
  const { runtime, mockDb } = createTestHarness();
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    const assertionToken = await buildValidAssertion({
      account_id: 'acc_ps01_test_01',
      operation_id: 'op_status_read_01',
      action: 'subscription_status',
    });

    const res = await fetch(
      `${baseUrl}/v1/subscription/status?account_id=acc_other_account&operation_id=op_status_read_01`,
      {
        headers: {
          authorization: PS01_AUTH,
          'x-wstera-account-assertion': assertionToken,
        },
      },
    );

    await assertDeniedResponse(res, 403, 'ACCOUNT_ASSERTION_MISMATCH');
    assert.equal(mockDb.auditEvents.length, 0, 'no audit event may be emitted for a denied read');
  } finally {
    await close();
  }
});

test('negative authority: portal request without provider customer mapping creates no portal session', async () => {
  const { runtime, stripeState, mockDb } = createTestHarness();
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    const assertionToken = await buildValidAssertion({
      account_id: 'acc_ps01_portal_missing',
      operation_id: 'op_portal_missing_01',
      action: 'portal',
    });

    const res = await fetch(`${baseUrl}/v1/portal`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: PS01_AUTH,
        'x-wstera-account-assertion': assertionToken,
      },
      body: JSON.stringify({
        account_id: 'acc_ps01_portal_missing',
        operation_id: 'op_portal_missing_01',
        return_ref: 'default',
      }),
    });

    await assertDeniedResponse(res, 404, 'PORTAL_CUSTOMER_NOT_FOUND');
    assert.equal(stripeState.createdSessions.length, 0, 'no portal session may be created');
    assert.equal(stripeState.createdCustomers.length, 0, 'no customer may be created as a side effect');
    assertNoDurableOperations(mockDb);
    assertNoPortalOrCustomerDbRows(mockDb);
  } finally {
    await close();
  }
});

test('negative authority: portal return_ref outside the allowlist fails closed', async () => {
  const { runtime, stripeState, mockDb } = createTestHarness();
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    const checkoutAssertion = await buildValidAssertion({
      account_id: 'acc_ps01_test_01',
      operation_id: 'op_portal_setup_checkout',
      action: 'checkout',
    });
    const checkoutRes = await postCheckout(baseUrl, {
      authorization: PS01_AUTH,
      assertion: checkoutAssertion,
      body: {
        account_id: 'acc_ps01_test_01',
        plan_id: 'founding-c2',
        operation_id: 'op_portal_setup_checkout',
        success_return_ref: 'default',
        cancel_return_ref: 'default',
      },
    });
    assert.equal(checkoutRes.status, 201);
    const sessionsAfterSetup = stripeState.createdSessions.length;
    assert.equal(sessionsAfterSetup, 1);

    const portalAssertion = await buildValidAssertion({
      account_id: 'acc_ps01_test_01',
      operation_id: 'op_portal_evil_ref',
      action: 'portal',
    });

    const res = await fetch(`${baseUrl}/v1/portal`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: PS01_AUTH,
        'x-wstera-account-assertion': portalAssertion,
      },
      body: JSON.stringify({
        account_id: 'acc_ps01_test_01',
        operation_id: 'op_portal_evil_ref',
        return_ref: 'https://evil.example/pwn',
      }),
    });

    await assertDeniedResponse(res, 400, 'RETURN_REF_DENIED');
    assert.equal(stripeState.createdSessions.length, sessionsAfterSetup, 'no new checkout or portal object may be created');
    assert.equal(stripeState.createdCustomers.length, 1, 'no additional customer may be created');
    const portalOps = [...mockDb.operations.values()].filter((op) => op.route === '/v1/portal');
    assert.equal(portalOps.length, 1, 'the denied portal attempt is recorded only in the idempotency ledger');
    assert.equal(portalOps[0].status, 'failed', 'the denied portal operation must not complete');
    assert.equal(portalOps[0].errorCode, 'RETURN_REF_DENIED', 'the ledger records the denial code');
  } finally {
    await close();
  }
});

test('negative authority: caller cannot supply customer, return URL, or profile version in the body', async () => {
  const { runtime, stripeState, mockDb } = createTestHarness();
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    const attempts = [
      { customer: 'cus_spoofed_999' },
      { return_url: 'https://evil.example/success' },
      { profile_version: 2 },
      { amountMinor: 1 },
    ];

    for (const [index, extra] of attempts.entries()) {
      const assertionToken = await buildValidAssertion({
        account_id: 'acc_ps01_test_01',
        operation_id: `op_body_spoof_${index}`,
        action: 'checkout',
      });

      const res = await postCheckout(baseUrl, {
        authorization: PS01_AUTH,
        assertion: assertionToken,
        body: {
          account_id: 'acc_ps01_test_01',
          plan_id: 'founding-c2',
          operation_id: `op_body_spoof_${index}`,
          success_return_ref: 'default',
          cancel_return_ref: 'default',
          ...extra,
        },
      });

      await assertDeniedResponse(res, 400, 'CALLER_AUTHORITY_OVERRIDE');
    }

    assertNoProviderObjects(stripeState);
    assertNoDurableOperations(mockDb);
    assertNoPortalOrCustomerDbRows(mockDb);
  } finally {
    await close();
  }
});

test('negative authority: credential from another product cannot verify a PS01-signed assertion', async () => {
  const { runtime, stripeState, mockDb } = createTestHarness();
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    const assertionToken = await buildValidAssertion({
      account_id: 'acc_ps01_test_01',
      operation_id: 'op_token_cross_product',
      action: 'checkout',
    });

    const res = await postCheckout(baseUrl, {
      authorization: LK01_AUTH,
      assertion: assertionToken,
      body: {
        account_id: 'acc_ps01_test_01',
        plan_id: 'founding-c2',
        operation_id: 'op_token_cross_product',
        success_return_ref: 'default',
        cancel_return_ref: 'default',
      },
    });

    await assertDeniedResponse(res, 401, 'ACCOUNT_ASSERTION_INVALID');
    assertNoProviderObjects(stripeState);
    assertNoDurableOperations(mockDb);
    assertNoPortalOrCustomerDbRows(mockDb);
  } finally {
    await close();
  }
});

test('negative authority: Stripe webhook livemode event is denied without durable claim', async () => {
  const { runtime, stripeState, mockDb } = createTestHarness();
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    const now = Math.floor(Date.now() / 1000);
    const event = {
      id: 'evt_test_livemode_denied_01',
      type: 'checkout.session.completed',
      livemode: true,
      data: {
        object: {
          id: 'cs_test_livemode_denied_01',
          object: 'checkout.session',
          customer: 'cus_test_100',
          livemode: true,
          metadata: {},
        },
      },
    };
    const payload = JSON.stringify(event);
    const signature = crypto.createHmac('sha256', 'whsec_test_stripe_webhook_secret_01')
      .update(`${now}.${payload}`)
      .digest('hex');

    const res = await fetch(`${baseUrl}/webhooks/stripe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': `t=${now},v1=${signature}`,
      },
      body: payload,
    });

    await assertDeniedResponse(res, 403, 'LIVE_WEBHOOK_DENIED');
    assertNoProviderObjects(stripeState);
    assertNoDurableOperations(mockDb);
    assert.equal(mockDb.auditEvents.length, 0, 'no durable webhook intake may be recorded');
  } finally {
    await close();
  }
});

test('negative authority: replayed webhook with stale timestamp is denied', async () => {
  const { runtime, stripeState, mockDb } = createTestHarness();
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    const now = Math.floor(Date.now() / 1000);
    const staleTimestamp = now - 600;
    const event = {
      id: 'evt_test_stale_replay_01',
      type: 'checkout.session.completed',
      livemode: false,
      data: {
        object: {
          id: 'cs_test_500',
          object: 'checkout.session',
          customer: 'cus_test_100',
          metadata: {},
        },
      },
    };
    const payload = JSON.stringify(event);
    const signature = crypto.createHmac('sha256', 'whsec_test_stripe_webhook_secret_01')
      .update(`${staleTimestamp}.${payload}`)
      .digest('hex');

    const res = await fetch(`${baseUrl}/webhooks/stripe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': `t=${staleTimestamp},v1=${signature}`,
      },
      body: payload,
    });

    await assertDeniedResponse(res, 400, 'WEBHOOK_TIMESTAMP_INVALID');
    assertNoProviderObjects(stripeState);
    assertNoDurableOperations(mockDb);
  } finally {
    await close();
  }
});

test('negative authority: query parameters fail closed on healthz and portal routes', async () => {
  const { runtime, stripeState, mockDb } = createTestHarness();
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    const healthRes = await fetch(`${baseUrl}/healthz?price_id=price_query_override`);
    await assertDeniedResponse(healthRes, 400, 'CALLER_AUTHORITY_OVERRIDE');

    const assertionToken = await buildValidAssertion({
      account_id: 'acc_ps01_test_01',
      operation_id: 'op_portal_query_spoof',
      action: 'portal',
    });
    const portalRes = await fetch(`${baseUrl}/v1/portal?customer_id=cus_spoofed_777`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: PS01_AUTH,
        'x-wstera-account-assertion': assertionToken,
      },
      body: JSON.stringify({
        account_id: 'acc_ps01_test_01',
        operation_id: 'op_portal_query_spoof',
        return_ref: 'default',
      }),
    });
    await assertDeniedResponse(portalRes, 400, 'CALLER_AUTHORITY_OVERRIDE');

    assertNoProviderObjects(stripeState);
    assertNoDurableOperations(mockDb);
    assertNoPortalOrCustomerDbRows(mockDb);
  } finally {
    await close();
  }
});

test('negative authority: credential pinned to an unregistered profile version cannot bootstrap', async () => {
  const { runtime, stripeState, mockDb } = createTestHarness({
    config: {
      credentials: [
        {
          keyId: 'ps01-v2-token-key-01',
          token: 'wstera-test-token-ps01-v2-0002',
          productId: PS01_PRODUCT_ID,
          environment: 'test',
          profileVersion: 2,
          scopes: ['checkout'],
        },
      ],
    },
  });
  await assert.rejects(
    () => runtime.initialize(),
    (error) => error instanceof Error && /exact profile version not found/.test(error.message),
  );
  assertNoProviderObjects(stripeState);
  assertNoDurableOperations(mockDb);
  assertNoPortalOrCustomerDbRows(mockDb);
});