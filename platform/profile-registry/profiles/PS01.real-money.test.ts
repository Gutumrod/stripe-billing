import type { ProductBillingProfile } from '../src/types';
import { ps01TestProfile } from './PS01.test';

// Versioned pricing candidate based only on Owner A-2/A-10. It stays pending_validation because
// matching TEST Prices for every currency/offer and launch-window evidence are not yet registered.
export const ps01RealMoneyTestProfile: ProductBillingProfile = {
  ...ps01TestProfile,
  profileVersion: 2,
  status: 'pending_validation',
  billingModels: ['subscription'],
  commercialPolicy: {
    ...ps01TestProfile.commercialPolicy,
    refundWindowDays: 7,
  },
  plans: [
    {
      planId: 'starter-monthly', packageRef: 'PS01-STARTER', model: 'subscription',
      amountMinor: 59000, pricesByCurrency: { THB: 59000, USD: 1700 }, interval: 'month',
      trialRef: null, freeTierRef: null, graceRef: 'pending://ps01/grace-policy',
      retryDunningRef: 'pending://ps01/dunning-policy', entitlementKeys: ['commercial_access'],
    },
    {
      planId: 'pro-monthly', packageRef: 'PS01-PRO', model: 'subscription',
      amountMinor: 99000, pricesByCurrency: { THB: 99000, USD: 2800 }, interval: 'month',
      trialRef: null, freeTierRef: null, graceRef: 'pending://ps01/grace-policy',
      retryDunningRef: 'pending://ps01/dunning-policy', entitlementKeys: ['commercial_access'],
    },
    {
      planId: 'starter-annual-launch', packageRef: 'PS01-STARTER', model: 'subscription',
      amountMinor: 569000, pricesByCurrency: { THB: 569000, USD: 16300 }, interval: 'year',
      salesStartsAt: null, salesEndsAt: null, trialRef: null, freeTierRef: null, graceRef: 'pending://ps01/grace-policy',
      retryDunningRef: 'pending://ps01/dunning-policy', entitlementKeys: ['commercial_access'],
    },
    {
      planId: 'pro-annual-launch', packageRef: 'PS01-PRO', model: 'subscription',
      amountMinor: 949000, pricesByCurrency: { THB: 949000, USD: 26900 }, interval: 'year',
      salesStartsAt: null, salesEndsAt: null, trialRef: null, freeTierRef: null, graceRef: 'pending://ps01/grace-policy',
      retryDunningRef: 'pending://ps01/dunning-policy', entitlementKeys: ['commercial_access'],
    },
  ],
  providerMappings: {
    stripe: {
      test: {
        stripeProductId: ps01TestProfile.providerMappings.stripe.test.stripeProductId,
        // This existing immutable TEST Price is the THB 990 Pro monthly mapping. No IDs are
        // fabricated for the other amounts/currencies; activation validation will keep them closed.
        stripePriceIds: { 'pro-monthly:THB': ps01TestProfile.providerMappings.stripe.test.stripePriceIds['founding-c2'] },
      },
      live: { stripeProductId: null, stripePriceIds: {} },
    },
  },
  admission: {
    ...ps01TestProfile.admission,
    activatedAt: null,
    activatedBy: null,
    accountBindingEvidenceRef: null,
    webhookEvidenceRef: null,
    reconciliationEvidenceRef: null,
    entitlementEvidenceRef: null,
    auditEvidenceRef: null,
  },
};
