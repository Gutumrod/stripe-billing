import {
  Subscription,
  SubscriptionBillingEvent,
  SubscriptionCoreConfig,
  SubscriptionStatus,
} from './types.js';
import { PlanRepository, SubscriptionRepository } from './repository.js';
import { EntitlementEngine, createEntitlementEngine } from './engine.js';
import { SubscriptionError } from './error.js';

export interface SubscriptionCore extends EntitlementEngine {
  getSubscription(accountId: string): Promise<Subscription | null>;
  createSubscription(params: {
    accountId: string;
    planId: string;
    trialDays?: number;
    metadata?: Record<string, string>;
  }): Promise<Subscription>;
  changePlan(params: {
    accountId: string;
    newPlanId: string;
    immediate?: boolean;
  }): Promise<Subscription>;
  cancelSubscription(params: {
    accountId: string;
    atPeriodEnd?: boolean;
  }): Promise<Subscription>;
  handleBillingEvent(event: SubscriptionBillingEvent): Promise<void>;
}

export function createSubscriptionCore(
  subscriptionRepo: SubscriptionRepository,
  planRepo: PlanRepository,
  config: SubscriptionCoreConfig = {}
): SubscriptionCore {
  const entitlementEngine = createEntitlementEngine(subscriptionRepo, planRepo);
  // const gracePeriodDays = config.gracePeriodDays ?? 3;

  return {
    ...entitlementEngine,

    async getSubscription(accountId: string): Promise<Subscription | null> {
      return await subscriptionRepo.getByAccountId(accountId);
    },

    async createSubscription(params: {
      accountId: string;
      planId: string;
      trialDays?: number;
      metadata?: Record<string, string>;
    }): Promise<Subscription> {
      const plan = await planRepo.getById(params.planId);
      if (!plan) {
        throw new SubscriptionError({
          message: `Plan not found: ${params.planId}`,
          code: 'PLAN_NOT_FOUND',
        });
      }

      const existing = await subscriptionRepo.getByAccountId(params.accountId);
      if (existing && existing.status !== 'expired' && existing.status !== 'cancelled') {
        throw new SubscriptionError({
          message: `Active subscription already exists for account: ${params.accountId}`,
          code: 'SUBSCRIPTION_ALREADY_EXISTS',
        });
      }

      const now = new Date();
      let status: SubscriptionStatus = 'active';
      let trialEnd: Date | undefined = undefined;

      const currentPeriodStart = now;
      const currentPeriodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days default interval

      if (params.trialDays && params.trialDays > 0) {
        status = 'trialing';
        trialEnd = new Date(now.getTime() + params.trialDays * 24 * 60 * 60 * 1000);
        currentPeriodEnd.setTime(trialEnd.getTime());
      }

      const subscription: Subscription = {
        id: `sub_${Math.random().toString(36).substring(2, 11)}`,
        accountId: params.accountId,
        planId: params.planId,
        status,
        currentPeriodStart,
        currentPeriodEnd,
        trialEnd,
        cancelAtPeriodEnd: false,
        metadata: params.metadata,
      };

      await subscriptionRepo.save(subscription);
      config.hooks?.onSubscriptionChange?.(subscription);
      return subscription;
    },

    async changePlan(params: {
      accountId: string;
      newPlanId: string;
      immediate?: boolean;
    }): Promise<Subscription> {
      const sub = await subscriptionRepo.getByAccountId(params.accountId);
      if (!sub) {
        throw new SubscriptionError({
          message: `Subscription not found for account: ${params.accountId}`,
          code: 'SUBSCRIPTION_NOT_FOUND',
        });
      }

      const plan = await planRepo.getById(params.newPlanId);
      if (!plan) {
        throw new SubscriptionError({
          message: `Plan not found: ${params.newPlanId}`,
          code: 'PLAN_NOT_FOUND',
        });
      }

      sub.planId = params.newPlanId;
      await subscriptionRepo.save(sub);
      config.hooks?.onSubscriptionChange?.(sub);
      return sub;
    },

    async cancelSubscription(params: {
      accountId: string;
      atPeriodEnd?: boolean;
    }): Promise<Subscription> {
      const sub = await subscriptionRepo.getByAccountId(params.accountId);
      if (!sub) {
        throw new SubscriptionError({
          message: `Subscription not found for account: ${params.accountId}`,
          code: 'SUBSCRIPTION_NOT_FOUND',
        });
      }

      const atPeriodEnd = params.atPeriodEnd ?? true;
      const now = new Date();

      if (atPeriodEnd) {
        sub.cancelAtPeriodEnd = true;
        sub.status = 'cancel_at_period_end';
      } else {
        sub.status = 'cancelled';
        sub.canceledAt = now;
      }

      await subscriptionRepo.save(sub);
      config.hooks?.onSubscriptionChange?.(sub);
      return sub;
    },

    async handleBillingEvent(event: SubscriptionBillingEvent): Promise<void> {
      const sub = await subscriptionRepo.getByAccountId(event.accountId);
      if (!sub) return;

      if (event.eventId && sub.lastProcessedEventId === event.eventId) {
        return;
      }

      const now = new Date();

      switch (event.eventType) {
        case 'subscription.started':
          sub.status = 'active';
          if (event.currentPeriodEnd) sub.currentPeriodEnd = event.currentPeriodEnd;
          break;
        case 'subscription.renewed':
          sub.status = 'active';
          if (event.currentPeriodEnd) sub.currentPeriodEnd = event.currentPeriodEnd;
          sub.cancelAtPeriodEnd = false;
          break;
        case 'subscription.payment_failed':
          // Enter past_due, then trigger grace period
          sub.status = 'past_due';
          break;
        case 'subscription.cancelled':
          sub.status = 'cancelled';
          sub.canceledAt = now;
          break;
        case 'subscription.expired':
          sub.status = 'expired';
          break;
      }

      sub.lastProcessedEventId = event.eventId;
      await subscriptionRepo.save(sub);
      config.hooks?.onSubscriptionChange?.(sub);
    },
  };
}
