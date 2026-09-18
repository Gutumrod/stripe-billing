import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import {
  databaseUrl, requireDatabaseUrl, SCHEMA, makeVerify, deleteByAccount, deleteOutboxByCorrelation,
  SnapshotAdapter,
} from './lr2d-real-db-fixtures.mjs';

const require = createRequire(import.meta.url);

// SB01 LR-2E — shared real-Postgres fixtures for the multi-product (PS01 + LK01) isolation and
// entitlement-transition test files. Reuses lr2d-real-db-fixtures.mjs's DB plumbing
// (databaseUrl/SCHEMA/makeVerify/deleteByAccount/SnapshotAdapter) rather than duplicating it; adds
// only what LR-2D's single-product fixtures did not need: two distinct neutral product ids so
// "same account string, different products" can be proven without colliding with LR-2D's own
// 'jsonb-regress-product' fixtures, and per-product snapshot/registry/runtime builders.
export { databaseUrl, requireDatabaseUrl, SCHEMA, makeVerify, deleteByAccount, deleteOutboxByCorrelation, SnapshotAdapter };

// Distinct from LR-2D's 'jsonb-regress-product' so the two suites' fixtures never collide.
export const PRODUCT_PS01 = 'lr2e-isolation-ps01';
export const PRODUCT_LK01 = 'lr2e-isolation-lk01';

// runtime_provider_customers has a unique constraint on (provider, provider_customer_id) — two
// products reusing the SAME literal account_id must each get their OWN provider_customer_id
// (exactly like two different Stripe Customers would exist for the same underlying account
// across two separate products in reality). The `tag` keeps the two products' fixtures unique.
export function providerCustomerIdFor(tag, accountId) {
  return `cus_lr2e_${tag}_${accountId}`;
}

export function BASE_SNAPSHOT_PS01(accountId) {
  return {
    customerId: providerCustomerIdFor('ps01', accountId),
    status: 'active',
    priceId: 'price_1UDCxyHB4GRCffd9RyaDWZ1c',
    productId: 'prod_VDeG7pTAPPBnw8',
    amountMinor: 99000,
    currency: 'THB',
    currentPeriodStart: Math.floor(Date.now() / 1000) - 86_400,
    currentPeriodEnd: Math.floor(Date.now() / 1000) + 29 * 86_400,
    cancelAtPeriodEnd: false,
    livemode: false,
    metadata: {
      wstera_product_id: PRODUCT_PS01,
      account_id: accountId,
      profile_version: '1',
      plan_id: 'founding-c2',
    },
  };
}

export function BASE_SNAPSHOT_LK01(accountId) {
  return {
    customerId: providerCustomerIdFor('lk01', accountId),
    status: 'active',
    priceId: 'price_1UDCxzHB4GRCffd9a0rUipHY',
    productId: 'prod_VDeGMVGn8CB4me',
    amountMinor: 19_900,
    currency: 'THB',
    currentPeriodStart: Math.floor(Date.now() / 1000) - 86_400,
    currentPeriodEnd: Math.floor(Date.now() / 1000) + 29 * 86_400,
    cancelAtPeriodEnd: false,
    livemode: false,
    metadata: {
      wstera_product_id: PRODUCT_LK01,
      account_id: accountId,
      profile_version: '1',
      plan_id: 'pro',
    },
  };
}

// Both products registered in ONE registry (pending_validation status, accepted by the runtime's
// admission-test-mode gate, matching every prior LR-2C/LR-2D harness convention).
export async function makeRegisteredRegistry() {
  const { ProductBillingProfileRegistry } = require('../../../profile-registry/dist/src/registry.js');
  const { ps01TestProfile } = require('../../../profile-registry/dist/profiles/PS01.test.js');
  const { lk01TestProfile } = require('../../../profile-registry/dist/profiles/LK01.test.js');
  const registry = new ProductBillingProfileRegistry();
  registry.register({ ...ps01TestProfile, productId: PRODUCT_PS01 });
  registry.register({ ...lk01TestProfile, productId: PRODUCT_LK01 });
  return registry;
}

const ENTITLEMENT_SIGNING_SECRET_PS01 = crypto.randomUUID() + crypto.randomUUID();
const ENTITLEMENT_SIGNING_SECRET_LK01 = crypto.randomUUID() + crypto.randomUUID();
export const ENTITLEMENT_KEY_PS01 = { keyId: 'lr2e-entitlement-key-ps01', productId: PRODUCT_PS01, environment: 'test', secret: ENTITLEMENT_SIGNING_SECRET_PS01 };
export const ENTITLEMENT_KEY_LK01 = { keyId: 'lr2e-entitlement-key-lk01', productId: PRODUCT_LK01, environment: 'test', secret: ENTITLEMENT_SIGNING_SECRET_LK01 };

// A runtime configured with a SnapshotAdapter bound to ONE product's provider snapshot at a time
// (SnapshotAdapter is single-snapshot, same as LR-2D's makeRuntime), but with BOTH products'
// entitlement signing keys configured — exactly like a real SB01 deployment, which serves every
// product from one runtime process. Callers seed only one reconcile job at a time (see the
// queue-leasing test file's seeding-order comments) so processOneJob's global FIFO lease always
// resolves to the caller's own fixture regardless of which product's SnapshotAdapter is attached.
export function makeProductRuntime(snapshotOrError, registry) {
  const { CentralBillingRuntime } = require('../../dist/index.js');
  return new CentralBillingRuntime({
    environment: 'test',
    schema: SCHEMA,
    admissionTestMode: true,
    databaseUrl,
    stripeSecretKey: `sk_test_lr2e_placeholder_${crypto.randomUUID()}`, // never used by SnapshotAdapter; never printed
    stripeWebhookSecret: `whsec_lr2e_placeholder_${crypto.randomUUID()}`,
    webhookMaxBytes: 1024 * 1024,
    credentials: [],
    assertionKeys: [],
    returnUrls: {},
    entitlementSigningKeys: [ENTITLEMENT_KEY_PS01, ENTITLEMENT_KEY_LK01],
    profileRegistry: registry,
    logger: { info() {}, warn() {}, error() {} },
    stripe: new SnapshotAdapter(snapshotOrError),
  });
}

// Mirrors lr2d-real-db-fixtures.mjs's ensureCustomerMapping, generalized to an explicit productId
// so PS01 and LK01 mappings for the same accountId can each be created independently through the
// runtime's own reserve/complete API (not a hand-written insert).
export async function ensureCustomerMapping(db, productId, accountId, providerCustomerId) {
  const reservationToken = crypto.randomUUID();
  const mapping = await db.reserveCustomer({
    environment: 'test', productId, accountId, profileVersion: 1, reservationToken,
  });
  if (mapping.providerCustomerId) return mapping;
  await db.completeCustomerReservation(mapping.id, reservationToken, providerCustomerId);
  return { ...mapping, providerCustomerId, state: 'ready' };
}

// runtime_entitlement_transitions has an FK to runtime_reconciliation_state on
// (environment, product_id, account_id, provider_subscription_id) — a transition can only be
// created once a matching reconciliation_state row exists (real provider-truth-shaped row, not a
// bare stub), which itself requires a runtime_provider_customers mapping first. Callers that only
// need the transitions/sink path (not a reconcile-job run) use this to satisfy both FKs directly.
export async function ensureReconciliationRow(db, { productId, accountId, providerSubscriptionId, planId, amountMinor, priceId, providerProductId }) {
  const providerCustomerId = providerCustomerIdFor(productId === PRODUCT_LK01 ? 'lk01' : 'ps01', accountId);
  await ensureCustomerMapping(db, productId, accountId, providerCustomerId);
  const snapshotHash = crypto.createHash('sha256').update(`${productId}:${providerSubscriptionId}:${planId}`).digest('hex');
  await db.upsertReconciliation({
    environment: 'test', productId, accountId, profileVersion: 1, planId, providerSubscriptionId,
    providerCustomerId, providerStatus: 'active', priceId, providerProductId, amountMinor,
    currency: 'THB', currentPeriodStart: null, currentPeriodEnd: null, cancelAtPeriodEnd: false,
    snapshotHash, correlationId: crypto.randomUUID(),
  });
}

// Generalized seedReconcileJob (lr2d-real-db-fixtures.mjs's version hardcodes its own
// single-product PRODUCT_ID) — inserts a pending reconcile outbox job directly, exactly like a
// real webhook claim would enqueue one.
export async function seedReconcileJobFor(verify, productId, accountId, providerSubscriptionId, reason = 'lr2e-reconcile-test') {
  const correlationId = crypto.randomUUID();
  await verify`
    insert into ${verify(`${SCHEMA}.runtime_outbox_jobs`)}
      (environment, product_id, account_id, profile_version, job_type, payload, status, dedupe_key, correlation_id)
    values ('test', ${productId}, ${accountId}, 1, 'reconcile',
            ${verify.json({ providerObjectId: providerSubscriptionId, reason })},
            'pending', ${`reconcile:${crypto.randomUUID()}`}, ${correlationId}::uuid)
  `;
  const [row] = await verify`
    select id::text as id, attempt_count::int as attempts, max_attempts::int as max_attempts
    from ${verify(`${SCHEMA}.runtime_outbox_jobs`)} where correlation_id = ${correlationId}::uuid
  `;
  return row;
}

// Seeds an entitlement_test_sink delivery job directly with a caller-supplied signed transition
// payload — used to prove ENTITLEMENT_JOB_SCOPE_MISMATCH fails closed against a real, leased,
// real-Postgres outbox row (not a hand-mirrored pure function).
export async function seedEntitlementDeliveryJobFor(verify, jobProductId, jobAccountId, transitionId, signed) {
  const correlationId = crypto.randomUUID();
  await verify`
    insert into ${verify(`${SCHEMA}.runtime_outbox_jobs`)}
      (environment, product_id, account_id, profile_version, job_type, payload, status, dedupe_key, correlation_id)
    values ('test', ${jobProductId}, ${jobAccountId}, 1, 'entitlement_test_sink',
            ${verify.json({ transitionId, signed })},
            'pending', ${`entitlement:${crypto.randomUUID()}`}, ${correlationId}::uuid)
  `;
  const [row] = await verify`
    select id::text as id from ${verify(`${SCHEMA}.runtime_outbox_jobs`)} where correlation_id = ${correlationId}::uuid
  `;
  return row;
}

// db.ts's createEntitlementTransition auto-enqueues its OWN 'entitlement_test_sink' outbox job,
// born 'pending', in the SAME transaction as the transition row. A caller that only wants the
// transition row (and delivers via db.deliverEntitlementToTestSink directly, never through the
// outbox — every isolation-file test that needs a transition does exactly this) has no way to
// avoid that row becoming visible, real, and leasable the instant createEntitlementTransition's
// own transaction commits. Real concurrent execution proved that a second call retiring it
// immediately afterwards (a separate UPDATE, necessarily a separate network round trip) is NOT
// race-free: a concurrently-running file's leaseNextJob (FIFO, global, `for update skip locked`)
// reliably won that single-round-trip window under real multi-file `node --test` concurrency,
// reproducing on 2/2 runs. The only race-free option that leaves src/ untouched is to never let
// the row be born 'pending' at all: this mirrors createEntitlementTransition's own SQL exactly
// (same columns, same conflict handling) via the caller's own `verify` connection, in one
// transaction, but inserts the outbox row as already 'completed'. No other connection can ever
// observe it in a leasable state, because no committed state where that is true ever exists.
export async function createEntitlementTransitionSinkOnly(verify, signed, providerEventDbId = null) {
  const envelope = signed.envelope;
  return verify.begin(async (tx) => {
    const inserted = await tx`
      insert into ${tx(`${SCHEMA}.runtime_entitlement_transitions`)}
        (environment, product_id, account_id, profile_version, plan_id, transition_type,
         entitlement_keys, provider_subscription_id, transition_version, idempotency_key,
         signed_envelope, signature, status, correlation_id, issued_at)
      values (${envelope.environment}, ${envelope.product_id}, ${envelope.account_id}, ${envelope.profile_version},
              ${envelope.plan_id}, ${envelope.transition_type}, ${tx.json(envelope.entitlement_keys)},
              ${envelope.provider_subscription_id}, ${envelope.transition_version}, ${envelope.idempotency_key},
              ${tx.json(envelope)}, ${signed.signature}, 'pending', ${envelope.correlation_id}::uuid, ${envelope.issued_at}::timestamptz)
      on conflict (idempotency_key) do nothing
      returning id::text as id
    `;
    const transitionId = inserted.length === 1
      ? inserted[0].id
      : (await tx`select id::text as id from ${tx(`${SCHEMA}.runtime_entitlement_transitions`)} where idempotency_key = ${envelope.idempotency_key}`)[0].id;

    const dedupeKey = `entitlement:${envelope.idempotency_key}`;
    await tx`
      insert into ${tx(`${SCHEMA}.runtime_outbox_jobs`)}
        (provider_event_id, environment, product_id, account_id, profile_version, job_type,
         payload, status, dedupe_key, correlation_id, completed_at)
      values (${providerEventDbId}, ${envelope.environment}, ${envelope.product_id}, ${envelope.account_id},
              ${envelope.profile_version}, 'entitlement_test_sink',
              ${tx.json({ transitionId, signed })}, 'completed', ${dedupeKey}, ${envelope.correlation_id}::uuid, now())
      on conflict (dedupe_key) do nothing
    `;
    return { transitionId };
  });
}

// Sweeps stale LR-2E fixture rows left behind by an earlier interrupted run — same rationale as
// lr2d-real-db-fixtures.mjs's sweepStaleLr2dFixtures (a stale row can otherwise be FIFO-leased
// ahead of a row this run just inserted). Scoped ONLY by account_id prefix (never by product_id):
// two LR-2E test *files* (this suite's isolation file and the appended queue-leasing tests in
// outbox-lease-reconcile-crash-window-real-db.test.mjs) both use the PRODUCT_PS01/PRODUCT_LK01
// ids and both run as separate node:test files, which node:test may schedule concurrently by
// default — a sweep keyed on product_id could delete a row the OTHER file just inserted. Each
// caller passes ITS OWN account_id prefix so the two files' sweeps can never touch each other's
// rows.
export async function sweepStaleLr2eFixtures(verify, accountPrefix) {
  const likePattern = `${accountPrefix.replace(/_/g, '\\_')}%`;
  await verify`
    delete from ${verify(`${SCHEMA}.runtime_outbox_jobs`)} where account_id like ${likePattern} escape '\\'
  `;
  for (const table of ['runtime_entitlement_test_sink', 'runtime_entitlement_transitions', 'runtime_reconciliation_state', 'runtime_audit_events', 'runtime_provider_customers']) {
    await verify`delete from ${verify(`${SCHEMA}.${table}`)} where account_id like ${likePattern} escape '\\'`;
  }
}
