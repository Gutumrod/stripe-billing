import { describe, it, expect } from 'vitest';
import { createSubscriptionCore, Plan } from '../../index.js';
import { createMockPlanRepository, createMockSubscriptionRepository } from '../../adapters/mock-repository.js';

describe('Subscription & Entitlement Core', () => {
  const plans: Plan[] = [
    {
      id: 'free',
      name: 'Free Plan',
      entitlements: {
        ai_reply: false,
        max_staff: 2,
        custom_domain: false,
      },
    },
    {
      id: 'pro',
      name: 'Pro Plan',
      entitlements: {
        ai_reply: true,
        max_staff: null, // unlimited
        custom_domain: true,
      },
    },
  ];

  it('should create subscription and check boolean entitlements', async () => {
    const planRepo = createMockPlanRepository(plans);
    const subRepo = createMockSubscriptionRepository();
    const core = createSubscriptionCore(subRepo, planRepo);

    await core.createSubscription({
      accountId: 'acc_123',
      planId: 'pro',
    });

    const canAi = await core.canUseFeature('acc_123', 'ai_reply');
    expect(canAi).toBe(true);

    const canDomain = await core.canUseFeature('acc_123', 'custom_domain');
    expect(canDomain).toBe(true);

    const limit = await core.getLimit('acc_123', 'max_staff');
    expect(limit).toBeNull(); // unlimited
  });

  it('should enforce numeric limits and usage checking', async () => {
    const planRepo = createMockPlanRepository(plans);
    const subRepo = createMockSubscriptionRepository();
    const core = createSubscriptionCore(subRepo, planRepo);

    await core.createSubscription({
      accountId: 'acc_free',
      planId: 'free',
    });

    const limit = await core.getLimit('acc_free', 'max_staff');
    expect(limit).toBe(2);

    const usageCheck1 = await core.checkUsage({
      accountId: 'acc_free',
      featureKey: 'max_staff',
      currentUsage: 1,
    });
    expect(usageCheck1.allowed).toBe(true);

    const usageCheck2 = await core.checkUsage({
      accountId: 'acc_free',
      featureKey: 'max_staff',
      currentUsage: 2,
    });
    expect(usageCheck2.allowed).toBe(false);
  });

  it('should handle billing events and state transitions', async () => {
    const planRepo = createMockPlanRepository(plans);
    const subRepo = createMockSubscriptionRepository();
    const core = createSubscriptionCore(subRepo, planRepo);

    await core.createSubscription({
      accountId: 'acc_billing',
      planId: 'pro',
    });

    let sub = await core.getSubscription('acc_billing');
    expect(sub?.status).toBe('active');

    // Simulate payment failure -> past_due
    await core.handleBillingEvent({
      eventType: 'subscription.payment_failed',
      accountId: 'acc_billing',
    });

    sub = await core.getSubscription('acc_billing');
    expect(sub?.status).toBe('past_due');

    // Simulate cancellation
    await core.cancelSubscription({
      accountId: 'acc_billing',
      atPeriodEnd: false,
    });

    sub = await core.getSubscription('acc_billing');
    expect(sub?.status).toBe('cancelled');

    // Cancelled subscription should block features
    const canAi = await core.canUseFeature('acc_billing', 'ai_reply');
    expect(canAi).toBe(false);
  });
});
