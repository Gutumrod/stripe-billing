import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { BillingDb } from '../dist/db.js';
import { signEntitlementTransition } from '../dist/security.js';
import {
  databaseUrl, requireDatabaseUrl, SCHEMA, PRODUCT_ID, makeVerify,
  deleteOutboxByCorrelation, deleteByAccount, BASE_SNAPSHOT, makeRegisteredRegistry,
  makeRuntime, seedReconcileJob, ensureCustomerMapping, sweepStaleLr2dFixtures, providerCustomerIdFor,
} from './helpers/lr2d-real-db-fixtures.mjs';
import {
  PRODUCT_PS01, PRODUCT_LK01, BASE_SNAPSHOT_PS01, BASE_SNAPSHOT_LK01,
  makeRegisteredRegistry as makeLr2eRegistry, makeProductRuntime as makeLr2eRuntime,
  ensureCustomerMapping as ensureLr2eCustomerMapping, seedReconcileJobFor,
  seedEntitlementDeliveryJobFor, sweepStaleLr2eFixtures, providerCustomerIdFor as providerCustomerIdForLr2e,
  ENTITLEMENT_KEY_PS01,
} from './helpers/lr2e-multiproduct-fixtures.mjs';

// SB01 LR-2D — real-PostgreSQL execution proofs for outbox durability, lease/concurrency safety,
// and provider-truth reconciliation rejection (dispatch §2 items 3, 4, 5, and 6). Prior LR-2C
// coverage proved the lease-conflict decision table only as a hand-mirrored pure function
// (tests/outbox-lease-conflict.test.mjs) and the shared SQL clause only as source text
// (tests/outbox-conflict-sql-qualification.test.mjs); nothing had ever EXECUTED
// claimWebhookEvent -> leaseNextJob -> failJob/completeJob, a genuine concurrent lease race, or
// the upsertReconciliation version path against the live catalog. This file runs the real
// statements against real PostgreSQL (BILLING_DATABASE_URL, billing_core_staging) and asserts
// observed row state. No provider API is touched here: reconcile rejection paths are proven with
// a minimal injected SnapshotAdapter (constructor injection point config.stripe exists in
// RuntimeConfig since Phase 2A), so these tests prove the runtime's decision logic, not the
// adapter's HTTP layer — the adapter's real re-fetch behavior is proven end-to-end by
// scripts/run-sb01-lr2d-reconcile-slice.mjs with real Stripe TEST objects.
//
// Credentials are read from the worker environment only; no secret value is printed or
// persisted; every row created here is deleted in finally blocks.

requireDatabaseUrl('the LR-2D real-Postgres outbox/reconcile tests');

const ACCOUNT = `lr2d_${crypto.randomUUID().slice(0, 8)}_acc`;
const ACCOUNT_WEBHOOK = `lr2d_crash_wh_${crypto.randomUUID().slice(0, 8)}_acc`;
const ACCOUNT_ENTITLEMENT = `lr2d_crash_ent_${crypto.randomUUID().slice(0, 8)}_acc`;

// SB01 LR-2E additions (appended below, after all existing LR-2D tests) reuse this file's
// existing "everything that leases from the shared outbox queue lives in one sequential file"
// protection rather than re-deriving it — see the comment immediately below. Account ids use a
// prefix distinct from both 'lr2d_' and the separate sb01-lr2e-isolation-real-db.test.mjs file's
// 'lr2eiso_' prefix so no sweep in any file can ever delete another file's fixture rows.
const LR2E_ACCOUNT_PREFIX = 'lr2equeue_';
const ACCOUNT_LR2E_GRANT_REVOKE = `${LR2E_ACCOUNT_PREFIX}grant_revoke_${crypto.randomUUID().slice(0, 8)}_acc`;
const ACCOUNT_LR2E_SCOPE_MISMATCH = `${LR2E_ACCOUNT_PREFIX}scope_mismatch_${crypto.randomUUID().slice(0, 8)}_acc`;

// The crash-window recovery tests (§2 item 7, bottom of this file) share this file rather than
// a separate one deliberately: `node --test` runs multiple test *files* concurrently by
// default, and leaseNextJob has no per-test scoping (by design — a real outbox worker drains
// the whole queue). Real execution proved that running the reconcile-queue tests in a second,
// concurrently-scheduled file races on the shared runtime_outbox_jobs table (one file's sweep /
// lease stealing the other's rows). All tests that touch the global outbox queue therefore live
// in this single file, which node:test runs sequentially within one worker.
before(async () => {
  const verify = makeVerify();
  const db = new BillingDb(databaseUrl, SCHEMA);
  try {
    await sweepStaleLr2dFixtures(verify);
    // Reconcile tests below need an existing `ready` customer mapping before processReconcileJob
    // will even consult the (SnapshotAdapter) provider re-fetch — see ensureCustomerMapping.
    // Each account gets its own provider_customer_id (unique constraint on that column).
    await ensureCustomerMapping(db, ACCOUNT, providerCustomerIdFor(ACCOUNT));
    await ensureCustomerMapping(db, ACCOUNT_WEBHOOK, providerCustomerIdFor(ACCOUNT_WEBHOOK));
    await ensureCustomerMapping(db, ACCOUNT_ENTITLEMENT, providerCustomerIdFor(ACCOUNT_ENTITLEMENT));
  } finally {
    await verify.end({ timeout: 5 });
    await db.close();
  }
});

after(async () => {
  const verify = makeVerify();
  try {
    await deleteByAccount(verify, 'runtime_provider_customers', [ACCOUNT, ACCOUNT_WEBHOOK, ACCOUNT_ENTITLEMENT]);
  } finally {
    await verify.end({ timeout: 5 });
  }
});

before(async () => {
  const verify = makeVerify();
  try {
    await sweepStaleLr2eFixtures(verify, LR2E_ACCOUNT_PREFIX);
  } finally {
    await verify.end({ timeout: 5 });
  }
});

after(async () => {
  const verify = makeVerify();
  const accounts = [ACCOUNT_LR2E_GRANT_REVOKE, ACCOUNT_LR2E_SCOPE_MISMATCH];
  try {
    for (const table of [
      'runtime_entitlement_test_sink', 'runtime_entitlement_transitions', 'runtime_outbox_jobs',
      'runtime_reconciliation_state', 'runtime_audit_events', 'runtime_provider_customers',
    ]) {
      await deleteByAccount(verify, table, accounts);
    }
  } finally {
    await verify.end({ timeout: 5 });
  }
});

// ---------------------------------------------------------------------------
// §2 item 4 — outbox enqueue -> lease -> complete, failure -> failed w/ backoff -> dead_letter,
// and the lease_owner/lease_expires_at invariant. All against the real catalog.
// ---------------------------------------------------------------------------
test('LR-2D outbox: enqueue -> lease stamps worker lease -> complete clears lease (real Postgres)', async () => {
  const db = new BillingDb(databaseUrl, SCHEMA);
  const verify = makeVerify();
  const correlationId = crypto.randomUUID();
  try {
    await db.enqueueReconciliation({
      environment: 'test', productId: PRODUCT_ID, accountId: ACCOUNT, profileVersion: 1,
      providerSubscriptionId: 'sub_outbox_happy', correlationId, reason: 'lr2d-outbox-happy',
    });

    const before = await verify`
      select status::text as status, lease_owner, lease_expires_at, attempt_count::int as attempts
      from ${verify(`${SCHEMA}.runtime_outbox_jobs`)}
      where correlation_id = ${correlationId}::uuid
    `;
    assert.equal(before.length, 1, 'exactly one row for the dedupe key');
    assert.equal(before[0].status, 'pending');
    assert.equal(before[0].lease_owner, null, 'pending rows carry no lease');
    assert.equal(before[0].lease_expires_at, null);

    const worker = `worker_lr2d_${crypto.randomUUID().slice(0, 6)}`;
    const job = await db.leaseNextJob(worker, 120);
    assert.ok(job, 'a job is available to lease');
    assert.equal(job.jobType, 'reconcile');
    assert.equal(job.payload.providerObjectId, 'sub_outbox_happy');

    const leased = await verify`
      select status::text as status, lease_owner, lease_expires_at, attempt_count::int as attempts
      from ${verify(`${SCHEMA}.runtime_outbox_jobs`)} where id = ${job.id}::uuid
    `;
    assert.equal(leased[0].status, 'processing');
    assert.equal(leased[0].lease_owner, worker, 'lease stamped with the leasing worker id');
    assert.ok(leased[0].lease_expires_at !== null, 'lease expiry stamped');
    assert.equal(leased[0].attempts, 1, 'lease increments attempt_count');

    const second = await db.leaseNextJob(`other_lr2d_${crypto.randomUUID().slice(0, 6)}`, 120);
    assert.ok(!second || second.id !== job.id, 'active lease prevents second lease of the same job');

    await db.completeJob(job.id);
    const done = await verify`
      select status::text as status, lease_owner, lease_expires_at, completed_at
      from ${verify(`${SCHEMA}.runtime_outbox_jobs`)} where id = ${job.id}::uuid
    `;
    assert.equal(done[0].status, 'completed');
    assert.equal(done[0].lease_owner, null, 'completed rows clear lease_owner');
    assert.equal(done[0].lease_expires_at, null, 'completed rows clear lease_expires_at');
    assert.ok(done[0].completed_at !== null, 'completed_at stamped');
  } finally {
    await deleteOutboxByCorrelation(verify, [correlationId]);
    await verify.end({ timeout: 5 });
    await db.close();
  }
});

test('LR-2D outbox: failJob sets failed with exponential backoff, then dead_letter at max_attempts (real Postgres)', async () => {
  const db = new BillingDb(databaseUrl, SCHEMA);
  const verify = makeVerify();
  const correlationId = crypto.randomUUID();
  try {
    await db.enqueueReconciliation({
      environment: 'test', productId: PRODUCT_ID, accountId: ACCOUNT, profileVersion: 1,
      providerSubscriptionId: 'sub_outbox_fail', correlationId, reason: 'lr2d-outbox-fail',
    });
    const [row] = await verify`
      select id::text as id, max_attempts::int as max_attempts
      from ${verify(`${SCHEMA}.runtime_outbox_jobs`)} where correlation_id = ${correlationId}::uuid
    `;

    let statuses = [];
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      const job = await db.leaseNextJob(`fail_worker_${attempt}`, 120);
      assert.ok(job, 'job is leasable (re-eligible after the fast-forward below, or on the first attempt)');
      assert.equal(job.id, row.id, 'the same job is re-leased');
      assert.equal(job.attemptCount, attempt, 'attempt_count increments per lease');
      const status = await db.failJob(job, 'RECONCILE_PRICE_MISMATCH');
      // Remaining delay is computed server-side (next_attempt_at - now(), both Postgres
      // timestamps) rather than comparing a DB timestamp against local Date.now(): the test
      // client and the database host do not share a clock, and the first real run against this
      // database measured a multi-second skew that made a client-side comparison flaky. This is
      // the real defect the local-clock version exposed, not a logic bug in failJob itself.
      const now = await verify`
        select status::text as status, last_error_code, lease_owner, lease_expires_at,
               next_attempt_at, extract(epoch from (next_attempt_at - now()))::float8 as remaining_seconds
        from ${verify(`${SCHEMA}.runtime_outbox_jobs`)} where id = ${row.id}::uuid
      `;
      statuses.push(now[0].status);
      const expected = attempt >= 12 ? 'dead_letter' : 'failed';
      assert.equal(status, expected, `attempt ${attempt}: failJob returns ${expected}`);
      assert.equal(now[0].status, expected);
      assert.equal(now[0].last_error_code, 'RECONCILE_PRICE_MISMATCH');
      assert.equal(now[0].lease_owner, null, 'failed/dead rows clear lease_owner (lease invariant)');
      assert.equal(now[0].lease_expires_at, null, 'failed/dead rows clear lease_expires_at (lease invariant)');
      if (attempt >= 12) {
        // failJob stamps next_attempt_at unconditionally (dead_letter included) — real execution
        // showed it is never nulled out. That's harmless, not a defect: leaseNextJob's WHERE
        // clause only matches status in ('pending','failed') (or an expired 'processing' lease);
        // 'dead_letter' is permanently excluded regardless of next_attempt_at. Prove the
        // meaningful invariant directly: even after fast-forwarding next_attempt_at into the
        // past, a dead_letter job is never leased again.
        await verify`
          update ${verify(`${SCHEMA}.runtime_outbox_jobs`)} set next_attempt_at = now() - interval '1 second'
          where id = ${row.id}::uuid
        `;
        const deadJob = await db.leaseNextJob('fail_worker_dead_letter_probe', 120);
        assert.equal(deadJob, null, 'dead_letter is terminal: never leasable again regardless of next_attempt_at');
        break;
      }
      const seconds = now[0].remaining_seconds;
      const expectedDelay = Math.min(300, Math.max(2, 2 ** Math.min(attempt, 8)));
      assert.ok(
        seconds >= expectedDelay - 1.5 && seconds <= expectedDelay + 3,
        `backoff for attempt ${attempt}: observed ~${seconds.toFixed(1)}s expected ~${expectedDelay}s`,
      );
      // Real defect this exposed: the original (never-executed) version of this test looped
      // straight into the next leaseNextJob call with no wait and no time-travel, which — now
      // that the clock-skew bug above is fixed — deterministically returns null, because the
      // row genuinely is not due again until next_attempt_at (real backoff gating proven here).
      // Actually sleeping through up to 300s of exponential backoff x12 attempts would make this
      // test take ~20+ minutes; instead prove eligibility is correctly gated (this assertion),
      // then fast-forward next_attempt_at to now() (a direct, test-only DB write — never done by
      // runtime code) to reach the next attempt without a real-time sleep.
      const notYetEligible = await db.leaseNextJob(`fail_worker_${attempt}_too_early`, 120);
      assert.equal(notYetEligible, null, `attempt ${attempt}: job must not be leasable before its backoff delay elapses`);
      await verify`
        update ${verify(`${SCHEMA}.runtime_outbox_jobs`)} set next_attempt_at = now() where id = ${row.id}::uuid
      `;
    }
    assert.equal(statuses[statuses.length - 1], 'dead_letter', 'terminal state reached at max_attempts');
  } finally {
    await deleteOutboxByCorrelation(verify, [correlationId]);
    await verify.end({ timeout: 5 });
    await db.close();
  }
});

test('LR-2D outbox: duplicate webhook claim after a completed reconcile does not re-enqueue (idempotency, real Postgres)', async () => {
  const db = new BillingDb(databaseUrl, SCHEMA);
  const verify = makeVerify();
  const providerEventId = `evt_lr2d_dupe_${crypto.randomUUID()}`;
  const correlationId = crypto.randomUUID();
  const mapping = { environment: 'test', productId: PRODUCT_ID, accountId: ACCOUNT, profileVersion: 1 };
  try {
    const first = await db.claimWebhookEvent({
      providerEventId, eventType: 'customer.subscription.created', livemode: false,
      providerObjectId: 'sub_lr2d_dupe', providerCustomerId: null, hints: { plan_id: 'founding-c2' },
      normalizedEnvelope: { provider: 'stripe', event_id: providerEventId }, mapping, correlationId,
    });
    assert.equal(first.duplicate, false);
    assert.equal(first.skipped, false);

    const [firstJob] = await verify`
      select id::text as id, status::text as status
      from ${verify(`${SCHEMA}.runtime_outbox_jobs`)} where provider_event_id = ${first.eventDbId}::uuid
    `;
    assert.equal(firstJob.status, 'pending');

    await db.leaseNextJob('lr2d_dupe_worker', 120);
    await db.completeJob(firstJob.id);

    const second = await db.claimWebhookEvent({
      providerEventId, eventType: 'customer.subscription.created', livemode: false,
      providerObjectId: 'sub_lr2d_dupe', providerCustomerId: null, hints: { plan_id: 'founding-c2' },
      normalizedEnvelope: { provider: 'stripe', event_id: providerEventId }, mapping,
      correlationId: crypto.randomUUID(),
    });
    assert.equal(second.duplicate, true, 'second delivery of the same provider_event_id is a duplicate');
    assert.equal(second.skipped, false);

    const events = await verify`
      select count(*)::int as n from ${verify(`${SCHEMA}.runtime_provider_events`)}
      where provider = 'stripe' and provider_event_id = ${providerEventId}
    `;
    assert.equal(events[0].n, 1, 'no second provider-event row');

    const jobs = await verify`
      select count(*)::int as n from ${verify(`${SCHEMA}.runtime_outbox_jobs`)}
      where provider_event_id = ${first.eventDbId}::uuid
    `;
    assert.equal(jobs[0].n, 1, 'no second reconcile job enqueued');

    const [kept] = await verify`
      select status::text as status from ${verify(`${SCHEMA}.runtime_outbox_jobs`)} where id = ${firstJob.id}::uuid
    `;
    assert.equal(kept.status, 'completed', 'duplicate delivery does not resurrect a completed job');
  } finally {
    await deleteOutboxByCorrelation(verify, [correlationId]);
    await verify`delete from ${verify(`${SCHEMA}.runtime_provider_events`)} where provider_event_id = ${providerEventId}`;
    await verify.end({ timeout: 5 });
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// §2 item 5 — lease/concurrency safety: a genuine concurrent lease race (two independent
// Postgres connections issuing leaseNextJob at the same time), not a sequential simulation.
// `for update skip locked` must hand the single pending job to exactly one of them.
// ---------------------------------------------------------------------------
test('LR-2D outbox: two concurrent lease attempts on the same pending job — only one wins (real Postgres, real concurrency)', async () => {
  const seed = new BillingDb(databaseUrl, SCHEMA);
  const verify = makeVerify();
  const correlationId = crypto.randomUUID();
  const dbA = new BillingDb(databaseUrl, SCHEMA);
  const dbB = new BillingDb(databaseUrl, SCHEMA);
  try {
    await seed.enqueueReconciliation({
      environment: 'test', productId: PRODUCT_ID, accountId: ACCOUNT, profileVersion: 1,
      providerSubscriptionId: 'sub_outbox_concurrent', correlationId, reason: 'lr2d-outbox-concurrent',
    });
    const [row] = await verify`
      select id::text as id from ${verify(`${SCHEMA}.runtime_outbox_jobs`)}
      where correlation_id = ${correlationId}::uuid
    `;

    // Two separate BillingDb instances hold two separate backend connections; racing their
    // leaseNextJob calls via Promise.all is real concurrency, not a hand-simulated ordering.
    const [jobA, jobB] = await Promise.all([
      dbA.leaseNextJob('lr2d_concurrent_worker_a', 120),
      dbB.leaseNextJob('lr2d_concurrent_worker_b', 120),
    ]);
    const leased = [jobA, jobB].filter(Boolean);
    assert.equal(leased.length, 1, 'exactly one concurrent lease attempt wins the only pending job');
    assert.equal(leased[0].id, row.id);

    const rows = await verify`
      select status::text as status, lease_owner
      from ${verify(`${SCHEMA}.runtime_outbox_jobs`)} where id = ${row.id}::uuid
    `;
    assert.equal(rows[0].status, 'processing');
    assert.ok(
      rows[0].lease_owner === 'lr2d_concurrent_worker_a' || rows[0].lease_owner === 'lr2d_concurrent_worker_b',
      'the persisted lease_owner matches whichever worker actually won the race',
    );
  } finally {
    await deleteOutboxByCorrelation(verify, [correlationId]);
    await verify.end({ timeout: 5 });
    await seed.close();
    await dbA.close();
    await dbB.close();
  }
});

// ---------------------------------------------------------------------------
// §2 item 6 — provider truth only: caller/DB-supplied commercial state that disagrees with the
// provider must be rejected (real executed reconcile jobs, real catalog rows).
// ---------------------------------------------------------------------------
test('LR-2D reconcile: active matching provider snapshot grants + delivers v1 to test sink (real Postgres)', async () => {
  const db = new BillingDb(databaseUrl, SCHEMA);
  const verify = makeVerify();
  try {
    const registry = await makeRegisteredRegistry();
    const runtime = makeRuntime(BASE_SNAPSHOT(ACCOUNT), { registry });
    const jobRow = await seedReconcileJob(verify, ACCOUNT, 'sub_lr2d_grant_v1');
    // processOneJob leases the job itself; a manual db.leaseNextJob here first would consume
    // the only lease (real defect found by running this: it left processOneJob with nothing to
    // lease, observed outcome 'idle' instead of 'completed').
    const outcome = await runtime.processOneJob('lr2d_grant_worker');
    assert.equal(outcome, 'completed');

    const [recRow] = await verify`
      select reconciliation_version::int as version, provider_status::text as status, price_id, amount_minor::bigint as amount, currency
      from ${verify(`${SCHEMA}.runtime_reconciliation_state`)}
      where environment='test' and account_id = ${ACCOUNT} and provider_subscription_id='sub_lr2d_grant_v1'
    `;
    assert.equal(recRow.version, 1);
    assert.equal(recRow.status, 'active');

    // The reconcile job only creates the signed transition + its own delivery outbox job
    // (job_type='entitlement_test_sink'); it does not deliver inline. Real execution exposed
    // this: the original (never-executed) diagnostic version of this test asserted the sink row
    // after a single processOneJob call and would always have found no row. A second
    // processOneJob call drains that delivery job, exactly as a real worker loop would.
    const deliveryOutcome = await runtime.processOneJob('lr2d_grant_worker_delivery');
    assert.equal(deliveryOutcome, 'completed');

    const [sinkRow] = await verify`
      select plan_id, transition_type, entitlement_keys, latest_transition_version::int as version
      from ${verify(`${SCHEMA}.runtime_entitlement_test_sink`)}
      where environment='test' and account_id = ${ACCOUNT}
    `;
    assert.equal(sinkRow.plan_id, 'founding-c2');
    assert.equal(sinkRow.transition_type, 'grant');
    assert.deepEqual(sinkRow.entitlement_keys, ['commercial_access']);
    assert.equal(sinkRow.version, 1);
  } finally {
    await deleteByAccount(verify, 'runtime_entitlement_test_sink', [ACCOUNT]);
    await deleteByAccount(verify, 'runtime_entitlement_transitions', [ACCOUNT]);
    await deleteByAccount(verify, 'runtime_outbox_jobs', [ACCOUNT]);
    await deleteByAccount(verify, 'runtime_reconciliation_state', [ACCOUNT]);
    await deleteByAccount(verify, 'runtime_audit_events', [ACCOUNT]);
    await verify.end({ timeout: 5 });
    await db.close();
  }
});

test('LR-2D reconcile: DB-supplied commercial state that disagrees with provider truth is overwritten, never merged (real Postgres)', async () => {
  const db = new BillingDb(databaseUrl, SCHEMA);
  const verify = makeVerify();
  try {
    const registry = await makeRegisteredRegistry();
    const runtime = makeRuntime(BASE_SNAPSHOT(ACCOUNT), { registry });
    await seedReconcileJob(verify, ACCOUNT, 'sub_lr2d_grant_v1');
    await verify`
      insert into ${verify(`${SCHEMA}.runtime_reconciliation_state`)}
        (environment, product_id, account_id, profile_version, plan_id, provider_subscription_id,
         provider_customer_id, provider_status, price_id, provider_product_id, amount_minor, currency,
         current_period_start, current_period_end, cancel_at_period_end, snapshot_hash,
         reconciliation_version, correlation_id, reconciled_at)
      values ('test', ${PRODUCT_ID}, ${ACCOUNT}, 1, 'plan-spoofed', 'sub_other_stale',
              ${providerCustomerIdFor(ACCOUNT)}, 'canceled', 'price_spoofed', 'prod_spoofed', 500, 'USD',
              null, null, false, ${'f'.repeat(64)}, 99, ${crypto.randomUUID()}::uuid, now())
    `;
    const outcome = await runtime.processOneJob('lr2d_grant_worker');
    assert.equal(outcome, 'completed', 'reconcile completes by REFRESHING from provider truth');

    const [recRow] = await verify`
      select plan_id, provider_status::text as status, price_id, amount_minor::bigint as amount, currency
      from ${verify(`${SCHEMA}.runtime_reconciliation_state`)}
      where environment='test' and account_id = ${ACCOUNT} and provider_subscription_id='sub_lr2d_grant_v1'
    `;
    assert.equal(recRow.plan_id, 'founding-c2', 'plan refreshed from provider truth');
    assert.equal(recRow.status, 'active');
    assert.equal(recRow.price_id, 'price_1UDCxyHB4GRCffd9RyaDWZ1c', 'price refreshed from provider truth');
    // postgres.js returns bigint columns as strings (to avoid silent precision loss); Number()
    // it before comparing to the JS numeric literal.
    assert.equal(Number(recRow.amount), 99000, 'amount refreshed from provider truth');
    assert.equal(recRow.currency, 'THB', 'currency refreshed from provider truth');

    const stale = await verify`
      select count(*)::int as n from ${verify(`${SCHEMA}.runtime_reconciliation_state`)}
      where environment='test' and account_id = ${ACCOUNT} and provider_subscription_id='sub_other_stale'
    `;
    assert.equal(stale[0].n, 1, 'the stale row for the other subscription is untouched (scoped by subscription)');
  } finally {
    await deleteByAccount(verify, 'runtime_entitlement_test_sink', [ACCOUNT]);
    await deleteByAccount(verify, 'runtime_entitlement_transitions', [ACCOUNT]);
    await deleteByAccount(verify, 'runtime_outbox_jobs', [ACCOUNT]);
    await deleteByAccount(verify, 'runtime_reconciliation_state', [ACCOUNT]);
    await deleteByAccount(verify, 'runtime_audit_events', [ACCOUNT]);
    await verify.end({ timeout: 5 });
    await db.close();
  }
});

// Real execution corrected two premises the (never-executed) diagnostic version of this loop
// got wrong: (1) a bare status change (e.g. 'past_due') is not actually a rejected path in the
// current runtime — transitionTypeForStatus maps any status outside grant/revoke to a 'pending'
// transition and the job completes normally, so that case is not a "provider truth mismatch" at
// all and is dropped here; (2) each real mismatch produces its OWN specific error code from
// processReconcileJob's validation order (product -> amount -> currency -> period -> metadata),
// not a single shared RECONCILE_PRICE_MISMATCH — the loop now asserts the code each case
// actually, verifiably produces.
for (const [mismatchCase, snapshotPatch, expectedCode] of [
  ['amountMinor only', { amountMinor: 49900 }, 'RECONCILE_AMOUNT_MISMATCH'],
  ['priceId only', { priceId: 'price_spoofed_other_plan' }, 'RECONCILE_PRICE_MISMATCH'],
  ['currency only', { currency: 'USD' }, 'RECONCILE_CURRENCY_MISMATCH'],
  ['product only', { productId: 'prod_spoofed_000' }, 'RECONCILE_PRODUCT_MISMATCH'],
  ['metadata account_id', { metadata: { wstera_product_id: PRODUCT_ID, account_id: 'acc_spoofed', profile_version: '1', plan_id: 'founding-c2' } }, 'RECONCILE_PROVIDER_METADATA_MISMATCH'],
]) {
  test(`LR-2D reconcile rejects provider truth mismatch: ${mismatchCase} (real Postgres)`, async () => {
    const db = new BillingDb(databaseUrl, SCHEMA);
    const verify = makeVerify();
    try {
      const registry = await makeRegisteredRegistry();
      const snapshot = { ...BASE_SNAPSHOT(ACCOUNT), ...snapshotPatch };
      const runtime = makeRuntime(snapshot, { registry });
      const jobRow = await seedReconcileJob(verify, ACCOUNT, 'sub_lr2d_grant_v1');
      const outcome = await runtime.processOneJob('lr2d_reject_worker');

      assert.equal(outcome, 'failed', 'mismatched provider truth must not complete');
      const [recRow] = await verify`
        select count(*)::int as n from ${verify(`${SCHEMA}.runtime_reconciliation_state`)}
        where environment='test' and account_id = ${ACCOUNT} and provider_subscription_id='sub_lr2d_grant_v1'
      `;
      assert.equal(recRow.n, 0, 'no reconciliation state row written for a rejected snapshot');
      const [sinkRow] = await verify`
        select count(*)::int as n from ${verify(`${SCHEMA}.runtime_entitlement_test_sink`)}
        where environment='test' and account_id = ${ACCOUNT}
      `;
      assert.equal(sinkRow.n, 0, 'no entitlement delivered for a rejected snapshot');
      const [outboxRow] = await verify`
        select status::text as status, last_error_code
        from ${verify(`${SCHEMA}.runtime_outbox_jobs`)} where id = ${jobRow.id}::uuid
      `;
      assert.equal(outboxRow.status, 'failed');
      assert.equal(outboxRow.last_error_code, expectedCode);
    } finally {
      await deleteByAccount(verify, 'runtime_entitlement_test_sink', [ACCOUNT]);
      await deleteByAccount(verify, 'runtime_entitlement_transitions', [ACCOUNT]);
      await deleteByAccount(verify, 'runtime_outbox_jobs', [ACCOUNT]);
      await deleteByAccount(verify, 'runtime_reconciliation_state', [ACCOUNT]);
      await deleteByAccount(verify, 'runtime_audit_events', [ACCOUNT]);
      await verify.end({ timeout: 5 });
      await db.close();
    }
  });
}

test('LR-2D reconcile: unmapped provider snapshot is rejected as RECONCILE_ACCOUNT_MISMATCH (real Postgres)', async () => {
  const db = new BillingDb(databaseUrl, SCHEMA);
  const verify = makeVerify();
  try {
    const registry = await makeRegisteredRegistry();
    const runtime = makeRuntime({ ...BASE_SNAPSHOT(ACCOUNT), customerId: 'cus_lr2d_unmapped' }, { registry });
    const jobRow = await seedReconcileJob(verify, ACCOUNT, 'sub_lr2d_unmapped');
    const outcome = await runtime.processOneJob('lr2d_unmapped_worker');
    assert.equal(outcome, 'failed');
    const [outboxRow] = await verify`
      select status::text as status, last_error_code
      from ${verify(`${SCHEMA}.runtime_outbox_jobs`)} where id = ${jobRow.id}::uuid
    `;
    assert.equal(outboxRow.last_error_code, 'RECONCILE_ACCOUNT_MISMATCH');
    assert.equal(outboxRow.status, 'failed');
  } finally {
    await deleteByAccount(verify, 'runtime_entitlement_test_sink', [ACCOUNT]);
    await deleteByAccount(verify, 'runtime_entitlement_transitions', [ACCOUNT]);
    await deleteByAccount(verify, 'runtime_outbox_jobs', [ACCOUNT]);
    await deleteByAccount(verify, 'runtime_reconciliation_state', [ACCOUNT]);
    await deleteByAccount(verify, 'runtime_audit_events', [ACCOUNT]);
    await verify.end({ timeout: 5 });
    await db.close();
  }
});

test('LR-2D reconcile: same provider snapshot processed twice yields no second sink version (idempotency, real Postgres)', async () => {
  const db = new BillingDb(databaseUrl, SCHEMA);
  const verify = makeVerify();
  try {
    const registry = await makeRegisteredRegistry();
    const runtime = makeRuntime(BASE_SNAPSHOT(ACCOUNT), { registry });
    await seedReconcileJob(verify, ACCOUNT, 'sub_lr2d_grant_v1');
    const outcome1 = await runtime.processOneJob('lr2d_idem_worker_1');
    assert.equal(outcome1, 'completed');
    // Drain the delivery job the reconcile enqueued (see the "grants + delivers v1" test above
    // for why this second call is required).
    const delivery1 = await runtime.processOneJob('lr2d_idem_worker_1_delivery');
    assert.equal(delivery1, 'completed');
    const [sinkV1] = await verify`
      select latest_transition_version::int as version from ${verify(`${SCHEMA}.runtime_entitlement_test_sink`)}
      where environment='test' and account_id = ${ACCOUNT}
    `;
    assert.equal(sinkV1.version, 1);

    await seedReconcileJob(verify, ACCOUNT, 'sub_lr2d_grant_v1');
    const outcome2 = await runtime.processOneJob('lr2d_idem_worker_2');
    assert.equal(outcome2, 'completed', 'second reconcile of an unchanged snapshot completes');
    // Unchanged snapshot -> reconciliation.changed is false -> processReconcileJob takes the
    // markProviderEventComplete branch and enqueues no second delivery job, so there is nothing
    // further to drain here; the sink must therefore still read back at version 1.
    const [sinkV2] = await verify`
      select latest_transition_version::int as version from ${verify(`${SCHEMA}.runtime_entitlement_test_sink`)}
      where environment='test' and account_id = ${ACCOUNT}
    `;
    assert.equal(sinkV2.version, 1, 'unchanged snapshot does not produce a second sink version');
  } finally {
    await deleteByAccount(verify, 'runtime_entitlement_test_sink', [ACCOUNT]);
    await deleteByAccount(verify, 'runtime_entitlement_transitions', [ACCOUNT]);
    await deleteByAccount(verify, 'runtime_outbox_jobs', [ACCOUNT]);
    await deleteByAccount(verify, 'runtime_reconciliation_state', [ACCOUNT]);
    await deleteByAccount(verify, 'runtime_audit_events', [ACCOUNT]);
    await verify.end({ timeout: 5 });
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// §2 item 7 — crash-window recovery without double charge or corrupt state. Each test durably
// persists one stage, asserts the durable row exists with the *next* stage not yet applied
// (proving the write really happened before the next step could run), then builds a brand-new
// BillingDb/CentralBillingRuntime instance (simulating a fresh process after a crash/restart —
// no in-memory state carries over) and drives recovery from that persisted row alone.
// ---------------------------------------------------------------------------
test('LR-2D crash-window: webhook claim is durable before any processing — a fresh process recovers it (real Postgres)', async () => {
  const preCrashDb = new BillingDb(databaseUrl, SCHEMA);
  const verify = makeVerify();
  const providerEventId = `evt_lr2d_crash_${crypto.randomUUID()}`;
  const correlationId = crypto.randomUUID();
  const mapping = { environment: 'test', productId: PRODUCT_ID, accountId: ACCOUNT_WEBHOOK, profileVersion: 1 };
  try {
    // Stage 1 ("pre-crash" process): the webhook route only ever does this durable claim —
    // nothing downstream has run yet.
    const claim = await preCrashDb.claimWebhookEvent({
      providerEventId, eventType: 'customer.subscription.created', livemode: false,
      providerObjectId: 'sub_lr2d_crash_recover', providerCustomerId: null,
      hints: { plan_id: 'founding-c2' },
      normalizedEnvelope: { provider: 'stripe', event_id: providerEventId }, mapping, correlationId,
    });
    assert.equal(claim.duplicate, false);
    assert.equal(claim.skipped, false);

    // Prove the "crash": the durable rows exist, but nothing has processed them.
    const [eventRow] = await verify`
      select status::text as status from ${verify(`${SCHEMA}.runtime_provider_events`)}
      where id = ${claim.eventDbId}::uuid
    `;
    assert.equal(eventRow.status, 'pending', 'webhook event persisted before any processing occurred');
    const [jobRow] = await verify`
      select status::text as status from ${verify(`${SCHEMA}.runtime_outbox_jobs`)}
      where provider_event_id = ${claim.eventDbId}::uuid
    `;
    assert.equal(jobRow.status, 'pending', 'reconcile job persisted, still unprocessed at the crash point');
    const [sinkBefore] = await verify`
      select count(*)::int as n from ${verify(`${SCHEMA}.runtime_entitlement_test_sink`)}
      where account_id = ${ACCOUNT_WEBHOOK}
    `;
    assert.equal(sinkBefore.n, 0, 'no entitlement effect exists yet at the crash point');

    // Stage 2 ("process restart"): a brand-new BillingDb + CentralBillingRuntime instance, no
    // shared in-memory state with Stage 1, recovers purely from the durably persisted row.
    const registry = await makeRegisteredRegistry();
    const recoveredRuntime = makeRuntime(BASE_SNAPSHOT(ACCOUNT_WEBHOOK), { registry });
    const outcome = await recoveredRuntime.processOneJob('lr2d_crash_recovery_worker');
    assert.equal(outcome, 'completed', 'the recovered process completes the job the crashed process only persisted');
    // Reconcile only creates the transition + its own delivery job; drain that too.
    const deliveryOutcome = await recoveredRuntime.processOneJob('lr2d_crash_recovery_worker_delivery');
    assert.equal(deliveryOutcome, 'completed');

    const [recRow] = await verify`
      select reconciliation_version::int as version, provider_status::text as status
      from ${verify(`${SCHEMA}.runtime_reconciliation_state`)}
      where environment='test' and account_id = ${ACCOUNT_WEBHOOK} and provider_subscription_id='sub_lr2d_crash_recover'
    `;
    assert.equal(recRow.version, 1);
    assert.equal(recRow.status, 'active');
    const [sinkAfter] = await verify`
      select latest_transition_version::int as version from ${verify(`${SCHEMA}.runtime_entitlement_test_sink`)}
      where account_id = ${ACCOUNT_WEBHOOK}
    `;
    assert.equal(sinkAfter.version, 1, 'recovery produced exactly one entitlement transition, not zero and not a duplicate');
  } finally {
    await deleteByAccount(verify, 'runtime_entitlement_test_sink', [ACCOUNT_WEBHOOK]);
    await deleteByAccount(verify, 'runtime_entitlement_transitions', [ACCOUNT_WEBHOOK]);
    await deleteByAccount(verify, 'runtime_outbox_jobs', [ACCOUNT_WEBHOOK]);
    await deleteByAccount(verify, 'runtime_reconciliation_state', [ACCOUNT_WEBHOOK]);
    await deleteByAccount(verify, 'runtime_audit_events', [ACCOUNT_WEBHOOK]);
    await verify`delete from ${verify(`${SCHEMA}.runtime_provider_events`)} where provider_event_id = ${providerEventId}`;
    await verify.end({ timeout: 5 });
    await preCrashDb.close();
  }
});

test('LR-2D crash-window: entitlement transition is durable before sink delivery — recovers exactly once even under a forced re-delivery (real Postgres)', async () => {
  const verify = makeVerify();
  try {
    const registry = await makeRegisteredRegistry();

    // Stage 1 ("pre-crash" process): reconcile completes, which durably writes the signed
    // entitlement transition + its delivery outbox job in the SAME transaction
    // (createEntitlementTransition), but the crash happens before that job is ever leased.
    const preCrashRuntime = makeRuntime(BASE_SNAPSHOT(ACCOUNT_ENTITLEMENT), { registry });
    await seedReconcileJob(verify, ACCOUNT_ENTITLEMENT, 'sub_lr2d_crash_entitlement');
    const reconcileOutcome = await preCrashRuntime.processOneJob('lr2d_crash_reconcile_worker');
    assert.equal(reconcileOutcome, 'completed');

    const [transitionBefore] = await verify`
      select status::text as status, transition_version::int as version
      from ${verify(`${SCHEMA}.runtime_entitlement_transitions`)} where account_id = ${ACCOUNT_ENTITLEMENT}
    `;
    assert.equal(transitionBefore.status, 'pending', 'transition persisted, not yet delivered — this is the crash point');
    assert.equal(transitionBefore.version, 1);
    const [sinkBefore] = await verify`
      select count(*)::int as n from ${verify(`${SCHEMA}.runtime_entitlement_test_sink`)}
      where account_id = ${ACCOUNT_ENTITLEMENT}
    `;
    assert.equal(sinkBefore.n, 0, 'downstream sink has not been touched yet — delivery genuinely has not run');
    const [deliveryJob] = await verify`
      select status::text as status from ${verify(`${SCHEMA}.runtime_outbox_jobs`)}
      where account_id = ${ACCOUNT_ENTITLEMENT} and job_type = 'entitlement_test_sink'
    `;
    assert.equal(deliveryJob.status, 'pending', 'delivery job persisted and durable, awaiting a worker');

    // Stage 2 ("process restart"): brand-new runtime instance recovers delivery purely from
    // the durably persisted transition + outbox job.
    const recoveredRuntime = makeRuntime(BASE_SNAPSHOT(ACCOUNT_ENTITLEMENT), { registry });
    const deliveryOutcome = await recoveredRuntime.processOneJob('lr2d_crash_delivery_worker');
    assert.equal(deliveryOutcome, 'completed');
    const [sinkAfter] = await verify`
      select latest_transition_version::int as version from ${verify(`${SCHEMA}.runtime_entitlement_test_sink`)}
      where account_id = ${ACCOUNT_ENTITLEMENT}
    `;
    assert.equal(sinkAfter.version, 1, 'recovery delivered exactly once');
    const [transitionAfter] = await verify`
      select status::text as status from ${verify(`${SCHEMA}.runtime_entitlement_transitions`)}
      where account_id = ${ACCOUNT_ENTITLEMENT}
    `;
    assert.equal(transitionAfter.status, 'delivered');

    // Stage 3: force a redelivery attempt (e.g. an at-least-once retry that fires again after
    // the ack was lost) by resetting the job back to pending and re-processing it. No double
    // charge / no corrupt state: deliverEntitlementToTestSink's
    // `where latest_transition_version < excluded.latest_transition_version` guard must keep
    // the sink at version 1, not create a second transition version.
    await verify`
      update ${verify(`${SCHEMA}.runtime_outbox_jobs`)}
      set status='pending', completed_at=null, lease_owner=null, lease_expires_at=null, updated_at=now()
      where account_id = ${ACCOUNT_ENTITLEMENT} and job_type = 'entitlement_test_sink'
    `;
    const redeliveryOutcome = await recoveredRuntime.processOneJob('lr2d_crash_redelivery_worker');
    assert.equal(redeliveryOutcome, 'completed', 'a forced redelivery still completes cleanly (no crash, no error)');
    const [sinkFinal] = await verify`
      select latest_transition_version::int as version from ${verify(`${SCHEMA}.runtime_entitlement_test_sink`)}
      where account_id = ${ACCOUNT_ENTITLEMENT}
    `;
    assert.equal(sinkFinal.version, 1, 'forced redelivery of the same transition version does not double-apply');
  } finally {
    await deleteByAccount(verify, 'runtime_entitlement_test_sink', [ACCOUNT_ENTITLEMENT]);
    await deleteByAccount(verify, 'runtime_entitlement_transitions', [ACCOUNT_ENTITLEMENT]);
    await deleteByAccount(verify, 'runtime_outbox_jobs', [ACCOUNT_ENTITLEMENT]);
    await deleteByAccount(verify, 'runtime_reconciliation_state', [ACCOUNT_ENTITLEMENT]);
    await deleteByAccount(verify, 'runtime_audit_events', [ACCOUNT_ENTITLEMENT]);
    await verify.end({ timeout: 5 });
  }
});

// ---------------------------------------------------------------------------
// SB01 LR-2E additions (appended, not interleaved, per this file's own top-of-file convention —
// see the LR2E_ACCOUNT_PREFIX comment above). These cover the two outbox/lease-scoped LR-2E
// objectives that tests/sb01-lr2e-isolation-real-db.test.mjs deliberately does not own, because it
// never leases from the shared queue: per-product grant/revoke monotonicity through the REAL
// outbox queue (processOneJob, not a hand-called db method), and cross-product job-scope
// rejection of ENTITLEMENT_JOB_SCOPE_MISMATCH via a real leased outbox row.
// ---------------------------------------------------------------------------
test('LR-2E outbox: per-product grant then revoke reaches the entitlement sink through the real leased queue, independently for PS01 and LK01 (real Postgres)', async () => {
  const db = new BillingDb(databaseUrl, SCHEMA);
  const verify = makeVerify();
  const ps01SubId = `sub_${LR2E_ACCOUNT_PREFIX}ps01_gr`;
  const lk01SubId = `sub_${LR2E_ACCOUNT_PREFIX}lk01_gr`;
  try {
    const registry = await makeLr2eRegistry();
    await ensureLr2eCustomerMapping(db, PRODUCT_PS01, ACCOUNT_LR2E_GRANT_REVOKE, providerCustomerIdForLr2e('ps01', ACCOUNT_LR2E_GRANT_REVOKE));
    await ensureLr2eCustomerMapping(db, PRODUCT_LK01, ACCOUNT_LR2E_GRANT_REVOKE, providerCustomerIdForLr2e('lk01', ACCOUNT_LR2E_GRANT_REVOKE));

    // PS01: grant via a real leased reconcile job, then drain its delivery job.
    const ps01GrantRuntime = makeLr2eRuntime(BASE_SNAPSHOT_PS01(ACCOUNT_LR2E_GRANT_REVOKE), registry);
    await seedReconcileJobFor(verify, PRODUCT_PS01, ACCOUNT_LR2E_GRANT_REVOKE, ps01SubId, 'lr2e-queue-ps01-grant');
    assert.equal(await ps01GrantRuntime.processOneJob('lr2e_gr_ps01_reconcile'), 'completed');
    assert.equal(await ps01GrantRuntime.processOneJob('lr2e_gr_ps01_delivery'), 'completed');

    // LK01: grant via its own real leased reconcile job, same shared account_id, own subscription id.
    const lk01GrantRuntime = makeLr2eRuntime(BASE_SNAPSHOT_LK01(ACCOUNT_LR2E_GRANT_REVOKE), registry);
    await seedReconcileJobFor(verify, PRODUCT_LK01, ACCOUNT_LR2E_GRANT_REVOKE, lk01SubId, 'lr2e-queue-lk01-grant');
    assert.equal(await lk01GrantRuntime.processOneJob('lr2e_gr_lk01_reconcile'), 'completed');
    assert.equal(await lk01GrantRuntime.processOneJob('lr2e_gr_lk01_delivery'), 'completed');

    const afterGrants = await verify`
      select product_id::text as product_id, plan_id, transition_type::text as transition_type,
             entitlement_keys, latest_transition_version::int as version
      from ${verify(`${SCHEMA}.runtime_entitlement_test_sink`)} where account_id = ${ACCOUNT_LR2E_GRANT_REVOKE}
      order by product_id
    `;
    assert.equal(afterGrants.length, 2, 'both products landed an independent grant in the real sink');
    const ps01Grant = afterGrants.find((r) => r.product_id === PRODUCT_PS01);
    const lk01Grant = afterGrants.find((r) => r.product_id === PRODUCT_LK01);
    assert.equal(ps01Grant.transition_type, 'grant');
    assert.equal(ps01Grant.version, 1);
    assert.deepEqual(ps01Grant.entitlement_keys, ['commercial_access']);
    assert.equal(lk01Grant.transition_type, 'grant');
    assert.equal(lk01Grant.version, 1);
    assert.deepEqual(lk01Grant.entitlement_keys, ['links.pro']);

    // Revoke PS01 only (real leased reconcile of a canceled snapshot, same subscription id ->
    // upsertReconciliation advances the SAME row to version 2) and prove LK01 is untouched.
    const ps01RevokeRuntime = makeLr2eRuntime({ ...BASE_SNAPSHOT_PS01(ACCOUNT_LR2E_GRANT_REVOKE), status: 'canceled' }, registry);
    await seedReconcileJobFor(verify, PRODUCT_PS01, ACCOUNT_LR2E_GRANT_REVOKE, ps01SubId, 'lr2e-queue-ps01-revoke');
    assert.equal(await ps01RevokeRuntime.processOneJob('lr2e_gr_ps01_revoke_reconcile'), 'completed');
    assert.equal(await ps01RevokeRuntime.processOneJob('lr2e_gr_ps01_revoke_delivery'), 'completed');

    const afterRevoke = await verify`
      select product_id::text as product_id, transition_type::text as transition_type,
             entitlement_keys, latest_transition_version::int as version
      from ${verify(`${SCHEMA}.runtime_entitlement_test_sink`)} where account_id = ${ACCOUNT_LR2E_GRANT_REVOKE}
      order by product_id
    `;
    const ps01Revoked = afterRevoke.find((r) => r.product_id === PRODUCT_PS01);
    const lk01Untouched = afterRevoke.find((r) => r.product_id === PRODUCT_LK01);
    assert.equal(ps01Revoked.transition_type, 'revoke');
    assert.equal(ps01Revoked.version, 2, 'PS01 monotonically advanced to v2 (revoke) through the real queue');
    assert.deepEqual(ps01Revoked.entitlement_keys, []);
    assert.equal(lk01Untouched.transition_type, 'grant', 'LK01 sink untouched by PS01\'s revoke');
    assert.equal(lk01Untouched.version, 1, 'LK01 version did not advance');
  } finally {
    await verify.end({ timeout: 5 });
    await db.close();
  }
});

test('LR-2E outbox: an entitlement delivery job whose outbox row claims a different product than its signed envelope fails closed as ENTITLEMENT_JOB_SCOPE_MISMATCH (real Postgres, real leased job)', async () => {
  const db = new BillingDb(databaseUrl, SCHEMA);
  const verify = makeVerify();
  const providerSubscriptionId = `sub_${LR2E_ACCOUNT_PREFIX}scope_ps01`;
  try {
    const registry = await makeLr2eRegistry();
    // Deliberately NOT calling db.createEntitlementTransition here: real execution showed it
    // auto-enqueues its OWN correctly-scoped entitlement_test_sink job in the same transaction
    // (db.ts's createEntitlementTransition), which would win the FIFO lease ahead of the
    // deliberately mismatched job below and mask the scope check entirely. The
    // ENTITLEMENT_JOB_SCOPE_MISMATCH guard in processEntitlementJob runs before any transition-id
    // DB lookup (verify signature -> compare envelope.product_id/account_id to the job's own ->
    // throw), so a synthetic transitionId is sufficient to prove it fails closed.
    const now = Date.now();
    const envelope = {
      environment: 'test', product_id: PRODUCT_PS01, account_id: ACCOUNT_LR2E_SCOPE_MISMATCH,
      profile_version: 1, plan_id: 'founding-c2', transition_type: 'grant',
      entitlement_keys: ['commercial_access'], provider_subscription_id: providerSubscriptionId,
      correlation_id: crypto.randomUUID(), transition_version: 1,
      idempotency_key: `lr2e-scope-${crypto.randomUUID()}`,
      issued_at: new Date(now).toISOString(), expires_at: new Date(now + 120_000).toISOString(),
      signing_key_id: ENTITLEMENT_KEY_PS01.keyId,
    };
    const signed = await signEntitlementTransition(envelope, ENTITLEMENT_KEY_PS01);

    // The signed envelope is genuinely PS01's — but the outbox row claiming to deliver it is
    // enqueued under LK01. A real Stripe-account operator error, a compromised worker, or a
    // programming bug could produce this; processEntitlementJob must fail closed rather than
    // deliver PS01's entitlement under LK01's product scope.
    const mismatchedJob = await seedEntitlementDeliveryJobFor(verify, PRODUCT_LK01, ACCOUNT_LR2E_SCOPE_MISMATCH, crypto.randomUUID(), signed);

    const runtime = makeLr2eRuntime(BASE_SNAPSHOT_PS01(ACCOUNT_LR2E_SCOPE_MISMATCH), registry);
    const outcome = await runtime.processOneJob('lr2e_scope_mismatch_worker');
    assert.equal(outcome, 'failed', 'a cross-product job/envelope scope mismatch must not complete');

    const [jobRow] = await verify`
      select status::text as status, last_error_code
      from ${verify(`${SCHEMA}.runtime_outbox_jobs`)} where id = ${mismatchedJob.id}::uuid
    `;
    assert.equal(jobRow.status, 'failed');
    assert.equal(jobRow.last_error_code, 'ENTITLEMENT_JOB_SCOPE_MISMATCH');

    const [sinkRow] = await verify`
      select count(*)::int as n from ${verify(`${SCHEMA}.runtime_entitlement_test_sink`)}
      where account_id = ${ACCOUNT_LR2E_SCOPE_MISMATCH}
    `;
    assert.equal(sinkRow.n, 0, 'no entitlement was delivered under the mismatched product scope');
  } finally {
    await verify.end({ timeout: 5 });
    await db.close();
  }
});
