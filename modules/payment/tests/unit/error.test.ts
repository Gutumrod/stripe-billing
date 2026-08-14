import { describe, it, expect } from 'vitest';
import { PaymentError } from '../../core/error.js';

describe('PaymentError', () => {
  it('should correctly initialize error properties and retryability', () => {
    const err = new PaymentError({
      message: 'Card declined',
      code: 'PAYMENT_DECLINED',
      provider: 'stripe',
      providerCode: 'card_declined',
      providerDeclineCode: 'generic_decline',
    });

    expect(err.message).toBe('Card declined');
    expect(err.code).toBe('PAYMENT_DECLINED');
    expect(err.retryable).toBe(false);
    expect(err.provider).toBe('stripe');
    expect(err.providerCode).toBe('card_declined');
  });

  it('should mark timeout and network errors as retryable by default', () => {
    const timeoutErr = new PaymentError({
      message: 'Timeout',
      code: 'PROVIDER_TIMEOUT',
    });
    expect(timeoutErr.retryable).toBe(true);

    const netErr = new PaymentError({
      message: 'Network error',
      code: 'PROVIDER_NETWORK_ERROR',
    });
    expect(netErr.retryable).toBe(true);
  });
});
