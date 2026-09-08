import { ProfileActivationError, ProfileResolutionError, ProfileValidationError } from './errors';
import type { AccountBoundRequestContext, BillingEnvironment, ProductBillingProfile, ProfileResolutionContext } from './types';
import { assertActivatable, assertValidRegistration } from './validate';

function profileKey(productId: string, environment: BillingEnvironment, version: number): string {
  return `${productId}::${environment}::${version}`;
}

function activeKey(productId: string, environment: BillingEnvironment): string {
  return `${productId}::${environment}`;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value as Readonly<T>;
}

function immutableCopy(profile: ProductBillingProfile): Readonly<ProductBillingProfile> {
  return deepFreeze(structuredClone(profile));
}

export class ProductBillingProfileRegistry {
  private readonly profiles = new Map<string, Readonly<ProductBillingProfile>>();
  private readonly activeVersions = new Map<string, number>();

  register(profile: ProductBillingProfile): Readonly<ProductBillingProfile> {
    assertValidRegistration(profile);
    const key = profileKey(profile.productId, profile.environment, profile.profileVersion);
    if (this.profiles.has(key)) throw new ProfileValidationError([`profile already registered: ${key}`]);
    const stored = immutableCopy(profile);
    this.profiles.set(key, stored);
    return immutableCopy(stored as ProductBillingProfile);
  }

  getRegistered(productId: string, environment: BillingEnvironment, version: number): Readonly<ProductBillingProfile> {
    const stored = this.profiles.get(profileKey(productId, environment, version));
    if (!stored) throw new ProfileResolutionError('exact profile version not found');
    return immutableCopy(stored as ProductBillingProfile);
  }

  resolveForRuntime(context: ProfileResolutionContext): Readonly<ProductBillingProfile> {
    if (context.requestedProductId && context.requestedProductId !== context.credentialProductId) {
      throw new ProfileResolutionError('caller product mismatch');
    }
    const stored = this.profiles.get(profileKey(context.credentialProductId, context.environment, context.profileVersion));
    if (!stored) throw new ProfileResolutionError('exact scoped profile not found');
    if (stored.status !== 'active') throw new ProfileResolutionError(`profile is not active: ${stored.status}`);
    return immutableCopy(stored as ProductBillingProfile);
  }

  activate(productId: string, environment: BillingEnvironment, version: number, activatedBy: string, allowLive = false): Readonly<ProductBillingProfile> {
    const key = profileKey(productId, environment, version);
    const stored = this.profiles.get(key);
    if (!stored) throw new ProfileActivationError(['profile is not registered']);
    const previous = this.activeVersions.get(activeKey(productId, environment)) ?? null;
    assertActivatable(stored as ProductBillingProfile, { previousActiveVersion: previous, allowLive });
    const activated: ProductBillingProfile = {
      ...(structuredClone(stored) as ProductBillingProfile),
      status: 'active',
      admission: {
        ...(structuredClone(stored.admission)),
        activatedAt: new Date().toISOString(),
        activatedBy,
      },
    };
    const frozen = immutableCopy(activated);
    this.profiles.set(key, frozen);
    this.activeVersions.set(activeKey(productId, environment), version);
    return immutableCopy(frozen as ProductBillingProfile);
  }

  getActiveVersion(productId: string, environment: BillingEnvironment): number | null {
    return this.activeVersions.get(activeKey(productId, environment)) ?? null;
  }
}

export function assertAccountBound(context: AccountBoundRequestContext): void {
  if (!context.accountId.trim()) throw new ProfileResolutionError('accountId is required');
  if (!context.operationId.trim()) throw new ProfileResolutionError('operationId is required');
  if (!context.accountAssertionVerified) throw new ProfileResolutionError('account-bound assertion is required');
  if (context.requestedProductId && context.requestedProductId !== context.credentialProductId) {
    throw new ProfileResolutionError('caller product mismatch');
  }
}
