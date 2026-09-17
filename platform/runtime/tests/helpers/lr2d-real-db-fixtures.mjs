import crypto from 'node:crypto';
import postgres from 'postgres';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Shared real-Postgres fixtures for the LR-2D outbox/reconcile/crash-window test files.
// Not itself a *.test.mjs file, so `node --test tests/*.test.mjs` does not pick it up.

export const databaseUrl = process.env.BILLING_DATABASE_URL;
export const SCHEMA = 'billing_core_staging';
export const PRODUCT_ID = 'jsonb-regress-product'; // same neutral product id the LR-2C durable-claim test uses

export function requireDatabaseUrl(label) {
  if (!databaseUrl) throw new Error(`BLOCKED_CREDENTIAL: BILLING_DATABASE_URL is required for ${label}`);
}

export function makeVerify() {
  return postgres(databaseUrl, { max: 1, prepare: false });
}

export async function deleteOutboxByCorrelation(verify, correlationIds) {
  if (correlationIds.length === 0) return;
  await verify`
    delete from ${verify(`${SCHEMA}.runtime_outbox_jobs`)} where correlation_id::text = any(${correlationIds})
  `;
}

export async function deleteByAccount(verify, table, accountIds) {
  await verify`delete from ${verify(`${SCHEMA}.${table}`)} where account_id = any(${accountIds})`;
}

// Minimal stripe-adapter double exposing only what processReconcileJob touches
// (retrieveSubscription) — proves the runtime's decision logic against a real database without
// a network call; the adapter's real HTTP layer is proven separately by
// scripts/run-sb01-lr2d-reconcile-slice.mjs against real Stripe TEST objects.
export class SnapshotAdapter {
  constructor(snapshotOrError) {
    this.snapshotOrError = snapshotOrError;
  }
  async retrieveSubscription(id) {
    if (this.snapshotOrError instanceof Error) throw this.snapshotOrError;
    return { ...this.snapshotOrError, subscriptionId: id };
  }
}

// runtime_provider_customers has a unique constraint on (provider, provider_customer_id): each
// account fixture needs its OWN provider_customer_id, not a shared literal (real execution
// proved reusing one literal across accounts' customer mappings violates that uniqueness).
export function providerCustomerIdFor(accountId) {
  return `cus_lr2d_probe_${accountId}`;
}

export function BASE_SNAPSHOT(accountId) {
  return {
    customerId: providerCustomerIdFor(accountId),
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
      wstera_product_id: PRODUCT_ID,
      account_id: accountId,
      profile_version: '1',
      plan_id: 'founding-c2',
    },
  };
}

export async function makeRegisteredRegistry() {
  const { ProductBillingProfileRegistry } = require('../../../profile-registry/dist/src/registry.js');
  const { ps01TestProfile } = require('../../../profile-registry/dist/profiles/PS01.test.js');
  const registry = new ProductBillingProfileRegistry();
  // Pinned PS01 registration status stays pending_validation (unchanged pin); the runtime's
  // reconcile gate accepts pending_validation in admission test mode, matching the established
  // LR-2C harness configuration.
  registry.register({ ...ps01TestProfile, productId: PRODUCT_ID });
  return registry;
}

const ENTITLEMENT_SIGNING_SECRET = crypto.randomUUID() + crypto.randomUUID();

export function makeRuntime(snapshotOrError, overrides = {}) {
  const { CentralBillingRuntime } = require('../../dist/index.js');
  return new CentralBillingRuntime({
    environment: 'test',
    schema: SCHEMA,
    admissionTestMode: true,
    databaseUrl,
    stripeSecretKey: `sk_test_lr2d_placeholder_${crypto.randomUUID()}`, // never used by SnapshotAdapter; never printed
    stripeWebhookSecret: `whsec_lr2d_placeholder_${crypto.randomUUID()}`,
    webhookMaxBytes: 1024 * 1024,
    credentials: [],
    assertionKeys: [],
    returnUrls: {},
    // A fixed, module-load-time secret (not one generated fresh per call): the crash-window
    // recovery tests build a "pre-crash" runtime and a separate "recovered" runtime and expect
    // the second to verify a signature the first created — exactly like production, where both
    // processes load the same signing key from a shared vault secret rather than each minting
    // their own. Real execution proved a fresh-per-call secret breaks that (verifyEntitlementTransition
    // rejects a transition signed by a different runtime instance).
    entitlementSigningKeys: [
      { keyId: 'lr2d-entitlement-key', productId: PRODUCT_ID, environment: 'test', secret: ENTITLEMENT_SIGNING_SECRET },
    ],
    profileRegistry: overrides.registry,
    logger: { info() {}, warn() {}, error() {} },
    stripe: new SnapshotAdapter(snapshotOrError),
  });
}

// processReconcileJob requires an existing, `ready` runtime_provider_customers row for the
// account before it will even re-fetch the provider subscription (getCustomerByAccount);
// without it every reconcile job in these tests fails closed with
// RECONCILE_CUSTOMER_MAPPING_MISSING before the SnapshotAdapter is ever consulted. Real
// execution exposed this missing test fixture; reuse the runtime's own public reserve/complete
// API (BillingDb) rather than hand-writing the insert, so the mapping is created exactly the
// way the checkout path creates it.
export async function ensureCustomerMapping(db, accountId, providerCustomerId) {
  const reservationToken = crypto.randomUUID();
  const mapping = await db.reserveCustomer({
    environment: 'test', productId: PRODUCT_ID, accountId, profileVersion: 1, reservationToken,
  });
  if (mapping.providerCustomerId) return mapping;
  await db.completeCustomerReservation(mapping.id, reservationToken, providerCustomerId);
  return { ...mapping, providerCustomerId, state: 'ready' };
}

// The shared billing_core_staging schema is also used by other LR-2D attempts in this
// worktree's history (diagnostic runs, prior interrupted executions); leaseNextJob has no
// per-test scoping (by design — a real outbox worker must drain the whole queue), so a stale
// row left behind by an earlier interrupted run can be FIFO-leased ahead of a row this test run
// just inserted. Real execution exposed exactly this (an orphaned `sub_lr2d_grant_v1` job stuck
// in `processing` from an earlier run was leased by an unrelated test). Sweep fixture rows
// identifiable by this suite's naming convention before running, mirroring the "drain
// pre-existing outbox jobs" step scripts/run-sb01-lr2c-real-slice.mjs already uses for the same
// reason.
export async function sweepStaleLr2dFixtures(verify) {
  await verify`
    delete from ${verify(`${SCHEMA}.runtime_outbox_jobs`)}
    where account_id like 'lr2d\\_%' escape '\\'
       or (payload->>'providerObjectId') like 'sub\\_lr2d\\_%' escape '\\'
       or (payload->>'providerObjectId') like 'sub\\_outbox\\_%' escape '\\'
  `;
  for (const table of ['runtime_entitlement_test_sink', 'runtime_entitlement_transitions', 'runtime_reconciliation_state', 'runtime_audit_events', 'runtime_provider_customers']) {
    await verify`delete from ${verify(`${SCHEMA}.${table}`)} where account_id like 'lr2d\\_%' escape '\\'`;
  }
  await verify`
    delete from ${verify(`${SCHEMA}.runtime_provider_events`)} where provider_event_id like 'evt\\_lr2d\\_%' escape '\\'
  `;
}

export async function seedReconcileJob(verify, accountId, providerSubscriptionId, reason = 'lr2d-reconcile-test') {
  const correlationId = crypto.randomUUID();
  await verify`
    insert into ${verify(`${SCHEMA}.runtime_outbox_jobs`)}
      (environment, product_id, account_id, profile_version, job_type, payload, status, dedupe_key, correlation_id)
    values ('test', ${PRODUCT_ID}, ${accountId}, 1, 'reconcile',
            ${verify.json({ providerObjectId: providerSubscriptionId, reason })},
            'pending', ${`reconcile:${crypto.randomUUID()}`}, ${correlationId}::uuid)
  `;
  const [row] = await verify`
    select id::text as id, attempt_count::int as attempts, max_attempts::int as max_attempts
    from ${verify(`${SCHEMA}.runtime_outbox_jobs`)} where correlation_id = ${correlationId}::uuid
  `;
  return row;
}
