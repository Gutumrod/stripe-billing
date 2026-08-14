export type CurrencyCode = string;

export type PaymentStatus =
  | 'pending'
  | 'requires_action'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'refunded'
  | 'cancelled';

export type CreatePaymentRequest = {
  amount: number; // Integer minor units (e.g., 10000 = 100.00 THB)
  currency: string; // ISO 4217 3-letter currency code
  referenceId: string; // Business internal reference ID
  idempotencyKey: string; // Mandatory unique key for idempotency
  customerId?: string;
  description?: string;
  metadata?: Record<string, string>;
  returnUrl?: string;
  cancelUrl?: string;
};

export type RefundPaymentRequest = {
  paymentId: string;
  idempotencyKey: string;
  amount?: number; // Optional partial refund amount in minor units
  reason?: string;
  metadata?: Record<string, string>;
};

export type PaymentOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type PaymentResult = {
  success: boolean;
  paymentId?: string;
  status?: PaymentStatus;
  amount?: number;
  currency?: string;
  checkoutUrl?: string;
  clientSecret?: string;
  provider?: string;
  providerReference?: string;
  error?: import('./error.js').PaymentError;
  rawProviderMetadata?: Record<string, unknown>;
};

export interface PaymentProvider {
  readonly name: string;
  createPayment(request: CreatePaymentRequest, options?: PaymentOptions): Promise<PaymentResult>;
  getPayment(paymentId: string, options?: PaymentOptions): Promise<PaymentResult>;
  refundPayment(request: RefundPaymentRequest, options?: PaymentOptions): Promise<PaymentResult>;
}

export type PaymentEvent = {
  eventId: string;
  eventType:
    | 'payment.succeeded'
    | 'payment.failed'
    | 'payment.processing'
    | 'payment.requires_action'
    | 'payment.refunded'
    | 'payment.cancelled'
    | 'unknown';
  paymentId: string;
  providerReference: string;
  status: PaymentStatus;
  amount: number;
  currency: string;
  metadata?: Record<string, string>;
  rawEvent?: unknown;
};

export type PaymentEventResult = {
  success: boolean;
  event?: PaymentEvent;
  error?: import('./error.js').PaymentError;
};

export type PaymentLoggingHooks = {
  onPaymentStart?: (request: CreatePaymentRequest) => void;
  onPaymentSuccess?: (result: PaymentResult) => void;
  onPaymentFailure?: (error: import('./error.js').PaymentError) => void;
};

export type PaymentCoreConfig = {
  defaultCurrency?: string;
  supportedCurrencies?: string[];
  maxAmountMinorUnits?: number;
  minAmountMinorUnits?: number;
  hooks?: PaymentLoggingHooks;
};

export type MockAdapterConfig = {
  failOnCreate?: boolean;
  failOnRefund?: boolean;
  simulatedDelayMs?: number;
  initialPayments?: Record<string, PaymentResult>;
  useCheckoutSession?: boolean;
};
