export type PaymentErrorCode =
  | 'INVALID_AMOUNT'
  | 'UNSUPPORTED_CURRENCY'
  | 'MISSING_IDEMPOTENCY_KEY'
  | 'PAYMENT_DECLINED'
  | 'INSUFFICIENT_FUNDS'
  | 'EXPIRED_CARD'
  | 'INVALID_CARD'
  | 'AUTHENTICATION_REQUIRED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_NETWORK_ERROR'
  | 'PROVIDER_AUTHENTICATION_ERROR'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_SERVER_ERROR'
  | 'PAYMENT_NOT_FOUND'
  | 'REFUND_FAILED'
  | 'UNKNOWN_PAYMENT_ERROR';

export class PaymentError extends Error {
  readonly code: PaymentErrorCode;
  readonly status?: number;
  readonly retryable: boolean;
  readonly provider?: string;
  readonly providerCode?: string;
  readonly providerDeclineCode?: string;
  readonly rawProviderError?: unknown;
  override readonly cause?: unknown;

  constructor(options: {
    message: string;
    code: PaymentErrorCode;
    status?: number;
    retryable?: boolean;
    provider?: string;
    providerCode?: string;
    providerDeclineCode?: string;
    rawProviderError?: unknown;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = 'PaymentError';
    this.code = options.code;
    this.status = options.status;
    this.retryable = options.retryable ?? getDefaultRetryable(options.code);
    this.provider = options.provider;
    this.providerCode = options.providerCode;
    this.providerDeclineCode = options.providerDeclineCode;
    this.rawProviderError = options.rawProviderError;
    this.cause = options.cause;

    if (typeof (Error as any).captureStackTrace === 'function') {
      (Error as any).captureStackTrace(this, PaymentError);
    }
  }
}

function getDefaultRetryable(code: PaymentErrorCode): boolean {
  switch (code) {
    case 'PROVIDER_TIMEOUT':
    case 'PROVIDER_NETWORK_ERROR':
    case 'PROVIDER_RATE_LIMITED':
    case 'PROVIDER_SERVER_ERROR':
      return true;
    default:
      return false;
  }
}
