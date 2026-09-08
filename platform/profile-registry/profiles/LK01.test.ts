import type { ProductBillingProfile } from '../src/types';

export const lk01TestProfile: ProductBillingProfile = {
  schemaVersion: 1,
  productId: 'prd_f4be6d1a9b544632a527e0e15e485622',
  productCode: 'LK01',
  displayName: 'WSTERA Link',
  environment: 'test',
  profileVersion: 1,
  status: 'pending_validation',
  billingModels: ['free', 'subscription', 'manual_renewal'],
  currency: {
    code: 'THB',
    minorUnitExponent: 2,
    allowedMinorUnits: { min: 0, max: 10_000_000, increment: 1 },
  },
  commercialPolicy: {
    policyRef: 'products/WSTERA-Link/docs/04_PRICING_ENTITLEMENTS.md',
    refundPolicyRef: 'PENDING_OWNER_POLICY',
    taxPolicyRef: null,
    priceChangePolicyRef: 'LOCKED_BASELINE_NOT_FINAL_PUBLIC_PRICE',
  },  plans: [
    {
      planId: 'free', packageRef: 'LK01-FREE', model: 'free', amountMinor: 0,
      interval: 'none', trialRef: null, freeTierRef: 'lk01-free-v1', graceRef: null,
      retryDunningRef: null, entitlementKeys: ['links.free'],
    },
    {
      planId: 'pro', packageRef: 'LK01-PRO-BASELINE', model: 'subscription', amountMinor: 19_900,
      interval: 'month', trialRef: null, freeTierRef: null, graceRef: 'lk01-card-grace-7d',
      retryDunningRef: 'lk01-card-recovery', entitlementKeys: ['links.pro'],
    },
    {
      planId: 'business', packageRef: 'LK01-BUSINESS-BASELINE', model: 'subscription', amountMinor: 59_000,
      interval: 'month', trialRef: null, freeTierRef: null, graceRef: 'lk01-card-grace-7d',
      retryDunningRef: 'lk01-card-recovery', entitlementKeys: ['links.business'],
    },
  ],
  rails: {
    cardSubscription: { enabled: true, autoRenew: true },
    promptpayManual: { enabled: true, autoRenew: false, expiryPolicyRef: 'lk01-promptpay-expiry-v1' },
    cardOneTime: { enabled: false, autoRenew: false },
  },  entitlementAdapter: {
    adapterId: 'lk01-entitlement-adapter', contractVersion: 1, mode: 'snapshot',
    ingressRef: null, snapshotRef: 'PENDING_IMPLEMENTATION', ttlSeconds: 300, signingKeyRef: null,
  },
  providerMappings: {
    stripe: {
      test: { stripeProductId: 'prod_VDeGMVGn8CB4me', stripePriceIds: { pro: 'price_1UDCxzHB4GRCffd9a0rUipHY', business: 'price_1UDCxzHB4GRCffd97bC6KI4h' } },
      live: { stripeProductId: null, stripePriceIds: {} },
    },
  },
  admission: {
    registeredAt: '2026-09-08T00:00:00.000Z', activatedAt: null, activatedBy: null,
    testRunId: 'billing-matrix-2026-09-08',
    isolationEvidenceRef: 'docs/platform/billing-core/MULTI-PROFILE-CONCURRENCY-EVIDENCE-2026-09-08.md',
    providerLifecycleEvidenceRef: 'docs/platform/billing-core/STRIPE-TEST-PROVIDER-MATRIX-EVIDENCE-2026-09-08.md',
    accountBindingEvidenceRef: null,
    webhookEvidenceRef: null,
    reconciliationEvidenceRef: null,
    entitlementEvidenceRef: null,
    auditEvidenceRef: null,
    rollbackProfileVersion: null,
  },
};