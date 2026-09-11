-- SB01 Phase 2B forward-only runtime DB contract.
-- Requires 0001_billing_core_schema.sql to have completed successfully first.
-- Apply only by the authorized migration owner. Phase 2B target: WSTERA LAB only.

BEGIN;

CREATE TABLE billing_core.runtime_credential_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment text NOT NULL CHECK (environment IN ('test', 'live')),
  product_id text NOT NULL,
  credential_key_id text NOT NULL,
  profile_version integer NOT NULL CHECK (profile_version > 0),
  token_fingerprint text NOT NULL CHECK (token_fingerprint ~ '^[0-9a-f]{64}$'),
  scopes jsonb NOT NULL CHECK (jsonb_typeof(scopes) = 'array'),
  status text NOT NULL CHECK (status IN ('active')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (environment, product_id, credential_key_id)
);

CREATE TABLE billing_core.runtime_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment text NOT NULL CHECK (environment IN ('test', 'live')),
  product_id text NOT NULL,
  account_id text NOT NULL,
  credential_key_id text NOT NULL,
  profile_version integer NOT NULL CHECK (profile_version > 0),
  route text NOT NULL,
  operation_id text NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  correlation_id uuid NOT NULL,
  response_projection jsonb CHECK (response_projection IS NULL OR jsonb_typeof(response_projection) = 'object'),
  provider_object_id text,
  error_code text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runtime_operations_credential_fk
    FOREIGN KEY (environment, product_id, credential_key_id)
    REFERENCES billing_core.runtime_credential_bindings (environment, product_id, credential_key_id),
  CONSTRAINT runtime_operations_completion_check CHECK (
    (status = 'completed' AND completed_at IS NOT NULL)
    OR (status <> 'completed' AND completed_at IS NULL)
  ),
  UNIQUE (environment, product_id, account_id, route, operation_id)
);

CREATE TABLE billing_core.runtime_provider_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment text NOT NULL CHECK (environment IN ('test', 'live')),
  product_id text NOT NULL,
  account_id text NOT NULL,
  profile_version integer NOT NULL CHECK (profile_version > 0),
  provider text NOT NULL DEFAULT 'stripe' CHECK (provider = 'stripe'),
  provider_customer_id text,
  state text NOT NULL CHECK (state IN ('reserved', 'ready')),
  reservation_token text,
  reservation_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runtime_provider_customers_reservation_invariant_check CHECK (
    (state = 'reserved' AND provider_customer_id IS NULL
      AND reservation_token IS NOT NULL AND reservation_expires_at IS NOT NULL)
    OR (state = 'ready' AND provider_customer_id IS NOT NULL
      AND reservation_token IS NULL AND reservation_expires_at IS NULL)
  ),
  UNIQUE (environment, product_id, account_id, provider),
  UNIQUE (environment, product_id, account_id, provider_customer_id)
);

CREATE UNIQUE INDEX runtime_provider_customers_provider_id_uidx
  ON billing_core.runtime_provider_customers (provider, provider_customer_id)
  WHERE provider_customer_id IS NOT NULL;

CREATE TABLE billing_core.runtime_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  correlation_id uuid NOT NULL,
  event_name text NOT NULL,
  outcome text NOT NULL,
  environment text CHECK (environment IS NULL OR environment IN ('test', 'live')),
  product_id text,
  account_id text,
  provider_object_id text,
  provider_event_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE billing_core.runtime_provider_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider = 'stripe'),
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  livemode boolean NOT NULL,
  environment text CHECK (environment IS NULL OR environment IN ('test', 'live')),
  product_id text,
  account_id text,
  profile_version integer CHECK (profile_version IS NULL OR profile_version > 0),
  provider_object_id text,
  provider_customer_id text,
  hint_envelope jsonb NOT NULL CHECK (jsonb_typeof(hint_envelope) = 'object'),
  normalized_envelope jsonb NOT NULL CHECK (jsonb_typeof(normalized_envelope) = 'object'),
  status text NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'skipped')),
  correlation_id uuid NOT NULL,
  completed_at timestamptz,
  last_error_code text,
  received_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runtime_provider_events_scope_check CHECK (
    (environment IS NULL AND product_id IS NULL AND account_id IS NULL AND profile_version IS NULL)
    OR (environment IS NOT NULL AND product_id IS NOT NULL AND account_id IS NOT NULL AND profile_version IS NOT NULL)
  ),
  CONSTRAINT runtime_provider_events_livemode_environment_check CHECK (
    environment IS NULL
    OR (environment = 'test' AND livemode = false)
    OR (environment = 'live' AND livemode = true)
  ),
  UNIQUE (provider, provider_event_id)
);

CREATE TABLE billing_core.runtime_outbox_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_event_id uuid REFERENCES billing_core.runtime_provider_events (id) ON DELETE RESTRICT,
  environment text NOT NULL CHECK (environment IN ('test', 'live')),
  product_id text NOT NULL,
  account_id text NOT NULL,
  profile_version integer NOT NULL CHECK (profile_version > 0),
  job_type text NOT NULL CHECK (job_type IN ('reconcile', 'entitlement_test_sink')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'failed', 'dead_letter', 'completed')),
  dedupe_key text NOT NULL UNIQUE,
  correlation_id uuid NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 12 CHECK (max_attempts > 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  last_attempt_at timestamptz,
  completed_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runtime_outbox_jobs_attempt_check CHECK (attempt_count <= max_attempts),
  CONSTRAINT runtime_outbox_jobs_lease_check CHECK (
    (status = 'processing' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'processing' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  ),
  CONSTRAINT runtime_outbox_jobs_completion_check CHECK (
    (status = 'completed' AND completed_at IS NOT NULL)
    OR (status <> 'completed' AND completed_at IS NULL)
  )
);

CREATE TABLE billing_core.runtime_reconciliation_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment text NOT NULL CHECK (environment IN ('test', 'live')),
  product_id text NOT NULL,
  account_id text NOT NULL,
  profile_version integer NOT NULL CHECK (profile_version > 0),
  plan_id text NOT NULL,
  provider_subscription_id text NOT NULL,
  provider_customer_id text NOT NULL,
  provider_status text NOT NULL,
  price_id text NOT NULL,
  provider_product_id text,
  amount_minor bigint CHECK (amount_minor IS NULL OR amount_minor >= 0),
  currency text CHECK (currency IS NULL OR (currency = upper(currency) AND char_length(currency) = 3)),
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
  reconciliation_version integer NOT NULL CHECK (reconciliation_version > 0),
  correlation_id uuid NOT NULL,
  reconciled_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runtime_reconciliation_period_check CHECK (
    current_period_start IS NULL OR current_period_end IS NULL OR current_period_end > current_period_start
  ),
  CONSTRAINT runtime_reconciliation_customer_fk
    FOREIGN KEY (environment, product_id, account_id, provider_customer_id)
    REFERENCES billing_core.runtime_provider_customers
      (environment, product_id, account_id, provider_customer_id),
  UNIQUE (environment, product_id, account_id, provider_subscription_id),
  UNIQUE (environment, provider_subscription_id)
);

CREATE TABLE billing_core.runtime_entitlement_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment text NOT NULL CHECK (environment IN ('test', 'live')),
  product_id text NOT NULL,
  account_id text NOT NULL,
  profile_version integer NOT NULL CHECK (profile_version > 0),
  plan_id text NOT NULL,
  transition_type text NOT NULL CHECK (transition_type IN ('grant', 'revoke', 'pending')),
  entitlement_keys jsonb NOT NULL CHECK (jsonb_typeof(entitlement_keys) = 'array'),
  provider_subscription_id text NOT NULL,
  transition_version integer NOT NULL CHECK (transition_version > 0),
  idempotency_key text NOT NULL UNIQUE,
  signed_envelope jsonb NOT NULL CHECK (jsonb_typeof(signed_envelope) = 'object'),
  signature text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered')),
  correlation_id uuid NOT NULL,
  issued_at timestamptz NOT NULL,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runtime_entitlement_transitions_delivery_check CHECK (
    (status = 'delivered' AND delivered_at IS NOT NULL)
    OR (status = 'pending' AND delivered_at IS NULL)
  ),
  CONSTRAINT runtime_entitlement_transitions_reconciliation_fk
    FOREIGN KEY (environment, product_id, account_id, provider_subscription_id)
    REFERENCES billing_core.runtime_reconciliation_state
      (environment, product_id, account_id, provider_subscription_id),
  UNIQUE (environment, product_id, account_id, provider_subscription_id, transition_version)
);

CREATE TABLE billing_core.runtime_entitlement_test_sink (
  environment text NOT NULL CHECK (environment IN ('test', 'live')),
  product_id text NOT NULL,
  account_id text NOT NULL,
  profile_version integer NOT NULL CHECK (profile_version > 0),
  plan_id text NOT NULL,
  transition_type text NOT NULL CHECK (transition_type IN ('grant', 'revoke', 'pending')),
  entitlement_keys jsonb NOT NULL CHECK (jsonb_typeof(entitlement_keys) = 'array'),
  provider_subscription_id text NOT NULL,
  latest_transition_version integer NOT NULL CHECK (latest_transition_version > 0),
  signed_envelope jsonb NOT NULL CHECK (jsonb_typeof(signed_envelope) = 'object'),
  signature text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (environment, product_id, account_id),
  CONSTRAINT runtime_entitlement_test_sink_reconciliation_fk
    FOREIGN KEY (environment, product_id, account_id, provider_subscription_id)
    REFERENCES billing_core.runtime_reconciliation_state
      (environment, product_id, account_id, provider_subscription_id)
);

CREATE INDEX runtime_audit_events_correlation_idx
  ON billing_core.runtime_audit_events (correlation_id, occurred_at DESC);
CREATE INDEX runtime_audit_events_product_account_idx
  ON billing_core.runtime_audit_events (environment, product_id, account_id, occurred_at DESC);
CREATE INDEX runtime_provider_events_customer_idx
  ON billing_core.runtime_provider_events (provider, provider_customer_id)
  WHERE provider_customer_id IS NOT NULL;
CREATE INDEX runtime_provider_events_status_idx
  ON billing_core.runtime_provider_events (status, received_at);
CREATE INDEX runtime_outbox_jobs_due_idx
  ON billing_core.runtime_outbox_jobs (next_attempt_at, created_at, id)
  WHERE status IN ('pending', 'failed', 'processing');
CREATE INDEX runtime_outbox_jobs_product_account_idx
  ON billing_core.runtime_outbox_jobs (environment, product_id, account_id, created_at DESC);
CREATE INDEX runtime_reconciliation_account_latest_idx
  ON billing_core.runtime_reconciliation_state
    (environment, product_id, account_id, reconciled_at DESC);
CREATE INDEX runtime_entitlement_transitions_account_idx
  ON billing_core.runtime_entitlement_transitions
    (environment, product_id, account_id, transition_version DESC);

GRANT SELECT, INSERT, UPDATE ON
  billing_core.runtime_credential_bindings,
  billing_core.runtime_operations,
  billing_core.runtime_provider_customers,
  billing_core.runtime_audit_events,
  billing_core.runtime_provider_events,
  billing_core.runtime_outbox_jobs,
  billing_core.runtime_reconciliation_state,
  billing_core.runtime_entitlement_transitions,
  billing_core.runtime_entitlement_test_sink
TO billing_core_app;

REVOKE ALL ON
  billing_core.runtime_credential_bindings,
  billing_core.runtime_operations,
  billing_core.runtime_provider_customers,
  billing_core.runtime_audit_events,
  billing_core.runtime_provider_events,
  billing_core.runtime_outbox_jobs,
  billing_core.runtime_reconciliation_state,
  billing_core.runtime_entitlement_transitions,
  billing_core.runtime_entitlement_test_sink
FROM billing_core_staging_app, anon, authenticated;

-- Staging mirrors production for Phase 2 runtime rehearsal.
CREATE TABLE billing_core_staging.runtime_credential_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment text NOT NULL CHECK (environment IN ('test', 'live')),
  product_id text NOT NULL,
  credential_key_id text NOT NULL,
  profile_version integer NOT NULL CHECK (profile_version > 0),
  token_fingerprint text NOT NULL CHECK (token_fingerprint ~ '^[0-9a-f]{64}$'),
  scopes jsonb NOT NULL CHECK (jsonb_typeof(scopes) = 'array'),
  status text NOT NULL CHECK (status IN ('active')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (environment, product_id, credential_key_id)
);

CREATE TABLE billing_core_staging.runtime_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment text NOT NULL CHECK (environment IN ('test', 'live')),
  product_id text NOT NULL,
  account_id text NOT NULL,
  credential_key_id text NOT NULL,
  profile_version integer NOT NULL CHECK (profile_version > 0),
  route text NOT NULL,
  operation_id text NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  correlation_id uuid NOT NULL,
  response_projection jsonb CHECK (response_projection IS NULL OR jsonb_typeof(response_projection) = 'object'),
  provider_object_id text,
  error_code text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runtime_operations_credential_fk
    FOREIGN KEY (environment, product_id, credential_key_id)
    REFERENCES billing_core_staging.runtime_credential_bindings (environment, product_id, credential_key_id),
  CONSTRAINT runtime_operations_completion_check CHECK (
    (status = 'completed' AND completed_at IS NOT NULL)
    OR (status <> 'completed' AND completed_at IS NULL)
  ),
  UNIQUE (environment, product_id, account_id, route, operation_id)
);

CREATE TABLE billing_core_staging.runtime_provider_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment text NOT NULL CHECK (environment IN ('test', 'live')),
  product_id text NOT NULL,
  account_id text NOT NULL,
  profile_version integer NOT NULL CHECK (profile_version > 0),
  provider text NOT NULL DEFAULT 'stripe' CHECK (provider = 'stripe'),
  provider_customer_id text,
  state text NOT NULL CHECK (state IN ('reserved', 'ready')),
  reservation_token text,
  reservation_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runtime_provider_customers_reservation_invariant_check CHECK (
    (state = 'reserved' AND provider_customer_id IS NULL
      AND reservation_token IS NOT NULL AND reservation_expires_at IS NOT NULL)
    OR (state = 'ready' AND provider_customer_id IS NOT NULL
      AND reservation_token IS NULL AND reservation_expires_at IS NULL)
  ),
  UNIQUE (environment, product_id, account_id, provider),
  UNIQUE (environment, product_id, account_id, provider_customer_id)
);

CREATE UNIQUE INDEX runtime_provider_customers_provider_id_uidx  ON billing_core_staging.runtime_provider_customers (provider, provider_customer_id)
  WHERE provider_customer_id IS NOT NULL;

CREATE TABLE billing_core_staging.runtime_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  correlation_id uuid NOT NULL,
  event_name text NOT NULL,
  outcome text NOT NULL,
  environment text CHECK (environment IS NULL OR environment IN ('test', 'live')),
  product_id text,
  account_id text,
  provider_object_id text,
  provider_event_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE billing_core_staging.runtime_provider_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider = 'stripe'),
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  livemode boolean NOT NULL,
  environment text CHECK (environment IS NULL OR environment IN ('test', 'live')),
  product_id text,
  account_id text,
  profile_version integer CHECK (profile_version IS NULL OR profile_version > 0),
  provider_object_id text,
  provider_customer_id text,
  hint_envelope jsonb NOT NULL CHECK (jsonb_typeof(hint_envelope) = 'object'),  normalized_envelope jsonb NOT NULL CHECK (jsonb_typeof(normalized_envelope) = 'object'),
  status text NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'skipped')),
  correlation_id uuid NOT NULL,
  completed_at timestamptz,
  last_error_code text,
  received_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runtime_provider_events_scope_check CHECK (
    (environment IS NULL AND product_id IS NULL AND account_id IS NULL AND profile_version IS NULL)
    OR (environment IS NOT NULL AND product_id IS NOT NULL AND account_id IS NOT NULL AND profile_version IS NOT NULL)
  ),
  CONSTRAINT runtime_provider_events_livemode_environment_check CHECK (
    environment IS NULL
    OR (environment = 'test' AND livemode = false)
    OR (environment = 'live' AND livemode = true)
  ),
  UNIQUE (provider, provider_event_id)
);

CREATE TABLE billing_core_staging.runtime_outbox_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_event_id uuid REFERENCES billing_core_staging.runtime_provider_events (id) ON DELETE RESTRICT,
  environment text NOT NULL CHECK (environment IN ('test', 'live')),
  product_id text NOT NULL,
  account_id text NOT NULL,
  profile_version integer NOT NULL CHECK (profile_version > 0),
  job_type text NOT NULL CHECK (job_type IN ('reconcile', 'entitlement_test_sink')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'failed', 'dead_letter', 'completed')),  dedupe_key text NOT NULL UNIQUE,
  correlation_id uuid NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 12 CHECK (max_attempts > 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  last_attempt_at timestamptz,
  completed_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runtime_outbox_jobs_attempt_check CHECK (attempt_count <= max_attempts),
  CONSTRAINT runtime_outbox_jobs_lease_check CHECK (
    (status = 'processing' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'processing' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  ),
  CONSTRAINT runtime_outbox_jobs_completion_check CHECK (
    (status = 'completed' AND completed_at IS NOT NULL)
    OR (status <> 'completed' AND completed_at IS NULL)
  )
);

CREATE TABLE billing_core_staging.runtime_reconciliation_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment text NOT NULL CHECK (environment IN ('test', 'live')),
  product_id text NOT NULL,
  account_id text NOT NULL,
  profile_version integer NOT NULL CHECK (profile_version > 0),
  plan_id text NOT NULL,  provider_subscription_id text NOT NULL,
  provider_customer_id text NOT NULL,
  provider_status text NOT NULL,
  price_id text NOT NULL,
  provider_product_id text,
  amount_minor bigint CHECK (amount_minor IS NULL OR amount_minor >= 0),
  currency text CHECK (currency IS NULL OR (currency = upper(currency) AND char_length(currency) = 3)),
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
  reconciliation_version integer NOT NULL CHECK (reconciliation_version > 0),
  correlation_id uuid NOT NULL,
  reconciled_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runtime_reconciliation_period_check CHECK (
    current_period_start IS NULL OR current_period_end IS NULL OR current_period_end > current_period_start
  ),
  CONSTRAINT runtime_reconciliation_customer_fk
    FOREIGN KEY (environment, product_id, account_id, provider_customer_id)
    REFERENCES billing_core_staging.runtime_provider_customers
      (environment, product_id, account_id, provider_customer_id),
  UNIQUE (environment, product_id, account_id, provider_subscription_id),
  UNIQUE (environment, provider_subscription_id)
);

CREATE TABLE billing_core_staging.runtime_entitlement_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment text NOT NULL CHECK (environment IN ('test', 'live')),
  product_id text NOT NULL,
  account_id text NOT NULL,  profile_version integer NOT NULL CHECK (profile_version > 0),
  plan_id text NOT NULL,
  transition_type text NOT NULL CHECK (transition_type IN ('grant', 'revoke', 'pending')),
  entitlement_keys jsonb NOT NULL CHECK (jsonb_typeof(entitlement_keys) = 'array'),
  provider_subscription_id text NOT NULL,
  transition_version integer NOT NULL CHECK (transition_version > 0),
  idempotency_key text NOT NULL UNIQUE,
  signed_envelope jsonb NOT NULL CHECK (jsonb_typeof(signed_envelope) = 'object'),
  signature text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered')),
  correlation_id uuid NOT NULL,
  issued_at timestamptz NOT NULL,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runtime_entitlement_transitions_delivery_check CHECK (
    (status = 'delivered' AND delivered_at IS NOT NULL)
    OR (status = 'pending' AND delivered_at IS NULL)
  ),
  CONSTRAINT runtime_entitlement_transitions_reconciliation_fk
    FOREIGN KEY (environment, product_id, account_id, provider_subscription_id)
    REFERENCES billing_core_staging.runtime_reconciliation_state
      (environment, product_id, account_id, provider_subscription_id),
  UNIQUE (environment, product_id, account_id, provider_subscription_id, transition_version)
);

CREATE TABLE billing_core_staging.runtime_entitlement_test_sink (
  environment text NOT NULL CHECK (environment IN ('test', 'live')),
  product_id text NOT NULL,
  account_id text NOT NULL,
  profile_version integer NOT NULL CHECK (profile_version > 0),  plan_id text NOT NULL,
  transition_type text NOT NULL CHECK (transition_type IN ('grant', 'revoke', 'pending')),
  entitlement_keys jsonb NOT NULL CHECK (jsonb_typeof(entitlement_keys) = 'array'),
  provider_subscription_id text NOT NULL,
  latest_transition_version integer NOT NULL CHECK (latest_transition_version > 0),
  signed_envelope jsonb NOT NULL CHECK (jsonb_typeof(signed_envelope) = 'object'),
  signature text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (environment, product_id, account_id),
  CONSTRAINT runtime_entitlement_test_sink_reconciliation_fk
    FOREIGN KEY (environment, product_id, account_id, provider_subscription_id)
    REFERENCES billing_core_staging.runtime_reconciliation_state
      (environment, product_id, account_id, provider_subscription_id)
);

CREATE INDEX runtime_audit_events_correlation_idx
  ON billing_core_staging.runtime_audit_events (correlation_id, occurred_at DESC);
CREATE INDEX runtime_audit_events_product_account_idx
  ON billing_core_staging.runtime_audit_events (environment, product_id, account_id, occurred_at DESC);
CREATE INDEX runtime_provider_events_customer_idx
  ON billing_core_staging.runtime_provider_events (provider, provider_customer_id)
  WHERE provider_customer_id IS NOT NULL;
CREATE INDEX runtime_provider_events_status_idx
  ON billing_core_staging.runtime_provider_events (status, received_at);
CREATE INDEX runtime_outbox_jobs_due_idx
  ON billing_core_staging.runtime_outbox_jobs (next_attempt_at, created_at, id)
  WHERE status IN ('pending', 'failed', 'processing');
CREATE INDEX runtime_outbox_jobs_product_account_idx
  ON billing_core_staging.runtime_outbox_jobs (environment, product_id, account_id, created_at DESC);
CREATE INDEX runtime_reconciliation_account_latest_idx
  ON billing_core_staging.runtime_reconciliation_state
    (environment, product_id, account_id, reconciled_at DESC);
CREATE INDEX runtime_entitlement_transitions_account_idx
  ON billing_core_staging.runtime_entitlement_transitions
    (environment, product_id, account_id, transition_version DESC);

GRANT SELECT, INSERT, UPDATE ON
  billing_core_staging.runtime_credential_bindings,
  billing_core_staging.runtime_operations,
  billing_core_staging.runtime_provider_customers,
  billing_core_staging.runtime_audit_events,
  billing_core_staging.runtime_provider_events,
  billing_core_staging.runtime_outbox_jobs,
  billing_core_staging.runtime_reconciliation_state,
  billing_core_staging.runtime_entitlement_transitions,
  billing_core_staging.runtime_entitlement_test_sink
TO billing_core_staging_app;

REVOKE ALL ON
  billing_core_staging.runtime_credential_bindings,
  billing_core_staging.runtime_operations,
  billing_core_staging.runtime_provider_customers,
  billing_core_staging.runtime_audit_events,
  billing_core_staging.runtime_provider_events,
  billing_core_staging.runtime_outbox_jobs,
  billing_core_staging.runtime_reconciliation_state,
  billing_core_staging.runtime_entitlement_transitions,
  billing_core_staging.runtime_entitlement_test_sink
FROM billing_core_app, anon, authenticated;

COMMIT;
