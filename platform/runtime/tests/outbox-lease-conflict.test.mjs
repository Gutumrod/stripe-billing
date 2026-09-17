import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveOutboxConflict } from '../dist/db.js';

// Regression for the SB01 Phase 2B outbox active-lease race: a duplicate webhook delivery
// (claimWebhookEvent) or duplicate enqueue (enqueueReconciliation) hitting the dedupe_key
// conflict must not steal/clear an unexpired processing lease, and must never resurrect
// dead_letter. This mirrors OUTBOX_LEASE_PRESERVING_CONFLICT_SET's branches; a live-Postgres
// exercise of the actual SQL was out of scope for this remediation round (no DB mutation
// permitted), so this is a logic-level proof, not an executed-query proof.

const NOW = new Date('2026-09-12T00:00:00.000Z');
const FUTURE = new Date(NOW.getTime() + 30_000);
const PAST = new Date(NOW.getTime() - 30_000);

test('unexpired processing lease is preserved on duplicate conflict (pre-fix bug: was reset to pending)', () => {
  const result = resolveOutboxConflict({ status: 'processing', leaseExpiresAt: FUTURE }, NOW);
  assert.deepEqual(result, { status: 'processing', preserveLease: true });
});

test('dead_letter stays fail-closed on duplicate conflict', () => {
  const result = resolveOutboxConflict({ status: 'dead_letter', leaseExpiresAt: null }, NOW);
  assert.deepEqual(result, { status: 'dead_letter', preserveLease: true });
});

test('expired processing lease is recovered to pending (legitimate lease-expiry recovery, unchanged)', () => {
  const result = resolveOutboxConflict({ status: 'processing', leaseExpiresAt: PAST }, NOW);
  assert.deepEqual(result, { status: 'pending', preserveLease: false });
});

test('pending job stays pending on duplicate conflict', () => {
  const result = resolveOutboxConflict({ status: 'pending', leaseExpiresAt: null }, NOW);
  assert.deepEqual(result, { status: 'pending', preserveLease: false });
});

test('failed job is reset to pending on duplicate conflict (unchanged pre-existing behavior)', () => {
  const result = resolveOutboxConflict({ status: 'failed', leaseExpiresAt: null }, NOW);
  assert.deepEqual(result, { status: 'pending', preserveLease: false });
});

// LR-2D real-execution defect fix (2026-09-17): a duplicate/stale event re-arriving after its
// job already completed must not resurrect it to pending — see
// docs/platform/billing-core/EVIDENCE-SB01-LR-2D-CLAUDE-2026-09-17.md. Real execution against
// live Postgres proved the prior "reset to pending" behavior violated
// runtime_outbox_jobs_completion_check the moment the resurrected row was completed/failed
// again (completed_at stays stamped from the first completion while status flips away from
// 'completed'). `completed` is now preserved exactly like `dead_letter`.
test('completed job is preserved on duplicate conflict (repaired: previously reset to pending, which corrupted completed_at)', () => {
  const result = resolveOutboxConflict({ status: 'completed', leaseExpiresAt: null }, NOW);
  assert.deepEqual(result, { status: 'completed', preserveLease: true });
});
