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
  const token = await signAccountAssertion(payload, secret);
  return token;
}

test('valid PS01 Test checkout creates checkout session through real HTTP server boundary', async () => {
  const { runtime, mockDb, stripeState } = createTestHarness();
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    const assertionToken = await buildValidAssertion({
      account_id: 'acc_ps01_test_01',
      operation_id: 'op_checkout_01',
      action: 'checkout',
    });

    const res = await fetch(`${baseUrl}/v1/checkout`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer wstera-test-token-ps01-9999',
        'x-wstera-account-assertion': assertionToken,
      },
      body: JSON.stringify({
        account_id: 'acc_ps01_test_01',
        plan_id: 'founding-c2',
        operation_id: 'op_checkout_01',
        success_return_ref: 'default',
        cancel_return_ref: 'default',
      }),
    });

    assert.equal(res.status, 201);
    const data = await res.json();
    assert.ok(data.checkout_session_id.startsWith('cs_test_'));
    assert.ok(data.checkout_url.startsWith('https://checkout.stripe.com/c/pay/cs_test_'));
    assert.equal(data.status, 'open');
    assert.ok(data.correlation_id);

    // Verify DB persistence of operation
    const op = mockDb.operations.get(`test:${PS01_PRODUCT_ID}:acc_ps01_test_01:/v1/checkout:op_checkout_01`);
    assert.ok(op);
    assert.equal(op.status, 'completed');
    assert.equal(op.providerObjectId, data.checkout_session_id);

    // Verify DB persistence of customer mapping
    const cust = mockDb.customers.get(`test:${PS01_PRODUCT_ID}:acc_ps01_test_01`);
    assert.ok(cust);
    assert.equal(cust.state, 'ready');
    assert.ok(cust.providerCustomerId.startsWith('cus_test_'));

    // Verify Stripe customer creation metadata
    assert.equal(stripeState.createdCustomers.length, 1);
    const stripeCust = stripeState.createdCustomers[0];
    assert.equal(stripeCust.metadata.wstera_product_id, PS01_PRODUCT_ID);
    assert.equal(stripeCust.metadata.wstera_product_code, 'PS01');
    assert.equal(stripeCust.metadata.account_id, 'acc_ps01_test_01');
    assert.equal(stripeCust.metadata.profile_version, '1');

    // Verify Stripe checkout session creation parameters (derived server-side)
    assert.equal(stripeState.createdSessions.length, 1);
    const session = stripeState.createdSessions[0];
    assert.equal(session.customer, cust.providerCustomerId);
    assert.equal(session.line_items[0].price, 'price_1UDCxyHB4GRCffd9RyaDWZ1c'); // from locked PS01 profile
    assert.equal(session.success_url, 'https://pawstia.app/checkout/success'); // from locked returnUrls
    assert.equal(session.cancel_url, 'https://pawstia.app/checkout/cancel'); // from locked returnUrls
    assert.equal(session.metadata.plan_id, 'founding-c2');
    assert.equal(session.metadata.operation_id, 'op_checkout_01');

    // Verify Audit logging
    const checkoutAudits = mockDb.auditEvents.filter((e) => e.eventName === 'checkout.created');
    assert.equal(checkoutAudits.length, 1);
    assert.equal(checkoutAudits[0].outcome, 'success');
    assert.equal(checkoutAudits[0].providerObjectId, data.checkout_session_id);

    // Verify re-fetch of provider object as financial truth
    const retrieved = await runtime.stripe.retrieveCheckoutSession(data.checkout_session_id);
    assert.equal(retrieved.id, data.checkout_session_id);
    assert.equal(retrieved.status, 'open');
  } finally {
    await close();
  }
});

test('idempotent replay of completed checkout re-fetches Stripe Test session and returns 200', async () => {
  const { runtime, stripeState } = createTestHarness();
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    const assertionToken = await buildValidAssertion({
      account_id: 'acc_ps01_test_01',
      operation_id: 'op_checkout_01',
      action: 'checkout',
    });

    const payload = JSON.stringify({
      account_id: 'acc_ps01_test_01',
      plan_id: 'founding-c2',
      operation_id: 'op_checkout_01',
      success_return_ref: 'default',
      cancel_return_ref: 'default',
    });

    // 1st request -> 201 Created
    const res1 = await fetch(`${baseUrl}/v1/checkout`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer wstera-test-token-ps01-9999',
        'x-wstera-account-assertion': assertionToken,
      },
      body: payload,
    });
    assert.equal(res1.status, 201);
    const data1 = await res1.json();
    assert.equal(stripeState.createdSessions.length, 1);
    assert.equal(stripeState.retrievedSessions.length, 0);

    // 2nd request with exact same payload -> 200 OK idempotent replay with re-fetch
    const res2 = await fetch(`${baseUrl}/v1/checkout`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer wstera-test-token-ps01-9999',
        'x-wstera-account-assertion': assertionToken,
      },
      body: payload,
    });
    assert.equal(res2.status, 200);
    const data2 = await res2.json();
    assert.equal(data2.idempotent_replay, true);
    assert.equal(data2.checkout_session_id, data1.checkout_session_id);
    assert.equal(data2.status, 'open');

    // Proves provider object re-fetch path was invoked
    assert.equal(stripeState.retrievedSessions.length, 1);
    assert.equal(stripeState.retrievedSessions[0], data1.checkout_session_id);

    // Proves no duplicate checkout session was created in Stripe
    assert.equal(stripeState.createdSessions.length, 1);
  } finally {
    await close();
  }
});

test('idempotency conflict fails closed when operation ID is reused with different request', async () => {
  const { runtime, stripeState } = createTestHarness();
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    const assertionToken = await buildValidAssertion({
      account_id: 'acc_ps01_test_01',
      operation_id: 'op_checkout_conflict_01',
      action: 'checkout',
    });

    // 1st call
    const res1 = await fetch(`${baseUrl}/v1/checkout`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer wstera-test-token-ps01-9999',
        'x-wstera-account-assertion': assertionToken,
      },
      body: JSON.stringify({
        account_id: 'acc_ps01_test_01',
        plan_id: 'founding-c2',
        operation_id: 'op_checkout_conflict_01',
        success_return_ref: 'default',
        cancel_return_ref: 'default',
      }),
    });
    assert.equal(res1.status, 201);
    assert.equal(stripeState.createdSessions.length, 1);

    // 2nd call: same operation ID, different cancel_return_ref -> fails closed
    const res2 = await fetch(`${baseUrl}/v1/checkout`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer wstera-test-token-ps01-9999',
        'x-wstera-account-assertion': assertionToken,
      },
      body: JSON.stringify({
        account_id: 'acc_ps01_test_01',
        plan_id: 'founding-c2',
        operation_id: 'op_checkout_conflict_01',
        success_return_ref: 'default',
        cancel_return_ref: 'non_default_ref',
      }),
    });
    assert.equal(res2.status, 400); // non_default_ref rejected by returnUrl check or 409
    // No new session was created in Stripe
    assert.equal(stripeState.createdSessions.length, 1);
  } finally {
    await close();
  }
});

test('negative authority: caller cannot override Stripe Price ID in request body', async () => {
  const { runtime, stripeState } = createTestHarness();
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    const assertionToken = await buildValidAssertion({
      account_id: 'acc_ps01_test_01',
      operation_id: 'op_price_override',
      action: 'checkout',
    });

    const res = await fetch(`${baseUrl}/v1/checkout`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer wstera-test-token-ps01-9999',
        'x-wstera-account-assertion': assertionToken,
      },
      body: JSON.stringify({
        account_id: 'acc_ps01_test_01',
        plan_id: 'founding-c2',
        operation_id: 'op_price_override',
        success_return_ref: 'default',
        cancel_return_ref: 'default',
        price_id: 'price_spoofed_000',
      }),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'CALLER_AUTHORITY_OVERRIDE');
    assert.equal(stripeState.createdSessions.length, 0);
  } finally {
    await close();
  }
});

test('negative authority: caller cannot override amount or currency in request body', async () => {
  const { runtime, stripeState } = createTestHarness();
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    const assertionToken = await buildValidAssertion({
      account_id: 'acc_ps01_test_01',
      operation_id: 'op_amount_override',
      action: 'checkout',
    });

    const res = await fetch(`${baseUrl}/v1/checkout`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer wstera-test-token-ps01-9999',
        'x-wstera-account-assertion': assertionToken,
      },
      body: JSON.stringify({
        account_id: 'acc_ps01_test_01',
        plan_id: 'founding-c2',
        operation_id: 'op_amount_override',
        success_return_ref: 'default',
        cancel_return_ref: 'default',
        amount_minor: 1,
        currency: 'USD',
      }),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'CALLER_AUTHORITY_OVERRIDE');
    assert.equal(stripeState.createdSessions.length, 0);
  } finally {
    await close();
  }
});

test('negative authority: caller cannot override provider customer ID or return URLs', async () => {
  const { runtime, stripeState } = createTestHarness();
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    const assertionToken = await buildValidAssertion({
      account_id: 'acc_ps01_test_01',
      operation_id: 'op_customer_override',
      action: 'checkout',
    });

    const res = await fetch(`${baseUrl}/v1/checkout`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer wstera-test-token-ps01-9999',
        'x-wstera-account-assertion': assertionToken,
      },
      body: JSON.stringify({
        account_id: 'acc_ps01_test_01',
        plan_id: 'founding-c2',
        operation_id: 'op_customer_override',
        success_return_ref: 'default',
        cancel_return_ref: 'default',
        customer_id: 'cus_spoofed_999',
        success_url: 'https://evil.com/pwn',
      }),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'CALLER_AUTHORITY_OVERRIDE');
    assert.equal(stripeState.createdSessions.length, 0);
  } finally {
    await close();
  }
});

test('negative authority: unallowlisted return URL ref fails closed', async () => {
  const { runtime, stripeState } = createTestHarness();
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    const assertionToken = await buildValidAssertion({
      account_id: 'acc_ps01_test_01',
      operation_id: 'op_unallowlisted_ref',
      action: 'checkout',
    });

    const res = await fetch(`${baseUrl}/v1/checkout`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer wstera-test-token-ps01-9999',
        'x-wstera-account-assertion': assertionToken,
      },
      body: JSON.stringify({
        account_id: 'acc_ps01_test_01',
        plan_id: 'founding-c2',
        operation_id: 'op_unallowlisted_ref',
        success_return_ref: 'untrusted_ref_xyz',
        cancel_return_ref: 'default',
      }),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'RETURN_REF_DENIED');
    assert.equal(stripeState.createdSessions.length, 0);
  } finally {
    await close();
  }
});

test('negative authority: query params on POST /v1/checkout fail closed', async () => {
  const { runtime, stripeState } = createTestHarness();
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    const assertionToken = await buildValidAssertion({
      account_id: 'acc_ps01_test_01',
      operation_id: 'op_query_spoof',
      action: 'checkout',
    });

    const res = await fetch(`${baseUrl}/v1/checkout?price_id=price_query_override&amount=10`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer wstera-test-token-ps01-9999',
        'x-wstera-account-assertion': assertionToken,
      },
      body: JSON.stringify({
        account_id: 'acc_ps01_test_01',
        plan_id: 'founding-c2',
        operation_id: 'op_query_spoof',
        success_return_ref: 'default',
        cancel_return_ref: 'default',
      }),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'CALLER_AUTHORITY_OVERRIDE');
    assert.equal(stripeState.createdSessions.length, 0);
  } finally {
    await close();
  }
});

test('negative authority: prohibited x-wstera-* headers fail closed', async () => {
  const { runtime, stripeState } = createTestHarness();
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    const assertionToken = await buildValidAssertion({
      account_id: 'acc_ps01_test_01',
      operation_id: 'op_header_spoof',
      action: 'checkout',
    });

    const res = await fetch(`${baseUrl}/v1/checkout`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer wstera-test-token-ps01-9999',
        'x-wstera-account-assertion': assertionToken,
        'x-wstera-price-id': 'price_header_override',
      },
      body: JSON.stringify({
        account_id: 'acc_ps01_test_01',
        plan_id: 'founding-c2',
        operation_id: 'op_header_spoof',
        success_return_ref: 'default',
        cancel_return_ref: 'default',
      }),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'CALLER_AUTHORITY_OVERRIDE');
    assert.equal(stripeState.createdSessions.length, 0);
  } finally {
    await close();
  }
});

test('negative authority: missing or tampered account assertion fails closed', async () => {
  const { runtime, stripeState } = createTestHarness();
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    // Missing assertion header
    const resMissing = await fetch(`${baseUrl}/v1/checkout`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer wstera-test-token-ps01-9999',
      },
      body: JSON.stringify({
        account_id: 'acc_ps01_test_01',
        plan_id: 'founding-c2',
        operation_id: 'op_missing_assertion',
        success_return_ref: 'default',
        cancel_return_ref: 'default',
      }),
    });
    assert.equal(resMissing.status, 401);
    const bodyMissing = await resMissing.json();
    assert.equal(bodyMissing.error, 'ACCOUNT_ASSERTION_REQUIRED');

    // Tampered assertion signature
    const validToken = await buildValidAssertion({
      account_id: 'acc_ps01_test_01',
      operation_id: 'op_tampered_assertion',
      action: 'checkout',
    });
    const tamperedToken = validToken.slice(0, -4) + 'zzzz';

    const resTampered = await fetch(`${baseUrl}/v1/checkout`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer wstera-test-token-ps01-9999',
        'x-wstera-account-assertion': tamperedToken,
      },
      body: JSON.stringify({
        account_id: 'acc_ps01_test_01',
        plan_id: 'founding-c2',
        operation_id: 'op_tampered_assertion',
        success_return_ref: 'default',
        cancel_return_ref: 'default',
      }),
    });
    assert.equal(resTampered.status, 401);
    const bodyTampered = await resTampered.json();
    assert.equal(bodyTampered.error, 'ACCOUNT_ASSERTION_INVALID');

    assert.equal(stripeState.createdSessions.length, 0);
  } finally {
    await close();
  }
});

test('negative authority: cross-product credential mismatch fails closed', async () => {
  const { runtime, stripeState } = createTestHarness();
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    // PS01 token presented, but assertion signed with LK01's secret key for LK01 product
    const lk01AssertionToken = await buildValidAssertion({
      iss: LK01_PRODUCT_ID,
      product_id: LK01_PRODUCT_ID,
      key_id: 'lk01-assertion-key-01',
      secret: LK01_ASSERTION_SECRET,
      account_id: 'acc_cross_product_01',
      operation_id: 'op_cross_product_01',
      action: 'checkout',
    });

    const res = await fetch(`${baseUrl}/v1/checkout`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer wstera-test-token-ps01-9999', // PS01 credential
        'x-wstera-account-assertion': lk01AssertionToken, // LK01 assertion
      },
      body: JSON.stringify({
        account_id: 'acc_cross_product_01',
        plan_id: 'founding-c2',
        operation_id: 'op_cross_product_01',
        success_return_ref: 'default',
        cancel_return_ref: 'default',
      }),
    });

    // Must fail closed (401 invalid key lookup for binding.productId)
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, 'ACCOUNT_ASSERTION_INVALID');
    assert.equal(stripeState.createdSessions.length, 0);
  } finally {
    await close();
  }
});

test('negative authority: expired account assertion fails closed', async () => {
  const { runtime, stripeState } = createTestHarness();
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    const now = Math.floor(Date.now() / 1000);
    const expiredAssertion = await buildValidAssertion({
      account_id: 'acc_ps01_test_01',
      operation_id: 'op_expired_assertion',
      action: 'checkout',
      iat: now - 600,
      exp: now - 300, // expired 5 minutes ago
    });

    const res = await fetch(`${baseUrl}/v1/checkout`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer wstera-test-token-ps01-9999',
        'x-wstera-account-assertion': expiredAssertion,
      },
      body: JSON.stringify({
        account_id: 'acc_ps01_test_01',
        plan_id: 'founding-c2',
        operation_id: 'op_expired_assertion',
        success_return_ref: 'default',
        cancel_return_ref: 'default',
      }),
    });

    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, 'ACCOUNT_ASSERTION_EXPIRED');
    assert.equal(stripeState.createdSessions.length, 0);
  } finally {
    await close();
  }
});

test('negative authority: live Stripe mode fails closed in Phase 2 Test runtime', async () => {
  const { runtime } = createTestHarness({
    stripeState: { returnLiveMode: true },
  });
  await runtime.initialize();
  const { baseUrl, close } = await startServer(runtime);

  try {
    const assertionToken = await buildValidAssertion({
      account_id: 'acc_ps01_test_01',
      operation_id: 'op_live_denied',
      action: 'checkout',
    });

    const res = await fetch(`${baseUrl}/v1/checkout`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer wstera-test-token-ps01-9999',
        'x-wstera-account-assertion': assertionToken,
      },
      body: JSON.stringify({
        account_id: 'acc_ps01_test_01',
        plan_id: 'founding-c2',
        operation_id: 'op_live_denied',
        success_return_ref: 'default',
        cancel_return_ref: 'default',
      }),
    });

    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error, 'LIVE_PROVIDER_OBJECT_DENIED');
  } finally {
    await close();
  }
});
