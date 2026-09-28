import test from 'node:test';
import assert from 'node:assert/strict';
import { StripeTestAdapter } from '../dist/stripe.js';
import { BillingRuntimeError } from '../dist/types.js';
import { projectOneTimeAccess } from '../dist/entitlements.js';

test('refund reconciliation resolves an invoice subscription and confirms full refund from provider truth', async () => {
  let requested;
  const adapter = new StripeTestAdapter({
    secretKey: 'sk_test_placeholder', environment: 'test',
    fetch: async (url) => {
      requested = String(url);
      return new Response(JSON.stringify({
        id: 'ch_test_refund', object: 'charge', livemode: false, refunded: true,
        amount: 99000, amount_refunded: 99000, currency: 'thb', customer: 'cus_test',
        payment_intent: 'pi_test',
        invoice: { id: 'in_test', parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_test' } } },
      }), { status: 200 });
    },
  });
  const charge = await adapter.retrieveRefundCharge('ch_test_refund');
  assert.match(requested, /\/charges\/ch_test_refund\?/);
  assert.equal(charge.chargeId, 'ch_test_refund');
  assert.equal(charge.fullyRefunded, true);
  assert.equal(charge.amountMinor, 99000);
  assert.equal(charge.paymentIntentId, 'pi_test');
  assert.equal(charge.subscriptionId, 'sub_test');
  assert.equal(charge.livemode, false);
});

test('refund reconciliation rejects a live provider charge in test environment', async () => {
  const adapter = new StripeTestAdapter({
    secretKey: 'sk_test_placeholder', environment: 'test',
    fetch: async () => new Response(JSON.stringify({ id: 'ch_live_fake', livemode: true }), { status: 200 }),
  });
  await assert.rejects(
    () => adapter.retrieveRefundCharge('ch_live_fake'),
    (error) => error instanceof BillingRuntimeError && error.code === 'LIVE_PROVIDER_OBJECT_DENIED',
  );
});

test('expired twelve-month update access does not renew, while perpetual source-use access remains valid', () => {
  const now = Date.UTC(2027, 0, 1);
  assert.deepEqual(projectOneTimeAccess({
    status: 'paid', sourceAccessUntil: null, updatesUntil: Date.UTC(2026, 11, 31),
  }, now), { sourceAccessActive: true, updatesActive: false });
  assert.deepEqual(projectOneTimeAccess({
    status: 'refunded', sourceAccessUntil: null, updatesUntil: Date.UTC(2027, 11, 31),
  }, now), { sourceAccessActive: false, updatesActive: false });
});
