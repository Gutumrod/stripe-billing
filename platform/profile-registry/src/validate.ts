import { ProfileActivationError, ProfileValidationError } from './errors';
import type { ProductBillingProfile } from './types';

const PAID_MODELS = new Set(['subscription', 'one_time', 'manual_renewal']);
const NON_ACTIVE_REGISTRATION = new Set(['draft', 'pending_validation', 'suspended', 'deprecated', 'retired']);

export function collectRegistrationIssues(profile: ProductBillingProfile): string[] {
  const issues: string[] = [];
  if (profile.schemaVersion !== 1) issues.push('schemaVersion must be 1');
  if (!profile.productId.trim()) issues.push('productId is required');
  if (!profile.productCode.trim()) issues.push('productCode is required');
  if (!Number.isInteger(profile.profileVersion) || profile.profileVersion < 1) issues.push('profileVersion must be a positive integer');
  if (!NON_ACTIVE_REGISTRATION.has(profile.status)) issues.push('active profiles must be created only through activate()');
  if (!/^[A-Z]{3}$/.test(profile.currency.code)) issues.push('currency.code must be uppercase ISO-4217 form');
  if (!Number.isInteger(profile.currency.minorUnitExponent) || profile.currency.minorUnitExponent < 0) issues.push('currency.minorUnitExponent must be a non-negative integer');
  if (profile.currency.allowedMinorUnits.increment <= 0) issues.push('currency increment must be positive');

  const planIds = new Set<string>();
  for (const plan of profile.plans) {
    if (!plan.planId.trim()) issues.push('planId is required');
    if (planIds.has(plan.planId)) issues.push(`duplicate planId ${plan.planId}`);
    planIds.add(plan.planId);
    if (!profile.billingModels.includes(plan.model)) issues.push(`plan ${plan.planId} model is not declared in billingModels`);
    if (plan.amountMinor !== null && (!Number.isInteger(plan.amountMinor) || plan.amountMinor < 0)) issues.push(`plan ${plan.planId} amountMinor is invalid`);
  }
  return issues;
}

export function assertValidRegistration(profile: ProductBillingProfile): void {
  const issues = collectRegistrationIssues(profile);
  if (issues.length) throw new ProfileValidationError(issues);
}
export interface ActivationCheckOptions {
  previousActiveVersion: number | null;
  allowLive?: boolean;
}

export function collectActivationIssues(profile: ProductBillingProfile, options: ActivationCheckOptions): string[] {
  const issues = collectRegistrationIssues({ ...profile, status: profile.status === 'active' ? 'pending_validation' : profile.status });
  if (profile.status !== 'pending_validation') issues.push('profile must be pending_validation before activation');
  if (profile.environment === 'live' && !options.allowLive) issues.push('live activation is not authorized');
  if (!profile.admission.testRunId) issues.push('admission.testRunId is required');
  if (!profile.admission.isolationEvidenceRef) issues.push('admission.isolationEvidenceRef is required');
  if (options.previousActiveVersion !== null && profile.admission.rollbackProfileVersion !== options.previousActiveVersion) {
    issues.push(`rollbackProfileVersion must reference current active version ${options.previousActiveVersion}`);
  }

  const mapping = profile.providerMappings.stripe[profile.environment];
  const hasCardRail = profile.rails.cardSubscription.enabled || profile.rails.cardOneTime.enabled;
  if (hasCardRail && !mapping.stripeProductId) issues.push(`Stripe ${profile.environment} product mapping is required`);
  for (const plan of profile.plans) {
    if (!PAID_MODELS.has(plan.model)) continue;
    if (plan.amountMinor === null || plan.amountMinor <= 0) issues.push(`paid plan ${plan.planId} requires positive amountMinor`);
    if (hasCardRail && !mapping.stripePriceIds[plan.planId]) issues.push(`paid plan ${plan.planId} requires Stripe ${profile.environment} Price mapping`);
  }
  return issues;
}

export function assertActivatable(profile: ProductBillingProfile, options: ActivationCheckOptions): void {
  const reasons = collectActivationIssues(profile, options);
  if (reasons.length) throw new ProfileActivationError(reasons);
}
