import {
  CreatePaymentRequest,
  PaymentProvider,
  PaymentResult,
  RefundPaymentRequest,
  PaymentOptions,
  MockAdapterConfig,
} from '../core/index.js';
import { PaymentError } from '../core/index.js';

export function createMockPaymentAdapter(config: MockAdapterConfig & { useCheckoutSession?: boolean } = {}): PaymentProvider {
  const payments = new Map<string, PaymentResult>();
  if (config.initialPayments) {
    for (const [id, res] of Object.entries(config.initialPayments)) {
      payments.set(id, res as PaymentResult);
    }
  }

  let counter = 1000;
  const useCheckoutSession = config.useCheckoutSession ?? true;

  return {
    name: 'mock',
    async createPayment(request: CreatePaymentRequest, _options?: PaymentOptions): Promise<PaymentResult> {
      if (config.simulatedDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, config.simulatedDelayMs));
      }

      if (config.failOnCreate) {
        const err = new PaymentError({
          message: 'Simulated payment failure',
          code: 'PAYMENT_DECLINED',
          provider: 'mock',
          providerCode: 'card_declined',
        });
        return { success: false, error: err };
      }

      const paymentId = `mock_pi_${counter++}`;
      const providerReference = `ch_${counter++}`;
      const result: PaymentResult = {
        success: true,
        paymentId,
        status: useCheckoutSession ? 'requires_action' : 'succeeded',
        amount: request.amount,
        currency: request.currency,
        checkoutUrl: useCheckoutSession ? `https://checkout.mockprovider.test/pay/${paymentId}` : undefined,
        clientSecret: useCheckoutSession ? undefined : `seti_${counter}_secret_${counter}`,
        provider: 'mock',
        providerReference,
        rawProviderMetadata: { simulated: true, metadata: request.metadata },
      };

      payments.set(paymentId, result);
      return result;
    },

    async getPayment(paymentId: string, _options?: PaymentOptions): Promise<PaymentResult> {
      if (config.simulatedDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, config.simulatedDelayMs));
      }

      const found = payments.get(paymentId);
      if (!found) {
        throw new PaymentError({
          message: `Payment not found: ${paymentId}`,
          code: 'PAYMENT_NOT_FOUND',
          provider: 'mock',
        });
      }
      return found;
    },

    async refundPayment(request: RefundPaymentRequest, _options?: PaymentOptions): Promise<PaymentResult> {
      if (config.simulatedDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, config.simulatedDelayMs));
      }

      if (config.failOnRefund) {
        throw new PaymentError({
          message: 'Simulated refund failure',
          code: 'REFUND_FAILED',
          provider: 'mock',
        });
      }

      const found = payments.get(request.paymentId);
      if (!found) {
        throw new PaymentError({
          message: `Payment not found for refund: ${request.paymentId}`,
          code: 'PAYMENT_NOT_FOUND',
          provider: 'mock',
        });
      }

      const updated: PaymentResult = {
        ...found,
        status: 'refunded',
      };
      payments.set(request.paymentId, updated);
      return updated;
    },
  };
}
