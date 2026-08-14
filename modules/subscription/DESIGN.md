# Subscription + Entitlement Module — DESIGN.md

**Version:** 0.1.0 (P1, experimental)
**Status:** Design (Stage 1 — Architect). This file is the single source of truth for downstream agents.
**Language / runtime:** TypeScript, ES2022, strict mode, `moduleResolution: Bundler`. Compatible with Cloudflare Workers (no `node:*` imports).

---

## 1. Purpose & Architectural Boundaries

The **Subscription + Entitlement Module** decouples SaaS business subscription lifecycle states and feature permission checks from billing providers (such as Stripe). 

> **CRITICAL BOUNDARY:** 
> - Payment Core / Stripe handle billing, invoices, and charge execution. They are **not** the source of truth for feature permissions or subscription business logic inside the app.
> - Host business logic **MUST NOT** scatter `if (plan === 'pro')` checks across the codebase. All feature permission and limit inquiries must query the Subscription & Entitlement Core via `canUseFeature()` or `checkUsage()`.
> - Subscription Core does **not** call Stripe API directly, nor does it handle email dispatch or UI rendering (delegated to Notification and Host UI modules).

---

## 2. Core Domain Models & Types

### 2.1 Subscription States
```ts
export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'grace_period'
  | 'cancel_at_period_end'
  | 'cancelled'
  | 'expired';
```

### 2.2 Plan & Entitlements Contract
```ts
export type EntitlementValue = boolean | number | string | null; // null means unlimited

export type Plan = {
  id: string;
  name: string;
  billingInterval?: 'month' | 'year';
  priceMinorUnits?: number;
  currency?: string;
  entitlements: Record<string, EntitlementValue>;
};
```

### 2.3 Subscription Record
```ts
export type Subscription = {
  id: string;
  accountId: string; // Generic tenant/account identifier
  planId: string;
  status: SubscriptionStatus;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  trialEnd?: Date;
  cancelAtPeriodEnd: boolean;
  canceledAt?: Date;
  metadata?: Record<string, string>;
};
```

---

## 3. Entitlement Engine API

```ts
export interface EntitlementEngine {
  canUseFeature(accountId: string, featureKey: string): Promise<boolean>;
  getLimit(accountId: string, featureKey: string): Promise<number | null>; // null = unlimited
  checkUsage(params: {
    accountId: string;
    featureKey: string;
    currentUsage: number;
  }): Promise<{ allowed: boolean; limit: number | null; currentUsage: number }>;
}
```

---

## 4. Repository Interfaces (Storage Agnostic)

```ts
export interface SubscriptionRepository {
  getByAccountId(accountId: string): Promise<Subscription | null>;
  save(subscription: Subscription): Promise<void>;
  updateStatus(accountId: string, status: SubscriptionStatus, extra?: Partial<Subscription>): Promise<void>;
}

export interface PlanRepository {
  getById(planId: string): Promise<Plan | null>;
  listAll(): Promise<Plan[]>;
}
```

---

## 5. Subscription Core Service API

```ts
export interface SubscriptionCore {
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

export type SubscriptionBillingEvent = {
  eventType:
    | 'subscription.started'
    | 'subscription.renewed'
    | 'subscription.payment_failed'
    | 'subscription.cancelled'
    | 'subscription.expired';
  accountId: string;
  planId?: string;
  currentPeriodEnd?: Date;
  rawEvent?: unknown;
};
```

---

## 6. State Machine & Grace Period Rules

1. **Trialing → Active**: Upon successful first payment conversion or trial start.
2. **Active → Past Due**: Triggered when `subscription.payment_failed` billing event arrives.
3. **Past Due → Grace Period**: Automatically enters grace period (configurable duration, e.g. 3 or 7 days).
4. **Grace Period → Expired**: Once grace period expires without successful renewal, status transitions to `expired` (features locked).
5. **Cancel at Period End**: Subscription remains active until `currentPeriodEnd`, then transitions to `cancelled` or `expired`.

---

## 7. Acceptance Criteria for Implementation
- [ ] Plan contract & Entitlements dictionary (`null` = unlimited)
- [ ] Subscription lifecycle state machine (trialing, active, past_due, grace_period, cancel_at_period_end, cancelled, expired)
- [ ] Configurable grace period handling
- [ ] Entitlement engine (`canUseFeature`, `getLimit`, `checkUsage`)
- [ ] Storage agnostic repositories (`SubscriptionRepository`, `PlanRepository`)
- [ ] Billing event handler (`handleBillingEvent`)
- [ ] Comprehensive unit tests covering all state transitions and entitlement rules
- [ ] `MODULE.md` and integration example
