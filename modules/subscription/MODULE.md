# Subscription + Entitlement Module

> Decouples SaaS business subscription lifecycle states and feature permission checks from billing providers (such as Stripe).

- **Version:** 0.1.0
- **Status:** Experimental / Pilot Ready
- **Priority:** P1 (SaaS Money Layer)

---

## Architecture

```text
Subscription Core
       │
       ├── Plan Repository
       ├── Subscription Repository
       └── Entitlement Engine
```

- **Core Responsibilities:** Manages subscription lifecycle states (`trialing`, `active`, `past_due`, `grace_period`, `cancel_at_period_end`, `cancelled`, `expired`), plan mapping, and entitlement evaluation (`canUseFeature`, `getLimit`, `checkUsage`).
- **Storage Agnostic:** Repositories (`SubscriptionRepository`, `PlanRepository`) abstract data persistence so the core is never tied to Supabase or Prisma.
- **Billing Integration:** Handles normalized billing events (`subscription.started`, `subscription.renewed`, `subscription.payment_failed`, `subscription.cancelled`, `subscription.expired`) passed from payment/webhook layers.

---

## Quick Start

```ts
import { createSubscriptionCore } from '@module-hub/subscription';
import { createMockPlanRepository, createMockSubscriptionRepository } from '@module-hub/subscription/adapters';

const subscriptionCore = createSubscriptionCore(subscriptionRepo, planRepo);

// Check if tenant can use a feature
const allowed = await subscriptionCore.canUseFeature('tenant_123', 'ai_reply');

// Check numeric limits
const usage = await subscriptionCore.checkUsage({
  accountId: 'tenant_123',
  featureKey: 'max_staff',
  currentUsage: 4,
});
```

---

## Definition of Done

- [x] Plan contract & Entitlements dictionary (`null` = unlimited)
- [x] Subscription lifecycle state machine
- [x] Entitlement engine (`canUseFeature`, `getLimit`, `checkUsage`)
- [x] Storage-agnostic repository interfaces
- [x] Billing event handler
- [x] Unit tests & typecheck passed
- [x] `MODULE.md` and integration example
