import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import {
  BillingDb, CentralBillingRuntime, createBillingHttpHandler, signAccountAssertion,
  signEntitlementTransition, verifyEntitlementTransition, BillingRuntimeError,
} from '../dist/index.js';
import {
  requireDatabaseUrl, SCHEMA, makeVerify, deleteByAccount, PRODUCT_PS01, PRODUCT_LK01,
  providerCustomerIdFor, makeRegisteredRegistry, ensureCustomerMapping, ensureReconciliationRow,
  ENTITLEMENT_KEY_PS01, ENTITLEMENT_KEY_LK01, sweepStaleLr2eFixtures, createEntitlementTransitionSinkOnly,
} from './helpers/lr2e-multiproduct-fixtures.mjs';

// SB01 LR-2E — real-PostgreSQL execution proofs that SB01 serves PS01 and LK01 with no
// cross-contamination (dispatch objective items 1, 3, 4). This file never calls
// processOneJob/leaseNextJob itself, so it never competes for a lease — but two other paths
// still insert real, leasable 'pending' rows into the SHARED outbox queue, and real concurrent
// execution proved a foreign file's leaseNextJob (FIFO, global, `for update skip locked`, not
// scoped by account/product) reliably steals one before this file's own cleanup can remove it:
// (1) db.enqueueReconciliation in the dedupe_key test below, retired by id the instant its
// dedupe_key has been read (see that test's own comment); (2) db.createEntitlementTransition's
// own auto-enqueued delivery job, used nowhere in this file (every test here delivers via
// db.deliverEntitlementToTestSink directly) — replaced everywhere with
// createEntitlementTransitionSinkOnly, which inserts the same transition row but the outbox row
// already 'completed', so it is never externally observable as leasable at all (a single retire
// call afterwards was tried first and still lost the race under real multi-file concurrency).
// The queue-leasing proofs (grant v1 -> revoke v2 per product, ENTITLEMENT_JOB_SCOPE_MISMATCH)
// are appended to tests/outbox-lease-reconcile-crash-window-real-db.test.mjs instead, which
// already owns that concurrency concern for the whole test suite (see that file's own
// top-of-file comment).
//
// Credentials are read from the worker environment only; no secret value is printed or persisted;
// every row created here is deleted in finally/after blocks.

requireDatabaseUrl('the LR-2E multi-product isolation real-Postgres tests');

function envelopeFor({ productId, accountId, transitionType, entitlementKeys, transitionVersion, planId, providerSubscriptionId, signingKeyId }) {
  const now = Date.now();
  return {
    environment: 'test',
    product_id: productId,
    account_id: accountId,
    profile_version: 1,
    plan_id: planId,
    transition_type: transitionType,
    entitlement_keys: entitlementKeys,
    provider_subscription_id: providerSubscriptionId,
    correlation_id: crypto.randomUUID(),
    transition_version: transitionVersion,
    idempotency_key: `lr2e-${crypto.randomUUID()}`,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + 120_000).toISOString(),
    signing_key_id: signingKeyId,
  };
}

async function startServer(runtime) {
  const handler = createBillingHttpHandler(runtime);
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async close() { await new Promise((resolve) => server.close(resolve)); },
  };
}

// Prefix unique to THIS file (not shared with the appended queue-leasing tests in
// outbox-lease-reconcile-crash-window-real-db.test.mjs) — see sweepStaleLr2eFixtures's comment
// for why the two files' sweeps must never share a prefix.
const ACCOUNT_PREFIX = 'lr2eiso_';
const ACCOUNT_MAPPING = `${ACCOUNT_PREFIX}mapping_${crypto.randomUUID().slice(0, 8)}_acc`;
const ACCOUNT_RECONCILE = `${ACCOUNT_PREFIX}reconcile_${crypto.randomUUID().slice(0, 8)}_acc`;
const ACCOUNT_ENTITLEMENT = `${ACCOUNT_PREFIX}entitlement_${crypto.randomUUID().slice(0, 8)}_acc`;
const ACCOUNT_STALE = `${ACCOUNT_PREFIX}stale_${crypto.randomUUID().slice(0, 8)}_acc`;
const ACCOUNT_ROUTES = `${ACCOUNT_PREFIX}routes_${crypto.randomUUID().slice(0, 8)}_acc`;
const ALL_ACCOUNTS = [ACCOUNT_MAPPING, ACCOUNT_RECONCILE, ACCOUNT_ENTITLEMENT, ACCOUNT_STALE, ACCOUNT_ROUTES];

before(async () => {
  const verify = makeVerify();
  try { await sweepStaleLr2eFixtures(verify, ACCOUNT_PREFIX); } finally { await verify.end({ timeout: 5 }); }
});

after(async () => {
  const verify = makeVerify();
  try {
    for (const table of [
      'runtime_entitlement_test_sink', 'runtime_entitlement_transitions', 'runtime_outbox_jobs',
      'runtime_reconciliation_state', 'runtime_audit_events', 'runtime_provider_customers',
      'runtime_operations',
    ]) {
      await deleteByAccount(verify, table, ALL_ACCOUNTS);
    }
    await verify`delete from ${verify(`${SCHEMA}.runtime_credential_bindings`)} where credential_key_id like 'lr2e-%'`;
  } finally {
    await verify.end({ timeout: 5 });
  }
});

// ---------------------------------------------------------------------------
// Objective item 3 — same account_id string across two products must not share DB-level state.
// ---------------------------------------------------------------------------
test('LR-2E: PS01 and LK01 do not share a provider customer mapping for the same account_id (real Postgres)', async () => {
  const db = new BillingDb(process.env.BILLING_DATABASE_URL, SCHEMA);
  const verify = makeVerify();
  try {
    const ps01CustomerId = providerCustomerIdFor('ps01', ACCOUNT_MAPPING);
    const lk01CustomerId = providerCustomerIdFor('lk01', ACCOUNT_MAPPING);
    await ensureCustomerMapping(db, PRODUCT_PS01, ACCOUNT_MAPPING, ps01CustomerId);
    await ensureCustomerMapping(db, PRODUCT_LK01, ACCOUNT_MAPPING, lk01CustomerId);

    const ps01Mapping = await db.getCustomerByAccount('test', PRODUCT_PS01, ACCOUNT_MAPPING);
    const lk01Mapping = await db.getCustomerByAccount('test', PRODUCT_LK01, ACCOUNT_MAPPING);
    assert.equal(ps01Mapping.providerCustomerId, ps01CustomerId);
    assert.equal(lk01Mapping.providerCustomerId, lk01CustomerId);
    assert.notEqual(ps01Mapping.providerCustomerId, lk01Mapping.providerCustomerId, 'each product gets its own provider customer id for the same account_id');

    const rows = await verify`
      select product_id::text as product_id, provider_customer_id
      from ${verify(`${SCHEMA}.runtime_provider_customers`)} where account_id = ${ACCOUNT_MAPPING}
      order by product_id
    `;
    assert.equal(rows.length, 2, 'exactly two independent mapping rows exist for the shared account_id');
    assert.deepEqual(new Set(rows.map((r) => r.product_id)), new Set([PRODUCT_PS01, PRODUCT_LK01]));

    const byProviderId = await db.getCustomerByProviderId(ps01CustomerId);
    assert.equal(byProviderId.productId, PRODUCT_PS01, 'reverse lookup by provider id resolves to the correct product, not the other one');
  } finally {
    await deleteByAccount(verify, 'runtime_provider_customers', [ACCOUNT_MAPPING]);
    await verify.end({ timeout: 5 });
    await db.close();
  }
});

test('LR-2E: PS01 and LK01 do not share an outbox dedupe_key for the same account_id + subscription-id literal, and keep independent reconciliation_state for the same account_id (real Postgres)', async () => {
  const db = new BillingDb(process.env.BILLING_DATABASE_URL, SCHEMA);
  const verify = makeVerify();
  const sharedSubId = 'sub_lr2e_shared_literal_001'; // deliberately the SAME literal for both products
  // runtime_reconciliation_state additionally carries UNIQUE (environment, provider_subscription_id)
  // — a real, deliberate schema invariant: SB01 backs every product from ONE Stripe account, so a
  // real Stripe subscription id can never legitimately repeat across products (unlike account_id,
  // which two products may share). The reconciliation_state half of this test therefore uses
  // per-product subscription ids while the outbox half above keeps proving the dedupe_key axis
  // with a genuinely shared literal (runtime_outbox_jobs carries no such global constraint).
  const ps01SubId = 'sub_lr2e_recon_ps01';
  const lk01SubId = 'sub_lr2e_recon_lk01';
  try {
    // runtime_reconciliation_state has an FK to runtime_provider_customers on
    // (environment, product_id, account_id, provider_customer_id) — establish both products'
    // mappings for this account before any upsertReconciliation call below.
    await ensureCustomerMapping(db, PRODUCT_PS01, ACCOUNT_RECONCILE, 'cus_lr2e_ps01_recon');
    await ensureCustomerMapping(db, PRODUCT_LK01, ACCOUNT_RECONCILE, 'cus_lr2e_lk01_recon');

    await db.enqueueReconciliation({
      environment: 'test', productId: PRODUCT_PS01, accountId: ACCOUNT_RECONCILE, profileVersion: 1,
      providerSubscriptionId: sharedSubId, correlationId: crypto.randomUUID(), reason: 'lr2e-shared-sub-ps01',
    });
    await db.enqueueReconciliation({
      environment: 'test', productId: PRODUCT_LK01, accountId: ACCOUNT_RECONCILE, profileVersion: 1,
      providerSubscriptionId: sharedSubId, correlationId: crypto.randomUUID(), reason: 'lr2e-shared-sub-lk01',
    });
    const jobs = await verify`
      select id::text as id, product_id::text as product_id, dedupe_key
      from ${verify(`${SCHEMA}.runtime_outbox_jobs`)}
      where account_id = ${ACCOUNT_RECONCILE} and (payload->>'providerObjectId') = ${sharedSubId}
      order by product_id
    `;
    assert.equal(jobs.length, 2, 'two independent outbox jobs exist for the same account+subscription literal across products');
    assert.notEqual(jobs[0].dedupe_key, jobs[1].dedupe_key, 'dedupe_key is product-scoped, not shared');
    // This file never leases from the shared queue (see the top-of-file comment), but a real
    // pending row IS leasable by ANY concurrently-running file's leaseNextJob (FIFO, global, not
    // scoped to this test) for as long as it sits in 'pending' — real concurrent execution proved
    // this exact race against tests/outbox-lease-reconcile-crash-window-real-db.test.mjs. Retire
    // these two rows by their own id (never a foreign row) the instant their dedupe_key has been
    // read, rather than leaving them leasable until this test's `finally` block runs.
    await verify`
      update ${verify(`${SCHEMA}.runtime_outbox_jobs`)} set status = 'completed', completed_at = now()
      where id = any(${jobs.map((j) => j.id)}::uuid[])
    `;

    const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
    await db.upsertReconciliation({
      environment: 'test', productId: PRODUCT_PS01, accountId: ACCOUNT_RECONCILE, profileVersion: 1,
      planId: 'founding-c2', providerSubscriptionId: ps01SubId, providerCustomerId: 'cus_lr2e_ps01_recon',
      providerStatus: 'active', priceId: 'price_ps01', providerProductId: 'prod_ps01', amountMinor: 99000,
      currency: 'THB', currentPeriodStart: null, currentPeriodEnd: null, cancelAtPeriodEnd: false,
      snapshotHash: hash('ps01-v1'), correlationId: crypto.randomUUID(),
    });
    await db.upsertReconciliation({
      environment: 'test', productId: PRODUCT_LK01, accountId: ACCOUNT_RECONCILE, profileVersion: 1,
      planId: 'pro', providerSubscriptionId: lk01SubId, providerCustomerId: 'cus_lr2e_lk01_recon',
      providerStatus: 'active', priceId: 'price_lk01', providerProductId: 'prod_lk01', amountMinor: 19900,
      currency: 'THB', currentPeriodStart: null, currentPeriodEnd: null, cancelAtPeriodEnd: false,
      snapshotHash: hash('lk01-v1'), correlationId: crypto.randomUUID(),
    });
    const recRows = await verify`
      select product_id::text as product_id, plan_id, amount_minor::int as amount, reconciliation_version::int as version
      from ${verify(`${SCHEMA}.runtime_reconciliation_state`)}
      where account_id = ${ACCOUNT_RECONCILE} and provider_subscription_id in (${ps01SubId}, ${lk01SubId})
      order by product_id
    `;
    assert.equal(recRows.length, 2, 'two independent reconciliation_state rows exist for the same account_id across products');
    const ps01Row = recRows.find((r) => r.product_id === PRODUCT_PS01);
    const lk01Row = recRows.find((r) => r.product_id === PRODUCT_LK01);
    assert.equal(ps01Row.plan_id, 'founding-c2');
    assert.equal(lk01Row.plan_id, 'pro');
    assert.equal(ps01Row.version, 1);
    assert.equal(lk01Row.version, 1);

    // Changing PS01's snapshot must not move LK01's version.
    await db.upsertReconciliation({
      environment: 'test', productId: PRODUCT_PS01, accountId: ACCOUNT_RECONCILE, profileVersion: 1,
      planId: 'founding-c2', providerSubscriptionId: ps01SubId, providerCustomerId: 'cus_lr2e_ps01_recon',
      providerStatus: 'canceled', priceId: 'price_ps01', providerProductId: 'prod_ps01', amountMinor: 99000,
      currency: 'THB', currentPeriodStart: null, currentPeriodEnd: null, cancelAtPeriodEnd: false,
      snapshotHash: hash('ps01-v2'), correlationId: crypto.randomUUID(),
    });
    const afterRows = await verify`
      select product_id::text as product_id, provider_status::text as status, reconciliation_version::int as version
      from ${verify(`${SCHEMA}.runtime_reconciliation_state`)}
      where account_id = ${ACCOUNT_RECONCILE} and provider_subscription_id in (${ps01SubId}, ${lk01SubId})
      order by product_id
    `;
    const ps01After = afterRows.find((r) => r.product_id === PRODUCT_PS01);
    const lk01After = afterRows.find((r) => r.product_id === PRODUCT_LK01);
    assert.equal(ps01After.status, 'canceled');
    assert.equal(ps01After.version, 2, 'PS01 row version advanced');
    assert.equal(lk01After.status, 'active', 'LK01 row untouched by PS01 mutation');
    assert.equal(lk01After.version, 1, 'LK01 row version did not advance');
  } finally {
    for (const table of ['runtime_outbox_jobs', 'runtime_reconciliation_state']) {
      await deleteByAccount(verify, table, [ACCOUNT_RECONCILE]);
    }
    await verify.end({ timeout: 5 });
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// Objective item 4 — entitlement transitions: signed/idempotent/monotonic through real Postgres,
// including the JSONB regression proof for db.ts's createEntitlementTransition /
// deliverEntitlementToTestSink (no dedicated real-DB coverage existed before this round — only
// fixed by parity with the LR-2C/LR-2D webhook-claim JSONB fix).
// ---------------------------------------------------------------------------
test('LR-2E: PS01 and LK01 entitlement transitions/sink rows for the same account_id are independent, and persist real jsonb (real Postgres)', async () => {
  const db = new BillingDb(process.env.BILLING_DATABASE_URL, SCHEMA);
  const verify = makeVerify();
  try {
    const ps01Envelope = envelopeFor({
      productId: PRODUCT_PS01, accountId: ACCOUNT_ENTITLEMENT, transitionType: 'grant',
      entitlementKeys: ['commercial_access'], transitionVersion: 1, planId: 'founding-c2',
      providerSubscriptionId: 'sub_lr2e_ent_ps01', signingKeyId: ENTITLEMENT_KEY_PS01.keyId,
    });
    const lk01Envelope = envelopeFor({
      productId: PRODUCT_LK01, accountId: ACCOUNT_ENTITLEMENT, transitionType: 'grant',
      entitlementKeys: ['links.pro'], transitionVersion: 1, planId: 'pro',
      providerSubscriptionId: 'sub_lr2e_ent_lk01', signingKeyId: ENTITLEMENT_KEY_LK01.keyId,
    });
    const ps01Signed = await signEntitlementTransition(ps01Envelope, ENTITLEMENT_KEY_PS01);
    const lk01Signed = await signEntitlementTransition(lk01Envelope, ENTITLEMENT_KEY_LK01);

    // Real signature verification against both configured keys must succeed for each product's
    // own signature (not just "some key matches").
    await verifyEntitlementTransition(ps01Signed, [ENTITLEMENT_KEY_PS01, ENTITLEMENT_KEY_LK01]);
    await verifyEntitlementTransition(lk01Signed, [ENTITLEMENT_KEY_PS01, ENTITLEMENT_KEY_LK01]);

    // runtime_entitlement_transitions has an FK to runtime_reconciliation_state on
    // (environment, product_id, account_id, provider_subscription_id) — seed a matching
    // provider-truth-shaped row for each product's subscription id first.
    await ensureReconciliationRow(db, { productId: PRODUCT_PS01, accountId: ACCOUNT_ENTITLEMENT, providerSubscriptionId: 'sub_lr2e_ent_ps01', planId: 'founding-c2', amountMinor: 99000, priceId: 'price_ps01_ent', providerProductId: 'prod_ps01_ent' });
    await ensureReconciliationRow(db, { productId: PRODUCT_LK01, accountId: ACCOUNT_ENTITLEMENT, providerSubscriptionId: 'sub_lr2e_ent_lk01', planId: 'pro', amountMinor: 19900, priceId: 'price_lk01_ent', providerProductId: 'prod_lk01_ent' });

    const { transitionId: ps01TransitionId } = await createEntitlementTransitionSinkOnly(verify, ps01Signed);
    const { transitionId: lk01TransitionId } = await createEntitlementTransitionSinkOnly(verify, lk01Signed);

    const transitionRows = await verify`
      select product_id::text as product_id, jsonb_typeof(entitlement_keys) as keys_type,
             jsonb_typeof(signed_envelope) as envelope_type, entitlement_keys
      from ${verify(`${SCHEMA}.runtime_entitlement_transitions`)} where account_id = ${ACCOUNT_ENTITLEMENT}
      order by product_id
    `;
    assert.equal(transitionRows.length, 2, 'two independent transition rows exist for the shared account_id');
    for (const row of transitionRows) {
      assert.equal(row.keys_type, 'array', 'entitlement_keys must persist as a real jsonb array, not a string scalar');
      assert.equal(row.envelope_type, 'object', 'signed_envelope must persist as a real jsonb object, not a string scalar');
    }

    const ps01Applied = await db.deliverEntitlementToTestSink({ transitionId: ps01TransitionId, signed: ps01Signed, providerEventDbId: null });
    const lk01Applied = await db.deliverEntitlementToTestSink({ transitionId: lk01TransitionId, signed: lk01Signed, providerEventDbId: null });
    assert.equal(ps01Applied, true);
    assert.equal(lk01Applied, true);

    const sinkRows = await verify`
      select product_id::text as product_id, plan_id, transition_type::text as transition_type,
             entitlement_keys, jsonb_typeof(entitlement_keys) as keys_type,
             jsonb_typeof(signed_envelope) as envelope_type, latest_transition_version::int as version
      from ${verify(`${SCHEMA}.runtime_entitlement_test_sink`)} where account_id = ${ACCOUNT_ENTITLEMENT}
      order by product_id
    `;
    assert.equal(sinkRows.length, 2, 'two independent sink rows exist for the shared account_id');
    const ps01Sink = sinkRows.find((r) => r.product_id === PRODUCT_PS01);
    const lk01Sink = sinkRows.find((r) => r.product_id === PRODUCT_LK01);
    assert.equal(ps01Sink.plan_id, 'founding-c2');
    assert.deepEqual(ps01Sink.entitlement_keys, ['commercial_access']);
    assert.equal(lk01Sink.plan_id, 'pro');
    assert.deepEqual(lk01Sink.entitlement_keys, ['links.pro']);
    for (const row of sinkRows) {
      assert.equal(row.keys_type, 'array');
      assert.equal(row.envelope_type, 'object');
    }

    // Revoking PS01 (v2) must not move LK01's sink version.
    const ps01Revoke = envelopeFor({
      productId: PRODUCT_PS01, accountId: ACCOUNT_ENTITLEMENT, transitionType: 'revoke',
      entitlementKeys: [], transitionVersion: 2, planId: 'founding-c2',
      providerSubscriptionId: 'sub_lr2e_ent_ps01', signingKeyId: ENTITLEMENT_KEY_PS01.keyId,
    });
    const ps01RevokeSigned = await signEntitlementTransition(ps01Revoke, ENTITLEMENT_KEY_PS01);
    const { transitionId: ps01RevokeId } = await createEntitlementTransitionSinkOnly(verify, ps01RevokeSigned);
    await db.deliverEntitlementToTestSink({ transitionId: ps01RevokeId, signed: ps01RevokeSigned, providerEventDbId: null });

    const afterRows = await verify`
      select product_id::text as product_id, transition_type::text as transition_type, latest_transition_version::int as version
      from ${verify(`${SCHEMA}.runtime_entitlement_test_sink`)} where account_id = ${ACCOUNT_ENTITLEMENT}
      order by product_id
    `;
    const ps01After = afterRows.find((r) => r.product_id === PRODUCT_PS01);
    const lk01After = afterRows.find((r) => r.product_id === PRODUCT_LK01);
    assert.equal(ps01After.transition_type, 'revoke');
    assert.equal(ps01After.version, 2, 'PS01 sink advanced to v2 (revoke)');
    assert.equal(lk01After.transition_type, 'grant');
    assert.equal(lk01After.version, 1, 'LK01 sink is untouched by PS01 revoke — no cross-contamination');
  } finally {
    for (const table of ['runtime_entitlement_test_sink', 'runtime_entitlement_transitions']) {
      await deleteByAccount(verify, table, [ACCOUNT_ENTITLEMENT]);
    }
    await verify.end({ timeout: 5 });
    await db.close();
  }
});

test('LR-2E: entitlement sink delivery is idempotent and rejects an out-of-order (lower) transition_version as stale (real Postgres)', async () => {
  const db = new BillingDb(process.env.BILLING_DATABASE_URL, SCHEMA);
  const verify = makeVerify();
  try {
    const v1 = envelopeFor({
      productId: PRODUCT_PS01, accountId: ACCOUNT_STALE, transitionType: 'grant',
      entitlementKeys: ['commercial_access'], transitionVersion: 1, planId: 'founding-c2',
      providerSubscriptionId: 'sub_lr2e_stale', signingKeyId: ENTITLEMENT_KEY_PS01.keyId,
    });
    const v2 = envelopeFor({
      productId: PRODUCT_PS01, accountId: ACCOUNT_STALE, transitionType: 'revoke',
      entitlementKeys: [], transitionVersion: 2, planId: 'founding-c2',
      providerSubscriptionId: 'sub_lr2e_stale', signingKeyId: ENTITLEMENT_KEY_PS01.keyId,
    });
    const v1Signed = await signEntitlementTransition(v1, ENTITLEMENT_KEY_PS01);
    const v2Signed = await signEntitlementTransition(v2, ENTITLEMENT_KEY_PS01);

    // Same FK requirement as the transitions/sink jsonb test above.
    await ensureReconciliationRow(db, { productId: PRODUCT_PS01, accountId: ACCOUNT_STALE, providerSubscriptionId: 'sub_lr2e_stale', planId: 'founding-c2', amountMinor: 99000, priceId: 'price_ps01_stale', providerProductId: 'prod_ps01_stale' });

    const { transitionId: v1Id } = await createEntitlementTransitionSinkOnly(verify, v1Signed);
    const { transitionId: v2Id } = await createEntitlementTransitionSinkOnly(verify, v2Signed);

    // Deliver v2 first (out-of-order arrival is realistic under at-least-once delivery).
    const v2Applied = await db.deliverEntitlementToTestSink({ transitionId: v2Id, signed: v2Signed, providerEventDbId: null });
    assert.equal(v2Applied, true);
    const afterV2 = await verify`
      select latest_transition_version::int as version, transition_type::text as transition_type
      from ${verify(`${SCHEMA}.runtime_entitlement_test_sink`)} where account_id = ${ACCOUNT_STALE} and product_id = ${PRODUCT_PS01}
    `;
    assert.equal(afterV2[0].version, 2);
    assert.equal(afterV2[0].transition_type, 'revoke');

    // The lower-versioned v1 arriving late (stale/out-of-order) must be rejected: applied=false,
    // sink stays at v2, real DB row unchanged.
    const v1AppliedLate = await db.deliverEntitlementToTestSink({ transitionId: v1Id, signed: v1Signed, providerEventDbId: null });
    assert.equal(v1AppliedLate, false, 'a lower transition_version than what is already applied must not apply');
    const afterStaleAttempt = await verify`
      select latest_transition_version::int as version, transition_type::text as transition_type
      from ${verify(`${SCHEMA}.runtime_entitlement_test_sink`)} where account_id = ${ACCOUNT_STALE} and product_id = ${PRODUCT_PS01}
    `;
    assert.equal(afterStaleAttempt[0].version, 2, 'sink version did not regress');
    assert.equal(afterStaleAttempt[0].transition_type, 'revoke', 'sink was not overwritten by the stale grant');

    // A duplicate/replayed delivery of the SAME (already-applied) v2 transition must not
    // double-apply either.
    const v2AppliedAgain = await db.deliverEntitlementToTestSink({ transitionId: v2Id, signed: v2Signed, providerEventDbId: null });
    assert.equal(v2AppliedAgain, false, 'a duplicate delivery of the currently-applied version must not re-apply');
    const afterDuplicate = await verify`
      select latest_transition_version::int as version from ${verify(`${SCHEMA}.runtime_entitlement_test_sink`)}
      where account_id = ${ACCOUNT_STALE} and product_id = ${PRODUCT_PS01}
    `;
    assert.equal(afterDuplicate[0].version, 2);
  } finally {
    for (const table of ['runtime_entitlement_test_sink', 'runtime_entitlement_transitions']) {
      await deleteByAccount(verify, table, [ACCOUNT_STALE]);
    }
    await verify.end({ timeout: 5 });
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// Objective item 4 (continued) — a tampered signed envelope and a wrong-product signing key must
// both be rejected. Pure security.ts real-crypto execution; no DB needed for the signature check
// itself (the fail-closed DB-side proof — ENTITLEMENT_JOB_SCOPE_MISMATCH via a real leased outbox
// job — lives in outbox-lease-reconcile-crash-window-real-db.test.mjs alongside the other
// queue-leasing tests).
// ---------------------------------------------------------------------------
test('LR-2E: a tampered signed entitlement envelope is rejected (real HMAC verification)', async () => {
  const envelope = envelopeFor({
    productId: PRODUCT_PS01, accountId: 'lr2e_tamper_probe_acc', transitionType: 'grant',
    entitlementKeys: ['commercial_access'], transitionVersion: 1, planId: 'founding-c2',
    providerSubscriptionId: 'sub_lr2e_tamper', signingKeyId: ENTITLEMENT_KEY_PS01.keyId,
  });
  const signed = await signEntitlementTransition(envelope, ENTITLEMENT_KEY_PS01);
  // Sanity: the untampered signature verifies.
  await verifyEntitlementTransition(signed, [ENTITLEMENT_KEY_PS01, ENTITLEMENT_KEY_LK01]);

  const tampered = { ...signed, envelope: { ...signed.envelope, entitlement_keys: ['commercial_access', 'stolen_key'] } };
  await assert.rejects(
    () => verifyEntitlementTransition(tampered, [ENTITLEMENT_KEY_PS01, ENTITLEMENT_KEY_LK01]),
    (error) => error instanceof BillingRuntimeError && error.code === 'ENTITLEMENT_SIGNATURE_INVALID',
    'a payload mutated after signing must fail HMAC verification, not silently pass',
  );
});

test('LR-2E: an entitlement transition signed with the wrong product\'s signing key is rejected (real HMAC verification)', async () => {
  // A legitimately-signed LK01 transition, relabeled to claim it is a PS01 transition while
  // keeping LK01's signature — proves the key lookup is scoped by (product_id, environment), not
  // just by key_id.
  const lk01Envelope = envelopeFor({
    productId: PRODUCT_LK01, accountId: 'lr2e_wrongkey_probe_acc', transitionType: 'grant',
    entitlementKeys: ['links.pro'], transitionVersion: 1, planId: 'pro',
    providerSubscriptionId: 'sub_lr2e_wrongkey', signingKeyId: ENTITLEMENT_KEY_LK01.keyId,
  });
  const lk01Signed = await signEntitlementTransition(lk01Envelope, ENTITLEMENT_KEY_LK01);
  const relabeled = { ...lk01Signed, envelope: { ...lk01Signed.envelope, product_id: PRODUCT_PS01 } };

  await assert.rejects(
    () => verifyEntitlementTransition(relabeled, [ENTITLEMENT_KEY_PS01, ENTITLEMENT_KEY_LK01]),
    (error) => error instanceof BillingRuntimeError && error.code === 'ENTITLEMENT_SIGNATURE_INVALID',
    'a transition signed by one product\'s key must not verify under a different claimed product_id',
  );

  // signEntitlementTransition itself also fails closed if asked to sign a mismatched pair
  // (defense in depth at the signing side, not just verification).
  await assert.rejects(
    () => signEntitlementTransition({ ...lk01Envelope, product_id: PRODUCT_PS01 }, ENTITLEMENT_KEY_LK01),
    (error) => error instanceof BillingRuntimeError && error.code === 'ENTITLEMENT_KEY_MISMATCH',
  );
});

// ---------------------------------------------------------------------------
// Objective items 1 + 2 — a PS01-scoped credential/assertion cannot read LK01 state through the
// real HTTP routes for the same account_id, and vice versa; credential binding is real,
// per-product, and persisted (real Postgres, real runtime.handle()).
// ---------------------------------------------------------------------------
test('LR-2E: real credential bindings are persisted per product, and real GET routes never return the other product\'s data for the same account_id (real Postgres, real routes)', async () => {
  const db = new BillingDb(process.env.BILLING_DATABASE_URL, SCHEMA);
  const verify = makeVerify();
  const PS01_TOKEN = `wstera-lr2e-ps01-${crypto.randomUUID()}`;
  const LK01_TOKEN = `wstera-lr2e-lk01-${crypto.randomUUID()}`;
  const PS01_ASSERTION_SECRET = crypto.randomUUID() + crypto.randomUUID();
  const LK01_ASSERTION_SECRET = crypto.randomUUID() + crypto.randomUUID();
  const PS01_KEY_ID = `lr2e-cred-ps01-${crypto.randomUUID().slice(0, 8)}`;
  const LK01_KEY_ID = `lr2e-cred-lk01-${crypto.randomUUID().slice(0, 8)}`;
  let close;
  try {
    const registry = await makeRegisteredRegistry();
    const runtime = new CentralBillingRuntime({
      environment: 'test', schema: SCHEMA, admissionTestMode: true,
      databaseUrl: process.env.BILLING_DATABASE_URL,
      stripeSecretKey: `sk_test_lr2e_route_placeholder_${crypto.randomUUID()}`,
      stripeWebhookSecret: `whsec_lr2e_route_placeholder_${crypto.randomUUID()}`,
      webhookMaxBytes: 1024 * 1024,
      credentials: [
        { keyId: PS01_KEY_ID, token: PS01_TOKEN, productId: PRODUCT_PS01, environment: 'test', profileVersion: 1, scopes: ['read'] },
        { keyId: LK01_KEY_ID, token: LK01_TOKEN, productId: PRODUCT_LK01, environment: 'test', profileVersion: 1, scopes: ['read'] },
      ],
      assertionKeys: [
        { keyId: `${PS01_KEY_ID}-assertion`, productId: PRODUCT_PS01, environment: 'test', secret: PS01_ASSERTION_SECRET },
        { keyId: `${LK01_KEY_ID}-assertion`, productId: PRODUCT_LK01, environment: 'test', secret: LK01_ASSERTION_SECRET },
      ],
      returnUrls: {},
      entitlementSigningKeys: [ENTITLEMENT_KEY_PS01, ENTITLEMENT_KEY_LK01],
      profileRegistry: registry,
      logger: { info() {}, warn() {}, error() {} },
      db,
    });
    await runtime.initialize();

    const bindingRows = await verify`
      select product_id::text as product_id, credential_key_id
      from ${verify(`${SCHEMA}.runtime_credential_bindings`)} where credential_key_id in (${PS01_KEY_ID}, ${LK01_KEY_ID})
      order by product_id
    `;
    assert.equal(bindingRows.length, 2, 'both credential bindings are persisted as independent real rows');
    assert.notEqual(bindingRows[0].product_id, bindingRows[1].product_id);

    // Seed distinct real reconciliation + entitlement state per product for the SAME account_id.
    const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
    await ensureCustomerMapping(db, PRODUCT_PS01, ACCOUNT_ROUTES, providerCustomerIdFor('ps01', ACCOUNT_ROUTES));
    await ensureCustomerMapping(db, PRODUCT_LK01, ACCOUNT_ROUTES, providerCustomerIdFor('lk01', ACCOUNT_ROUTES));
    await db.upsertReconciliation({
      environment: 'test', productId: PRODUCT_PS01, accountId: ACCOUNT_ROUTES, profileVersion: 1,
      planId: 'founding-c2', providerSubscriptionId: 'sub_lr2e_route_ps01', providerCustomerId: providerCustomerIdFor('ps01', ACCOUNT_ROUTES),
      providerStatus: 'active', priceId: 'price_ps01_route', providerProductId: 'prod_ps01_route', amountMinor: 99000,
      currency: 'THB', currentPeriodStart: null, currentPeriodEnd: null, cancelAtPeriodEnd: false,
      snapshotHash: hash('route-ps01'), correlationId: crypto.randomUUID(),
    });
    await db.upsertReconciliation({
      environment: 'test', productId: PRODUCT_LK01, accountId: ACCOUNT_ROUTES, profileVersion: 1,
      planId: 'pro', providerSubscriptionId: 'sub_lr2e_route_lk01', providerCustomerId: providerCustomerIdFor('lk01', ACCOUNT_ROUTES),
      providerStatus: 'active', priceId: 'price_lk01_route', providerProductId: 'prod_lk01_route', amountMinor: 19900,
      currency: 'THB', currentPeriodStart: null, currentPeriodEnd: null, cancelAtPeriodEnd: false,
      snapshotHash: hash('route-lk01'), correlationId: crypto.randomUUID(),
    });
    const ps01Env = envelopeFor({ productId: PRODUCT_PS01, accountId: ACCOUNT_ROUTES, transitionType: 'grant', entitlementKeys: ['commercial_access'], transitionVersion: 1, planId: 'founding-c2', providerSubscriptionId: 'sub_lr2e_route_ps01', signingKeyId: ENTITLEMENT_KEY_PS01.keyId });
    const lk01Env = envelopeFor({ productId: PRODUCT_LK01, accountId: ACCOUNT_ROUTES, transitionType: 'grant', entitlementKeys: ['links.pro'], transitionVersion: 1, planId: 'pro', providerSubscriptionId: 'sub_lr2e_route_lk01', signingKeyId: ENTITLEMENT_KEY_LK01.keyId });
    const ps01Signed = await signEntitlementTransition(ps01Env, ENTITLEMENT_KEY_PS01);
    const lk01Signed = await signEntitlementTransition(lk01Env, ENTITLEMENT_KEY_LK01);
    const { transitionId: ps01TId } = await createEntitlementTransitionSinkOnly(verify, ps01Signed);
    const { transitionId: lk01TId } = await createEntitlementTransitionSinkOnly(verify, lk01Signed);
    await db.deliverEntitlementToTestSink({ transitionId: ps01TId, signed: ps01Signed, providerEventDbId: null });
    await db.deliverEntitlementToTestSink({ transitionId: lk01TId, signed: lk01Signed, providerEventDbId: null });

    const started = await startServer(runtime);
    close = started.close;
    const baseUrl = started.baseUrl;

    async function assertion(input) {
      const now = Math.floor(Date.now() / 1000);
      return signAccountAssertion({
        iss: input.productId, aud: 'wstera-billing-core', key_id: `${input.keyId}-assertion`,
        product_id: input.productId, environment: 'test', account_id: ACCOUNT_ROUTES, action: input.action,
        operation_id: input.operationId, nonce: crypto.randomUUID(), iat: now, exp: now + 240,
      }, input.secret);
    }
    async function get(path, token, assertionToken) {
      const res = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}`, 'x-wstera-account-assertion': assertionToken } });
      return { status: res.status, json: await res.json() };
    }

    const ps01StatusAssertion = await assertion({ productId: PRODUCT_PS01, keyId: PS01_KEY_ID, secret: PS01_ASSERTION_SECRET, action: 'subscription_status', operationId: 'op_lr2e_ps01_status' });
    const ps01Status = await get(`/v1/subscription/status?account_id=${ACCOUNT_ROUTES}&operation_id=op_lr2e_ps01_status`, PS01_TOKEN, ps01StatusAssertion);
    assert.equal(ps01Status.status, 200);
    assert.equal(ps01Status.json.subscription.plan_id, 'founding-c2', 'PS01 credential reads PS01\'s own subscription plan');
    // amount_minor is a bigint column, serialized as a string over the wire (real behaviour, not
    // a bug) — compare numerically rather than weakening this into a string-literal assertion.
    assert.equal(Number(ps01Status.json.subscription.amount_minor), 99000);
    assert.notEqual(ps01Status.json.subscription.plan_id, 'pro', 'PS01 credential never sees LK01\'s plan_id for the same account_id');

    const lk01StatusAssertion = await assertion({ productId: PRODUCT_LK01, keyId: LK01_KEY_ID, secret: LK01_ASSERTION_SECRET, action: 'subscription_status', operationId: 'op_lr2e_lk01_status' });
    const lk01Status = await get(`/v1/subscription/status?account_id=${ACCOUNT_ROUTES}&operation_id=op_lr2e_lk01_status`, LK01_TOKEN, lk01StatusAssertion);
    assert.equal(lk01Status.status, 200);
    assert.equal(lk01Status.json.subscription.plan_id, 'pro', 'LK01 credential reads LK01\'s own subscription plan');
    assert.equal(Number(lk01Status.json.subscription.amount_minor), 19900);

    const ps01EntAssertion = await assertion({ productId: PRODUCT_PS01, keyId: PS01_KEY_ID, secret: PS01_ASSERTION_SECRET, action: 'entitlements_read', operationId: 'op_lr2e_ps01_ent' });
    const ps01Ent = await get(`/v1/entitlements?account_id=${ACCOUNT_ROUTES}&operation_id=op_lr2e_ps01_ent`, PS01_TOKEN, ps01EntAssertion);
    assert.deepEqual(ps01Ent.json.entitlement_projection.entitlement_keys, ['commercial_access']);

    const lk01EntAssertion = await assertion({ productId: PRODUCT_LK01, keyId: LK01_KEY_ID, secret: LK01_ASSERTION_SECRET, action: 'entitlements_read', operationId: 'op_lr2e_lk01_ent' });
    const lk01Ent = await get(`/v1/entitlements?account_id=${ACCOUNT_ROUTES}&operation_id=op_lr2e_lk01_ent`, LK01_TOKEN, lk01EntAssertion);
    assert.deepEqual(lk01Ent.json.entitlement_projection.entitlement_keys, ['links.pro']);

    // Objective item 2 — an assertion bound to PS01's product/account/action/operation_id fails
    // closed when presented against the LK01 credential (real route, real fail-closed error).
    const auditBefore = await verify`
      select count(*)::int as n from ${verify(`${SCHEMA}.runtime_audit_events`)} where account_id = ${ACCOUNT_ROUTES}
    `;
    const crossRes = await get(`/v1/subscription/status?account_id=${ACCOUNT_ROUTES}&operation_id=op_lr2e_ps01_status`, LK01_TOKEN, ps01StatusAssertion);
    assert.equal(crossRes.status, 401);
    assert.equal(crossRes.json.error, 'ACCOUNT_ASSERTION_INVALID', 'a PS01-signed assertion is unknown to the LK01 credential\'s key set');
    const auditAfter = await verify`
      select count(*)::int as n from ${verify(`${SCHEMA}.runtime_audit_events`)} where account_id = ${ACCOUNT_ROUTES}
    `;
    assert.equal(auditAfter[0].n, auditBefore[0].n, 'the denied cross-product assertion attempt leaves no new real audit row');
  } finally {
    if (close) await close();
    for (const table of ['runtime_entitlement_test_sink', 'runtime_entitlement_transitions', 'runtime_reconciliation_state', 'runtime_provider_customers', 'runtime_audit_events']) {
      await deleteByAccount(verify, table, [ACCOUNT_ROUTES]);
    }
    await verify`delete from ${verify(`${SCHEMA}.runtime_credential_bindings`)} where credential_key_id in (${PS01_KEY_ID}, ${LK01_KEY_ID})`;
    await verify.end({ timeout: 5 });
    await db.close();
  }
});
