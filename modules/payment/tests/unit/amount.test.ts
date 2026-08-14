import { describe, it, expect } from 'vitest';
import { assertValidAmount, assertValidCurrency } from '../../core/amount.js';
import { PaymentError } from '../../core/error.js';

describe('Amount & Currency Validation', () => {
  it('should accept valid minor unit integer amounts', () => {
    expect(() => assertValidAmount(10000)).not.toThrow();
    expect(() => assertValidAmount(100, 50, 1000)).not.toThrow();
  });

  it('should reject floating-point amounts', () => {
    expect(() => assertValidAmount(100.50)).toThrow(PaymentError);
    try {
      assertValidAmount(100.50);
    } catch (e: any) {
      expect(e.code).toBe('INVALID_AMOUNT');
    }
  });

  it('should reject zero or negative amounts', () => {
    expect(() => assertValidAmount(0)).toThrow(PaymentError);
    expect(() => assertValidAmount(-500)).toThrow(PaymentError);
  });

  it('should reject non-numeric amount values', () => {
    expect(() => assertValidAmount('1000' as any)).toThrow(PaymentError);
    expect(() => assertValidAmount(NaN)).toThrow(PaymentError);
  });

  it('should validate currency codes', () => {
    expect(() => assertValidCurrency('THB', ['THB', 'USD'])).not.toThrow();
    expect(() => assertValidCurrency('EUR', ['THB', 'USD'])).toThrow(PaymentError);
    expect(() => assertValidCurrency('' as any)).toThrow(PaymentError);
  });
});
