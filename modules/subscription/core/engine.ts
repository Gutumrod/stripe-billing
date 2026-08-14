import { PlanRepository, SubscriptionRepository } from './repository.js';


export interface EntitlementEngine {
  canUseFeature(accountId: string, featureKey: string): Promise<boolean>;
  getLimit(accountId: string, featureKey: string): Promise<number | null>; // null = unlimited
  checkUsage(params: {
    accountId: string;
    featureKey: string;
    currentUsage: number;
  }): Promise<{ allowed: boolean; limit: number | null; currentUsage: number }>;
}

export function createEntitlementEngine(
  subscriptionRepo: SubscriptionRepository,
  planRepo: PlanRepository
): EntitlementEngine {
  async function resolvePlan(accountId: string) {
    const sub = await subscriptionRepo.getByAccountId(accountId);
    if (!sub) return null;

    // If subscription is expired or cancelled, no entitlements active
    if (sub.status === 'expired' || sub.status === 'cancelled') {
      return null;
    }

    const plan = await planRepo.getById(sub.planId);
    return plan;
  }

  return {
    async canUseFeature(accountId: string, featureKey: string): Promise<boolean> {
      const plan = await resolvePlan(accountId);
      if (!plan) return false;

      const entitlement = plan.entitlements[featureKey];
      if (entitlement === undefined || entitlement === null) {
        return false;
      }

      if (typeof entitlement === 'boolean') {
        return entitlement;
      }

      if (typeof entitlement === 'number') {
        return entitlement > 0;
      }

      if (typeof entitlement === 'string') {
        return entitlement.trim() !== '' && entitlement.toLowerCase() !== 'false';
      }

      return false;
    },

    async getLimit(accountId: string, featureKey: string): Promise<number | null> {
      const plan = await resolvePlan(accountId);
      if (!plan) return 0;

      const entitlement = plan.entitlements[featureKey];
      if (entitlement === undefined) return 0;
      if (entitlement === null) return null; // unlimited

      if (typeof entitlement === 'number') {
        return entitlement;
      }

      if (typeof entitlement === 'boolean') {
        return entitlement ? null : 0;
      }

      return null;
    },

    async checkUsage(params: {
      accountId: string;
      featureKey: string;
      currentUsage: number;
    }): Promise<{ allowed: boolean; limit: number | null; currentUsage: number }> {
      const limit = await this.getLimit(params.accountId, params.featureKey);
      if (limit === null) {
        return { allowed: true, limit: null, currentUsage: params.currentUsage };
      }

      const allowed = params.currentUsage < limit;
      return { allowed, limit, currentUsage: params.currentUsage };
    },
  };
}
