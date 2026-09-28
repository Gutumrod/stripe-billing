import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migration = readFileSync(resolve(import.meta.dirname, '../../../docs/platform/billing-core/migrations/0003_one_time_purchase_refunds.sql'), 'utf8');

test('forward migration adds replay-safe purchase, refund, and entitlement-version state in both schemas', () => {
  for (const schema of ['billing_core', 'billing_core_staging']) {
    assert.match(migration, new RegExp(`CREATE TABLE ${schema}\\.runtime_one_time_purchases`));
    assert.match(migration, new RegExp(`CREATE TABLE ${schema}\\.runtime_payment_refunds`));
    assert.match(migration, new RegExp(`CREATE TABLE ${schema}\\.runtime_entitlement_version_reservations`));
  }
  assert.match(migration, /provider_checkout_session_id text NOT NULL UNIQUE/);
  assert.match(migration, /UNIQUE \(environment, provider_payment_intent_id\)/);
  assert.match(migration, /source_access_until timestamptz/);
  assert.match(migration, /updates_until timestamptz NOT NULL/);
  assert.match(migration, /provider_event_id uuid NOT NULL UNIQUE/);
  assert.match(migration, /'refund_reconcile'.*'purchase_reconcile'/s);
  assert.doesNotMatch(migration, /DROP TABLE/i);
});
