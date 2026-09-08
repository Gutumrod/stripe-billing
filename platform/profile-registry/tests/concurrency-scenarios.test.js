const test = require('node:test');
const assert = require('node:assert/strict');
const { ProductBillingProfileRegistry, assertAccountBound } = require('../dist/src');
const { ps01TestProfile } = require('../dist/profiles/PS01.test');
const { lk01TestProfile } = require('../dist/profiles/LK01.test');

function clone(value) { return structuredClone(value); }

function activateFixture(registry, source, stripeProductId, prices) {
  const profile = clone(source);
  profile.providerMappings.stripe.test.stripeProductId = stripeProductId;
  profile.providerMappings.stripe.test.stripePriceIds = { ...prices };
  profile.admission.testRunId = `local-fixture-${profile.productCode}`;
  profile.admission.isolationEvidenceRef = `fixture://isolation/${profile.productCode}`;
  profile.admission.providerLifecycleEvidenceRef = `fixture://provider/${profile.productCode}`;
  profile.admission.accountBindingEvidenceRef = `fixture://account-binding/${profile.productCode}`;
  profile.admission.webhookEvidenceRef = `fixture://webhook/${profile.productCode}`;
  profile.admission.reconciliationEvidenceRef = `fixture://reconciliation/${profile.productCode}`;
  profile.admission.entitlementEvidenceRef = `fixture://entitlement/${profile.productCode}`;
  profile.admission.auditEvidenceRef = `fixture://audit/${profile.productCode}`;
  registry.register(profile);
  return registry.activate(profile.productId, 'test', profile.profileVersion, 'local-test-harness');
}

class LocalBillingLifecycleHarness {
  constructor(registry) {
    this.registry = registry;
    this.states = new Map();
    this.locks = new Map();
  }

  key(productId, accountId) { return `${productId}::${accountId}`; }
  async serial(productId, accountId, work) {
    const key = this.key(productId, accountId);
    const previous = this.locks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.locks.set(key, tail);
    await previous;
    try { return await work(); }
    finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  async subscribe(context, planId) {
    assertAccountBound(context);
    return this.serial(context.credentialProductId, context.accountId, async () => {
      const profile = this.registry.resolveForRuntime(context);
      const plan = profile.plans.find((p) => p.planId === planId);
      if (!plan || plan.model !== 'subscription') throw new Error('subscription plan required');
      const key = this.key(profile.productId, context.accountId);
      const previous = this.states.get(key);
      if (previous?.lastOperationId === context.operationId) return previous;
      const next = Object.freeze({ productId: profile.productId, productCode: profile.productCode,
        accountId: context.accountId, planId, status: 'active', revision: (previous?.revision || 0) + 1,
        lastOperationId: context.operationId });
      this.states.set(key, next);
      await Promise.resolve();
      return next;
    });
  }
  async cancel(context) {
    assertAccountBound(context);
    return this.serial(context.credentialProductId, context.accountId, async () => {
      const profile = this.registry.resolveForRuntime(context);
      const key = this.key(profile.productId, context.accountId);
      const previous = this.states.get(key);
      if (!previous) throw new Error('subscription not found');
      if (previous.lastOperationId === context.operationId) return previous;
      const next = Object.freeze({ ...previous, status: 'cancelled', revision: previous.revision + 1,
        lastOperationId: context.operationId });
      this.states.set(key, next);
      await Promise.resolve();
      return next;
    });
  }

  get(productId, accountId) { return this.states.get(this.key(productId, accountId)) || null; }
}

function buildHarness() {
  const registry = new ProductBillingProfileRegistry();
  activateFixture(registry, ps01TestProfile, 'prod_fixture_ps01', {
    'founding-c2': 'price_fixture_ps01_founding_c2',
  });
  activateFixture(registry, lk01TestProfile, 'prod_fixture_lk01', {
    pro: 'price_fixture_lk01_pro', business: 'price_fixture_lk01_business',
  });
  return new LocalBillingLifecycleHarness(registry);
}

function context(profile, accountId, operationId) {
  return { credentialProductId: profile.productId, requestedProductId: profile.productId,
    environment: 'test', profileVersion: 1, accountId, operationId, accountAssertionVerified: true };
}
test('customers 1-3 subscribe separately across PS01/LK01 without state bleed', async () => {
  const h = buildHarness();
  await h.subscribe(context(ps01TestProfile, 'customer-1', 'c1-sub'), 'founding-c2');
  await h.subscribe(context(lk01TestProfile, 'customer-2', 'c2-sub'), 'pro');
  await h.subscribe(context(ps01TestProfile, 'customer-3', 'c3-sub'), 'founding-c2');
  assert.equal(h.get(ps01TestProfile.productId, 'customer-1').status, 'active');
  assert.equal(h.get(lk01TestProfile.productId, 'customer-2').productCode, 'LK01');
  assert.equal(h.get(ps01TestProfile.productId, 'customer-3').productCode, 'PS01');
});

test('customers 1-3 subscribe simultaneously', async () => {
  const h = buildHarness();
  await Promise.all([
    h.subscribe(context(ps01TestProfile, 'customer-1', 'all-sub-1'), 'founding-c2'),
    h.subscribe(context(lk01TestProfile, 'customer-2', 'all-sub-2'), 'business'),
    h.subscribe(context(ps01TestProfile, 'customer-3', 'all-sub-3'), 'founding-c2'),
  ]);
  assert.equal(h.get(ps01TestProfile.productId, 'customer-1').status, 'active');
  assert.equal(h.get(lk01TestProfile.productId, 'customer-2').planId, 'business');
  assert.equal(h.get(ps01TestProfile.productId, 'customer-3').status, 'active');
});
test('customers 1-3 cancel simultaneously after active subscriptions', async () => {
  const h = buildHarness();
  await Promise.all([
    h.subscribe(context(ps01TestProfile, 'customer-1', 'seed-1'), 'founding-c2'),
    h.subscribe(context(lk01TestProfile, 'customer-2', 'seed-2'), 'pro'),
    h.subscribe(context(ps01TestProfile, 'customer-3', 'seed-3'), 'founding-c2'),
  ]);
  await Promise.all([
    h.cancel(context(ps01TestProfile, 'customer-1', 'cancel-1')),
    h.cancel(context(lk01TestProfile, 'customer-2', 'cancel-2')),
    h.cancel(context(ps01TestProfile, 'customer-3', 'cancel-3')),
  ]);
  assert.equal(h.get(ps01TestProfile.productId, 'customer-1').status, 'cancelled');
  assert.equal(h.get(lk01TestProfile.productId, 'customer-2').status, 'cancelled');
  assert.equal(h.get(ps01TestProfile.productId, 'customer-3').status, 'cancelled');
});

test('all subscribe then only customer 2 cancels', async () => {
  const h = buildHarness();
  await Promise.all([
    h.subscribe(context(ps01TestProfile, 'customer-1', 'mix-1'), 'founding-c2'),
    h.subscribe(context(lk01TestProfile, 'customer-2', 'mix-2'), 'pro'),
    h.subscribe(context(ps01TestProfile, 'customer-3', 'mix-3'), 'founding-c2'),
  ]);
  await h.cancel(context(lk01TestProfile, 'customer-2', 'mix-cancel-2'));
  assert.equal(h.get(ps01TestProfile.productId, 'customer-1').status, 'active');
  assert.equal(h.get(lk01TestProfile.productId, 'customer-2').status, 'cancelled');
  assert.equal(h.get(ps01TestProfile.productId, 'customer-3').status, 'active');
});
test('all subscribe then customers 1 and 2 cancel together; customer 3 stays active', async () => {
  const h = buildHarness();
  await Promise.all([
    h.subscribe(context(ps01TestProfile, 'customer-1', 'pair-seed-1'), 'founding-c2'),
    h.subscribe(context(lk01TestProfile, 'customer-2', 'pair-seed-2'), 'business'),
    h.subscribe(context(ps01TestProfile, 'customer-3', 'pair-seed-3'), 'founding-c2'),
  ]);
  await Promise.all([
    h.cancel(context(ps01TestProfile, 'customer-1', 'pair-cancel-1')),
    h.cancel(context(lk01TestProfile, 'customer-2', 'pair-cancel-2')),
  ]);
  assert.equal(h.get(ps01TestProfile.productId, 'customer-1').status, 'cancelled');
  assert.equal(h.get(lk01TestProfile.productId, 'customer-2').status, 'cancelled');
  assert.equal(h.get(ps01TestProfile.productId, 'customer-3').status, 'active');
});

test('same account id in two products remains isolated', async () => {
  const h = buildHarness();
  await Promise.all([
    h.subscribe(context(ps01TestProfile, 'shared-account', 'shared-ps'), 'founding-c2'),
    h.subscribe(context(lk01TestProfile, 'shared-account', 'shared-lk'), 'pro'),
  ]);
  await h.cancel(context(ps01TestProfile, 'shared-account', 'shared-ps-cancel'));
  assert.equal(h.get(ps01TestProfile.productId, 'shared-account').status, 'cancelled');
  assert.equal(h.get(lk01TestProfile.productId, 'shared-account').status, 'active');
});
test('same-account cancel then resubscribe is serialized deterministically', async () => {
  const h = buildHarness();
  await h.subscribe(context(ps01TestProfile, 'customer-race', 'race-seed'), 'founding-c2');
  await Promise.all([
    h.cancel(context(ps01TestProfile, 'customer-race', 'race-cancel')),
    h.subscribe(context(ps01TestProfile, 'customer-race', 'race-resub'), 'founding-c2'),
  ]);
  const finalState = h.get(ps01TestProfile.productId, 'customer-race');
  assert.equal(finalState.status, 'active');
  assert.equal(finalState.revision, 3);
  assert.equal(finalState.lastOperationId, 'race-resub');
});

test('cross-product spoof is rejected during concurrent operations', async () => {
  const h = buildHarness();
  const spoof = context(ps01TestProfile, 'customer-spoof', 'spoof-1');
  spoof.requestedProductId = lk01TestProfile.productId;
  await assert.rejects(() => h.subscribe(spoof, 'founding-c2'));
  assert.equal(h.get(ps01TestProfile.productId, 'customer-spoof'), null);
  assert.equal(h.get(lk01TestProfile.productId, 'customer-spoof'), null);
});
