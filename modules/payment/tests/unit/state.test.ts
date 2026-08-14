import { describe, it, expect } from 'vitest';
import { isValidPaymentStatus } from '../../core/state.js';

describe('Payment Status Validation', () => {
  it('should validate normalized payment statuses', () => {
    expect(isValidPaymentStatus('pending')).toBe(true);
    expect(isValidPaymentStatus('requires_action')).toBe(true);
    expect(isValidPaymentStatus('processing')).toBe(true);
    expect(isValidPaymentStatus('succeeded')).toBe(true);
    expect(isValidPaymentStatus('failed')).toBe(true);
    expect(isValidPaymentStatus('refunded')).toBe(true);
    expect(isValidPaymentStatus('cancelled')).toBe(true);

    expect(isValidPaymentStatus('unknown_state')).toBe(false);
    expect(isValidPaymentStatus(123)).toBe(false);
  });
});
