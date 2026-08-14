export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'grace_period'
  | 'cancel_at_period_end'
  | 'cancelled'
  | 'expired';

export type EntitlementValue = boolean | number | string | null; // null means unlimited

export type Plan = {
  id: string;
  name: string;
  billingInterval?: 'month' | 'year';
  priceMinorUnits?: number;
  currency?: string;
  entitlements: Record<string, EntitlementValue>;
};

export type Subscription = {
  id: string;
  accountId: string;
  planId: string;
  status: SubscriptionStatus;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  trialEnd?: Date;
  cancelAtPeriodEnd: boolean;
  canceledAt?: Date;
  metadata?: Record<string, string>;
};

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

export type SubscriptionCoreConfig = {
  gracePeriodDays?: number; // Default e.g. 3 or 7 days
  hooks?: {
    onSubscriptionChange?: (subscription: Subscription) => void;
    onEntitlementCheck?: (accountId: string, featureKey: string, allowed: boolean) => void;
  };
};
