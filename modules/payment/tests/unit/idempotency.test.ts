import { describe, it, expect } from 'vitest';
import { assertValidIdempotencyKey } from '../../core/idempotency.js';
import { PaymentError } from '../../core/error.js';

describe('Idempotency Validation', () => {
  it('should accept non-empty idempotency key', () => {
    expect(() => assertValidIdempotencyKey('key_12345')).not.toThrow();
  });

  it('should reject missing or empty idempotency key', () => {
    expect(() => assertValidIdempotencyKey('')).toThrow(PaymentError);
    expect(() => assertValidIdempotencyKey('   ')).toThrow(PaymentError);
    expect(() => assertValidIdempotencyKey(undefined)).toThrow(PaymentError);
  });
});
