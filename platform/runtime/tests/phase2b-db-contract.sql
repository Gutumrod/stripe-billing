BEGIN;

INSERT INTO billing_core_staging.runtime_credential_bindings
(environment, product_id, credential_key_id, profile_version, token_fingerprint, scopes, status)
VALUES
('test','phase2b-p1','key-p1',1,repeat('a',64),'["checkout","read"]'::jsonb,'active'),
('test','phase2b-p2','key-p2',1,repeat('b',64),'["checkout","read"]'::jsonb,'active');

INSERT INTO billing_core_staging.runtime_operations
(environment,product_id,account_id,credential_key_id,profile_version,route,operation_id,request_fingerprint,status,correlation_id)
VALUES ('test','phase2b-p1','acct-shared','key-p1',1,'checkout','op-1',repeat('c',64),'pending',gen_random_uuid());

DO $$ BEGIN
  BEGIN
    INSERT INTO billing_core_staging.runtime_operations
    (environment,product_id,account_id,credential_key_id,profile_version,route,operation_id,request_fingerprint,status,correlation_id)
    VALUES ('test','phase2b-p1','acct-shared','key-p1',1,'checkout','op-1',repeat('c',64),'pending',gen_random_uuid());
    RAISE EXCEPTION 'duplicate operation accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    INSERT INTO billing_core_staging.runtime_operations
    (environment,product_id,account_id,credential_key_id,profile_version,route,operation_id,request_fingerprint,status,correlation_id)
    VALUES ('test','phase2b-p2','acct-shared','key-p1',1,'checkout','op-x',repeat('d',64),'pending',gen_random_uuid());
    RAISE EXCEPTION 'cross-product credential accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
END $$;

INSERT INTO billing_core_staging.runtime_provider_customers
(environment,product_id,account_id,profile_version,provider,provider_customer_id,state)
VALUES
('test','phase2b-p1','acct-shared',1,'stripe','cus_phase2b_p1','ready'),
('test','phase2b-p2','acct-shared',1,'stripe','cus_phase2b_p2','ready');

DO $$ BEGIN
  IF (SELECT count(*) FROM billing_core_staging.runtime_provider_customers
      WHERE environment='test' AND account_id='acct-shared' AND product_id IN ('phase2b-p1','phase2b-p2')) <> 2 THEN
    RAISE EXCEPTION 'same account text did not isolate by product';
  END IF;
  BEGIN
    INSERT INTO billing_core_staging.runtime_provider_customers
    (environment,product_id,account_id,profile_version,provider,provider_customer_id,state)
    VALUES ('test','phase2b-p2','acct-other',1,'stripe','cus_phase2b_p1','ready');
    RAISE EXCEPTION 'provider customer reused cross-product';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    INSERT INTO billing_core_staging.runtime_provider_customers
    (environment,product_id,account_id,profile_version,provider,state)
    VALUES ('test','phase2b-p1','acct-invalid',1,'stripe','ready');
    RAISE EXCEPTION 'invalid ready mapping accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
END $$;

INSERT INTO billing_core_staging.runtime_provider_events
(provider,provider_event_id,event_type,livemode,environment,product_id,account_id,profile_version,hint_envelope,normalized_envelope,status,correlation_id)
VALUES ('stripe','evt_phase2b_1','customer.subscription.updated',false,'test','phase2b-p1','acct-shared',1,'{}','{}','pending',gen_random_uuid());

DO $$ BEGIN
  BEGIN
    INSERT INTO billing_core_staging.runtime_provider_events
    (provider,provider_event_id,event_type,livemode,environment,product_id,account_id,profile_version,hint_envelope,normalized_envelope,status,correlation_id)
    VALUES ('stripe','evt_phase2b_bad','test',true,'test','phase2b-p1','acct-shared',1,'{}','{}','pending',gen_random_uuid());
    RAISE EXCEPTION 'livemode/environment mismatch accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
END $$;

INSERT INTO billing_core_staging.runtime_outbox_jobs
(environment,product_id,account_id,profile_version,job_type,payload,status,dedupe_key,correlation_id)
VALUES ('test','phase2b-p1','acct-shared',1,'reconcile','{}','pending','phase2b-dedupe',gen_random_uuid());

DO $$ BEGIN
  BEGIN
    INSERT INTO billing_core_staging.runtime_outbox_jobs
    (environment,product_id,account_id,profile_version,job_type,payload,status,dedupe_key,correlation_id)
    VALUES ('test','phase2b-p2','acct-shared',1,'reconcile','{}','pending','phase2b-dedupe',gen_random_uuid());
    RAISE EXCEPTION 'outbox dedupe collision accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;
END $$;

INSERT INTO billing_core_staging.runtime_reconciliation_state
(environment,product_id,account_id,profile_version,plan_id,provider_subscription_id,provider_customer_id,provider_status,price_id,amount_minor,currency,cancel_at_period_end,snapshot_hash,reconciliation_version,correlation_id)
VALUES
('test','phase2b-p1','acct-shared',1,'plan-a','sub_phase2b_p1','cus_phase2b_p1','active','price-a',100,'THB',false,repeat('e',64),1,gen_random_uuid()),
('test','phase2b-p2','acct-shared',1,'plan-b','sub_phase2b_p2','cus_phase2b_p2','active','price-b',200,'THB',false,repeat('f',64),1,gen_random_uuid());

DO $$ BEGIN
  BEGIN
    INSERT INTO billing_core_staging.runtime_reconciliation_state
    (environment,product_id,account_id,profile_version,plan_id,provider_subscription_id,provider_customer_id,provider_status,price_id,snapshot_hash,reconciliation_version,correlation_id)
    VALUES ('test','phase2b-p2','acct-shared',1,'plan-b','sub_phase2b_p1','cus_phase2b_p2','active','price-b',repeat('1',64),1,gen_random_uuid());
    RAISE EXCEPTION 'provider subscription reused cross-product';
  EXCEPTION WHEN unique_violation THEN NULL; END;
END $$;

INSERT INTO billing_core_staging.runtime_entitlement_transitions
(environment,product_id,account_id,profile_version,plan_id,transition_type,entitlement_keys,provider_subscription_id,transition_version,idempotency_key,signed_envelope,signature,status,correlation_id,issued_at)
VALUES ('test','phase2b-p1','acct-shared',1,'plan-a','grant','["access"]','sub_phase2b_p1',1,'phase2b-ent-1','{}','sig','pending',gen_random_uuid(),now());

DO $$ BEGIN
  BEGIN
    INSERT INTO billing_core_staging.runtime_entitlement_transitions
    (environment,product_id,account_id,profile_version,plan_id,transition_type,entitlement_keys,provider_subscription_id,transition_version,idempotency_key,signed_envelope,signature,status,correlation_id,issued_at)
    VALUES ('test','phase2b-p2','acct-shared',1,'plan-b','grant','["access"]','sub_phase2b_p1',1,'phase2b-ent-x','{}','sig','pending',gen_random_uuid(),now());
    RAISE EXCEPTION 'cross-product entitlement reconciliation accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
END $$;

ROLLBACK;