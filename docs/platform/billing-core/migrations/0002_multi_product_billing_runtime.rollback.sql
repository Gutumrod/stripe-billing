-- SB01 Phase 2B rollback for migration 0002 only.
-- Destructive: authorized migration owner only. Do not run after Phase 2C without House/Sol approval.
-- Preserves the historical 0001 baseline objects and roles.

BEGIN;

DROP TABLE billing_core.runtime_entitlement_test_sink;
DROP TABLE billing_core.runtime_entitlement_transitions;
DROP TABLE billing_core.runtime_reconciliation_state;
DROP TABLE billing_core.runtime_outbox_jobs;
DROP TABLE billing_core.runtime_provider_events;
DROP TABLE billing_core.runtime_audit_events;
DROP TABLE billing_core.runtime_provider_customers;
DROP TABLE billing_core.runtime_operations;
DROP TABLE billing_core.runtime_credential_bindings;

DROP TABLE billing_core_staging.runtime_entitlement_test_sink;
DROP TABLE billing_core_staging.runtime_entitlement_transitions;
DROP TABLE billing_core_staging.runtime_reconciliation_state;
DROP TABLE billing_core_staging.runtime_outbox_jobs;
DROP TABLE billing_core_staging.runtime_provider_events;
DROP TABLE billing_core_staging.runtime_audit_events;
DROP TABLE billing_core_staging.runtime_provider_customers;
DROP TABLE billing_core_staging.runtime_operations;
DROP TABLE billing_core_staging.runtime_credential_bindings;

COMMIT;