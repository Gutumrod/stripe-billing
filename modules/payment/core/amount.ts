import { PaymentError } from './error.js';

export function assertValidAmount(amount: unknown, min?: number, max?: number): asserts amount is number {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new PaymentError({
      message: `Amount must be a finite number, received: ${typeof amount}`,
      code: 'INVALID_AMOUNT',
    });
  }

  if (!Number.isInteger(amount)) {
    throw new PaymentError({
      message: `Amount must be an integer minor units (no floating-point numbers allowed), received: ${amount}`,
      code: 'INVALID_AMOUNT',
    });
  }

  if (amount <= 0) {
    throw new PaymentError({
      message: `Amount must be strictly positive (> 0), received: ${amount}`,
      code: 'INVALID_AMOUNT',
    });
  }

  if (amount > Number.MAX_SAFE_INTEGER) {
    throw new PaymentError({
      message: `Amount exceeds maximum safe integer limit: ${amount}`,
      code: 'INVALID_AMOUNT',
    });
  }

  if (min !== undefined && amount < min) {
    throw new PaymentError({
      message: `Amount ${amount} is below minimum allowed minor units: ${min}`,
      code: 'INVALID_AMOUNT',
    });
  }

  if (max !== undefined && amount > max) {
    throw new PaymentError({
      message: `Amount ${amount} exceeds maximum allowed minor units: ${max}`,
      code: 'INVALID_AMOUNT',
    });
  }
}

export function assertValidCurrency(currency: unknown, supportedCurrencies?: string[]): asserts currency is string {
  if (typeof currency !== 'string' || currency.trim() === '') {
    throw new PaymentError({
      message: `Currency must be a non-empty string, received: ${typeof currency}`,
      code: 'UNSUPPORTED_CURRENCY',
    });
  }

  const normalized = currency.trim().toUpperCase();
  if (supportedCurrencies && supportedCurrencies.length > 0) {
    if (!supportedCurrencies.map(c => c.toUpperCase()).includes(normalized)) {
      throw new PaymentError({
        message: `Currency '${currency}' is not supported. Allowed currencies: ${supportedCurrencies.join(', ')}`,
        code: 'UNSUPPORTED_CURRENCY',
      });
    }
  }
}
