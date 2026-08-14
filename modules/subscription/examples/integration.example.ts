import { createSubscriptionCore, Plan } from '../index.js';
import { createMockPlanRepository, createMockSubscriptionRepository } from '../adapters/mock-repository.js';

const samplePlans: Plan[] = [
  {
    id: 'starter',
    name: 'Starter Plan',
    entitlements: {
      ai_reply: false,
      max_projects: 3,
    },
  },
  {
    id: 'enterprise',
    name: 'Enterprise Plan',
    entitlements: {
      ai_reply: true,
      max_projects: null, // unlimited
    },
  },
];

async function run() {
  const planRepo = createMockPlanRepository(samplePlans);
  const subRepo = createMockSubscriptionRepository();

  const subscriptionCore = createSubscriptionCore(subRepo, planRepo, {
    hooks: {
      onSubscriptionChange: (sub) => console.log(`[Subscription Hook] Account ${sub.accountId} status: ${sub.status}`),
    },
  });

  // 1. Create subscription with starter plan
  console.log('--- Creating Subscription ---');
  await subscriptionCore.createSubscription({
    accountId: 'tenant_999',
    planId: 'starter',
  });

  // 2. Check entitlements
  const canUseAi = await subscriptionCore.canUseFeature('tenant_999', 'ai_reply');
  console.log('Can use AI Reply (Starter):', canUseAi); // false

  const usage = await subscriptionCore.checkUsage({
    accountId: 'tenant_999',
    featureKey: 'max_projects',
    currentUsage: 3,
  });
  console.log('Project usage check (3 / limit 3):', usage.allowed); // false

  // 3. Upgrade plan to Enterprise
  console.log('\n--- Upgrading to Enterprise ---');
  await subscriptionCore.changePlan({
    accountId: 'tenant_999',
    newPlanId: 'enterprise',
  });

  const canUseAiPro = await subscriptionCore.canUseFeature('tenant_999', 'ai_reply');
  console.log('Can use AI Reply (Enterprise):', canUseAiPro); // true

  const limitPro = await subscriptionCore.getLimit('tenant_999', 'max_projects');
  console.log('Max projects limit (Enterprise):', limitPro === null ? 'Unlimited' : limitPro); // Unlimited
}

run();
