export type SubscriptionErrorCode =
  | 'SUBSCRIPTION_NOT_FOUND'
  | 'PLAN_NOT_FOUND'
  | 'INVALID_SUBSCRIPTION_STATE'
  | 'INVALID_PLAN'
  | 'FEATURE_NOT_FOUND'
  | 'SUBSCRIPTION_ALREADY_EXISTS'
  | 'UNKNOWN_SUBSCRIPTION_ERROR';

export class SubscriptionError extends Error {
  readonly code: SubscriptionErrorCode;
  override readonly cause?: unknown;

  constructor(options: {
    message: string;
    code: SubscriptionErrorCode;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = 'SubscriptionError';
    this.code = options.code;
    this.cause = options.cause;

    if (typeof (Error as any).captureStackTrace === 'function') {
      (Error as any).captureStackTrace(this, SubscriptionError);
    }
  }
}
