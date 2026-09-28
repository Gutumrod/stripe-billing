-- DRAFT — NOT APPLIED. Phase 0.5. Review:
-- docs/platform/billing-core/REVIEW-PHASE-0-5-2026-08-29.md. Apply per APPLY-RUNBOOK.md only after
-- Commander + CEO sign-off.
--
-- Role passwords are deliberately absent. Set them out-of-band and store them in the vault.
-- Run this as the Project A migration owner, never as an application runtime role.

BEGIN;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'billing_core_app') THEN
    CREATE ROLE billing_core_app
      LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'billing_core_staging_app') THEN
    CREATE ROLE billing_core_staging_app
      LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END
$roles$;

CREATE SCHEMA IF NOT EXISTS billing_core;
CREATE SCHEMA IF NOT EXISTS billing_core_staging;

REVOKE ALL ON SCHEMA billing_core FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SCHEMA billing_core_staging FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SCHEMA billing_core FROM billing_core_staging_app;
REVOKE ALL ON SCHEMA billing_core_staging FROM billing_core_app;

GRANT USAGE ON SCHEMA billing_core TO billing_core_app;
GRANT USAGE ON SCHEMA billing_core_staging TO billing_core_staging_app;

CREATE TYPE billing_core.subscription_status AS ENUM (
  'trialing',
  'active',
  'past_due',
  'grace_period',
  'cancel_at_period_end',
  'cancelled',
  'expired'
);

CREATE TYPE billing_core.event_processing_status AS ENUM (
  'pending',
  'processing',
  'completed',
  'failed',
  'skipped'
);

CREATE TYPE billing_core.delivery_job_status AS ENUM (
  'pending',
  'processing',
  'completed',
  'failed'
);

REVOKE ALL ON TYPE billing_core.subscription_status FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TYPE billing_core.event_processing_status FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TYPE billing_core.delivery_job_status FROM PUBLIC, anon, authenticated;
GRANT USAGE ON TYPE billing_core.subscription_status TO billing_core_app;
GRANT USAGE ON TYPE billing_core.event_processing_status TO billing_core_app;
GRANT USAGE ON TYPE billing_core.delivery_job_status TO billing_core_app;

CREATE TABLE billing_core.plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product text NOT NULL,
  plan_key text NOT NULL,
  name text NOT NULL,
  currency text NOT NULL CHECK (currency = upper(currency) AND char_length(currency) = 3),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  billing_interval text NOT NULL CHECK (billing_interval IN ('month', 'year')),
  entitlements jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(entitlements) = 'object'),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product, plan_key),
  UNIQUE (id, product)
);

CREATE TABLE billing_core.subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product text NOT NULL,
  account_id text NOT NULL,
  plan_id uuid NOT NULL,
  status billing_core.subscription_status NOT NULL,
  stripe_subscription_id text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  grace_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  provider_state_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscriptions_plan_product_fk
    FOREIGN KEY (plan_id, product) REFERENCES billing_core.plans (id, product),
  CONSTRAINT subscriptions_grace_end_check
    CHECK (status <> 'grace_period' OR grace_period_end IS NOT NULL),
  UNIQUE (product, account_id),
  UNIQUE (stripe_subscription_id),
  UNIQUE (id, product, account_id)
);

CREATE TABLE billing_core.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product text NOT NULL,
  account_id text NOT NULL,
  subscription_id uuid,
  stripe_payment_intent_id text,
  stripe_invoice_id text,
  status text NOT NULL,
  currency text NOT NULL CHECK (currency = upper(currency) AND char_length(currency) = 3),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payments_subscription_owner_fk
    FOREIGN KEY (subscription_id, product, account_id)
    REFERENCES billing_core.subscriptions (id, product, account_id),
  UNIQUE (stripe_payment_intent_id),
  UNIQUE (stripe_invoice_id)
);

CREATE TABLE billing_core.stripe_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product text NOT NULL,
  account_id text NOT NULL,
  stripe_customer_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product, account_id)
);

CREATE TABLE billing_core.processed_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id text NOT NULL UNIQUE,
  event_type text NOT NULL,
  product text,
  account_id text,
  status billing_core.event_processing_status NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  received_at timestamptz NOT NULL DEFAULT now(),
  processing_started_at timestamptz,
  completed_at timestamptz,
  last_attempt_at timestamptz,
  last_error_code text,
  last_error_at timestamptz,
  CONSTRAINT processed_events_terminal_time_check CHECK (
    (status IN ('completed', 'skipped') AND completed_at IS NOT NULL)
    OR (status NOT IN ('completed', 'skipped') AND completed_at IS NULL)
  )
);

CREATE TABLE billing_core.delivery_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  processed_event_id uuid NOT NULL UNIQUE
    REFERENCES billing_core.processed_events (id),
  destination text NOT NULL,
  action text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status billing_core.delivery_job_status NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 12 CHECK (max_attempts > 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  last_attempt_at timestamptz,
  completed_at timestamptz,
  last_error_code text,
  last_error_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT delivery_jobs_lease_check CHECK (
    (status = 'processing' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'processing' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  ),
  CONSTRAINT delivery_jobs_completion_check CHECK (
    (status = 'completed' AND completed_at IS NOT NULL)
    OR (status <> 'completed' AND completed_at IS NULL)
  )
);

CREATE TABLE billing_core.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  outcome text NOT NULL,
  stripe_event_id text,
  correlation_id uuid NOT NULL,
  product text,
  account_reference text,
  attempt integer CHECK (attempt IS NULL OR attempt >= 0),
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  error_code text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object')
);

CREATE INDEX subscriptions_status_grace_idx
  ON billing_core.subscriptions (status, grace_period_end);
CREATE INDEX subscriptions_product_account_idx
  ON billing_core.subscriptions (product, account_id);
CREATE INDEX payments_product_account_occurred_idx
  ON billing_core.payments (product, account_id, occurred_at DESC);
CREATE INDEX processed_events_incomplete_idx
  ON billing_core.processed_events (status, received_at)
  WHERE status IN ('pending', 'processing', 'failed');
CREATE INDEX delivery_jobs_due_idx
  ON billing_core.delivery_jobs (next_attempt_at, created_at)
  WHERE status IN ('pending', 'processing', 'failed');
CREATE INDEX audit_events_correlation_idx
  ON billing_core.audit_events (correlation_id, occurred_at);
CREATE INDEX audit_events_stripe_event_idx
  ON billing_core.audit_events (stripe_event_id, occurred_at)
  WHERE stripe_event_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA billing_core TO billing_core_app;
REVOKE DELETE ON billing_core.processed_events, billing_core.audit_events FROM billing_core_app;
REVOKE ALL ON ALL TABLES IN SCHEMA billing_core FROM billing_core_staging_app, anon, authenticated;

-- Staging is intentionally schema-equivalent to production for restore/security rehearsal.
CREATE TYPE billing_core_staging.subscription_status AS ENUM (
  'trialing',
  'active',
  'past_due',
  'grace_period',
  'cancel_at_period_end',
  'cancelled',
  'expired'
);

CREATE TYPE billing_core_staging.event_processing_status AS ENUM (
  'pending',
  'processing',
  'completed',
  'failed',
  'skipped'
);

CREATE TYPE billing_core_staging.delivery_job_status AS ENUM (
  'pending',
  'processing',
  'completed',
  'failed'
);

REVOKE ALL ON TYPE billing_core_staging.subscription_status FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TYPE billing_core_staging.event_processing_status FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TYPE billing_core_staging.delivery_job_status FROM PUBLIC, anon, authenticated;
GRANT USAGE ON TYPE billing_core_staging.subscription_status TO billing_core_staging_app;
GRANT USAGE ON TYPE billing_core_staging.event_processing_status TO billing_core_staging_app;
GRANT USAGE ON TYPE billing_core_staging.delivery_job_status TO billing_core_staging_app;

CREATE TABLE billing_core_staging.plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product text NOT NULL,
  plan_key text NOT NULL,
  name text NOT NULL,
  currency text NOT NULL CHECK (currency = upper(currency) AND char_length(currency) = 3),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  billing_interval text NOT NULL CHECK (billing_interval IN ('month', 'year')),
  entitlements jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(entitlements) = 'object'),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product, plan_key),
  UNIQUE (id, product)
);

CREATE TABLE billing_core_staging.subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product text NOT NULL,
  account_id text NOT NULL,
  plan_id uuid NOT NULL,
  status billing_core_staging.subscription_status NOT NULL,
  stripe_subscription_id text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  grace_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  provider_state_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscriptions_plan_product_fk
    FOREIGN KEY (plan_id, product) REFERENCES billing_core_staging.plans (id, product),
  CONSTRAINT subscriptions_grace_end_check
    CHECK (status <> 'grace_period' OR grace_period_end IS NOT NULL),
  UNIQUE (product, account_id),
  UNIQUE (stripe_subscription_id),
  UNIQUE (id, product, account_id)
);

CREATE TABLE billing_core_staging.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product text NOT NULL,
  account_id text NOT NULL,
  subscription_id uuid,
  stripe_payment_intent_id text,
  stripe_invoice_id text,
  status text NOT NULL,
  currency text NOT NULL CHECK (currency = upper(currency) AND char_length(currency) = 3),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payments_subscription_owner_fk
    FOREIGN KEY (subscription_id, product, account_id)
    REFERENCES billing_core_staging.subscriptions (id, product, account_id),
  UNIQUE (stripe_payment_intent_id),
  UNIQUE (stripe_invoice_id)
);

CREATE TABLE billing_core_staging.stripe_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product text NOT NULL,
  account_id text NOT NULL,
  stripe_customer_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product, account_id)
);

CREATE TABLE billing_core_staging.processed_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id text NOT NULL UNIQUE,
  event_type text NOT NULL,
  product text,
  account_id text,
  status billing_core_staging.event_processing_status NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  received_at timestamptz NOT NULL DEFAULT now(),
  processing_started_at timestamptz,
  completed_at timestamptz,
  last_attempt_at timestamptz,
  last_error_code text,
  last_error_at timestamptz,
  CONSTRAINT processed_events_terminal_time_check CHECK (
    (status IN ('completed', 'skipped') AND completed_at IS NOT NULL)
    OR (status NOT IN ('completed', 'skipped') AND completed_at IS NULL)
  )
);

CREATE TABLE billing_core_staging.delivery_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  processed_event_id uuid NOT NULL UNIQUE
    REFERENCES billing_core_staging.processed_events (id),
  destination text NOT NULL,
  action text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status billing_core_staging.delivery_job_status NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 12 CHECK (max_attempts > 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  last_attempt_at timestamptz,
  completed_at timestamptz,
  last_error_code text,
  last_error_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT delivery_jobs_lease_check CHECK (
    (status = 'processing' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'processing' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  ),
  CONSTRAINT delivery_jobs_completion_check CHECK (
    (status = 'completed' AND completed_at IS NOT NULL)
    OR (status <> 'completed' AND completed_at IS NULL)
  )
);

CREATE TABLE billing_core_staging.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  outcome text NOT NULL,
  stripe_event_id text,
  correlation_id uuid NOT NULL,
  product text,
  account_reference text,
  attempt integer CHECK (attempt IS NULL OR attempt >= 0),
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  error_code text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object')
);

CREATE INDEX subscriptions_status_grace_idx
  ON billing_core_staging.subscriptions (status, grace_period_end);
CREATE INDEX subscriptions_product_account_idx
  ON billing_core_staging.subscriptions (product, account_id);
CREATE INDEX payments_product_account_occurred_idx
  ON billing_core_staging.payments (product, account_id, occurred_at DESC);
CREATE INDEX processed_events_incomplete_idx
  ON billing_core_staging.processed_events (status, received_at)
  WHERE status IN ('pending', 'processing', 'failed');
CREATE INDEX delivery_jobs_due_idx
  ON billing_core_staging.delivery_jobs (next_attempt_at, created_at)
  WHERE status IN ('pending', 'processing', 'failed');
CREATE INDEX audit_events_correlation_idx
  ON billing_core_staging.audit_events (correlation_id, occurred_at);
CREATE INDEX audit_events_stripe_event_idx
  ON billing_core_staging.audit_events (stripe_event_id, occurred_at)
  WHERE stripe_event_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA billing_core_staging
  TO billing_core_staging_app;
REVOKE DELETE ON billing_core_staging.processed_events, billing_core_staging.audit_events
  FROM billing_core_staging_app;
REVOKE ALL ON ALL TABLES IN SCHEMA billing_core_staging
  FROM billing_core_app, anon, authenticated;

COMMIT;
