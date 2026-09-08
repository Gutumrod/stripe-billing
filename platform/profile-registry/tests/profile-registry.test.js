const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ProductBillingProfileRegistry,
  ProfileActivationError,
  ProfileResolutionError,
  ProfileValidationError,
  assertAccountBound,
} = require('../dist/src');
const { ps01TestProfile } = require('../dist/profiles/PS01.test');

function cloneProfile(profile) {
  return structuredClone(profile);
}

function activatableProfile(version = 1) {
  const profile = cloneProfile(ps01TestProfile);
  profile.profileVersion = version;
  profile.providerMappings.stripe.test.stripeProductId = 'prod_test_ps01';
  profile.providerMappings.stripe.test.stripePriceIds['founding-c2'] = 'price_test_ps01_founding_c2';
  profile.admission.testRunId = `test-run-${version}`;
  profile.admission.isolationEvidenceRef = `evidence://ps01/isolation/${version}`;
  return profile;
}

test('PS01 registers only as pending_validation', () => {
  const registry = new ProductBillingProfileRegistry();
  const registered = registry.register(ps01TestProfile);
  assert.equal(registered.status, 'pending_validation');
});
test('PS01 cannot activate until admission evidence is complete', () => {
  const registry = new ProductBillingProfileRegistry();
  registry.register(ps01TestProfile);
  assert.throws(
    () => registry.activate(ps01TestProfile.productId, 'test', 1, 'owner'),
    (error) => error instanceof ProfileActivationError && error.reasons.some((r) => r.includes('admission.testRunId')),
  );
});

test('runtime resolution rejects caller product spoofing', () => {
  const registry = new ProductBillingProfileRegistry();
  registry.register(activatableProfile());
  registry.activate(ps01TestProfile.productId, 'test', 1, 'owner');
  assert.throws(() => registry.resolveForRuntime({
    credentialProductId: ps01TestProfile.productId,
    requestedProductId: 'prd_other',
    environment: 'test',
    profileVersion: 1,
  }), ProfileResolutionError);
});

test('runtime resolution is exact by product, environment, and version', () => {
  const registry = new ProductBillingProfileRegistry();
  registry.register(activatableProfile());
  registry.activate(ps01TestProfile.productId, 'test', 1, 'owner');
  assert.equal(registry.resolveForRuntime({
    credentialProductId: ps01TestProfile.productId,
    environment: 'test',
    profileVersion: 1,
  }).productCode, 'PS01');
  assert.throws(() => registry.resolveForRuntime({
    credentialProductId: ps01TestProfile.productId,
    environment: 'live',
    profileVersion: 1,
  }), ProfileResolutionError);
  assert.throws(() => registry.resolveForRuntime({
    credentialProductId: ps01TestProfile.productId,
    environment: 'test',
    profileVersion: 2,
  }), ProfileResolutionError);
});

test('duplicate exact profile version is rejected', () => {
  const registry = new ProductBillingProfileRegistry();
  registry.register(ps01TestProfile);
  assert.throws(() => registry.register(ps01TestProfile), ProfileValidationError);
});

test('partial paid mapping cannot activate', () => {
  const registry = new ProductBillingProfileRegistry();
  const profile = activatableProfile();
  delete profile.providerMappings.stripe.test.stripePriceIds['founding-c2'];
  registry.register(profile);
  assert.throws(() => registry.activate(profile.productId, 'test', 1, 'owner'), ProfileActivationError);
});

test('replacement activation requires rollback to current active version', () => {
  const registry = new ProductBillingProfileRegistry();
  const v1 = activatableProfile(1);
  registry.register(v1);
  registry.activate(v1.productId, 'test', 1, 'owner');

  const v2 = activatableProfile(2);
  registry.register(v2);
  assert.throws(() => registry.activate(v2.productId, 'test', 2, 'owner'), ProfileActivationError);

  const registry2 = new ProductBillingProfileRegistry();
  registry2.register(v1);
  registry2.activate(v1.productId, 'test', 1, 'owner');
  const v2WithRollback = activatableProfile(2);
  v2WithRollback.admission.rollbackProfileVersion = 1;
  registry2.register(v2WithRollback);
  assert.equal(registry2.activate(v2WithRollback.productId, 'test', 2, 'owner').profileVersion, 2);
});

test('account-scoped context fails closed without verified assertion', () => {
  assert.throws(() => assertAccountBound({
    credentialProductId: ps01TestProfile.productId,
    environment: 'test',
    profileVersion: 1,
    accountId: 'tenant-a',
    operationId: 'checkout-1',
    accountAssertionVerified: false,
  }), ProfileResolutionError);
});
