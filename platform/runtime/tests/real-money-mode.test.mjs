import test from 'node:test';
import assert from 'node:assert/strict';
import { StripeTestAdapter } from '../dist/stripe.js';
import { BillingRuntimeError } from '../dist/types.js';
import { CentralBillingRuntime } from '../dist/runtime.js';
import { ps01RealMoneyTestProfile } from '../../profile-registry/dist/profiles/PS01.real-money.test.js';
import { moduleHubTestProfile, moduleHubProductProfiles } from '../../profile-registry/dist/profiles/MODULE-HUB.test.js';

test('Stripe adapter requires a key prefix that matches its explicit environment', () => {
  assert.throws(
    () => new StripeTestAdapter({ secretKey: `${['sk', 'live', '_'].join('')}placeholder`, environment: 'test', fetch: async () => new Response('{}') }),
    (error) => error instanceof BillingRuntimeError && error.code === 'STRIPE_KEY_ENVIRONMENT_MISMATCH',
  );
  assert.throws(
    () => new StripeTestAdapter({ secretKey: 'sk_test_placeholder', environment: 'live', fetch: async () => new Response('{}') }),
    (error) => error instanceof BillingRuntimeError && error.code === 'STRIPE_KEY_ENVIRONMENT_MISMATCH',
  );
});

test('test runtime continues to reject live Stripe objects', async () => {
  const adapter = new StripeTestAdapter({
    secretKey: 'sk_test_placeholder',
    environment: 'test',
    fetch: async () => new Response(JSON.stringify({ id: 'cs_live_fake', livemode: true }), { status: 200 }),
  });
  await assert.rejects(
    () => adapter.retrieveCheckoutSession('cs_live_fake'),
    (error) => error instanceof BillingRuntimeError && error.code === 'LIVE_PROVIDER_OBJECT_DENIED',
  );
});

test('production environment is accepted only with the production schema and matching adapter key mode', () => {
  const config = {
    environment: 'live', schema: 'billing_core', admissionTestMode: false,
    databaseUrl: 'postgres://placeholder.invalid/billing', stripeSecretKey: `${['sk', 'live', '_'].join('')}placeholder`,
    stripeWebhookSecret: 'whsec_live_placeholder', webhookMaxBytes: 1024,
    credentials: [], assertionKeys: [], returnUrls: {}, entitlementSigningKeys: [],
    profileRegistry: { getRegistered() { throw new Error('not used'); }, resolveForRuntime() { throw new Error('not used'); } },
    logger: { info() {}, warn() {}, error() {} }, fetch: async () => new Response('{}'),
  };
  assert.doesNotThrow(() => new CentralBillingRuntime(config));
  assert.throws(
    () => new CentralBillingRuntime({ ...config, schema: 'billing_core_staging' }),
    (error) => error instanceof BillingRuntimeError && error.code === 'LIVE_RUNTIME_DENIED',
  );
});

test('one-time checkout uses Stripe payment mode and sends only the server-mapped Price', async () => {
  let captured;
  const adapter = new StripeTestAdapter({
    secretKey: 'sk_test_placeholder',
    environment: 'test',
    fetch: async (_url, init) => {
      captured = new URLSearchParams(init.body);
      return new Response(JSON.stringify({ id: 'cs_test_once', url: 'https://checkout.stripe.test/session', status: 'open', livemode: false }), { status: 200 });
    },
  });
  const session = await adapter.createOneTimeCheckout({
    customerId: 'cus_test_account', priceId: 'price_test_server_profile',
    successUrl: 'https://app.example/success', cancelUrl: 'https://app.example/cancel',
    metadata: { account_id: 'acct_1', plan_id: 'module_source' }, idempotencyKey: 'checkout-once-1',
  });
  assert.equal(captured.get('mode'), 'payment');
  assert.equal(captured.get('line_items[0][price]'), 'price_test_server_profile');
  assert.equal(captured.get('line_items[0][quantity]'), '1');
  assert.equal(captured.get('metadata[plan_id]'), 'module_source');
  assert.equal(session.id, 'cs_test_once');
});

test('PS01 version 2 keeps A-10 fixed prices server-owned and closes annual launch pricing until dates are pinned', () => {
  const plans = Object.fromEntries(ps01RealMoneyTestProfile.plans.map((plan) => [plan.planId, plan]));
  assert.equal(ps01RealMoneyTestProfile.status, 'pending_validation');
  assert.equal(ps01RealMoneyTestProfile.commercialPolicy.refundWindowDays, 7);
  assert.deepEqual(plans['starter-monthly'].pricesByCurrency, { THB: 59000, USD: 1700 });
  assert.deepEqual(plans['pro-monthly'].pricesByCurrency, { THB: 99000, USD: 2800 });
  assert.deepEqual(plans['starter-annual-launch'].pricesByCurrency, { THB: 569000, USD: 16300 });
  assert.deepEqual(plans['pro-annual-launch'].pricesByCurrency, { THB: 949000, USD: 26900 });
  assert.equal(plans['starter-annual-launch'].salesStartsAt, null);
  assert.equal(plans['starter-annual-launch'].salesEndsAt, null);
  assert.deepEqual(Object.keys(ps01RealMoneyTestProfile.providerMappings.stripe.test.stripePriceIds), ['pro-monthly:THB']);
  assert.deepEqual(ps01RealMoneyTestProfile.providerMappings.stripe.live.stripePriceIds, {});
});

test('Module Hub profile contains only A-12 one-time SKUs as editable dual-currency data and has no renewal plan', () => {
  const plans = Object.fromEntries(moduleHubTestProfile.plans.map((plan) => [plan.planId, plan]));
  assert.equal(moduleHubTestProfile.status, 'pending_validation');
  assert.equal(moduleHubTestProfile.commercialPolicy.refundWindowDays, 7);
  assert.deepEqual(Object.keys(plans).sort(), [
    'bundle-8', 'config-runtime', 'enterprise-features', 'event-bus', 'feature-flags',
    'http-client', 'notification', 'product-catalog', 'rate-limit',
  ].sort());
  assert.deepEqual(plans['event-bus'].pricesByCurrency, { THB: 139000, USD: 3900 });
  assert.deepEqual(plans['http-client'].pricesByCurrency, { THB: 169000, USD: 4900 });
  assert.deepEqual(plans['product-catalog'].pricesByCurrency, { THB: 239000, USD: 6900 });
  assert.deepEqual(plans['bundle-8'].pricesByCurrency, { THB: 869000, USD: 24900 });
  assert.ok(moduleHubTestProfile.plans.every((plan) => plan.model === 'one_time' && plan.includedUpdateMonths === 12));
  assert.deepEqual(moduleHubTestProfile.providerMappings.stripe.test.stripePriceIds, {});
  assert.deepEqual(moduleHubTestProfile.providerMappings.stripe.live.stripePriceIds, {});
});

test('Module Hub runtime product identities match the eight locked module slugs and one explicit bundle ID', () => {
  assert.deepEqual(moduleHubProductProfiles.map((profile) => profile.productId).sort(), [
    'config-runtime', 'enterprise-features', 'event-bus', 'feature-flags', 'http-client',
    'module-hub-bundle-8', 'notification', 'product-catalog', 'rate-limit',
  ].sort());
  for (const profile of moduleHubProductProfiles) {
    assert.equal(profile.plans.length, 1);
    assert.equal(profile.plans[0].model, 'one_time');
    assert.equal(profile.plans[0].includedUpdateMonths, 12);
    assert.equal(profile.providerMappings.stripe.test.stripeProductId, null);
    assert.deepEqual(profile.providerMappings.stripe.test.stripePriceIds, {});
  }
});
