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
  BillingDependencyError,
  BillingRuntimeError,
  ControlReadErrorCode,
  ControlReadProjectionError,
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
// Addressed read resources fail closed with a typed 404 after authorization, so a missing
// account_id / operation_id is a not-found resource rather than a malformed body field
// (DG-11; matches the existing GET /v1/portal not-found precedent). Distinct from the
// runtime's unshaped `{"error":"NOT_FOUND"}` unmatched-path body.
function requireAddressedString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BillingRuntimeError('NOT_FOUND', `${field} is required to address this resource`, 404);
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

// ---------------------------------------------------------------------------------------------
// LR-2F-A STAGE C — Control read projection (authority: STAGE-B-OWNER-RULING-AMENDMENT §3/§4,
// DG-1/DG-2/DG-3/DG-4/DG-5/DG-6/DG-7/DG-10/DG-11/DG-12/DG-13/DG-14/DG-16).
//
// Route: GET /v1/billing/control/snapshot?account_id=<id>&operation_id=<id>
//   * scope `control_read` (C-1) — a `read` credential is denied AUTH_SCOPE_DENIED
//   * mandatory operation_id + HMAC account assertion bound to (product, environment, account,
//     operation_id, action) (DG-9)
//   * exactly one account per read; no product-wide aggregate and no account-enumeration
//     array surface (DG-1/DG-16)
//   * caller-supplied query/header authority other than the assertion -> 400 (CALLER_AUTHORITY_OVERRIDE)
//   * no body, no mutation, no provider call
// The v1 body carries exactly these top-level keys, in this order:
//   schemaVersion, productId, environment, accountId, observedAt, readiness, freshness,
//   subscription, paymentDataState, payments, warnings, correlation_id
//
// Typed failures (DG-11/DG-12; see controlReadError/controlReadNotFound below). Their wire body is
// this route's own error envelope `{ error, message, retryable }`, projected at this route's
// boundary only — the shared catch-all envelope stays exactly `{ error, message }`
// (STAGE-B-READ-CONTRACT.md:570; `retryable` is carried on the error object and logged, never
// returned to the caller of a pre-existing route):
//   CONTROL_READ_RESOURCE_NOT_FOUND  404 — authenticated, but no authoritative row exists:
//                                          runtime_reconciliation_state AND
//                                          runtime_entitlement_test_sink both empty for the
//                                          addressed account. Never 200 with a null projection.
//   CONTROL_READ_UNKNOWN_PRODUCT     404 — credential product has no resolvable profile.
//   CONTROL_READ_DEPENDENCY_DEGRADED 503 — retryable: authoritative billing DB temporarily
//                                          unavailable. Distinguishable by code from both of the
//                                          above and from a generic internal error.
//   INTERNAL_ERROR                   500 — genuinely unexpected software error, still the untyped
//                                          default. Deliberately not a typed Control read code.
// ---------------------------------------------------------------------------------------------
const CONTROL_READ_ROUTE = '/v1/billing/control/snapshot';
const CONTROL_READ_ACTION = 'control_billing_snapshot_read';
// DG-2: mandatory SB01-native integer literal, validated by construction (no coercion path).
const CONTROL_READ_SCHEMA_VERSION = 1;
// DG-6: domain separator for the opaque subscription reference derivation.
const CONTROL_READ_REF_DOMAIN = 'wstera-control-subscription-ref-v1';
// DG-3: readiness is projection-level. A 200 read means SB01 authoritatively served this
// account's projection, so state is `ready` (closed set: waiting_for_billing_core | ready |
// degraded) and reason is a non-empty operator string. `waiting_for_billing_core` is not
// hard-coded while the read path works.
const CONTROL_READ_READINESS_REASON =
  'Authoritative SB01 billing reconciliation is readable for this account; payment actions remain disabled.';
// DG-13: explicit typed absence — `payments: []` alone would conflate "no payments" with
// "SB01 holds no authoritative payment projection at all".
const CONTROL_READ_PAYMENT_WARNING =
  'payment_projection_not_available: SB01 holds no authoritative payment source at schemaVersion 1; '
  + 'payments is an empty collection and paymentDataState is not_available.';

// LR-2F-A DG-11/DG-12 (C-10/C-11/C-12) — route-scoped classification of the two TYPED failures the
// Control read must report, and the ONLY place either may be produced inside this route. Both
// statuses are fixed here (404 / 503) and are never derived from an upstream value, so a failure
// cannot smuggle a provider- or dependency-supplied status onto the wire.
//
// It is deliberately NOT a general error mapper:
//   * an already-classified `BillingRuntimeError` (auth 401/403, assertion 401/403, scope 403,
//     caller-authority 400, credential/env mismatch) is re-thrown untouched;
//   * a `ControlReadProjectionError` is re-thrown untouched (idempotent);
//   * `UNKNOWN_PRODUCT` (re-coded in security.ts:resolveProfile from the registry's bare
//     ProfileResolutionError) becomes CONTROL_READ_UNKNOWN_PRODUCT with its own code and status;
//   * an explicitly typed dependency failure becomes CONTROL_READ_DEPENDENCY_DEGRADED, 503 and
//     retryable — reachable-but-degraded, never reported as a generic internal error (DG-12);
//   * EVERYTHING else is returned unchanged, so a genuinely unexpected software error still
//     reaches the handler's untyped catch as 500 INTERNAL_ERROR (DG-12: "do not silently relabel
//     every software error as ordinary degradation").
// DG-11/DG-12 — the wire codes this route may emit, typed so a typo cannot silently mint a new
// code and so `INTERNAL_ERROR` can never be reached through a typed path here.
const CONTROL_READ_RESOURCE_NOT_FOUND_CODE: ControlReadErrorCode = 'CONTROL_READ_RESOURCE_NOT_FOUND';
const CONTROL_READ_UNKNOWN_PRODUCT_CODE: ControlReadErrorCode = 'CONTROL_READ_UNKNOWN_PRODUCT';
const CONTROL_READ_DEPENDENCY_DEGRADED_CODE: ControlReadErrorCode = 'CONTROL_READ_DEPENDENCY_DEGRADED';

function controlReadError(error: unknown): unknown {
  if (error instanceof ControlReadProjectionError) return error;
  if (error instanceof BillingDependencyError) {
    return new ControlReadProjectionError(
      CONTROL_READ_DEPENDENCY_DEGRADED_CODE,
      'Authoritative SB01 billing dependency is temporarily unavailable; retry with backoff.',
      503,
      true,
    );
  }
  if (error instanceof BillingRuntimeError) {
    if (error.code === 'UNKNOWN_PRODUCT') {
      return new ControlReadProjectionError(
        CONTROL_READ_UNKNOWN_PRODUCT_CODE,
        'The authenticated credential product has no resolvable billing profile.',
        404,
      );
    }
    return error;
  }
  // DG-11 / C-11: unknown-product classification. After the credential authenticates, the route
  // resolves the profile through the profile registry, which signals "this credential's product
  // has no resolvable profile" with a bare `ProfileResolutionError extends Error`
  // (platform/profile-registry/src/registry.ts:40 'exact profile version not found',
  // :49 'exact scoped profile not found', :50 'profile is not active'). It is NOT a
  // BillingRuntimeError, so before this branch it reached the handler's untyped catch and surfaced
  // as `500 INTERNAL_ERROR` purely for lack of classification — the exact collapse DG-11 forbids.
  // Matched structurally by name rather than by importing the class, because the profile registry
  // is an independent module (DG-8 keeps SB01's dependency direction registry-free) and the
  // runtime already consumes it only through the injected `ProfileRegistryLike` port. Only the
  // error's identity is used; `error.message` may name a profile status and is deliberately NOT
  // echoed into the wire body.
  if (error instanceof Error && error.name === 'ProfileResolutionError') {
    return new ControlReadProjectionError(
      CONTROL_READ_UNKNOWN_PRODUCT_CODE,
      'The authenticated credential product has no resolvable billing profile.',
      404,
    );
  }
  return error;
}

// DG-11 — the typed not-found condition, constructed in exactly one place so the code and status
// cannot drift apart. The message is a fixed operator string: it names no account, no product, no
// credential and no authoritative column.
function controlReadNotFound(): ControlReadProjectionError {
  return new ControlReadProjectionError(
    CONTROL_READ_RESOURCE_NOT_FOUND_CODE,
    'No authoritative SB01 billing projection exists for the addressed account.',
    404,
  );
}

// Absent authority is reported as absent — never as zero, empty string or a placeholder (DG-4).
function optionalStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}
function integerOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  // postgres.js returns bigint columns as strings; a non-integer string is not a revision counter.
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}
function isoTimestampOrNull(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return optionalStringOrNull(value);
}

// DG-6: opaque, non-provider-executable reference. Deterministic for the same
// (environment, productId, accountId, provider subscription id) and it never embeds the raw
// provider id, so it cannot be replayed against the provider. Only hex + a fixed prefix, so a
// Stripe-shaped `sub_...` identifier can never be a substring of the result.
async function deriveControlSubscriptionRef(
  environment: string,
  productId: string,
  accountId: string,
  providerSubscriptionId: string,
): Promise<string> {
  const digest = await sha256Hex(
    [CONTROL_READ_REF_DOMAIN, environment, productId, accountId, providerSubscriptionId].join('\u001f'),
  );
  return `sub_ref_${digest.slice(0, 32)}`;
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
    this.db = config.db ?? new BillingDb(config.databaseUrl, config.schema);
    this.stripe = config.stripe ?? new StripeTestAdapter({ secretKey: config.stripeSecretKey, fetch: config.fetch });
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
    for (const [headerName] of request.headers) {
      const lower = headerName.toLowerCase();
      if (lower.startsWith('x-wstera-') && lower !== 'x-wstera-account-assertion') {
        throw new BillingRuntimeError('CALLER_AUTHORITY_OVERRIDE', `Authoritative or unsupported header: ${headerName}`, 400);
      }
    }
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
      if (request.method === 'POST' && url.pathname === '/v1/checkout') {
        this.validateQuery(url, []);
        return await this.handleCheckout(request);
      }
      if (request.method === 'GET' && url.pathname === '/v1/subscription/status') return await this.handleSubscriptionStatus(request, url);
      if (request.method === 'GET' && url.pathname === '/v1/entitlements') return await this.handleEntitlements(request, url);
      if (request.method === 'GET' && url.pathname === CONTROL_READ_ROUTE) return await this.handleControlBillingSnapshot(request, url);
      if (request.method === 'POST' && url.pathname === '/v1/portal') {
        this.validateQuery(url, []);
        return await this.handlePortal(request);
      }
      if (request.method === 'POST' && url.pathname === '/webhooks/stripe') {
        this.validateQuery(url, []);
        return await this.handleWebhook(request);
      }
      if (request.method === 'GET' && url.pathname === '/healthz') {
        this.validateQuery(url, []);
        return jsonResponse({ ok: true, environment: this.config.environment });
      }
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
      // Existing bounded error envelope, restored to the shape the base contract fixes at exactly
      // `{ error, message }`: `retryable` is carried on the error object and logged, never returned
      // to the caller (STAGE-B-READ-CONTRACT.md:570). It is therefore deliberately absent from this
      // shared catch-all — the Control read route alone projects it, at its own boundary
      // (see handleControlBillingSnapshot, DG-12).
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
    let providerCustomerId = mapping.providerCustomerId;
    if (!providerCustomerId) {
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
      providerCustomerId = customer.id;
    }
    const checkoutKey = await deriveIdempotencyKey([
      authority.credential.environment, authority.credential.productId, accountId,
      operationId, String(authority.profile.profileVersion), 'checkout',
    ]);
    try {
      const checkout = await this.stripe.createSubscriptionCheckout({
        customerId: providerCustomerId,
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

  // LR-2F-A STAGE C — account-scoped Control read projection. Read-only: it performs no ledger
  // write, no provider call and no mutation. Authorization is identical in shape to the existing
  // read routes (x-wstera-* header rejection, credential env check, account-bound assertion),
  // except that the required scope is the dedicated `control_read` (DG-10).
  private async handleControlBillingSnapshot(request: Request, url: URL): Promise<Response> {
    try {
      return await this.projectControlBillingSnapshot(request, url);
    } catch (rawError) {
      // The one place this route converts an internal failure into the Control read wire contract;
      // see controlReadError() for exactly what is and is not re-classified.
      const error = controlReadError(rawError);
      const runtimeError = error instanceof BillingRuntimeError
        ? error
        : new BillingRuntimeError('INTERNAL_ERROR', 'Unexpected billing runtime error', 500);
      // Because this route now answers with its own envelope, it must also own the failure log the
      // shared catch-all would otherwise have written: the same event and the same fields, with
      // `retryable` included, since the base contract requires the value to be logged
      // (STAGE-B-READ-CONTRACT.md:570,627). Logging behaviour on this route is therefore unchanged.
      this.config.logger.error('billing.request.failed', {
        path: url.pathname,
        code: runtimeError.code,
        status: runtimeError.status,
        retryable: runtimeError.retryable,
      });
      // This route's boundary re-emits the runtime's error ENVELOPE (not the error itself) with
      // DG-12's `retryable` added, because a typed degraded dependency must be actionable as data
      // rather than prose. It is deliberately confined to this route: everything above is
      // unchanged, the shared catch-all still returns exactly `{ error, message }` for every other
      // route, which is what STAGE-B-READ-CONTRACT.md:570 fixes (DG-12 §3 names no wire field and
      // cannot amend that). The status stays the typed status the envelope already carried, so
      // 404/403/401/400 bodies are byte-identical to the pre-repair projection and only the typed
      // degraded 503 gains the field. Nothing else is added: no stack, no internal detail, no
      // connection string, no provider or credential value.
      return jsonResponse(
        {
          error: runtimeError.code,
          message: runtimeError.message,
          retryable: runtimeError.retryable,
        },
        runtimeError.status,
      );
    }
  }

  private async projectControlBillingSnapshot(request: Request, url: URL): Promise<Response> {
    // Query allowlist: exactly the two address fields. Any unlisted query parameter is a
    // caller-asserted authority and is refused (DG-1/DG-16: no filter, no product-wide read).
    this.validateQuery(url, ['account_id', 'operation_id']);
    const accountId = requireAddressedString(url.searchParams.get('account_id'), 'account_id');
    const operationId = requireAddressedString(url.searchParams.get('operation_id'), 'operation_id');
    const authority = await this.authority(
      request, 'control_read', CONTROL_READ_ACTION, accountId, operationId,
    );
    // productId and environment are BOTH credential-derived and never read from a request field
    // or query parameter (DG-8/DG-14). resolveProfile() inside authority() cross-verifies the
    // credential environment against the runtime and resolves the profile from the credential's
    // own (productId, environment, profileVersion) triple, so a caller cannot select either.
    const productId = authority.credential.productId;
    const environment = authority.credential.environment;

    const state = await this.db.getSubscriptionState(environment, productId, accountId);
    const projection = await this.db.getEntitlementProjection(environment, productId, accountId);

    // DG-11: authorization has already succeeded above. SB01 holds no account registry, so
    // "unknown account" and "known account with no billing data" are indistinguishable at this
    // revision; the ruling's plain reading is therefore that NO authoritative row at all means the
    // addressed resource does not exist. Returning 200 with `subscription: null` and an all-null
    // freshness block would present a non-existent resource as an existing one, which is exactly
    // what DG-11 forbids. SB01's billing truth lives in these two authoritative tables —
    // runtime_reconciliation_state and runtime_entitlement_test_sink — so EITHER row being present
    // is an existing resource and falls through to the unchanged 200 projection below; NEITHER
    // being present is the typed 404. Readiness and freshness cannot be served without one of
    // them, so there is no degraded-but-present state to report at this point.
    if (!state && !projection) throw controlReadNotFound();

    // DG-5: the authoritative provider status string is passed through verbatim. No mapping into
    // any Control status vocabulary is performed anywhere; `cancelAtPeriodEnd` stays its own
    // boolean. DG-6: the provider subscription id is replaced by an opaque ref and is never
    // emitted under any key. Raw provider/product identifiers and price ids are excluded.
    let subscription: Record<string, unknown> | null = null;
    if (state) {
      const rawProviderSubscriptionId = optionalStringOrNull(state.provider_subscription_id);
      subscription = {
        subscriptionRef: rawProviderSubscriptionId
          ? await deriveControlSubscriptionRef(environment, productId, accountId, rawProviderSubscriptionId)
          : null,
        planId: optionalStringOrNull(state.plan_id),
        profileVersion: integerOrNull(state.profile_version),
        providerStatus: optionalStringOrNull(state.provider_status),
        amountMinor: integerOrNull(state.amount_minor),
        currency: optionalStringOrNull(state.currency),
        currentPeriodStart: isoTimestampOrNull(state.current_period_start),
        currentPeriodEnd: isoTimestampOrNull(state.current_period_end),
        cancelAtPeriodEnd: state.cancel_at_period_end === true,
        reconciledAt: isoTimestampOrNull(state.reconciled_at),
      };
    }

    // DG-4: freshness is data, not a timer. Every member is null when the corresponding
    // authoritative row is absent — never a fabricated placeholder and never a server-side
    // staleness verdict (stale is labelled, not refused).
    const freshness = {
      reconciledAt: state ? isoTimestampOrNull(state.reconciled_at) : null,
      appliedAt: projection ? isoTimestampOrNull(projection.applied_at) : null,
      reconciliationVersion: state ? integerOrNull(state.reconciliation_version) : null,
      latestTransitionVersion: projection ? integerOrNull(projection.latest_transition_version) : null,
    };

    // DG-3: readiness is the authenticated projection-level signal, bounded to states SB01 can
    // authoritatively know. canExecutePaymentActions is a fixed literal false (binding security
    // rule; never configurable, never widened).
    const readiness = {
      state: 'ready' as const,
      canRead: true,
      canExecutePaymentActions: false as const,
      reason: CONTROL_READ_READINESS_REASON,
    };

    const warnings = [CONTROL_READ_PAYMENT_WARNING];

    const body = {
      schemaVersion: CONTROL_READ_SCHEMA_VERSION,
      productId,
      environment,
      accountId,
      observedAt: new Date().toISOString(),
      readiness,
      freshness,
      subscription,
      // DG-13: `payments: []` is structurally stable but never means "this account has no
      // payments" on its own; the absence of any authoritative payment source is typed here.
      paymentDataState: 'not_available',
      payments: [] as unknown[],
      warnings,
      correlation_id: authority.correlationId,
    };
    return jsonResponse(body, 200, authority.correlationId);
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
    // Validate the portal return URL allowlist before any durable ledger write: a denied
    // arbitrary return ref must create no operation row, audit row, or provider call.
    this.returnUrl(authority.profile, 'portal', returnRef);
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
