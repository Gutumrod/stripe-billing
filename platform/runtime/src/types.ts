export type BillingEnvironment = 'test' | 'live';
// LR-2F-A DG-10 (STAGE-B-OWNER-RULING-AMENDMENT §3, C-1): `control_read` is the dedicated Control
// projection scope. It is read-only, product-bound, environment-bound and account-assertion-bound,
// and grants no checkout, portal, subscription mutation, refund or provider execution authority.
// The pre-existing `checkout` | `read` | `portal` members are unchanged.
export type CredentialScope = 'checkout' | 'read' | 'portal' | 'control_read';

export interface CredentialBinding {
  keyId: string;
  token: string;
  productId: string;
  environment: BillingEnvironment;
  profileVersion: number;
  scopes: CredentialScope[];
}

export interface AccountAssertionKey {
  keyId: string;
  productId: string;
  environment: BillingEnvironment;
  secret: string;
}

export interface ReturnUrlSet {
  success: Record<string, string>;
  cancel: Record<string, string>;
  portal: Record<string, string>;
}
export interface EntitlementSigningKey {
  keyId: string;
  productId: string;
  environment: BillingEnvironment;
  secret: string;
}

export interface PlanProfile {
  planId: string;
  packageRef: string;
  model: 'free' | 'trial' | 'subscription' | 'one_time' | 'manual_renewal';
  amountMinor: number | null;
  interval: 'none' | 'month' | 'year' | 'manual_period';
  entitlementKeys: string[];
}

export interface RuntimeProfile {
  productId: string;
  productCode: string;
  environment: BillingEnvironment;
  profileVersion: number;
  status: string;
  currency: { code: string };
  plans: PlanProfile[];
  providerMappings: {
    stripe: {
      test: { stripeProductId: string | null; stripePriceIds: Record<string, string> };
      live: { stripeProductId: string | null; stripePriceIds: Record<string, string> };
    };
  };
}

export interface ProfileRegistryLike {
  getRegistered(productId: string, environment: BillingEnvironment, version: number): Readonly<RuntimeProfile>;
  resolveForRuntime(context: {
    credentialProductId: string;
    requestedProductId?: string;
    environment: BillingEnvironment;
    profileVersion: number;
  }): Readonly<RuntimeProfile>;
}

import type { BillingDb } from './db';
import type { StripeTestAdapter } from './stripe';

export interface RuntimeLogger {
  info(event: string, fields: Record<string, unknown>): void;
  warn(event: string, fields: Record<string, unknown>): void;
  error(event: string, fields: Record<string, unknown>): void;
}
export interface RuntimeConfig {
  environment: BillingEnvironment;
  schema: 'billing_core' | 'billing_core_staging';
  admissionTestMode: boolean;
  databaseUrl: string;
  stripeSecretKey: string;
  stripeWebhookSecret: string;
  webhookMaxBytes: number;
  credentials: CredentialBinding[];
  assertionKeys: AccountAssertionKey[];
  returnUrls: Record<string, ReturnUrlSet>;
  entitlementSigningKeys: EntitlementSigningKey[];
  profileRegistry: ProfileRegistryLike;
  logger: RuntimeLogger;
  fetch?: typeof globalThis.fetch;
  db?: BillingDb;
  stripe?: StripeTestAdapter;
}

export interface RequestAuthority {
  credential: CredentialBinding;
  correlationId: string;
  accountId: string;
  operationId: string;
  action: string;
  profile: Readonly<RuntimeProfile>;
}
export interface CheckoutInput {
  account_id: string;
  plan_id: string;
  operation_id: string;
  success_return_ref: string;
  cancel_return_ref: string;
}

export interface ProviderSubscriptionSnapshot {
  subscriptionId: string;
  customerId: string;
  status: string;
  priceId: string;
  productId: string | null;
  amountMinor: number | null;
  currency: string | null;
  currentPeriodStart: number | null;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  livemode: boolean;
  metadata: Record<string, string>;
}

export interface EntitlementTransitionEnvelope {
  environment: BillingEnvironment;
  product_id: string;
  account_id: string;
  profile_version: number;
  plan_id: string;
  transition_type: 'grant' | 'revoke' | 'pending';
  entitlement_keys: string[];
  provider_subscription_id: string;
  correlation_id: string;
  transition_version: number;
  idempotency_key: string;
  issued_at: string;
  expires_at: string;
  signing_key_id: string;
}

export interface SignedEntitlementTransition {
  envelope: EntitlementTransitionEnvelope;
  signature: string;
}

export class BillingRuntimeError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  constructor(code: string, message: string, status = 400, retryable = false) {
    super(message);
    this.name = 'BillingRuntimeError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

// LR-2F-A DG-11/DG-12 (STAGE-B-OWNER-RULING-AMENDMENT §3 "Status codes", §4 C-10/C-11/C-12) —
// the closed, wire-visible error-code set of the Control read route
// GET /v1/billing/control/snapshot. Every member is a stable machine-readable code so a caller
// classifies the failure by code alone. `INTERNAL_ERROR` is deliberately NOT a member: the
// control read path must not be able to report a *typed* condition through the untyped envelope.
export type ControlReadErrorCode =
  // DG-11: authenticated read of an account/resource SB01 holds no authoritative row for -> 404.
  // "Do not return `200 + null` for a resource that does not exist."
  | 'CONTROL_READ_RESOURCE_NOT_FOUND'
  // DG-11: the authenticated credential's product has no resolvable profile -> typed 404.
  // "Unknown product handling must be typed so it does not accidentally collapse into generic 500."
  | 'CONTROL_READ_UNKNOWN_PRODUCT'
  // DG-12: authoritative dependency (billing DB) temporarily unavailable -> typed 503, retryable,
  // and never misrepresented as a generic internal error or as "SB01 disconnected".
  | 'CONTROL_READ_DEPENDENCY_DEGRADED';

// The Control read projection's typed failure. It is a specialization of the existing bounded
// error envelope and adds no wire field: the envelope already emits exactly `code`, `message`
// `status` and `retryable`, so a caller classifies the failure without internal detail, a stack
// trace, a connection string or any provider/credential value being exposed.
export class ControlReadProjectionError extends BillingRuntimeError {
  constructor(code: ControlReadErrorCode, message: string, status: number, retryable = false) {
    super(code, message, status, retryable);
    this.name = 'ControlReadProjectionError';
  }
}

// LR-2F-A DG-12 (C-12) — typed authoritative-dependency failure. A dependency that is
// unreachable or temporarily unusable is a retryable/degraded condition, NOT an internal software
// error, so it must not surface as INTERNAL_ERROR. `retryable: true` is carried as data so the
// caller can act on it without parsing prose. Codes are internal to the dependency boundary; the
// Control read route re-maps them onto its own wire code CONTROL_READ_DEPENDENCY_DEGRADED.
export class BillingDependencyError extends BillingRuntimeError {
  constructor(code: string, message: string, status = 503, retryable = true) {
    super(code, message, status, retryable);
    this.name = 'BillingDependencyError';
  }
}

export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}
