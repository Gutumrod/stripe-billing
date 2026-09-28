import { BillingRuntimeError, ProviderSubscriptionSnapshot, RuntimeProfile } from './types';

export interface StripeTestAdapterOptions {
  secretKey: string;
  environment?: 'test' | 'live';
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

interface StripeObject {
  id: string;
  livemode?: boolean;
  [key: string]: unknown;
}

export class StripeTestAdapter {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly environment: 'test' | 'live';
  constructor(private readonly options: StripeTestAdapterOptions) {
    this.environment = options.environment ?? 'test';
    const expectedPrefix = this.environment === 'test' ? 'sk_test_' : 'sk_live_';
    if (!options.secretKey.startsWith(expectedPrefix)) {
      throw new BillingRuntimeError('STRIPE_KEY_ENVIRONMENT_MISMATCH', `Stripe ${this.environment} environment requires a matching secret key`, 500);
    }
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }
  private async request<T extends StripeObject>(
    path: string,
    method: 'GET' | 'POST',
    params?: URLSearchParams,
    idempotencyKey?: string,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${this.options.secretKey}` };
      if (params) headers['Content-Type'] = 'application/x-www-form-urlencoded';
      if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
      const response = await this.fetchImpl(`https://api.stripe.com/v1${path}`, {
        method,
        headers,
        body: params,
        signal: controller.signal,
      });
      const body = await response.json() as Record<string, unknown>;
      if (!response.ok) {
        const error = (body.error ?? {}) as Record<string, unknown>;
        throw new BillingRuntimeError(
          'STRIPE_REQUEST_FAILED',
          `Stripe request failed: ${String(error.type ?? response.status)} ${String(error.code ?? '')}`.trim(),
          response.status >= 500 || response.status === 429 ? 503 : 502,
          response.status >= 500 || response.status === 429,
        );
      }
      const object = body as unknown as T;
      if (typeof object.livemode === 'boolean' && object.livemode !== (this.environment === 'live')) {
        const code = this.environment === 'test' ? 'LIVE_PROVIDER_OBJECT_DENIED' : 'TEST_PROVIDER_OBJECT_DENIED';
        throw new BillingRuntimeError(code, 'Stripe returned an object for a different billing environment', 500);
      }
      return object;
    } catch (error) {
      if (error instanceof BillingRuntimeError) throw error;
      const name = error instanceof Error ? error.name : '';
      if (name === 'AbortError') {
        throw new BillingRuntimeError('STRIPE_TIMEOUT', 'Stripe request timed out', 503, true);
      }
      throw new BillingRuntimeError('STRIPE_NETWORK_ERROR', 'Stripe network request failed', 503, true);
    } finally {
      clearTimeout(timer);
    }
  }

  async createCustomer(
    metadata: Record<string, string>,
    idempotencyKey: string,
  ): Promise<{ id: string }> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(metadata)) params.set(`metadata[${key}]`, value);
    const customer = await this.request<StripeObject>('/customers', 'POST', params, idempotencyKey);
    return { id: customer.id };
  }
  async createSubscriptionCheckout(input: {
    customerId: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }): Promise<{ id: string; url: string | null; status: string | null }> {
    const params = new URLSearchParams();
    params.set('mode', 'subscription');
    params.set('customer', input.customerId);
    params.set('line_items[0][price]', input.priceId);
    params.set('line_items[0][quantity]', '1');
    params.set('success_url', input.successUrl);
    params.set('cancel_url', input.cancelUrl);
    for (const [key, value] of Object.entries(input.metadata)) {
      params.set(`metadata[${key}]`, value);
      params.set(`subscription_data[metadata][${key}]`, value);
    }
    const session = await this.request<StripeObject>('/checkout/sessions', 'POST', params, input.idempotencyKey);
    return {
      id: session.id,
      url: typeof session.url === 'string' ? session.url : null,
      status: typeof session.status === 'string' ? session.status : null,
    };
  }
  async createOneTimeCheckout(input: {
    customerId: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }): Promise<{ id: string; url: string | null; status: string | null }> {
    const params = new URLSearchParams();
    params.set('mode', 'payment');
    params.set('customer', input.customerId);
    params.set('line_items[0][price]', input.priceId);
    params.set('line_items[0][quantity]', '1');
    params.set('success_url', input.successUrl);
    params.set('cancel_url', input.cancelUrl);
    for (const [key, value] of Object.entries(input.metadata)) params.set(`metadata[${key}]`, value);
    const session = await this.request<StripeObject>('/checkout/sessions', 'POST', params, input.idempotencyKey);
    return {
      id: session.id,
      url: typeof session.url === 'string' ? session.url : null,
      status: typeof session.status === 'string' ? session.status : null,
    };
  }
  async createPortalSession(input: {
    customerId: string;
    returnUrl: string;
    idempotencyKey: string;
  }): Promise<{ id: string; url: string | null }> {
    const params = new URLSearchParams();
    params.set('customer', input.customerId);
    params.set('return_url', input.returnUrl);
    const session = await this.request<StripeObject>('/billing_portal/sessions', 'POST', params, input.idempotencyKey);
    return { id: session.id, url: typeof session.url === 'string' ? session.url : null };
  }

  async retrieveCheckoutSession(id: string): Promise<StripeObject> {
    return this.request<StripeObject>(`/checkout/sessions/${encodeURIComponent(id)}`, 'GET');
  }

  async listCustomerSubscriptions(customerId: string): Promise<string[]> {
    const result = await this.request<StripeObject>(
      `/subscriptions?customer=${encodeURIComponent(customerId)}&status=all&limit=100`, 'GET',
    );
    const data = Array.isArray(result.data) ? result.data as Array<Record<string, unknown>> : [];
    return data.map((item) => String(item.id ?? '')).filter(Boolean);
  }

  async retrieveSubscription(id: string): Promise<ProviderSubscriptionSnapshot> {
    const subscription = await this.request<StripeObject>(
      `/subscriptions/${encodeURIComponent(id)}?expand[]=latest_invoice.payment_intent`,
      'GET',
    );
    const items = subscription.items as { data?: Array<Record<string, unknown>> } | undefined;
    const item = items?.data?.[0] ?? {};
    const price = (item.price ?? {}) as Record<string, unknown>;
    const product = price.product;
    const customer = subscription.customer;
    const itemStart = typeof item.current_period_start === 'number' ? item.current_period_start : null;
    const itemEnd = typeof item.current_period_end === 'number' ? item.current_period_end : null;
    const subStart = typeof subscription.current_period_start === 'number' ? subscription.current_period_start : null;
    const subEnd = typeof subscription.current_period_end === 'number' ? subscription.current_period_end : null;
    return {
      subscriptionId: subscription.id,
      customerId: typeof customer === 'string' ? customer : String((customer as Record<string, unknown> | undefined)?.id ?? ''),
      status: String(subscription.status ?? 'unknown'),
      priceId: String(price.id ?? ''),
      productId: typeof product === 'string' ? product : String((product as Record<string, unknown> | undefined)?.id ?? '') || null,
      amountMinor: typeof price.unit_amount === 'number' ? price.unit_amount : null,
      currency: typeof price.currency === 'string' ? price.currency.toUpperCase() : null,
      currentPeriodStart: subStart ?? itemStart,
      currentPeriodEnd: subEnd ?? itemEnd,
      cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
      livemode: subscription.livemode === true,
      metadata: subscription.metadata && typeof subscription.metadata === 'object'
        ? Object.fromEntries(Object.entries(subscription.metadata as Record<string, unknown>).map(([key, value]) => [key, String(value)]))
        : {},
    };
  }

  resolvePrice(profile: Readonly<RuntimeProfile>, planId: string, currency = profile.currency.code): string {
    if (profile.environment !== this.environment) {
      throw new BillingRuntimeError('PROFILE_ENVIRONMENT_MISMATCH', 'Stripe profile environment differs from configured adapter', 500);
    }
    const mapping = profile.providerMappings.stripe[profile.environment].stripePriceIds;
    const priceId = mapping[`${planId}:${currency}`] ?? (currency === profile.currency.code ? mapping[planId] : undefined);
    if (!priceId) throw new BillingRuntimeError('PLAN_PROVIDER_MAPPING_MISSING', 'Stripe Test Price mapping missing', 409);
    return priceId;
  }
}
