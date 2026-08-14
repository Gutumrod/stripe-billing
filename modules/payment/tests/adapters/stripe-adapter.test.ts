import { describe, it, expect } from 'vitest';
import { createStripeAdapter } from '../../adapters/stripe-adapter.js';

describe('Stripe Adapter Event Parsing', () => {
  const adapter = createStripeAdapter({ secretKey: 'sk_test_mock' });

  it('should parse payment_intent.succeeded webhook event', () => {
    const rawEvent = {
      id: 'evt_123',
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_123',
          status: 'succeeded',
          amount: 15000,
          currency: 'thb',
          metadata: { orderId: 'ord_1' },
        },
      },
    };

    const result = adapter.parsePaymentEvent(rawEvent);
    expect(result.success).toBe(true);
    expect(result.event?.eventType).toBe('payment.succeeded');
    expect(result.event?.status).toBe('succeeded');
    expect(result.event?.amount).toBe(15000);
    expect(result.event?.currency).toBe('THB');
    expect(result.event?.paymentId).toBe('pi_123');
  });

  it('should parse checkout.session.completed webhook event', () => {
    const rawEvent = {
      id: 'evt_456',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_123',
          payment_intent: 'pi_456',
          status: 'complete',
          amount_total: 20000,
          currency: 'usd',
        },
      },
    };

    const result = adapter.parsePaymentEvent(rawEvent);
    expect(result.success).toBe(true);
    expect(result.event?.eventType).toBe('payment.succeeded');
    expect(result.event?.status).toBe('succeeded');
    expect(result.event?.amount).toBe(20000);
    expect(result.event?.currency).toBe('USD');
  });
});
