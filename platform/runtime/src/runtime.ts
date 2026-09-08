import { BillingDb, OutboxJob } from './db';
import {
  authenticateBearer,
  deriveIdempotencyKey,
  requestFingerprint,
  resolveProfile,
  sha256Hex,
  signEntitlementTransition,
  verifyAccountAssertion,
  verifyEntitlementTransition,
} from './security';
import { StripeTestAdapter } from './stripe';
import {
  BillingRuntimeError,
  CredentialScope,
  EntitlementTransitionEnvelope,
  RequestAuthority,
  RuntimeConfig,
  RuntimeProfile,
  SignedEntitlementTransition,
} from './types';
import { readBoundedRawBody, verifyStripeWebhook } from './webhook';

const API_BODY_MAX_BYTES = 64 * 1024;
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
function jsonResponse(body: Record<string, unknown>, status = 200, correlationId?: string): Response {
  const headers = new Headers(JSON_HEADERS);
  if (correlationId) headers.set('x-correlation-id', correlationId);
  return new Response(JSON.stringify(body), { status, headers });
}

async function readJsonBody(request: Request, allowedKeys: string[]): Promise<Record<string, unknown>> {
  const raw = await readBoundedRawBody(request, API_BODY_MAX_BYTES);
  let body: Record<string, unknown>;
  try {
    const parsed = raw ? JSON.parse(raw) as unknown : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
    body = parsed as Record<string, unknown>;
  } catch {
    throw new BillingRuntimeError('REQUEST_JSON_INVALID', 'Request body must be a JSON object', 400);
  }
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new BillingRuntimeError('CALLER_AUTHORITY_OVERRIDE', `Unsupported or authoritative fields: ${unknown.join(', ')}`, 400);
  }
  return body;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BillingRuntimeError('REQUEST_FIELD_REQUIRED', `${field} is required`, 400);
  }
  return value.trim();
}
function planForPrice(profile: Readonly<RuntimeProfile>, priceId: string): { plan: RuntimeProfile['plans'][number]; priceId: string } {
  const mapping = profile.providerMappings.stripe[profile.environment].stripePriceIds;
  const entry = Object.entries(mapping).find(([, mappedPrice]) => mappedPrice === priceId);
  if (!entry) throw new BillingRuntimeError('RECONCILE_PRICE_MISMATCH', 'Provider Price is not mapped to pinned profile', 409);
  const plan = profile.plans.find((candidate) => candidate.planId === entry[0]);
  if (!plan) throw new BillingRuntimeError('RECONCILE_PLAN_MISSING', 'Mapped plan is missing from pinned profile', 409);
  return { plan, priceId: entry[1] };
}

function transitionTypeForStatus(status: string): 'grant' | 'revoke' | 'pending' {
  if (status === 'active' || status === 'trialing') return 'grant';
  if (['canceled', 'unpaid', 'incomplete_expired'].includes(status)) return 'revoke';
  return 'pending';
}

export class CentralBillingRuntime {
  readonly db: BillingDb;
  readonly stripe: StripeTestAdapter;

  constructor(readonly config: RuntimeConfig) {
    if (config.environment !== 'test') {
      throw new BillingRuntimeError('LIVE_RUNTIME_DENIED', 'Phase 2 runtime is Test-only', 500);
    }
    if (config.schema !== 'billing_core_staging') {
      throw new BillingRuntimeError('PHASE2_SCHEMA_DENIED', 'Phase 2 runtime must use billing_core_staging', 500);
    }
    this.db = new BillingDb(config.databaseUrl, config.schema);
    this.stripe = new StripeTestAdapter({ secretKey: config.stripeSecretKey, fetch: config.fetch });
  }
  async initialize(): Promise<void> {
    await this.db.ping();
    for (const credential of this.config.credentials) {
      if (credential.environment !== this.config.environment) {
        throw new BillingRuntimeError('CREDENTIAL_ENV_MISMATCH', 'Credential environment differs from runtime', 500);
      }
      resolveProfile(this.config.profileRegistry, credential, this.config.admissionTestMode);
      await this.db.ensureCredentialBinding(credential, await sha256Hex(credential.token));
    }
    this.config.logger.info('billing.runtime.initialized', {
      environment: this.config.environment,
      schema: this.config.schema,
      admissionTestMode: this.config.admissionTestMode,
      credentialCount: this.config.credentials.length,
    });
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  private async authority(
    request: Request,
    scope: CredentialScope,
    action: string,
    accountId: string,
    operationId: string,
  ): Promise<RequestAuthority> {
    const credential = await authenticateBearer(request.headers.get('authorization'), this.config.credentials, scope);
    if (credential.environment !== this.config.environment) {
      throw new BillingRuntimeError('CREDENTIAL_ENV_MISMATCH', 'Credential environment denied', 403);
    }
    await verifyAccountAssertion(
      request.headers.get('x-wstera-account-assertion'), credential, action,
      accountId, operationId, this.config.assertionKeys,
    );
    const profile = resolveProfile(this.config.profileRegistry, credential, this.config.admissionTestMode);
    return {
      credential,
      correlationId: crypto.randomUUID(),
      accountId,
      operationId,
      action,
      profile,
    };
  }

  private returnUrl(profile: Readonly<RuntimeProfile>, kind: 'success' | 'cancel' | 'portal', ref: string): string {
    const set = this.config.returnUrls[profile.productId];
    const value = set?.[kind]?.[ref];
    if (!value) throw new BillingRuntimeError('RETURN_REF_DENIED', 'Return destination reference is not allowlisted', 400);
    let url: URL;
    try { url = new URL(value); } catch { throw new BillingRuntimeError('RETURN_CONFIG_INVALID', 'Configured return URL is invalid', 500); }
    if (!['https:', 'http:'].includes(url.protocol)) {
      throw new BillingRuntimeError('RETURN_CONFIG_INVALID', 'Configured return URL protocol is invalid', 500);
    }
    return url.toString();
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === 'POST' && url.pathname === '/v1/checkout') return await this.handleCheckout(request);
      if (request.method === 'GET' && url.pathname === '/v1/subscription/status') return await this.handleSubscriptionStatus(request, url);
      if (request.method === 'GET' && url.pathname === '/v1/entitlements') return await this.handleEntitlements(request, url);
      if (request.method === 'POST' && url.pathname === '/v1/portal') return await this.handlePortal(request);
      if (request.method === 'POST' && url.pathname === '/webhooks/stripe') return await this.handleWebhook(request);
      if (request.method === 'GET' && url.pathname === '/healthz') return jsonResponse({ ok: true, environment: this.config.environment });
      return jsonResponse({ error: 'NOT_FOUND' }, 404);
    } catch (error) {
      const runtimeError = error instanceof BillingRuntimeError
        ? error
        : new BillingRuntimeError('INTERNAL_ERROR', 'Unexpected billing runtime error', 500);
      this.config.logger.error('billing.request.failed', {
        path: url.pathname,
        code: runtimeError.code,
        status: runtimeError.status,
        retryable: runtimeError.retryable,
      });
      return jsonResponse({ error: runtimeError.code, message: runtimeError.message }, runtimeError.status);
    }
  }

  private async handleCheckout(request: Request): Promise<Response> {
    const body = await readJsonBody(request, [
      'account_id', 'plan_id', 'operation_id', 'success_return_ref', 'cancel_return_ref',
    ]);
    const accountId = requireString(body.account_id, 'account_id');
    const planId = requireString(body.plan_id, 'plan_id');
    const operationId = requireString(body.operation_id, 'operation_id');
    const successRef = requireString(body.success_return_ref, 'success_return_ref');
    const cancelRef = requireString(body.cancel_return_ref, 'cancel_return_ref');
    const authority = await this.authority(request, 'checkout', 'checkout', accountId, operationId);
    const plan = authority.profile.plans.find((candidate) => candidate.planId === planId);
    if (!plan || !['subscription', 'one_time', 'manual_renewal'].includes(plan.model) || !plan.amountMinor) {
      throw new BillingRuntimeError('PLAN_NOT_CHECKOUT_ELIGIBLE', 'Plan is not eligible for paid checkout', 409);
    }
    if (plan.model !== 'subscription') {
      throw new BillingRuntimeError('PHASE2_MODEL_UNSUPPORTED', 'Phase 2 checkout proves subscription rail only', 409);
    }
    const priceId = this.stripe.resolvePrice(authority.profile, planId);
    const successUrl = this.returnUrl(authority.profile, 'success', successRef);
    const cancelUrl = this.returnUrl(authority.profile, 'cancel', cancelRef);
    const fingerprint = await requestFingerprint({
      route: '/v1/checkout', accountId, planId, operationId, successRef, cancelRef,
      productId: authority.profile.productId, profileVersion: authority.profile.profileVersion, priceId,
    });
    const operation = await this.db.beginOperation({
      environment: authority.credential.environment, productId: authority.credential.productId,
      accountId, credentialKeyId: authority.credential.keyId, profileVersion: authority.profile.profileVersion,
      route: '/v1/checkout', operationId, requestFingerprint: fingerprint, correlationId: authority.correlationId,
    });
    const correlationId = operation.correlationId;
    if (operation.status === 'completed' && operation.providerObjectId) {
      const existing = await this.stripe.retrieveCheckoutSession(operation.providerObjectId);
      return jsonResponse({
        checkout_session_id: existing.id,
        checkout_url: typeof existing.url === 'string' ? existing.url : null,
        status: typeof existing.status === 'string' ? existing.status : null,
        correlation_id: correlationId,
        idempotent_replay: true,
      }, 200, correlationId);
    }
    const reservationToken = await deriveIdempotencyKey([
      authority.credential.environment, authority.credential.productId, accountId,
      String(authority.profile.profileVersion), 'customer-reservation',
    ]);
    let mapping = await this.db.reserveCustomer({
      environment: authority.credential.environment,
      productId: authority.credential.productId,
      accountId,
      profileVersion: authority.profile.profileVersion,
      reservationToken,
    });
    if (!mapping.providerCustomerId) {
      const customerKey = await deriveIdempotencyKey([
        authority.credential.environment, authority.credential.productId, accountId,
        String(authority.profile.profileVersion), 'stripe-customer',
      ]);
      const customer = await this.stripe.createCustomer({
        wstera_product_id: authority.profile.productId,
        wstera_product_code: authority.profile.productCode,
        account_id: accountId,
        profile_version: String(authority.profile.profileVersion),
      }, customerKey);
      await this.db.completeCustomerReservation(mapping.id, reservationToken, customer.id);
      mapping = { ...mapping, state: 'ready', providerCustomerId: customer.id, reservationToken: null };
    }
    const checkoutKey = await deriveIdempotencyKey([
      authority.credential.environment, authority.credential.productId, accountId,
      operationId, String(authority.profile.profileVersion), 'checkout',
    ]);
    try {
      const checkout = await this.stripe.createSubscriptionCheckout({
        customerId: mapping.providerCustomerId,
        priceId,
        successUrl,
        cancelUrl,
        idempotencyKey: checkoutKey,
        metadata: {
          wstera_product_id: authority.profile.productId,
          wstera_product_code: authority.profile.productCode,
          account_id: accountId,
          profile_version: String(authority.profile.profileVersion),
          plan_id: planId,
          operation_id: operationId,
        },
      });
      await this.db.completeOperation(operation.id, checkout.id, {
        checkout_session_id: checkout.id,
        status: checkout.status,
        correlation_id: correlationId,
      });
      await this.db.audit({
        correlationId, eventName: 'checkout.created', outcome: 'success',
        environment: authority.credential.environment, productId: authority.profile.productId,
        accountId, providerObjectId: checkout.id,
        details: { plan_id: planId, profile_version: authority.profile.profileVersion },
      });
      return jsonResponse({
        checkout_session_id: checkout.id,
        checkout_url: checkout.url,
        status: checkout.status,
        correlation_id: correlationId,
      }, 201, correlationId);
    } catch (error) {
      const code = error instanceof BillingRuntimeError ? error.code : 'CHECKOUT_FAILED';
      await this.db.failOperation(operation.id, code);
      await this.db.audit({
        correlationId, eventName: 'checkout.created', outcome: 'failure',
        environment: authority.credential.environment, productId: authority.profile.productId,
        accountId, details: { error_code: code, plan_id: planId },
      });
      throw error;
    }
  }
  private validateQuery(url: URL, allowedKeys: string[]): void {
    const allowed = new Set(allowedKeys);
    const unknown = [...url.searchParams.keys()].filter((key) => !allowed.has(key));
    if (unknown.length > 0) {
      throw new BillingRuntimeError('CALLER_AUTHORITY_OVERRIDE', `Unsupported or authoritative query fields: ${unknown.join(', ')}`, 400);
    }
  }

  private async handleSubscriptionStatus(request: Request, url: URL): Promise<Response> {
    this.validateQuery(url, ['account_id', 'operation_id']);
    const accountId = requireString(url.searchParams.get('account_id'), 'account_id');
    const operationId = requireString(url.searchParams.get('operation_id'), 'operation_id');
    const authority = await this.authority(request, 'read', 'subscription_status', accountId, operationId);
    const state = await this.db.getSubscriptionState(
      authority.credential.environment, authority.profile.productId, accountId,
    );
    await this.db.audit({
      correlationId: authority.correlationId, eventName: 'subscription.status.read', outcome: 'success',
      environment: authority.credential.environment, productId: authority.profile.productId, accountId,
      details: { found: Boolean(state) },
    });
    return jsonResponse({
      account_id: accountId,
      product_id: authority.profile.productId,
      profile_version: authority.profile.profileVersion,
      subscription: state,
      correlation_id: authority.correlationId,
    }, 200, authority.correlationId);
  }
  private async handleEntitlements(request: Request, url: URL): Promise<Response> {
    this.validateQuery(url, ['account_id', 'operation_id']);
    const accountId = requireString(url.searchParams.get('account_id'), 'account_id');
    const operationId = requireString(url.searchParams.get('operation_id'), 'operation_id');
    const authority = await this.authority(request, 'read', 'entitlements_read', accountId, operationId);
    const projection = await this.db.getEntitlementProjection(
      authority.credential.environment, authority.profile.productId, accountId,
    );
    await this.db.audit({
      correlationId: authority.correlationId, eventName: 'entitlements.read', outcome: 'success',
      environment: authority.credential.environment, productId: authority.profile.productId, accountId,
      details: { found: Boolean(projection), source: 'core-test-sink' },
    });
    return jsonResponse({
      account_id: accountId,
      product_id: authority.profile.productId,
      profile_version: authority.profile.profileVersion,
      entitlement_projection: projection,
      source: 'core-test-sink',
      product_state_mutated: false,
      correlation_id: authority.correlationId,
    }, 200, authority.correlationId);
  }

  private async handlePortal(request: Request): Promise<Response> {
    const body = await readJsonBody(request, ['account_id', 'operation_id', 'return_ref']);
    const accountId = requireString(body.account_id, 'account_id');
    const operationId = requireString(body.operation_id, 'operation_id');
    const returnRef = requireString(body.return_ref, 'return_ref');
    const authority = await this.authority(request, 'portal', 'portal', accountId, operationId);
    const mapping = await this.db.getCustomerByAccount(
      authority.credential.environment, authority.profile.productId, accountId,
    );
    if (!mapping?.providerCustomerId) {
      throw new BillingRuntimeError('PORTAL_CUSTOMER_NOT_FOUND', 'No provider customer mapping for account', 404);
    }
    const fingerprint = await requestFingerprint({
      route: '/v1/portal', accountId, operationId, returnRef,
      productId: authority.profile.productId, profileVersion: authority.profile.profileVersion,
    });
    const operation = await this.db.beginOperation({
      environment: authority.credential.environment, productId: authority.profile.productId, accountId,
      credentialKeyId: authority.credential.keyId, profileVersion: authority.profile.profileVersion,
      route: '/v1/portal', operationId, requestFingerprint: fingerprint, correlationId: authority.correlationId,
    });
    const correlationId = operation.correlationId;
    const portalKey = await deriveIdempotencyKey([
      authority.credential.environment, authority.profile.productId, accountId,
      operationId, String(authority.profile.profileVersion), 'portal',
    ]);
    try {
      const portal = await this.stripe.createPortalSession({
        customerId: mapping.providerCustomerId,
        returnUrl: this.returnUrl(authority.profile, 'portal', returnRef),
        idempotencyKey: portalKey,
      });
      await this.db.completeOperation(operation.id, portal.id, {
        portal_session_id: portal.id,
        correlation_id: correlationId,
      });
      await this.db.audit({
        correlationId, eventName: 'portal.created', outcome: 'success',
        environment: authority.credential.environment, productId: authority.profile.productId,
        accountId, providerObjectId: portal.id,
      });
      return jsonResponse({
        portal_session_id: portal.id,
        portal_url: portal.url,
        correlation_id: correlationId,
      }, 201, correlationId);
    } catch (error) {
      const code = error instanceof BillingRuntimeError ? error.code : 'PORTAL_FAILED';
      await this.db.failOperation(operation.id, code);
      await this.db.audit({
        correlationId, eventName: 'portal.created', outcome: 'failure',
        environment: authority.credential.environment, productId: authority.profile.productId,
        accountId, details: { error_code: code },
      });
      throw error;
    }
  }

  private async handleWebhook(request: Request): Promise<Response> {
    const correlationId = crypto.randomUUID();
    const rawBody = await readBoundedRawBody(request, this.config.webhookMaxBytes);
    const event = await verifyStripeWebhook(
      rawBody, request.headers.get('stripe-signature'), this.config.stripeWebhookSecret,
    );
    if (event.livemode) {
      throw new BillingRuntimeError('LIVE_WEBHOOK_DENIED', 'Live Stripe webhook denied in Phase 2', 403);
    }
    const mapping = event.providerCustomerId
      ? await this.db.getCustomerByProviderId(event.providerCustomerId)
      : null;
    if (mapping) {
      const hintMismatch =
        (event.hints.product_id && event.hints.product_id !== mapping.productId) ||
        (event.hints.account_id && event.hints.account_id !== mapping.accountId) ||
        (event.hints.profile_version && Number(event.hints.profile_version) !== mapping.profileVersion);
      if (hintMismatch) {
        await this.db.audit({
          correlationId, eventName: 'webhook.routing_hint_mismatch', outcome: 'warning',
          environment: mapping.environment, productId: mapping.productId, accountId: mapping.accountId,
          providerEventId: event.providerEventId,
          details: { hints_ignored: true },
        });
      }
    }
    const claimed = await this.db.claimWebhookEvent({
      providerEventId: event.providerEventId, eventType: event.eventType, livemode: event.livemode,
      providerObjectId: event.providerObjectId, providerCustomerId: event.providerCustomerId,
      hints: event.hints, normalizedEnvelope: event.normalizedEnvelope, mapping, correlationId,
    });
    await this.db.audit({
      correlationId, eventName: 'webhook.intake',
      outcome: claimed.skipped ? 'skipped' : claimed.duplicate ? 'duplicate' : 'accepted',
      environment: mapping?.environment ?? null, productId: mapping?.productId ?? null,
      accountId: mapping?.accountId ?? null, providerEventId: event.providerEventId,
      providerObjectId: event.providerObjectId,
      details: { duplicate: claimed.duplicate, skipped: claimed.skipped, durable_claim: true },
    });
    return jsonResponse({
      received: true,
      duplicate: claimed.duplicate,
      skipped: claimed.skipped,
      correlation_id: correlationId,
    }, 200, correlationId);
  }

  async enqueueAccountSweep(input: {
    productId: string;
    accountId: string;
    profileVersion: number;
  }): Promise<number> {
    const mapping = await this.db.getCustomerByAccount('test', input.productId, input.accountId);
    if (!mapping?.providerCustomerId) return 0;
    const subscriptionIds = await this.stripe.listCustomerSubscriptions(mapping.providerCustomerId);
    for (const subscriptionId of subscriptionIds) {
      await this.db.enqueueReconciliation({
        environment: 'test', productId: input.productId, accountId: input.accountId,
        profileVersion: input.profileVersion, providerSubscriptionId: subscriptionId,
        correlationId: crypto.randomUUID(), reason: 'scheduled-sweep',
      });
    }
    return subscriptionIds.length;
  }

  async processOneJob(workerId: string): Promise<'idle' | 'completed' | 'failed' | 'dead_letter'> {
    const job = await this.db.leaseNextJob(workerId);
    if (!job) return 'idle';
    try {
      if (job.jobType === 'reconcile') await this.processReconcileJob(job);
      else if (job.jobType === 'entitlement_test_sink') await this.processEntitlementJob(job);
      else throw new BillingRuntimeError('OUTBOX_JOB_UNKNOWN', 'Unknown outbox job type', 500);
      await this.db.completeJob(job.id);
      return 'completed';
    } catch (error) {
      const code = error instanceof BillingRuntimeError ? error.code : 'OUTBOX_JOB_FAILED';
      if (job.providerEventDbId) await this.db.markProviderEventError(job.providerEventDbId, code);
      const status = await this.db.failJob(job, code);
      await this.db.audit({
        correlationId: job.correlationId, eventName: `outbox.${job.jobType}`, outcome: status,
        environment: job.environment, productId: job.productId, accountId: job.accountId,
        details: { error_code: code, attempt: job.attemptCount },
      });
      return status;
    }
  }
  private async processReconcileJob(job: OutboxJob): Promise<void> {
    if (job.environment !== 'test') throw new BillingRuntimeError('LIVE_JOB_DENIED', 'Live reconciliation job denied', 500);
    const providerObjectId = requireString(job.payload.providerObjectId, 'providerObjectId');
    const profile = this.config.profileRegistry.getRegistered(job.productId, job.environment, job.profileVersion);
    if (profile.status === 'pending_validation' && !this.config.admissionTestMode) {
      throw new BillingRuntimeError('PROFILE_NOT_ACTIVE', 'Pending profile cannot reconcile outside admission test mode', 409);
    }
    if (!['pending_validation', 'active', 'deprecated', 'suspended'].includes(profile.status)) {
      throw new BillingRuntimeError('PROFILE_NOT_RECONCILABLE', `Profile status cannot reconcile: ${profile.status}`, 409);
    }
    const mapping = await this.db.getCustomerByAccount(job.environment, job.productId, job.accountId);
    if (!mapping?.providerCustomerId) {
      throw new BillingRuntimeError('RECONCILE_CUSTOMER_MAPPING_MISSING', 'Provider customer mapping is missing', 409);
    }
    const snapshot = await this.stripe.retrieveSubscription(providerObjectId);
    if (snapshot.livemode) throw new BillingRuntimeError('LIVE_PROVIDER_OBJECT_DENIED', 'Live provider object denied', 500);
    if (snapshot.customerId !== mapping.providerCustomerId) {
      throw new BillingRuntimeError('RECONCILE_ACCOUNT_MISMATCH', 'Provider customer does not match account mapping', 409);
    }
    const { plan } = planForPrice(profile, snapshot.priceId);
    const expectedMapping = profile.providerMappings.stripe[profile.environment];
    if (snapshot.productId !== expectedMapping.stripeProductId) {
      throw new BillingRuntimeError('RECONCILE_PRODUCT_MISMATCH', 'Provider Product does not match pinned profile', 409);
    }
    if (snapshot.amountMinor !== plan.amountMinor) {
      throw new BillingRuntimeError('RECONCILE_AMOUNT_MISMATCH', 'Provider amount does not match pinned plan', 409);
    }
    if (snapshot.currency !== profile.currency.code) {
      throw new BillingRuntimeError('RECONCILE_CURRENCY_MISMATCH', 'Provider currency does not match pinned profile', 409);
    }
    if (plan.interval !== 'none') {
      if (!snapshot.currentPeriodStart || !snapshot.currentPeriodEnd || snapshot.currentPeriodEnd <= snapshot.currentPeriodStart) {
        throw new BillingRuntimeError('RECONCILE_PERIOD_INVALID', 'Provider billing period is missing or invalid', 409);
      }
      const days = (snapshot.currentPeriodEnd - snapshot.currentPeriodStart) / 86_400;
      if (plan.interval === 'month' && (days < 20 || days > 40)) {
        throw new BillingRuntimeError('RECONCILE_PERIOD_MISMATCH', 'Provider billing period is not monthly', 409);
      }
      if (plan.interval === 'year' && (days < 330 || days > 400)) {
        throw new BillingRuntimeError('RECONCILE_PERIOD_MISMATCH', 'Provider billing period is not yearly', 409);
      }
    }
    const metadataChecks: Array<[string, string]> = [
      ['wstera_product_id', profile.productId],
      ['account_id', job.accountId],
      ['profile_version', String(profile.profileVersion)],
      ['plan_id', plan.planId],
    ];
    for (const [key, expected] of metadataChecks) {
      if (snapshot.metadata[key] && snapshot.metadata[key] !== expected) {
        throw new BillingRuntimeError('RECONCILE_PROVIDER_METADATA_MISMATCH', `Provider metadata mismatch: ${key}`, 409);
      }
    }
    const snapshotHash = await requestFingerprint({
      subscriptionId: snapshot.subscriptionId,
      customerId: snapshot.customerId,
      status: snapshot.status,
      priceId: snapshot.priceId,
      productId: snapshot.productId,
      amountMinor: snapshot.amountMinor,
      currency: snapshot.currency,
      currentPeriodStart: snapshot.currentPeriodStart,
      currentPeriodEnd: snapshot.currentPeriodEnd,
      cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
    });
    const reconciliation = await this.db.upsertReconciliation({
      environment: job.environment,
      productId: job.productId,
      accountId: job.accountId,
      profileVersion: profile.profileVersion,
      planId: plan.planId,
      providerSubscriptionId: snapshot.subscriptionId,
      providerCustomerId: snapshot.customerId,
      providerStatus: snapshot.status,
      priceId: snapshot.priceId,
      providerProductId: snapshot.productId,
      amountMinor: snapshot.amountMinor,
      currency: snapshot.currency,
      currentPeriodStart: snapshot.currentPeriodStart ? new Date(snapshot.currentPeriodStart * 1000) : null,
      currentPeriodEnd: snapshot.currentPeriodEnd ? new Date(snapshot.currentPeriodEnd * 1000) : null,
      cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
      snapshotHash,
      correlationId: job.correlationId,
    });
    if (reconciliation.changed) {
      const signingKey = this.config.entitlementSigningKeys.find((candidate) =>
        candidate.productId === job.productId && candidate.environment === job.environment,
      );
      if (!signingKey) {
        throw new BillingRuntimeError('ENTITLEMENT_SIGNING_KEY_MISSING', 'Entitlement signing key is missing', 500);
      }
      const now = Date.now();
      const transitionType = transitionTypeForStatus(snapshot.status);
      const envelope: EntitlementTransitionEnvelope = {
        environment: job.environment,
        product_id: job.productId,
        account_id: job.accountId,
        profile_version: profile.profileVersion,
        plan_id: plan.planId,
        transition_type: transitionType,
        entitlement_keys: transitionType === 'grant' ? plan.entitlementKeys : [],
        provider_subscription_id: snapshot.subscriptionId,
        correlation_id: job.correlationId,
        transition_version: reconciliation.version,
        idempotency_key: await deriveIdempotencyKey([
          job.environment, job.productId, job.accountId, snapshot.subscriptionId,
          String(reconciliation.version), transitionType,
        ]),
        issued_at: new Date(now).toISOString(),
        expires_at: new Date(now + 120_000).toISOString(),
        signing_key_id: signingKey.keyId,
      };
      const signed = await signEntitlementTransition(envelope, signingKey);
      await this.db.createEntitlementTransition({ signed, providerEventDbId: job.providerEventDbId });
    } else if (job.providerEventDbId) {
      await this.db.markProviderEventComplete(job.providerEventDbId);
    }
    await this.db.audit({
      correlationId: job.correlationId,
      eventName: 'reconciliation.completed',
      outcome: 'success',
      environment: job.environment,
      productId: job.productId,
      accountId: job.accountId,
      providerObjectId: snapshot.subscriptionId,
      details: {
        provider_status: snapshot.status,
        plan_id: plan.planId,
        reconciliation_version: reconciliation.version,
        changed: reconciliation.changed,
      },
    });
  }

  private async processEntitlementJob(job: OutboxJob): Promise<void> {
    const transitionId = requireString(job.payload.transitionId, 'transitionId');
    const signedCandidate = job.payload.signed;
    if (!signedCandidate || typeof signedCandidate !== 'object') {
      throw new BillingRuntimeError('ENTITLEMENT_PAYLOAD_INVALID', 'Entitlement job payload is invalid', 500);
    }
    const signed = signedCandidate as SignedEntitlementTransition;
    await verifyEntitlementTransition(signed, this.config.entitlementSigningKeys);
    if (signed.envelope.product_id !== job.productId || signed.envelope.account_id !== job.accountId) {
      throw new BillingRuntimeError('ENTITLEMENT_JOB_SCOPE_MISMATCH', 'Entitlement job scope mismatch', 500);
    }
    const applied = await this.db.deliverEntitlementToTestSink({
      transitionId,
      signed,
      providerEventDbId: job.providerEventDbId,
    });
    await this.db.audit({
      correlationId: job.correlationId,
      eventName: 'entitlement.test_sink.delivered',
      outcome: applied ? 'applied' : 'duplicate_or_stale',
      environment: job.environment,
      productId: job.productId,
      accountId: job.accountId,
      providerObjectId: signed.envelope.provider_subscription_id,
      details: {
        transition_type: signed.envelope.transition_type,
        transition_version: signed.envelope.transition_version,
        sink_only: true,
      },
    });
  }
}
