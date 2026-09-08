export type BillingEnvironment = 'test' | 'live';
export type CredentialScope = 'checkout' | 'read' | 'portal';

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

export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}
