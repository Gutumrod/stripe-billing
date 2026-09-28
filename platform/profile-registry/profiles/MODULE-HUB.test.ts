import type { ProductBillingProfile } from '../src/types';

// A-12 pricing is stored here as versioned profile data. This test profile is pending and has no
// fabricated Stripe Price IDs, so it cannot activate checkout until immutable TEST mappings exist.
const prices: Array<[string, number, number]> = [
  ['event-bus', 139000, 3900],
  ['feature-flags', 139000, 3900],
  ['rate-limit', 139000, 3900],
  ['http-client', 169000, 4900],
  ['enterprise-features', 169000, 4900],
  ['notification', 169000, 4900],
  ['config-runtime', 169000, 4900],
  ['product-catalog', 239000, 6900],
  ['bundle-8', 869000, 24900],
];

export const moduleHubTestProfile: ProductBillingProfile = {
  schemaVersion: 1,
  productId: 'module-hub',
  productCode: 'MODULE-HUB',
  displayName: 'WSTERA Module Hub',
  environment: 'test',
  profileVersion: 1,
  status: 'pending_validation',
  billingModels: ['one_time'],
  currency: {
    code: 'THB',
    minorUnitExponent: 2,
    allowedMinorUnits: { min: 100, max: 100000000, increment: 1 },
  },
  commercialPolicy: {
    policyRef: 'STATUS-HOUSE.md#Addendum-A-12',
    refundPolicyRef: 'STATUS-HOUSE.md#Addendum-A-10',
    refundWindowDays: 7,
    taxPolicyRef: null,
    priceChangePolicyRef: 'Owner-editable versioned profile data; never auto-convert currencies',
  },
  plans: prices.map(([sku, thb, usd]) => ({
    planId: sku,
    packageRef: sku === 'bundle-8' ? 'module-hub:bundle-8' : `module-hub:${sku}`,
    model: 'one_time',
    amountMinor: thb,
    pricesByCurrency: { THB: thb, USD: usd },
    interval: 'none',
    trialRef: null,
    freeTierRef: null,
    graceRef: null,
    retryDunningRef: null,
    entitlementKeys: [`source:${sku}`, `updates:${sku}`],
    includedUpdateMonths: 12,
  })),
  rails: {
    cardSubscription: { enabled: false, autoRenew: true },
    promptpayManual: { enabled: false, autoRenew: false, expiryPolicyRef: null },
    cardOneTime: { enabled: true, autoRenew: false },
  },
  entitlementAdapter: {
    adapterId: 'module-hub-purchase-ledger',
    contractVersion: 1,
    mode: 'pull',
    ingressRef: null,
    snapshotRef: 'GET /v1/one-time-entitlements',
    ttlSeconds: null,
    signingKeyRef: 'pending://vault/module-hub-billing-signing-key',
  },
  providerMappings: {
    stripe: {
      test: { stripeProductId: null, stripePriceIds: {} },
      live: { stripeProductId: null, stripePriceIds: {} },
    },
  },
  admission: {
    registeredAt: '2026-09-28T00:00:00.000Z',
    activatedAt: null,
    activatedBy: null,
    testRunId: null,
    isolationEvidenceRef: null,
    providerLifecycleEvidenceRef: null,
    accountBindingEvidenceRef: null,
    webhookEvidenceRef: null,
    reconciliationEvidenceRef: null,
    entitlementEvidenceRef: null,
    auditEvidenceRef: null,
    rollbackProfileVersion: null,
  },
};
