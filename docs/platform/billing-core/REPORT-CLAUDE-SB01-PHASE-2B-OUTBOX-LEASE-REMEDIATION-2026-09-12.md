# SB01 Phase 2B — Outbox Active-Lease Remediation Report (Claude)

Status: **COMPLETE — READY FOR HOUSE/SOL REVIEW R2**

Dispatch: `docs/dispatch/AGENT-DISPATCH-SB01-PHASE-2B-OUTBOX-LEASE-REMEDIATION-CLAUDE-2026-09-12.md`
Task: `docs/tasks/TASK-SB01-PHASE-2B.md` (checkpoint CP-06)

## Source of Truth read (this invocation)

A prior invocation of this same dispatch could not read the House worktree
(`D:\AI-Workspace\runtime\worktrees\house-billing-core-20260909\...`) or run
npm/node in its sandbox, and stopped short of commit with the fix drafted but
unverified. This invocation had both capabilities and re-read, in precedence
order: `docs/tasks/TASK-SB01-PHASE-2B.md`, the House canonical handoff
(`HANDOFF-SB01-PHASE-2B-OUTBOX-LEASE-REMEDIATION-2026-09-12.md`), the House
disposition review (`REVIEW-SB01-PHASE-2B-CLAUDE-QA-DISPOSITION-2026-09-12.md`),
and the House remediation brief
(`BRIEF-SB01-PHASE-2B-OUTBOX-LEASE-REMEDIATION-2026-09-12.md`). All four are
consistent with each other and with the dispatch's own restated defect set —
no conflicting or additional requirements were found.

The prior invocation's uncommitted `db.ts`/test/report changes were treated as
an untrusted draft: independently re-derived the required invariant from the
House documents above, re-read the diff line by line against the defect
contract (not assumed correct because it was already staged), and confirmed
the fix and test are correctly scoped before proceeding. No changes to the
prior invocation's source fix were needed; the test file and this report are
rewritten below with real, executed results.

## Bounded defect (from House brief / disposition)

`platform/runtime/src/db.ts`, `claimWebhookEvent` and `enqueueReconciliation`:
on a duplicate `dedupe_key` conflict, both previously reset an actively leased
`processing` outbox job unconditionally to `pending` and cleared
`lease_owner` / `lease_expires_at`, letting a second worker lease the same
logical job while the first worker's lease was still active.
`enqueueReconciliation`'s copy additionally did not preserve `dead_letter`.

## Change made

`platform/runtime/src/db.ts`:

- Added `OUTBOX_LEASE_PRESERVING_CONFLICT_SET`, one shared SQL `SET` clause
  now used by both `claimWebhookEvent`'s and `enqueueReconciliation`'s
  `on conflict (dedupe_key) do update`. The clause:
  - leaves `status`, `lease_owner`, `lease_expires_at`, `next_attempt_at`
    untouched when the existing row is `dead_letter` (fail-closed, now
    identical at both call sites — this also fixes `enqueueReconciliation`'s
    previously missing `dead_letter` guard);
  - leaves them untouched when the existing row is `processing` with an
    unexpired `lease_expires_at` (the active-lease race fix);
  - otherwise resets to `pending` / clears the lease / sets
    `next_attempt_at=now()` — unchanged from prior behavior for `pending`,
    `failed`, `completed`, and expired-lease `processing` rows.
- Added `resolveOutboxConflict`, a pure function mirroring the same decision
  table, used by the regression test below (the dispatch prohibits any live
  DB mutation this round, so the actual `on conflict` SQL cannot itself be
  exercised; this pure mirror is the source-level substitute). Both call
  sites use the byte-identical SQL constant, so this single decision table
  covers both affected paths.

`platform/runtime/tests/outbox-lease-conflict.test.mjs` (new): six
`node:test` cases against `resolveOutboxConflict` — unexpired-`processing`-lease
preservation (the pre-fix bug), `dead_letter` fail-closed, expired-lease
recovery, and unchanged `pending`/`failed`/`completed` behavior.

## Required regression / verification — actual results

| Check | Result |
|---|---|
| Targeted active-lease duplicate regression, `claimWebhookEvent` path | **PASS** — `resolveOutboxConflict({status:'processing', leaseExpiresAt: FUTURE})` → `{status:'processing', preserveLease:true}`; both call sites share the identical SQL constant |
| Targeted active-lease duplicate regression, `enqueueReconciliation` path | **PASS** — same shared clause/test as above |
| `dead_letter` remains fail-closed | **PASS** — `resolveOutboxConflict({status:'dead_letter', ...})` → `{status:'dead_letter', preserveLease:true}` |
| Normal/legitimate lease-expiry-recovery behavior unregressed | **PASS** — expired-lease `processing`, `pending`, `failed`, `completed` all still resolve to `pending`, matching prior behavior |
| Runtime `npm test` (build + `node --test tests/*.test.mjs`) | **PASS** — 6/6 (`tests 6, pass 6, fail 0`) |
| Runtime `npm run typecheck` | **PASS** — clean, no output |
| Profile-registry `npm test` | **PASS** — 16/16 (`tests 16, pass 16, fail 0`) |
| `git diff --check` | **PASS** — empty output |
| No LAB/DB/provider mutation | **PASS** — no such calls made; test is a pure-function unit test |

Raw command output (this invocation):

```
$ npm test   (platform/runtime)
✔ unexpired processing lease is preserved on duplicate conflict (pre-fix bug: was reset to pending)
✔ dead_letter stays fail-closed on duplicate conflict
✔ expired processing lease is recovered to pending (legitimate lease-expiry recovery, unchanged)
✔ pending job stays pending on duplicate conflict
✔ failed job is reset to pending on duplicate conflict (unchanged pre-existing behavior)
✔ completed job is reset to pending on duplicate conflict (unchanged pre-existing behavior)
tests 6, pass 6, fail 0

$ npm run typecheck   (platform/runtime)
> tsc --noEmit -p tsconfig.json
(no output — clean)

$ npm test   (platform/profile-registry)
tests 16, pass 16, fail 0

$ git diff --check
(no output — clean)
```

## Blockers/limitations

None. The prior invocation's blockers (no House-repo read access, no
npm/node execution) were both resolved by this invocation's tooling; all
required checks above were actually executed, not inferred.

The active-lease invariant itself is proven only at the pure-function
decision-table level (`resolveOutboxConflict`), not via an executed
`on conflict` query against a live Postgres instance, because the dispatch
prohibits any DB mutation this round. Both call sites use the byte-identical
`OUTBOX_LEASE_PRESERVING_CONFLICT_SET` string, so the decision table applies
identically to both; a future edit to one call site's embedding without the
shared constant would require re-verifying this test's coverage still holds.

## Deviations from dispatch

- None. Scope stayed to `platform/runtime/src/db.ts`, the new regression
  test, and this report.

## Commit / evidence

- Changed files: `platform/runtime/src/db.ts`,
  `platform/runtime/tests/outbox-lease-conflict.test.mjs`,
  `docs/platform/billing-core/REPORT-CLAUDE-SB01-PHASE-2B-OUTBOX-LEASE-REMEDIATION-2026-09-12.md`.
- Material remediation SHA: `2cfdfaea25278294d26f66ee88947e0407645402`.
- Branch: `work/sb01-central-billing-pc-20260911`, pushed to `origin/feature/central-billing-phase2-runtime`.
- Remote parity at material return: `0/0`.

## Actual stop checkpoint

**READY FOR HOUSE/SOL REVIEW R2.** Phase 2C remains HOLD; this round does not
authorize merge, deploy, release, or Phase 2C start.
## Commander Post-Return Verification

- Exact material remediation SHA: `2cfdfaea25278294d26f66ee88947e0407645402`.
- Dispatch gate baseline: `9d6e9a0a345531ea7fae4be53c03f6877ed78066`.
- Material changed-file boundary: exactly 3 files — `platform/runtime/src/db.ts`, `platform/runtime/tests/outbox-lease-conflict.test.mjs`, and this remediation report.
- Commander re-ran `platform/runtime` build: **PASS**.
- Commander re-ran `platform/runtime` typecheck: **PASS**.
- Commander re-ran targeted outbox lease regression: **6/6 PASS**.
- Commander re-ran full runtime test suite: **6/6 PASS**.
- Commander re-ran Product Billing Profile Registry regression: **16/16 PASS**.
- Commander re-ran `git diff --check` across the remediation range: **PASS**.
- Material commit was pushed to `origin/feature/central-billing-phase2-runtime` and local/remote parity was `0/0` before the Commander checkpoint-only update.
- No LAB/database/provider mutation, Phase 2C work, merge, release, or deploy occurred.

The material remediation SHA above is the exact source revision House/Sol R2 must review. The later checkpoint commit only persists this verification and transitions the canonical Task back to House/Sol review.
