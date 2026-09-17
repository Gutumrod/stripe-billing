import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import postgres from 'postgres';
import { BillingDb } from '../dist/db.js';

// LR-2C FIX-04 regression (DURABLE-CLAIM-JSONB-DOUBLE-ENCODE): claimWebhookEvent used to pass
// JSON.stringify(...) into a `$n::jsonb` cast on this prepare:false connection. postgres@3.4.5
// then stores the JSON *text* as a jsonb string scalar instead of an object, which the live
// catalog constraints (runtime_provider_events_hint_envelope_check /
// _normalized_envelope_check, runtime_outbox_jobs payload object check) correctly reject with
// PostgresError 23514 -> HTTP 500 -> zero durable provider-event rows. Prior coverage
// (tests/outbox-conflict-sql-qualification.test.mjs) only proves SQL text shape, never executes
// a statement. This test runs the real INSERT against a live PostgreSQL database (no db mock)
// and asserts the persisted jsonb_typeof, so it fails against the pre-repair encoding and
// passes once claimWebhookEvent writes real jsonb via sql.json()/tx.json().

const databaseUrl = process.env.BILLING_DATABASE_URL;
if (!databaseUrl) {
  throw new Error('BLOCKED_CREDENTIAL: BILLING_DATABASE_URL is required for this real-Postgres regression test');
}

test('claimWebhookEvent durably persists hint_envelope, normalized_envelope, and outbox payload as real jsonb objects on live Postgres', async () => {
  const db = new BillingDb(databaseUrl, 'billing_core_staging');
  const verify = postgres(databaseUrl, { max: 1, prepare: false });
  const providerEventId = `evt_test_jsonb_regress_${crypto.randomUUID()}`;
  const mapping = {
    environment: 'test',
    productId: 'jsonb-regress-product',
    accountId: 'jsonb-regress-account',
    profileVersion: 1,
  };

  try {
    const result = await db.claimWebhookEvent({
      providerEventId,
      eventType: 'checkout.session.completed',
      livemode: false,
      providerObjectId: 'cs_test_jsonb_regress',
      providerCustomerId: null,
      hints: { nested: { ok: true }, list: [1, 2, 3] },
      normalizedEnvelope: { kind: 'checkout.session.completed', raw: { id: providerEventId } },
      mapping,
      correlationId: crypto.randomUUID(),
    });

    assert.equal(result.duplicate, false);
    assert.equal(result.skipped, false);
    assert.ok(result.eventDbId);

    const [eventRow] = await verify`
      select jsonb_typeof(hint_envelope) as hint_type,
             jsonb_typeof(normalized_envelope) as normalized_type,
             hint_envelope, normalized_envelope
      from billing_core_staging.runtime_provider_events
      where id = ${result.eventDbId}::uuid
    `;
    assert.equal(eventRow.hint_type, 'object', 'hint_envelope must be stored as a jsonb object, not a string scalar');
    assert.equal(eventRow.normalized_type, 'object', 'normalized_envelope must be stored as a jsonb object, not a string scalar');
    assert.deepEqual(eventRow.hint_envelope, { nested: { ok: true }, list: [1, 2, 3] });
    assert.deepEqual(eventRow.normalized_envelope, { kind: 'checkout.session.completed', raw: { id: providerEventId } });

    const [outboxRow] = await verify`
      select jsonb_typeof(payload) as payload_type, payload
      from billing_core_staging.runtime_outbox_jobs
      where provider_event_id = ${result.eventDbId}::uuid
    `;
    assert.equal(outboxRow.payload_type, 'object', 'outbox payload must be stored as a jsonb object, not a string scalar');
    assert.equal(outboxRow.payload.providerEventId, providerEventId);
  } finally {
    await verify`
      delete from billing_core_staging.runtime_outbox_jobs
      where provider_event_id = (
        select id from billing_core_staging.runtime_provider_events where provider_event_id = ${providerEventId}
      )
    `;
    await verify`delete from billing_core_staging.runtime_provider_events where provider_event_id = ${providerEventId}`;
    await verify.end({ timeout: 5 });
    await db.close();
  }
});
