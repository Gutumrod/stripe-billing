import postgres, { Sql } from 'postgres';
import { BillingEnvironment, BillingRuntimeError, CredentialBinding, SignedEntitlementTransition } from './types';

type JsonRecord = Record<string, postgres.JSONValue>;

// Shared by claimWebhookEvent and enqueueReconciliation: on a duplicate dedupe_key, keep an
// unexpired `processing` lease intact (don't hand the same job to a second worker), keep
// `dead_letter` fail-closed, and — LR-2D real-execution defect fix, see
// docs/platform/billing-core/EVIDENCE-SB01-LR-2D-CLAUDE-2026-09-17.md — keep `completed` intact
// too. A duplicate/stale event re-arriving after its job already completed must not resurrect
// it to `pending`: that both re-processes already-settled billing state and, since `completed`
// rows always carry a non-null `completed_at`, violates `runtime_outbox_jobs_completion_check`
// (status<>'completed' requires completed_at IS NULL) the instant a second worker later
// completes/fails it again. Decision table mirrored by resolveOutboxConflict for testing.
//
// Both affected INSERTs alias the conflict target as `existing_job` (`insert into ... as
// existing_job`). Existing-row RHS reads must go through that alias: inside `on conflict do
// update`, an unqualified column name is ambiguous between the existing target row and the
// proposed `excluded` row and PostgreSQL rejects it (or worse, resolves it unexpectedly). SET
// target columns on the LHS must stay unqualified — PostgreSQL does not accept a qualified
// assignment target there.
export const OUTBOX_LEASE_PRESERVING_CONFLICT_SET = `
  status=case
    when existing_job.status in ('dead_letter','completed') then existing_job.status
    when existing_job.status='processing' and existing_job.lease_expires_at > now() then 'processing'
    else 'pending'
  end,
  next_attempt_at=case
    when existing_job.status in ('dead_letter','completed') then existing_job.next_attempt_at
    when existing_job.status='processing' and existing_job.lease_expires_at > now() then existing_job.next_attempt_at
    else now()
  end,
  lease_owner=case
    when existing_job.status in ('dead_letter','completed') then existing_job.lease_owner
    when existing_job.status='processing' and existing_job.lease_expires_at > now() then existing_job.lease_owner
    else null
  end,
  lease_expires_at=case
    when existing_job.status in ('dead_letter','completed') then existing_job.lease_expires_at
    when existing_job.status='processing' and existing_job.lease_expires_at > now() then existing_job.lease_expires_at
    else null
  end,
  updated_at=now()
`;

export interface OutboxConflictRow {
  status: string;
  leaseExpiresAt: Date | null;
}

// Pure mirror of OUTBOX_LEASE_PRESERVING_CONFLICT_SET's branches, kept in sync by hand; used by
// tests/outbox-lease-conflict.test.mjs since the SQL itself needs a live database to execute.
export function resolveOutboxConflict(current: OutboxConflictRow, now: Date): {
  status: 'dead_letter' | 'completed' | 'processing' | 'pending';
  preserveLease: boolean;
} {
  if (current.status === 'dead_letter' || current.status === 'completed') {
    return { status: current.status, preserveLease: true };
  }
  const leaseActive = current.status === 'processing'
    && current.leaseExpiresAt !== null
    && current.leaseExpiresAt.getTime() > now.getTime();
  if (leaseActive) return { status: 'processing', preserveLease: true };
  return { status: 'pending', preserveLease: false };
}

export interface OperationState {
  id: string;
  status: string;
  correlationId: string;
  responseProjection: Record<string, unknown> | null;
  providerObjectId: string | null;
}

export interface CustomerMapping {
  id: string;
  environment: BillingEnvironment;
  productId: string;
  accountId: string;
  profileVersion: number;
  providerCustomerId: string | null;
  state: 'reserved' | 'ready';
  reservationToken: string | null;
}

export interface OutboxJob {
  id: string;
  providerEventDbId: string | null;
  environment: BillingEnvironment;
  productId: string;
  accountId: string;
  profileVersion: number;
  jobType: 'reconcile' | 'entitlement_test_sink';
  payload: Record<string, unknown>;
  attemptCount: number;
  maxAttempts: number;
  correlationId: string;
}

export interface ReconciliationState {
  id: string;
  version: number;
  changed: boolean;
  status: string;
}

export class BillingDb {
  private readonly sql: Sql;
  private readonly schemaPrefix: string;

  constructor(databaseUrl: string, schema: 'billing_core' | 'billing_core_staging') {
    if (!databaseUrl) throw new BillingRuntimeError('DATABASE_URL_REQUIRED', 'Billing database URL is required', 500);
    this.schemaPrefix = schema;
    this.sql = postgres(databaseUrl, { max: 8, idle_timeout: 20, connect_timeout: 15, prepare: false });
  }

  private table(name: string): ReturnType<Sql['unsafe']> {
    if (!/^runtime_[a-z_]+$/.test(name)) throw new Error('Unsafe runtime table name');
    return this.sql.unsafe(`${this.schemaPrefix}.${name}`);
  }
  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }

  async ping(): Promise<void> {
    await this.sql`select 1 as ok`;
  }

  async ensureCredentialBinding(binding: CredentialBinding, tokenFingerprint: string): Promise<void> {
    const table = this.table('runtime_credential_bindings');
    await this.sql`
      insert into ${table}
        (environment, product_id, credential_key_id, profile_version, token_fingerprint, scopes, status)
      values
        (${binding.environment}, ${binding.productId}, ${binding.keyId}, ${binding.profileVersion},
         ${tokenFingerprint}, ${this.sql.json(binding.scopes)}, 'active')
      on conflict (environment, product_id, credential_key_id) do update set
        profile_version = excluded.profile_version,
        token_fingerprint = excluded.token_fingerprint,
        scopes = excluded.scopes,
        status = 'active',
        updated_at = now()
    `;
  }

  async beginOperation(input: {
    environment: BillingEnvironment;
    productId: string;
    accountId: string;
    credentialKeyId: string;
    profileVersion: number;
    route: string;
    operationId: string;
    requestFingerprint: string;
    correlationId: string;
  }): Promise<OperationState> {
    const table = this.table('runtime_operations');
    const inserted = await this.sql`
      insert into ${table}
        (environment, product_id, account_id, credential_key_id, profile_version, route,
         operation_id, request_fingerprint, status, correlation_id)
      values
        (${input.environment}, ${input.productId}, ${input.accountId}, ${input.credentialKeyId},
         ${input.profileVersion}, ${input.route}, ${input.operationId}, ${input.requestFingerprint},
         'pending', ${input.correlationId}::uuid)
      on conflict (environment, product_id, account_id, route, operation_id) do nothing
      returning id::text, status, correlation_id::text, response_projection, provider_object_id
    `;
    const row = inserted[0] ?? (await this.sql`
      select id::text, status, correlation_id::text, response_projection,
             provider_object_id, request_fingerprint
      from ${table}
      where environment=${input.environment} and product_id=${input.productId}
        and account_id=${input.accountId} and route=${input.route} and operation_id=${input.operationId}
    `)[0];
    if (!row) throw new BillingRuntimeError('OPERATION_PERSIST_FAILED', 'Could not persist billing operation', 500, true);
    if ('request_fingerprint' in row && row.request_fingerprint !== input.requestFingerprint) {
      throw new BillingRuntimeError('IDEMPOTENCY_CONFLICT', 'Operation ID reused with different request', 409);
    }
    return {
      id: String(row.id),
      status: String(row.status),
      correlationId: String(row.correlation_id),
      responseProjection: (row.response_projection ?? null) as Record<string, unknown> | null,
      providerObjectId: row.provider_object_id ? String(row.provider_object_id) : null,
    };
  }

  async completeOperation(operationId: string, providerObjectId: string | null, response: JsonRecord): Promise<void> {
    const table = this.table('runtime_operations');
    await this.sql`
      update ${table}
      set status='completed', provider_object_id=${providerObjectId},
          response_projection=${this.sql.json(response)}, completed_at=now(), updated_at=now(), error_code=null
      where id=${operationId}::uuid
    `;
  }

  async failOperation(operationId: string, errorCode: string): Promise<void> {
    const table = this.table('runtime_operations');
    await this.sql`update ${table} set status='failed', error_code=${errorCode}, updated_at=now() where id=${operationId}::uuid`;
  }
  async reserveCustomer(input: {
    environment: BillingEnvironment;
    productId: string;
    accountId: string;
    profileVersion: number;
    reservationToken: string;
    leaseSeconds?: number;
  }): Promise<CustomerMapping> {
    const tableName = `${this.schemaPrefix}.runtime_provider_customers`;
    const leaseSeconds = input.leaseSeconds ?? 90;
    return this.sql.begin(async (tx) => {
      await tx.unsafe(
        `insert into ${tableName}
         (environment, product_id, account_id, profile_version, provider, state, reservation_token, reservation_expires_at)
         values ($1,$2,$3,$4,'stripe','reserved',$5,now()+($6 || ' seconds')::interval)
         on conflict (environment, product_id, account_id, provider) do nothing`,
        [input.environment, input.productId, input.accountId, input.profileVersion, input.reservationToken, String(leaseSeconds)],
      );
      let rows = await tx.unsafe(
        `select id::text, environment, product_id, account_id, profile_version, provider_customer_id,
                state, reservation_token, reservation_expires_at
         from ${tableName}
         where environment=$1 and product_id=$2 and account_id=$3 and provider='stripe'
         for update`,
        [input.environment, input.productId, input.accountId],
      );
      let row = rows[0];
      if (!row) throw new BillingRuntimeError('CUSTOMER_RESERVATION_FAILED', 'Customer reservation missing', 500, true);
      if (row.state === 'ready' && row.provider_customer_id) return this.mapCustomer(row);
      const expiresAt = row.reservation_expires_at ? new Date(String(row.reservation_expires_at)).getTime() : 0;
      if (row.reservation_token !== input.reservationToken && expiresAt > Date.now()) {
        throw new BillingRuntimeError('CUSTOMER_MAPPING_BUSY', 'Customer mapping is being created', 409, true);
      }
      if (row.reservation_token !== input.reservationToken) {
        rows = await tx.unsafe(
          `update ${tableName}
           set reservation_token=$4, reservation_expires_at=now()+($5 || ' seconds')::interval,
               profile_version=$6, updated_at=now()
           where environment=$1 and product_id=$2 and account_id=$3 and provider='stripe'
           returning id::text, environment, product_id, account_id, profile_version,
                     provider_customer_id, state, reservation_token`,
          [input.environment, input.productId, input.accountId, input.reservationToken, String(leaseSeconds), input.profileVersion],
        );
        row = rows[0];
      }
      return this.mapCustomer(row);
    });
  }

  private mapCustomer(row: Record<string, unknown>): CustomerMapping {
    return {
      id: String(row.id),
      environment: String(row.environment) as BillingEnvironment,
      productId: String(row.product_id),
      accountId: String(row.account_id),
      profileVersion: Number(row.profile_version),
      providerCustomerId: row.provider_customer_id ? String(row.provider_customer_id) : null,
      state: String(row.state) as 'reserved' | 'ready',
      reservationToken: row.reservation_token ? String(row.reservation_token) : null,
    };
  }

  async completeCustomerReservation(mappingId: string, reservationToken: string, providerCustomerId: string): Promise<void> {
    const table = this.table('runtime_provider_customers');
    const rows = await this.sql`
      update ${table}
      set provider_customer_id=${providerCustomerId}, state='ready', reservation_token=null,
          reservation_expires_at=null, updated_at=now()
      where id=${mappingId}::uuid and reservation_token=${reservationToken}
      returning id
    `;
    if (rows.length !== 1) {
      throw new BillingRuntimeError('CUSTOMER_RESERVATION_LOST', 'Customer reservation ownership was lost', 409, true);
    }
  }
  async getCustomerByAccount(environment: BillingEnvironment, productId: string, accountId: string): Promise<CustomerMapping | null> {
    const table = this.table('runtime_provider_customers');
    const rows = await this.sql`
      select id::text, environment, product_id, account_id, profile_version,
             provider_customer_id, state, reservation_token
      from ${table}
      where environment=${environment} and product_id=${productId} and account_id=${accountId}
        and provider='stripe' and state='ready'
    `;
    return rows[0] ? this.mapCustomer(rows[0]) : null;
  }

  async getCustomerByProviderId(providerCustomerId: string): Promise<CustomerMapping | null> {
    const table = this.table('runtime_provider_customers');
    const rows = await this.sql`
      select id::text, environment, product_id, account_id, profile_version,
             provider_customer_id, state, reservation_token
      from ${table}
      where provider='stripe' and provider_customer_id=${providerCustomerId} and state='ready'
    `;
    return rows[0] ? this.mapCustomer(rows[0]) : null;
  }

  async audit(input: {
    correlationId: string;
    eventName: string;
    outcome: string;
    environment?: BillingEnvironment | null;
    productId?: string | null;
    accountId?: string | null;
    providerObjectId?: string | null;
    providerEventId?: string | null;
    details?: JsonRecord;
  }): Promise<void> {
    const table = this.table('runtime_audit_events');
    await this.sql`
      insert into ${table}
        (correlation_id, event_name, outcome, environment, product_id, account_id,
         provider_object_id, provider_event_id, details)
      values
        (${input.correlationId}::uuid, ${input.eventName}, ${input.outcome},
         ${input.environment ?? null}, ${input.productId ?? null}, ${input.accountId ?? null},
         ${input.providerObjectId ?? null}, ${input.providerEventId ?? null},
         ${this.sql.json(input.details ?? {})})
    `;
  }

  async claimWebhookEvent(input: {
    providerEventId: string;
    eventType: string;
    livemode: boolean;
    providerObjectId: string | null;
    providerCustomerId: string | null;
    hints: Record<string, unknown>;
    normalizedEnvelope: Record<string, unknown>;
    mapping: CustomerMapping | null;
    correlationId: string;
  }): Promise<{ duplicate: boolean; skipped: boolean; eventDbId: string }> {
    const eventTable = `${this.schemaPrefix}.runtime_provider_events`;
    const outboxTable = `${this.schemaPrefix}.runtime_outbox_jobs`;
    return this.sql.begin(async (tx) => {
      const inserted = await tx.unsafe(
        `insert into ${eventTable}
          (provider, provider_event_id, event_type, livemode, environment, product_id, account_id,
           profile_version, provider_object_id, provider_customer_id, hint_envelope,
           normalized_envelope, status, correlation_id)
         values ('stripe',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13::uuid)
         on conflict (provider, provider_event_id) do nothing
         returning id::text`,
        [input.providerEventId, input.eventType, input.livemode,
         input.mapping?.environment ?? null, input.mapping?.productId ?? null,
         input.mapping?.accountId ?? null, input.mapping?.profileVersion ?? null,
         input.providerObjectId, input.providerCustomerId, tx.json(input.hints as unknown as JsonRecord),
         tx.json(input.normalizedEnvelope as unknown as JsonRecord), input.mapping ? 'pending' : 'skipped', input.correlationId],
      );
      const duplicate = inserted.length === 0;
      const eventRow = inserted[0] ?? (await tx.unsafe(
        `select id::text, status, environment, product_id, account_id, profile_version
         from ${eventTable} where provider='stripe' and provider_event_id=$1`, [input.providerEventId],
      ))[0];
      if (!eventRow) throw new BillingRuntimeError('WEBHOOK_CLAIM_FAILED', 'Webhook claim could not be persisted', 500, true);
      const skipped = String(eventRow.status) === 'skipped' || !input.mapping;
      if (!skipped) {
        const dedupeKey = `stripe:${input.providerEventId}:reconcile`;
        await tx.unsafe(
          `insert into ${outboxTable} as existing_job
            (provider_event_id, environment, product_id, account_id, profile_version, job_type,
             payload, status, dedupe_key, correlation_id)
           values ($1::uuid,$2,$3,$4,$5,'reconcile',$6::jsonb,'pending',$7,$8::uuid)
           on conflict (dedupe_key) do update set ${OUTBOX_LEASE_PRESERVING_CONFLICT_SET}`,
          [eventRow.id, input.mapping!.environment, input.mapping!.productId, input.mapping!.accountId,
           input.mapping!.profileVersion, tx.json({ providerEventId: input.providerEventId,
             providerObjectId: input.providerObjectId, providerCustomerId: input.providerCustomerId }),
           dedupeKey, input.correlationId],
        );
      }
      return { duplicate, skipped, eventDbId: String(eventRow.id) };
    });
  }

  async leaseNextJob(workerId: string, leaseSeconds = 60): Promise<OutboxJob | null> {
    const tableName = `${this.schemaPrefix}.runtime_outbox_jobs`;
    return this.sql.begin(async (tx) => {
      const rows = await tx.unsafe(
        `with candidate as (
           select id from ${tableName}
           where next_attempt_at <= now()
             and (status in ('pending','failed') or (status='processing' and lease_expires_at < now()))
           order by created_at, id
           for update skip locked
           limit 1
         )
         update ${tableName} j
         set status='processing', attempt_count=j.attempt_count+1, lease_owner=$1,
             lease_expires_at=now()+($2 || ' seconds')::interval, last_attempt_at=now(), updated_at=now()
         from candidate where j.id=candidate.id
         returning j.id::text, j.provider_event_id::text, j.environment, j.product_id, j.account_id,
                   j.profile_version, j.job_type, j.payload, j.attempt_count, j.max_attempts,
                   j.correlation_id::text`,
        [workerId, String(leaseSeconds)],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        id: String(row.id),
        providerEventDbId: row.provider_event_id ? String(row.provider_event_id) : null,
        environment: String(row.environment) as BillingEnvironment,
        productId: String(row.product_id),
        accountId: String(row.account_id),
        profileVersion: Number(row.profile_version),
        jobType: String(row.job_type) as OutboxJob['jobType'],
        payload: (row.payload ?? {}) as Record<string, unknown>,
        attemptCount: Number(row.attempt_count),
        maxAttempts: Number(row.max_attempts),
        correlationId: String(row.correlation_id),
      };
    });
  }

  async completeJob(jobId: string): Promise<void> {
    const table = this.table('runtime_outbox_jobs');
    await this.sql`
      update ${table}
      set status='completed', lease_owner=null, lease_expires_at=null,
          completed_at=now(), updated_at=now(), last_error_code=null
      where id=${jobId}::uuid
    `;
  }

  async failJob(job: OutboxJob, errorCode: string): Promise<'failed' | 'dead_letter'> {
    const table = this.table('runtime_outbox_jobs');
    const terminal = job.attemptCount >= job.maxAttempts;
    const status = terminal ? 'dead_letter' : 'failed';
    const delaySeconds = Math.min(300, Math.max(2, 2 ** Math.min(job.attemptCount, 8)));
    await this.sql`
      update ${table}
      set status=${status}, lease_owner=null, lease_expires_at=null,
          next_attempt_at=now()+(${delaySeconds} || ' seconds')::interval,
          last_error_code=${errorCode}, updated_at=now()
      where id=${job.id}::uuid
    `;
    return status;
  }

  async markProviderEventComplete(eventDbId: string): Promise<void> {
    const table = this.table('runtime_provider_events');
    await this.sql`
      update ${table}
      set status='completed', completed_at=now(), last_error_code=null
      where id=${eventDbId}::uuid
    `;
  }

  async markProviderEventError(eventDbId: string, errorCode: string): Promise<void> {
    const table = this.table('runtime_provider_events');
    await this.sql`update ${table} set status='failed', last_error_code=${errorCode} where id=${eventDbId}::uuid`;
  }

  async enqueueReconciliation(input: {
    environment: BillingEnvironment; productId: string; accountId: string; profileVersion: number;
    providerSubscriptionId: string; correlationId: string; reason: string;
  }): Promise<void> {
    const table = this.table('runtime_outbox_jobs');
    const dedupeKey = `reconcile:${input.environment}:${input.productId}:${input.accountId}:${input.providerSubscriptionId}:${input.reason}`;
    await this.sql`
      insert into ${table} as existing_job
        (environment, product_id, account_id, profile_version, job_type, payload, status, dedupe_key, correlation_id)
      values (${input.environment}, ${input.productId}, ${input.accountId}, ${input.profileVersion},
              'reconcile', ${this.sql.json({ providerObjectId: input.providerSubscriptionId, reason: input.reason })},
              'pending', ${dedupeKey}, ${input.correlationId}::uuid)
      on conflict (dedupe_key) do update set ${this.sql.unsafe(OUTBOX_LEASE_PRESERVING_CONFLICT_SET)}
    `;
  }

  async upsertReconciliation(input: {
    environment: BillingEnvironment;
    productId: string;
    accountId: string;
    profileVersion: number;
    planId: string;
    providerSubscriptionId: string;
    providerCustomerId: string;
    providerStatus: string;
    priceId: string;
    providerProductId: string | null;
    amountMinor: number | null;
    currency: string | null;
    currentPeriodStart: Date | null;
    currentPeriodEnd: Date | null;
    cancelAtPeriodEnd: boolean;
    snapshotHash: string;
    correlationId: string;
  }): Promise<ReconciliationState> {
    const tableName = `${this.schemaPrefix}.runtime_reconciliation_state`;
    return this.sql.begin(async (tx) => {
      const current = (await tx.unsafe(
        `select id::text, reconciliation_version, provider_status, snapshot_hash
         from ${tableName}
         where environment=$1 and product_id=$2 and account_id=$3 and provider_subscription_id=$4
         for update`,
        [input.environment, input.productId, input.accountId, input.providerSubscriptionId],
      ))[0];
      const changed = !current || String(current.snapshot_hash) !== input.snapshotHash;
      const nextVersion = current ? Number(current.reconciliation_version) + (changed ? 1 : 0) : 1;
      const rows = await tx.unsafe(
        `insert into ${tableName}
          (environment, product_id, account_id, profile_version, plan_id, provider_subscription_id,
           provider_customer_id, provider_status, price_id, provider_product_id, amount_minor, currency,
           current_period_start, current_period_end, cancel_at_period_end, snapshot_hash,
           reconciliation_version, correlation_id, reconciled_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::uuid,now())
         on conflict (environment, product_id, account_id, provider_subscription_id) do update set
           profile_version=excluded.profile_version, plan_id=excluded.plan_id,
           provider_customer_id=excluded.provider_customer_id, provider_status=excluded.provider_status,
           price_id=excluded.price_id, provider_product_id=excluded.provider_product_id,
           amount_minor=excluded.amount_minor, currency=excluded.currency,
           current_period_start=excluded.current_period_start, current_period_end=excluded.current_period_end,
           cancel_at_period_end=excluded.cancel_at_period_end, snapshot_hash=excluded.snapshot_hash,
           reconciliation_version=$17, correlation_id=excluded.correlation_id, reconciled_at=now()
         returning id::text, reconciliation_version, provider_status`,
        [input.environment, input.productId, input.accountId, input.profileVersion, input.planId,
         input.providerSubscriptionId, input.providerCustomerId, input.providerStatus, input.priceId,
         input.providerProductId, input.amountMinor, input.currency, input.currentPeriodStart,
         input.currentPeriodEnd, input.cancelAtPeriodEnd, input.snapshotHash, nextVersion, input.correlationId],
      );
      const row = rows[0];
      return {
        id: String(row.id),
        version: Number(row.reconciliation_version),
        changed,
        status: String(row.provider_status),
      };
    });
  }

  async getSubscriptionState(environment: BillingEnvironment, productId: string, accountId: string): Promise<Record<string, unknown> | null> {
    const table = this.table('runtime_reconciliation_state');
    const rows = await this.sql`
      select profile_version, plan_id, provider_subscription_id, provider_status,
             amount_minor, currency, current_period_start, current_period_end,
             cancel_at_period_end, reconciliation_version, reconciled_at
      from ${table}
      where environment=${environment} and product_id=${productId} and account_id=${accountId}
      order by reconciled_at desc limit 1
    `;
    return rows[0] ? { ...rows[0] } : null;
  }

  async getEntitlementProjection(environment: BillingEnvironment, productId: string, accountId: string): Promise<Record<string, unknown> | null> {
    const table = this.table('runtime_entitlement_test_sink');
    const rows = await this.sql`
      select profile_version, plan_id, transition_type, entitlement_keys,
             provider_subscription_id, latest_transition_version, applied_at
      from ${table}
      where environment=${environment} and product_id=${productId} and account_id=${accountId}
    `;
    return rows[0] ? { ...rows[0] } : null;
  }

  async createEntitlementTransition(input: {
    signed: SignedEntitlementTransition;
    providerEventDbId: string | null;
  }): Promise<{ transitionId: string; created: boolean }> {
    const transitionTable = `${this.schemaPrefix}.runtime_entitlement_transitions`;
    const outboxTable = `${this.schemaPrefix}.runtime_outbox_jobs`;
    const envelope = input.signed.envelope;
    return this.sql.begin(async (tx) => {
      const inserted = await tx.unsafe(
        `insert into ${transitionTable}
          (environment, product_id, account_id, profile_version, plan_id, transition_type,
           entitlement_keys, provider_subscription_id, transition_version, idempotency_key,
           signed_envelope, signature, status, correlation_id, issued_at)
         values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb,$12,'pending',$13::uuid,$14::timestamptz)
         on conflict (idempotency_key) do nothing returning id::text`,
        [envelope.environment, envelope.product_id, envelope.account_id, envelope.profile_version,
         envelope.plan_id, envelope.transition_type, tx.json(envelope.entitlement_keys),
         envelope.provider_subscription_id, envelope.transition_version, envelope.idempotency_key,
         tx.json(envelope as unknown as JsonRecord), input.signed.signature, envelope.correlation_id, envelope.issued_at],
      );
      const created = inserted.length === 1;
      const transitionId = created ? String(inserted[0].id) : String((await tx.unsafe(
        `select id::text from ${transitionTable} where idempotency_key=$1`, [envelope.idempotency_key],
      ))[0].id);
      const dedupeKey = `entitlement:${envelope.idempotency_key}`;
      await tx.unsafe(
        `insert into ${outboxTable}
          (provider_event_id, environment, product_id, account_id, profile_version, job_type,
           payload, status, dedupe_key, correlation_id)
         values ($1::uuid,$2,$3,$4,$5,'entitlement_test_sink',$6::jsonb,'pending',$7,$8::uuid)
         on conflict (dedupe_key) do nothing`,
        [input.providerEventDbId, envelope.environment, envelope.product_id, envelope.account_id,
         envelope.profile_version, tx.json({ transitionId, signed: input.signed } as unknown as JsonRecord), dedupeKey,
         envelope.correlation_id],
      );
      return { transitionId, created };
    });
  }

  async deliverEntitlementToTestSink(input: {
    transitionId: string;
    signed: SignedEntitlementTransition;
    providerEventDbId: string | null;
  }): Promise<boolean> {
    const sinkTable = `${this.schemaPrefix}.runtime_entitlement_test_sink`;
    const transitionTable = `${this.schemaPrefix}.runtime_entitlement_transitions`;
    const eventTable = `${this.schemaPrefix}.runtime_provider_events`;
    const envelope = input.signed.envelope;
    return this.sql.begin(async (tx) => {
      const existing = (await tx.unsafe(
        `select latest_transition_version from ${sinkTable}
         where environment=$1 and product_id=$2 and account_id=$3 for update`,
        [envelope.environment, envelope.product_id, envelope.account_id],
      ))[0];
      const previousVersion = existing ? Number(existing.latest_transition_version) : 0;
      const applied = envelope.transition_version > previousVersion;
      if (applied) {
        await tx.unsafe(
          `insert into ${sinkTable}
            (environment, product_id, account_id, profile_version, plan_id, transition_type,
             entitlement_keys, provider_subscription_id, latest_transition_version,
             signed_envelope, signature, applied_at)
           values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::jsonb,$11,now())
           on conflict (environment, product_id, account_id) do update set
             profile_version=excluded.profile_version, plan_id=excluded.plan_id,
             transition_type=excluded.transition_type, entitlement_keys=excluded.entitlement_keys,
             provider_subscription_id=excluded.provider_subscription_id,
             latest_transition_version=excluded.latest_transition_version,
             signed_envelope=excluded.signed_envelope, signature=excluded.signature, applied_at=now()
           where ${sinkTable}.latest_transition_version < excluded.latest_transition_version`,
          [envelope.environment, envelope.product_id, envelope.account_id, envelope.profile_version,
           envelope.plan_id, envelope.transition_type, tx.json(envelope.entitlement_keys),
           envelope.provider_subscription_id, envelope.transition_version, tx.json(envelope as unknown as JsonRecord),
           input.signed.signature],
        );
      }
      await tx.unsafe(
        `update ${transitionTable} set status='delivered', delivered_at=coalesce(delivered_at,now()) where id=$1::uuid`,
        [input.transitionId],
      );
      if (input.providerEventDbId) {
        await tx.unsafe(
          `update ${eventTable} set status='completed', completed_at=coalesce(completed_at,now()), last_error_code=null
           where id=$1::uuid`, [input.providerEventDbId],
        );
      }
      return applied;
    });
  }
}
