import {
  CreatePaymentRequest,
  PaymentProvider,
  PaymentResult,
  RefundPaymentRequest,
  PaymentOptions,
  PaymentStatus,
  PaymentEvent,
  PaymentEventResult,
} from '../core/index.js';
import { PaymentError, PaymentErrorCode } from '../core/index.js';

export type StripeAdapterConfig = {
  secretKey: string;
  publishableKey?: string;
  webhookSecret?: string;
  apiVersion?: string;
  fetch?: typeof globalThis.fetch;
  maxRetries?: number;
  timeoutMs?: number;
  useCheckoutSession?: boolean; // Default true
};

export interface StripeAdapterExtensions {
  parsePaymentEvent(rawPayload: unknown): PaymentEventResult;
}

export function createStripeAdapter(config: StripeAdapterConfig): PaymentProvider & StripeAdapterExtensions {
  const fetchImpl = config.fetch || globalThis.fetch;
  const apiVersion = config.apiVersion || '2024-06-20';
  const useCheckoutSession = config.useCheckoutSession ?? true;
  const timeoutMs = config.timeoutMs || 10000;

  async function stripeRequest(endpoint: string, method: string, bodyParams?: Record<string, any>, idempotencyKey?: string): Promise<any> {
    const url = `https://api.stripe.com/v1${endpoint}`;
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${config.secretKey}`,
      'Stripe-Version': apiVersion,
      'Content-Type': 'application/x-www-form-urlencoded',
    };

    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }

    let encodedBody: string | undefined = undefined;
    if (bodyParams) {
      const formBody: string[] = [];
      const serialize = (obj: any, prefix = '') => {
        for (const key of Object.keys(obj)) {
          const value = obj[key];
          if (value === undefined || value === null) continue;
          const propName = prefix ? `${prefix}[${key}]` : key;
          if (typeof value === 'object' && !Array.isArray(value)) {
            serialize(value, propName);
          } else if (Array.isArray(value)) {
            value.forEach((item, index) => {
              if (typeof item === 'object') {
                serialize(item, `${propName}[${index}]`);
              } else {
                formBody.push(`${encodeURIComponent(`${propName}[${index}]`)}=${encodeURIComponent(String(item))}`);
              }
            });
          } else {
            formBody.push(`${encodeURIComponent(propName)}=${encodeURIComponent(String(value))}`);
          }
        }
      };
      serialize(bodyParams);
      encodedBody = formBody.join('&');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(url, {
        method,
        headers,
        body: method !== 'GET' && method !== 'HEAD' ? encodedBody : undefined,
        signal: controller.signal,
      });

      clearTimeout(timer);

      const json = await response.json();

      if (!response.ok) {
        throw mapStripeError(response.status, json);
      }

      return json;
    } catch (err: any) {
      clearTimeout(timer);
      if (err instanceof PaymentError) {
        throw err;
      }
      if (err.name === 'AbortError' || err.message?.includes('aborted')) {
        throw new PaymentError({
          message: `Stripe API request timed out after ${timeoutMs}ms`,
          code: 'PROVIDER_TIMEOUT',
          provider: 'stripe',
          cause: err,
        });
      }
      throw new PaymentError({
        message: `Stripe network error: ${err.message || String(err)}`,
        code: 'PROVIDER_NETWORK_ERROR',
        provider: 'stripe',
        cause: err,
      });
    }
  }

  function mapStripeError(status: number, json: any): PaymentError {
    const errObj = json?.error || {};
    const code = errObj.code;
    const declineCode = errObj.decline_code;
    const type = errObj.type;
    const message = errObj.message || 'Unknown Stripe error';

    let mappedCode: PaymentErrorCode = 'UNKNOWN_PAYMENT_ERROR';
    let retryable = false;

    if (status === 401) {
      mappedCode = 'PROVIDER_AUTHENTICATION_ERROR';
    } else if (status === 429) {
      mappedCode = 'PROVIDER_RATE_LIMITED';
      retryable = true;
    } else if (status >= 500) {
      mappedCode = 'PROVIDER_SERVER_ERROR';
      retryable = true;
    } else if (type === 'card_error') {
      switch (declineCode) {
        case 'insufficient_funds':
          mappedCode = 'INSUFFICIENT_FUNDS';
          break;
        case 'expired_card':
          mappedCode = 'EXPIRED_CARD';
          break;
        case 'authentication_required':
          mappedCode = 'AUTHENTICATION_REQUIRED';
          break;
        case 'incorrect_number':
        case 'invalid_cvc':
        case 'invalid_expiry_month':
        case 'invalid_expiry_year':
          mappedCode = 'INVALID_CARD';
          break;
        default:
          mappedCode = 'PAYMENT_DECLINED';
          break;
      }
    } else if (code === 'resource_missing' || status === 404) {
      mappedCode = 'PAYMENT_NOT_FOUND';
    } else if (code === 'charge_already_refunded' || code === 'refund_failed') {
      mappedCode = 'REFUND_FAILED';
    }

    return new PaymentError({
      message,
      code: mappedCode,
      status,
      retryable,
      provider: 'stripe',
      providerCode: code,
      providerDeclineCode: declineCode,
      rawProviderError: json,
    });
  }

  function normalizeStripeStatus(stripeStatus: string, paymentStatus?: string): PaymentStatus {
    if (stripeStatus === 'succeeded' || paymentStatus === 'paid') return 'succeeded';
    if (stripeStatus === 'requires_action' || stripeStatus === 'requires_payment_method' || stripeStatus === 'requires_confirmation' || stripeStatus === 'requires_capture') {
      return stripeStatus === 'requires_payment_method' ? 'pending' : 'requires_action';
    }
    if (stripeStatus === 'processing') return 'processing';
    if (stripeStatus === 'canceled' || stripeStatus === 'expired') return 'cancelled';
    if (stripeStatus === 'failed' || stripeStatus === 'unpaid') return 'failed';
    return 'pending';
  }

  return {
    name: 'stripe',

    async createPayment(request: CreatePaymentRequest, _options?: PaymentOptions): Promise<PaymentResult> {
      if (useCheckoutSession) {
        const payload: Record<string, any> = {
          mode: 'payment',
          'payment_method_types[0]': 'card',
          'line_items[0][price_data][currency]': request.currency.toLowerCase(),
          'line_items[0][price_data][unit_amount]': request.amount,
          'line_items[0][price_data][product_data][name]': request.description || `Reference: ${request.referenceId}`,
          'line_items[0][quantity]': 1,
          success_url: request.returnUrl || 'https://example.com/success?session_id={CHECKOUT_SESSION_ID}',
          cancel_url: request.cancelUrl || 'https://example.com/cancel',
          client_reference_id: request.referenceId,
        };

        if (request.metadata) {
          for (const [k, v] of Object.entries(request.metadata)) {
            payload[`metadata[${k}]`] = v;
          }
        }

        const session = await stripeRequest('/checkout/sessions', 'POST', payload, request.idempotencyKey);

        return {
          success: true,
          paymentId: session.id,
          status: 'requires_action',
          amount: request.amount,
          currency: request.currency,
          checkoutUrl: session.url,
          provider: 'stripe',
          providerReference: session.payment_intent || session.id,
          rawProviderMetadata: { sessionId: session.id, status: session.status },
        };
      } else {
        const payload: Record<string, any> = {
          amount: request.amount,
          currency: request.currency.toLowerCase(),
          automatic_payment_methods: { enabled: true },
          description: request.description,
          metadata: { referenceId: request.referenceId, ...request.metadata },
        };

        const intent = await stripeRequest('/payment_intents', 'POST', payload, request.idempotencyKey);

        return {
          success: true,
          paymentId: intent.id,
          status: normalizeStripeStatus(intent.status),
          amount: request.amount,
          currency: request.currency,
          clientSecret: intent.client_secret,
          provider: 'stripe',
          providerReference: intent.id,
          rawProviderMetadata: { intentStatus: intent.status },
        };
      }
    },

    async getPayment(paymentId: string, _options?: PaymentOptions): Promise<PaymentResult> {
      if (paymentId.startsWith('cs_')) {
        const session = await stripeRequest(`/checkout/sessions/${paymentId}`, 'GET');
        const paymentStatus = session.payment_status;
        const status = normalizeStripeStatus(session.status, paymentStatus);
        const amount = session.amount_total || 0;
        const currency = (session.currency || 'THB').toUpperCase();

        return {
          success: true,
          paymentId: session.id,
          status,
          amount,
          currency,
          checkoutUrl: session.url,
          provider: 'stripe',
          providerReference: session.payment_intent || session.id,
          rawProviderMetadata: session,
        };
      } else {
        const intent = await stripeRequest(`/payment_intents/${paymentId}`, 'GET');
        const status = normalizeStripeStatus(intent.status);
        const amount = intent.amount;
        const currency = (intent.currency || 'THB').toUpperCase();

        return {
          success: true,
          paymentId: intent.id,
          status,
          amount,
          currency,
          clientSecret: intent.client_secret,
          provider: 'stripe',
          providerReference: intent.id,
          rawProviderMetadata: intent,
        };
      }
    },

    async refundPayment(request: RefundPaymentRequest, _options?: PaymentOptions): Promise<PaymentResult> {
      const payload: Record<string, any> = {
        payment_intent: request.paymentId,
      };
      if (request.amount !== undefined) {
        payload.amount = request.amount;
      }
      if (request.reason) {
        payload.reason = request.reason;
      }
      if (request.metadata) {
        payload.metadata = request.metadata;
      }

      const refund = await stripeRequest('/refunds', 'POST', payload, request.idempotencyKey);

      return {
        success: true,
        paymentId: request.paymentId,
        status: 'refunded',
        amount: refund.amount,
        currency: (refund.currency || 'THB').toUpperCase(),
        provider: 'stripe',
        providerReference: refund.id,
        rawProviderMetadata: refund,
      };
    },

    parsePaymentEvent(rawPayload: unknown): PaymentEventResult {
      try {
        if (!rawPayload || typeof rawPayload !== 'object') {
          throw new Error('Invalid raw payload: expected an object');
        }
        const event = rawPayload as any;
        const eventId = event.id || 'evt_unknown';
        const type = event.type || 'unknown';
        const dataObj = event.data?.object || {};

        let eventType: PaymentEvent['eventType'] = 'unknown';
        let status: PaymentStatus = 'pending';

        switch (type) {
          case 'payment_intent.succeeded':
            eventType = 'payment.succeeded';
            status = 'succeeded';
            break;
          case 'payment_intent.payment_failed':
            eventType = 'payment.failed';
            status = 'failed';
            break;
          case 'payment_intent.processing':
            eventType = 'payment.processing';
            status = 'processing';
            break;
          case 'payment_intent.amount_capturable_updated':
            eventType = 'payment.requires_action';
            status = 'requires_action';
            break;
          case 'payment_intent.canceled':
            eventType = 'payment.cancelled';
            status = 'cancelled';
            break;
          case 'checkout.session.completed':
            eventType = 'payment.succeeded';
            status = 'succeeded';
            break;
          case 'checkout.session.expired':
            eventType = 'payment.cancelled';
            status = 'cancelled';
            break;
          case 'charge.refunded':
            eventType = 'payment.refunded';
            status = 'refunded';
            break;
          default:
            eventType = 'unknown';
            status = normalizeStripeStatus(dataObj.status || 'pending');
            break;
        }

        const paymentId = dataObj.id || dataObj.payment_intent || 'unknown_id';
        const providerReference = dataObj.id || '';
        const amount = dataObj.amount || dataObj.amount_total || 0;
        const currency = (dataObj.currency || 'THB').toUpperCase();
        const metadata = dataObj.metadata || {};

        return {
          success: true,
          event: {
            eventId,
            eventType,
            paymentId,
            providerReference,
            status,
            amount,
            currency,
            metadata,
            rawEvent: event,
          },
        };
      } catch (err: any) {
        return {
          success: false,
          error: new PaymentError({
            message: `Failed to parse Stripe payment event: ${err.message || String(err)}`,
            code: 'UNKNOWN_PAYMENT_ERROR',
            cause: err,
          }),
        };
      }
    },
  };
}
