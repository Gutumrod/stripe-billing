import { PaymentError } from './error.js';

export function assertValidIdempotencyKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.trim() === '') {
    throw new PaymentError({
      message: 'Mandatory idempotencyKey is missing or empty',
      code: 'MISSING_IDEMPOTENCY_KEY',
    });
  }
}
