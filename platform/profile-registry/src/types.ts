export type BillingEnvironment = 'test' | 'live';
export type ProfileStatus = 'draft' | 'pending_validation' | 'active' | 'suspended' | 'deprecated' | 'retired';
export type BillingModel = 'free' | 'trial' | 'subscription' | 'one_time' | 'manual_renewal';
export type EntitlementMode = 'push' | 'pull' | 'snapshot';

export interface CurrencyContract {
  code: string;
  minorUnitExponent: number;
  allowedMinorUnits: { min: number; max: number; increment: number };
}

export interface PlanContract {
  planId: string;
  packageRef: string;
  model: BillingModel;
  amountMinor: number | null;
  interval: 'none' | 'month' | 'year' | 'manual_period';
  trialRef: string | null;
  freeTierRef: string | null;
  graceRef: string | null;
  retryDunningRef: string | null;
  entitlementKeys: string[];
}

export interface RailContract {
  cardSubscription: { enabled: boolean; autoRenew: true };
  promptpayManual: { enabled: boolean; autoRenew: false; expiryPolicyRef: string | null };
  cardOneTime: { enabled: boolean; autoRenew: false };
}
export interface EntitlementAdapterContract {
  adapterId: string;
  contractVersion: number;
  mode: EntitlementMode;
  ingressRef: string | null;
  snapshotRef: string | null;
  ttlSeconds: number | null;
  signingKeyRef: string | null;
}

export interface StripeEnvironmentMapping {
  stripeProductId: string | null;
  stripePriceIds: Record<string, string>;
}

export interface AdmissionContract {
  registeredAt: string;
  activatedAt: string | null;
  activatedBy: string | null;
  testRunId: string | null;
  isolationEvidenceRef: string | null;
  rollbackProfileVersion: number | null;
}

export interface ProductBillingProfile {
  schemaVersion: 1;
  productId: string;
  productCode: string;
  displayName: string;
  environment: BillingEnvironment;
  profileVersion: number;
  status: ProfileStatus;
  billingModels: BillingModel[];
  currency: CurrencyContract;
  commercialPolicy: {
    policyRef: string;
    refundPolicyRef: string;
    taxPolicyRef: string | null;
    priceChangePolicyRef: string | null;
  };
  plans: PlanContract[];
  rails: RailContract;
  entitlementAdapter: EntitlementAdapterContract;
  providerMappings: {
    stripe: {
      test: StripeEnvironmentMapping;
      live: StripeEnvironmentMapping;
    };
  };
  admission: AdmissionContract;
}

export interface ProfileResolutionContext {
  credentialProductId: string;
  requestedProductId?: string;
  environment: BillingEnvironment;
  profileVersion: number;
}

export interface AccountBoundRequestContext extends ProfileResolutionContext {
  accountId: string;
  operationId: string;
  accountAssertionVerified: boolean;
}
