-- SB01 one-time purchase ledger, refund markers, and monotonic subscription refund transitions.
-- Apply only after migration provenance is reconciled and an Owner-approved staging runbook exists.
-- This is additive and forward-only: rollback application code but retain the tables and money history.
BEGIN;

ALTER TABLE billing_core.runtime_outbox_jobs
  DROP CONSTRAINT IF EXISTS runtime_outbox_jobs_job_type_check;
ALTER TABLE billing_core.runtime_outbox_jobs
  ADD CONSTRAINT runtime_outbox_jobs_job_type_check
  CHECK (job_type IN ('reconcile', 'refund_reconcile', 'purchase_reconcile', 'entitlement_test_sink'));

ALTER TABLE billing_core_staging.runtime_outbox_jobs
  DROP CONSTRAINT IF EXISTS runtime_outbox_jobs_job_type_check;
ALTER TABLE billing_core_staging.runtime_outbox_jobs
  ADD CONSTRAINT runtime_outbox_jobs_job_type_check
  CHECK (job_type IN ('reconcile', 'refund_reconcile', 'purchase_reconcile', 'entitlement_test_sink'));

CREATE TABLE billing_core.runtime_one_time_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment text NOT NULL CHECK (environment IN ('test','live')),
  product_id text NOT NULL,
  account_id text NOT NULL,
  profile_version integer NOT NULL CHECK (profile_version > 0),
  plan_id text NOT NULL,
  package_ref text NOT NULL,
  provider_checkout_session_id text NOT NULL UNIQUE,
  provider_payment_intent_id text NOT NULL,
  provider_charge_id text,
  provider_customer_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('paid','refunded')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL CHECK (currency = upper(currency) AND char_length(currency) = 3),
  purchased_at timestamptz NOT NULL,
  source_access_until timestamptz,
  updates_until timestamptz NOT NULL,
  refund_event_id uuid REFERENCES billing_core.runtime_provider_events(id) ON DELETE RESTRICT,
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (updates_until > purchased_at),
  UNIQUE (environment, provider_payment_intent_id),
  FOREIGN KEY (environment, product_id, account_id, provider_customer_id)
    REFERENCES billing_core.runtime_provider_customers(environment, product_id, account_id, provider_customer_id)
);

CREATE TABLE billing_core.runtime_payment_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_event_id uuid NOT NULL UNIQUE REFERENCES billing_core.runtime_provider_events(id) ON DELETE RESTRICT,
  environment text NOT NULL CHECK (environment IN ('test','live')),
  product_id text NOT NULL,
  account_id text NOT NULL,
  provider_payment_intent_id text,
  provider_charge_id text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  amount_refunded_minor bigint NOT NULL CHECK (amount_refunded_minor >= 0),
  fully_refunded boolean NOT NULL,
  status text NOT NULL CHECK (status IN ('recorded','applied','partial','unmatched')),
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (amount_refunded_minor <= amount_minor)
);
CREATE INDEX runtime_payment_refunds_payment_intent_idx
  ON billing_core.runtime_payment_refunds(environment, product_id, account_id, provider_payment_intent_id)
  WHERE provider_payment_intent_id IS NOT NULL;

CREATE TABLE billing_core.runtime_entitlement_version_reservations (
  environment text NOT NULL CHECK (environment IN ('test','live')),
  product_id text NOT NULL,
  account_id text NOT NULL,
  provider_subscription_id text NOT NULL,
  provider_event_id uuid NOT NULL UNIQUE REFERENCES billing_core.runtime_provider_events(id) ON DELETE RESTRICT,
  transition_version integer NOT NULL CHECK (transition_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (environment, product_id, account_id, provider_subscription_id, transition_version),
  FOREIGN KEY (environment, product_id, account_id, provider_subscription_id)
    REFERENCES billing_core.runtime_reconciliation_state(environment, product_id, account_id, provider_subscription_id)
);

CREATE TABLE billing_core_staging.runtime_one_time_purchases (LIKE billing_core.runtime_one_time_purchases INCLUDING ALL);
ALTER TABLE billing_core_staging.runtime_one_time_purchases
  ADD CONSTRAINT runtime_one_time_purchases_customer_fk
  FOREIGN KEY (environment, product_id, account_id, provider_customer_id)
  REFERENCES billing_core_staging.runtime_provider_customers(environment, product_id, account_id, provider_customer_id);
ALTER TABLE billing_core_staging.runtime_one_time_purchases
  ADD CONSTRAINT runtime_one_time_purchases_refund_event_fk
  FOREIGN KEY (refund_event_id) REFERENCES billing_core_staging.runtime_provider_events(id) ON DELETE RESTRICT;

CREATE TABLE billing_core_staging.runtime_payment_refunds (LIKE billing_core.runtime_payment_refunds INCLUDING ALL);
ALTER TABLE billing_core_staging.runtime_payment_refunds
  ADD CONSTRAINT runtime_payment_refunds_event_fk
  FOREIGN KEY (provider_event_id) REFERENCES billing_core_staging.runtime_provider_events(id) ON DELETE RESTRICT;
CREATE INDEX runtime_payment_refunds_payment_intent_idx
  ON billing_core_staging.runtime_payment_refunds(environment, product_id, account_id, provider_payment_intent_id)
  WHERE provider_payment_intent_id IS NOT NULL;

CREATE TABLE billing_core_staging.runtime_entitlement_version_reservations (
  environment text NOT NULL CHECK (environment IN ('test','live')),
  product_id text NOT NULL,
  account_id text NOT NULL,
  provider_subscription_id text NOT NULL,
  provider_event_id uuid NOT NULL UNIQUE REFERENCES billing_core_staging.runtime_provider_events(id) ON DELETE RESTRICT,
  transition_version integer NOT NULL CHECK (transition_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (environment, product_id, account_id, provider_subscription_id, transition_version),
  FOREIGN KEY (environment, product_id, account_id, provider_subscription_id)
    REFERENCES billing_core_staging.runtime_reconciliation_state(environment, product_id, account_id, provider_subscription_id)
);

GRANT SELECT, INSERT, UPDATE ON
  billing_core.runtime_one_time_purchases,
  billing_core.runtime_payment_refunds,
  billing_core.runtime_entitlement_version_reservations
TO billing_core_app;
GRANT SELECT, INSERT, UPDATE ON
  billing_core_staging.runtime_one_time_purchases,
  billing_core_staging.runtime_payment_refunds,
  billing_core_staging.runtime_entitlement_version_reservations
TO billing_core_staging_app;
REVOKE ALL ON
  billing_core_staging.runtime_one_time_purchases,
  billing_core_staging.runtime_payment_refunds,
  billing_core_staging.runtime_entitlement_version_reservations
FROM billing_core_app, anon, authenticated;

COMMIT;
