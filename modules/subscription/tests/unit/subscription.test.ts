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

  it('should change plan and update entitlements', async () => {
    const planRepo = createMockPlanRepository(plans);
    const subRepo = createMockSubscriptionRepository();
    const core = createSubscriptionCore(subRepo, planRepo);

    await core.createSubscription({
      accountId: 'acc_change',
      planId: 'free',
    });

    const initialAi = await core.canUseFeature('acc_change', 'ai_reply');
    expect(initialAi).toBe(false);

    const updated = await core.changePlan({
      accountId: 'acc_change',
      newPlanId: 'pro',
    });

    expect(updated.planId).toBe('pro');

    const sub = await core.getSubscription('acc_change');
    expect(sub?.planId).toBe('pro');

    const canAi = await core.canUseFeature('acc_change', 'ai_reply');
    expect(canAi).toBe(true);
  });

  it('should cancel subscription at period end', async () => {
    const planRepo = createMockPlanRepository(plans);
    const subRepo = createMockSubscriptionRepository();
    const core = createSubscriptionCore(subRepo, planRepo);

    await core.createSubscription({
      accountId: 'acc_cancel_period',
      planId: 'pro',
    });

    const cancelled = await core.cancelSubscription({
      accountId: 'acc_cancel_period',
      atPeriodEnd: true,
    });

    expect(cancelled.status).toBe('cancel_at_period_end');
    expect(cancelled.cancelAtPeriodEnd).toBe(true);

    const sub = await core.getSubscription('acc_cancel_period');
    expect(sub?.status).toBe('cancel_at_period_end');
    expect(sub?.cancelAtPeriodEnd).toBe(true);
  });

  it('should throw PLAN_NOT_FOUND when creating subscription with nonexistent plan', async () => {
    const planRepo = createMockPlanRepository(plans);
    const subRepo = createMockSubscriptionRepository();
    const core = createSubscriptionCore(subRepo, planRepo);

    await expect(
      core.createSubscription({
        accountId: 'acc_invalid_plan',
        planId: 'nonexistent',
      })
    ).rejects.toMatchObject({ code: 'PLAN_NOT_FOUND' });
  });

  it('should throw SUBSCRIPTION_ALREADY_EXISTS when creating duplicate subscription for active account', async () => {
    const planRepo = createMockPlanRepository(plans);
    const subRepo = createMockSubscriptionRepository();
    const core = createSubscriptionCore(subRepo, planRepo);

    await core.createSubscription({
      accountId: 'acc_duplicate',
      planId: 'free',
    });

    await expect(
      core.createSubscription({
        accountId: 'acc_duplicate',
        planId: 'pro',
      })
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_ALREADY_EXISTS' });
  });

  it('should throw SUBSCRIPTION_NOT_FOUND when changing plan or cancelling for nonexistent subscription', async () => {
    const planRepo = createMockPlanRepository(plans);
    const subRepo = createMockSubscriptionRepository();
    const core = createSubscriptionCore(subRepo, planRepo);

    await expect(
      core.changePlan({
        accountId: 'acc_missing',
        newPlanId: 'pro',
      })
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_NOT_FOUND' });

    await expect(
      core.cancelSubscription({
        accountId: 'acc_missing',
        atPeriodEnd: true,
      })
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_NOT_FOUND' });
  });

  it('should handle subscription.started billing event and update period end', async () => {
    const planRepo = createMockPlanRepository(plans);
    const subRepo = createMockSubscriptionRepository();
    const core = createSubscriptionCore(subRepo, planRepo);

    await core.createSubscription({
      accountId: 'acc_started',
      planId: 'pro',
      trialDays: 14,
    });

    let sub = await core.getSubscription('acc_started');
    expect(sub?.status).toBe('trialing');

    const newPeriodEnd = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
    await core.handleBillingEvent({
      eventType: 'subscription.started',
      accountId: 'acc_started',
      currentPeriodEnd: newPeriodEnd,
    });

    sub = await core.getSubscription('acc_started');
    expect(sub?.status).toBe('active');
    expect(sub?.currentPeriodEnd).toEqual(newPeriodEnd);
  });

  it('should handle subscription.renewed billing event and reset cancelAtPeriodEnd', async () => {
    const planRepo = createMockPlanRepository(plans);
    const subRepo = createMockSubscriptionRepository();
    const core = createSubscriptionCore(subRepo, planRepo);

    await core.createSubscription({
      accountId: 'acc_renewed',
      planId: 'pro',
    });

    await core.cancelSubscription({
      accountId: 'acc_renewed',
      atPeriodEnd: true,
    });

    let sub = await core.getSubscription('acc_renewed');
    expect(sub?.cancelAtPeriodEnd).toBe(true);

    const renewalPeriodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await core.handleBillingEvent({
      eventType: 'subscription.renewed',
      accountId: 'acc_renewed',
      currentPeriodEnd: renewalPeriodEnd,
    });

    sub = await core.getSubscription('acc_renewed');
    expect(sub?.status).toBe('active');
    expect(sub?.cancelAtPeriodEnd).toBe(false);
    expect(sub?.currentPeriodEnd).toEqual(renewalPeriodEnd);
  });

  it('should handle subscription.expired billing event', async () => {
    const planRepo = createMockPlanRepository(plans);
    const subRepo = createMockSubscriptionRepository();
    const core = createSubscriptionCore(subRepo, planRepo);

    await core.createSubscription({
      accountId: 'acc_expired',
      planId: 'pro',
    });

    await core.handleBillingEvent({
      eventType: 'subscription.expired',
      accountId: 'acc_expired',
    });

    const sub = await core.getSubscription('acc_expired');
    expect(sub?.status).toBe('expired');
  });

  it('should ignore duplicate billing events with the same eventId (idempotency)', async () => {
    const planRepo = createMockPlanRepository(plans);
    const subRepo = createMockSubscriptionRepository();
    const core = createSubscriptionCore(subRepo, planRepo);

    await core.createSubscription({
      accountId: 'acc_idempotent',
      planId: 'pro',
    });

    // First event with eventId 'evt_test_1'
    await core.handleBillingEvent({
      eventType: 'subscription.payment_failed',
      accountId: 'acc_idempotent',
      eventId: 'evt_test_1',
    });

    let sub = await core.getSubscription('acc_idempotent');
    expect(sub?.status).toBe('past_due');
    expect(sub?.lastProcessedEventId).toBe('evt_test_1');

    // Duplicate event with the same eventId but different eventType
    await core.handleBillingEvent({
      eventType: 'subscription.expired',
      accountId: 'acc_idempotent',
      eventId: 'evt_test_1',
    });

    sub = await core.getSubscription('acc_idempotent');
    // Status must remain 'past_due' because the duplicate event was ignored
    expect(sub?.status).toBe('past_due');
  });
});
