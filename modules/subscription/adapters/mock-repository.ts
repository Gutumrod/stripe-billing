import { Plan, Subscription, SubscriptionStatus } from '../core/index.js';
import { PlanRepository, SubscriptionRepository } from '../core/index.js';

export function createMockSubscriptionRepository(initialSubs: Subscription[] = []): SubscriptionRepository {
  const store = new Map<string, Subscription>();
  for (const s of initialSubs) {
    store.set(s.accountId, { ...s });
  }

  return {
    async getByAccountId(accountId: string): Promise<Subscription | null> {
      return store.get(accountId) || null;
    },
    async save(subscription: Subscription): Promise<void> {
      store.set(subscription.accountId, { ...subscription });
    },
    async updateStatus(accountId: string, status: SubscriptionStatus, extra?: Partial<Subscription>): Promise<void> {
      const existing = store.get(accountId);
      if (existing) {
        store.set(accountId, { ...existing, status, ...extra });
      }
    },
  };
}

export function createMockPlanRepository(initialPlans: Plan[] = []): PlanRepository {
  const store = new Map<string, Plan>();
  for (const p of initialPlans) {
    store.set(p.id, { ...p });
  }

  return {
    async getById(planId: string): Promise<Plan | null> {
      return store.get(planId) || null;
    },
    async listAll(): Promise<Plan[]> {
      return Array.from(store.values());
    },
    async save(plan: Plan): Promise<void> {
      store.set(plan.id, { ...plan });
    },
  };
}
