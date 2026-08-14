import {
  CreatePaymentRequest,
  PaymentCoreConfig,
  PaymentOptions,
  PaymentProvider,
  PaymentResult,
  RefundPaymentRequest,
} from './types.js';
import { assertValidAmount, assertValidCurrency } from './amount.js';
import { assertValidIdempotencyKey } from './idempotency.js';
import { PaymentError } from './error.js';

export interface PaymentCore {
  createPayment(request: CreatePaymentRequest, options?: PaymentOptions): Promise<PaymentResult>;
  getPayment(paymentId: string, options?: PaymentOptions): Promise<PaymentResult>;
  refundPayment(request: RefundPaymentRequest, options?: PaymentOptions): Promise<PaymentResult>;
}

export function createPaymentCore(config: PaymentCoreConfig = {}, provider: PaymentProvider): PaymentCore {
  return {
    async createPayment(request: CreatePaymentRequest, options?: PaymentOptions): Promise<PaymentResult> {
      try {
        // 1. Validate idempotencyKey
        assertValidIdempotencyKey(request.idempotencyKey);

        // 2. Validate amount (integer minor units, min/max bounds)
        assertValidAmount(request.amount, config.minAmountMinorUnits, config.maxAmountMinorUnits);

        // 3. Validate currency
        const currency = request.currency || config.defaultCurrency;
        if (!currency) {
          throw new PaymentError({
            message: 'Currency is required and no default currency is configured in PaymentCoreConfig',
            code: 'UNSUPPORTED_CURRENCY',
          });
        }
        assertValidCurrency(currency, config.supportedCurrencies);

        const validatedRequest: CreatePaymentRequest = {
          ...request,
          currency: currency.toUpperCase(),
        };

        // 4. Trigger onPaymentStart hook
        config.hooks?.onPaymentStart?.(validatedRequest);

        // 5. Delegate to provider adapter
        const result = await provider.createPayment(validatedRequest, options);

        if (result.success) {
          config.hooks?.onPaymentSuccess?.(result);
        } else if (result.error) {
          config.hooks?.onPaymentFailure?.(result.error);
        }

        return result;
      } catch (error) {
        let paymentErr: PaymentError;
        if (error instanceof PaymentError) {
          paymentErr = error;
        } else {
          paymentErr = new PaymentError({
            message: error instanceof Error ? error.message : String(error),
            code: 'UNKNOWN_PAYMENT_ERROR',
            cause: error,
          });
        }
        config.hooks?.onPaymentFailure?.(paymentErr);
        return {
          success: false,
          error: paymentErr,
        };
      }
    },

    async getPayment(paymentId: string, options?: PaymentOptions): Promise<PaymentResult> {
      try {
        if (!paymentId || typeof paymentId !== 'string' || paymentId.trim() === '') {
          throw new PaymentError({
            message: 'Payment ID must be a non-empty string',
            code: 'PAYMENT_NOT_FOUND',
          });
        }
        return await provider.getPayment(paymentId, options);
      } catch (error) {
        if (error instanceof PaymentError) {
          return {
            success: false,
            error,
          };
        }
        return {
          success: false,
          error: new PaymentError({
            message: error instanceof Error ? error.message : String(error),
            code: 'UNKNOWN_PAYMENT_ERROR',
            cause: error,
          }),
        };
      }
    },

    async refundPayment(request: RefundPaymentRequest, options?: PaymentOptions): Promise<PaymentResult> {
      try {
        // 1. Validate idempotencyKey
        assertValidIdempotencyKey(request.idempotencyKey);

        if (!request.paymentId || typeof request.paymentId !== 'string' || request.paymentId.trim() === '') {
          throw new PaymentError({
            message: 'Payment ID is required for refund',
            code: 'REFUND_FAILED',
          });
        }

        // 2. Validate refund amount if provided
        if (request.amount !== undefined) {
          assertValidAmount(request.amount);
        }

        return await provider.refundPayment(request, options);
      } catch (error) {
        if (error instanceof PaymentError) {
          return {
            success: false,
            error,
          };
        }
        return {
          success: false,
          error: new PaymentError({
            message: error instanceof Error ? error.message : String(error),
            code: 'REFUND_FAILED',
            cause: error,
          }),
        };
      }
    },
  };
}
