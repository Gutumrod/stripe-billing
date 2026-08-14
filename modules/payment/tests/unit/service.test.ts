import { describe, it, expect } from 'vitest';
import { createPaymentCore, createMockPaymentAdapter } from '../../index.js';

describe('PaymentCore Service with Mock Adapter', () => {
  it('should create payment successfully', async () => {
    const adapter = createMockPaymentAdapter();
    const core = createPaymentCore({ defaultCurrency: 'THB' }, adapter);

    const result = await core.createPayment({
      amount: 10000,
      currency: 'THB',
      referenceId: 'ref_001',
      idempotencyKey: 'idemp_001',
    });

    expect(result.success).toBe(true);
    expect(result.paymentId).toBeDefined();
    expect(result.status).toBe('requires_action');
    expect(result.checkoutUrl).toBeDefined();
  });

  it('should fail when amount is floating-point or negative', async () => {
    const adapter = createMockPaymentAdapter();
    const core = createPaymentCore({ defaultCurrency: 'THB' }, adapter);

    const result = await core.createPayment({
      amount: 99.99, // floating point
      currency: 'THB',
      referenceId: 'ref_002',
      idempotencyKey: 'idemp_002',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_AMOUNT');
  });

  it('should fail when idempotencyKey is missing', async () => {
    const adapter = createMockPaymentAdapter();
    const core = createPaymentCore({ defaultCurrency: 'THB' }, adapter);

    const result = await core.createPayment({
      amount: 1000,
      currency: 'THB',
      referenceId: 'ref_003',
      idempotencyKey: '',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('MISSING_IDEMPOTENCY_KEY');
  });

  it('should retrieve payment successfully', async () => {
    const adapter = createMockPaymentAdapter();
    const core = createPaymentCore({ defaultCurrency: 'THB' }, adapter);

    const created = await core.createPayment({
      amount: 5000,
      currency: 'THB',
      referenceId: 'ref_004',
      idempotencyKey: 'idemp_004',
    });

    const retrieved = await core.getPayment(created.paymentId!);
    expect(retrieved.success).toBe(true);
    expect(retrieved.paymentId).toBe(created.paymentId);
    expect(retrieved.amount).toBe(5000);
  });

  it('should refund payment successfully', async () => {
    const adapter = createMockPaymentAdapter();
    const core = createPaymentCore({ defaultCurrency: 'THB' }, adapter);

    const created = await core.createPayment({
      amount: 5000,
      currency: 'THB',
      referenceId: 'ref_005',
      idempotencyKey: 'idemp_005',
    });

    const refund = await core.refundPayment({
      paymentId: created.paymentId!,
      amount: 5000,
      idempotencyKey: 'idemp_refund_005',
    });

    expect(refund.success).toBe(true);
    expect(refund.status).toBe('refunded');
  });
});
