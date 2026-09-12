import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OUTBOX_LEASE_PRESERVING_CONFLICT_SET } from '../dist/db.js';

// R2-F1/R2-F2 regression: resolveOutboxConflict (outbox-lease-conflict.test.mjs) proves the
// intended decision table but cannot detect that the actual SQL was ambiguous, since it is a
// hand-mirrored pure function, not the executed statement. This file proves, at the source
// level, that the real ON CONFLICT DO UPDATE clause qualifies every existing-row RHS read
// through the `existing_job` target alias, and that both claimWebhookEvent and
// enqueueReconciliation embed that same shared, qualified clause. No PostgreSQL statement is
// executed here (none is authorized this round); this is source/string-level proof only.

const srcPath = fileURLToPath(new URL('../src/db.ts', import.meta.url));
const src = fs.readFileSync(srcPath, 'utf8');

test('shared conflict SET clause qualifies every existing-row RHS read via existing_job', () => {
  // Every conditional read of the existing row's status/lease_expires_at must go through the
  // target alias. If a future edit strips the qualifier, this fails.
  assert.doesNotMatch(OUTBOX_LEASE_PRESERVING_CONFLICT_SET, /when\s+status=/);
  assert.doesNotMatch(OUTBOX_LEASE_PRESERVING_CONFLICT_SET, /(?<!existing_job\.)lease_expires_at\s*>\s*now\(\)/);
  assert.match(OUTBOX_LEASE_PRESERVING_CONFLICT_SET, /when existing_job\.status='dead_letter' then 'dead_letter'/);
  assert.match(
    OUTBOX_LEASE_PRESERVING_CONFLICT_SET,
    /when existing_job\.status='processing' and existing_job\.lease_expires_at > now\(\) then 'processing'/,
  );
  assert.match(OUTBOX_LEASE_PRESERVING_CONFLICT_SET, /existing_job\.next_attempt_at/);
  assert.match(OUTBOX_LEASE_PRESERVING_CONFLICT_SET, /existing_job\.lease_owner/);
  assert.match(OUTBOX_LEASE_PRESERVING_CONFLICT_SET, /existing_job\.lease_expires_at/);
});

test('shared conflict SET clause leaves LHS assignment targets unqualified', () => {
  // PostgreSQL rejects a qualified assignment target in `ON CONFLICT DO UPDATE SET`; only the
  // RHS existing-row reads may be qualified.
  assert.match(OUTBOX_LEASE_PRESERVING_CONFLICT_SET, /^\s*status=case/m);
  assert.match(OUTBOX_LEASE_PRESERVING_CONFLICT_SET, /^\s*next_attempt_at=case/m);
  assert.match(OUTBOX_LEASE_PRESERVING_CONFLICT_SET, /^\s*lease_owner=case/m);
  assert.match(OUTBOX_LEASE_PRESERVING_CONFLICT_SET, /^\s*lease_expires_at=case/m);
  assert.match(OUTBOX_LEASE_PRESERVING_CONFLICT_SET, /^\s*updated_at=now\(\)/m);
});

test('claimWebhookEvent aliases its outbox INSERT target and uses the shared qualified clause', () => {
  const start = src.indexOf('async claimWebhookEvent');
  const end = src.indexOf('async leaseNextJob');
  assert.ok(start !== -1 && end !== -1 && start < end, 'could not locate claimWebhookEvent body');
  const section = src.slice(start, end);
  assert.match(section, /insert into \$\{outboxTable\} as existing_job/);
  assert.match(section, /on conflict \(dedupe_key\) do update set \$\{OUTBOX_LEASE_PRESERVING_CONFLICT_SET\}/);
});

test('enqueueReconciliation aliases its outbox INSERT target and uses the shared qualified clause', () => {
  const start = src.indexOf('async enqueueReconciliation');
  const end = src.indexOf('async upsertReconciliation');
  assert.ok(start !== -1 && end !== -1 && start < end, 'could not locate enqueueReconciliation body');
  const section = src.slice(start, end);
  assert.match(section, /insert into \$\{table\} as existing_job/);
  assert.match(
    section,
    /on conflict \(dedupe_key\) do update set \$\{this\.sql\.unsafe\(OUTBOX_LEASE_PRESERVING_CONFLICT_SET\)\}/,
  );
});
