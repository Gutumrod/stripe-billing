import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyStripeWebhook } from '../dist/webhook.js';

const secret = 'whsec_test_placeholder';
async function signedEvent(event, now) {
  const raw = JSON.stringify(event);
  const timestamp = String(now);
  const signature = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
  return verifyStripeWebhook(raw, `t=${timestamp},v1=${signature}`, secret, now);
}

test('signed full-refund event is routed by durable Charge ID and retains the PaymentIntent identity', async () => {
  const now = Math.floor(Date.now() / 1000);
  const event = await signedEvent({
    id: 'evt_refund_1', type: 'charge.refunded', livemode: false, created: now,
    data: { object: {
      id: 'ch_test_refund', object: 'charge', livemode: false, customer: 'cus_test',
      payment_intent: 'pi_test', amount: 99000, amount_refunded: 99000, refunded: true,
      metadata: { wstera_product_id: 'ps01', account_id: 'acct_1', profile_version: '1' },
    } },
  }, now);
  assert.equal(event.providerEventId, 'evt_refund_1');
  assert.equal(event.providerObjectId, 'ch_test_refund');
  assert.equal(event.providerObjectType, 'charge');
  assert.equal(event.paymentIntentId, 'pi_test');
  assert.equal(event.normalizedEnvelope.amount_refunded, 99000);
});

test('only a one-time Checkout completion routes the session ID; subscription checkout keeps its subscription ID', async () => {
  const now = Math.floor(Date.now() / 1000);
  const oneTime = await signedEvent({
    id: 'evt_once', type: 'checkout.session.completed', livemode: false, created: now,
    data: { object: { id: 'cs_test_once', object: 'checkout.session', livemode: false,
      customer: 'cus_test', payment_intent: 'pi_once', metadata: { billing_model: 'one_time' } } },
  }, now);
  assert.equal(oneTime.providerObjectId, 'cs_test_once');

  const subscription = await signedEvent({
    id: 'evt_subscription', type: 'checkout.session.completed', livemode: false, created: now,
    data: { object: { id: 'cs_test_sub', object: 'checkout.session', livemode: false,
      customer: 'cus_test', subscription: 'sub_test_1', metadata: { billing_model: 'subscription' } } },
  }, now);
  assert.equal(subscription.providerObjectId, 'sub_test_1');
});
