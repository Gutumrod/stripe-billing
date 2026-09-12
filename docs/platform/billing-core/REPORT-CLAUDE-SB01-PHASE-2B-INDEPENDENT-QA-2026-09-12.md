# SB01 Phase 2B ΓÇö Independent QA Verifier Report (Claude)

**Reviewed revision:** `3f62fab6c97010bd5311684efc8d7e9d3eece475` (confirmed exact HEAD match)
**Verifier worktree:** `D:\AI-Workspace\runtime\reviews\sb01-phase2b-claude-qa-3f62fab`
**Changed tracked files at stop:** `NONE`

## Checks/tests executed and results

| Check | Result |
|---|---|
| `git rev-parse HEAD` == `3f62fab...` | PASS |
| `git diff --stat 049b34a..3f62fab` reviewed | PASS (5 files, 788 insertions, 0 deletions, additive-only) |
| `0001` untouched by target diff | PASS ΓÇö `0001_billing_core_schema.sql` does not exist anywhere in this repo's history (master, feature branch, or any commit); it exists only in the separate House `billing-core` repo. The diff cannot have modified it. |
| `0002` migration + rollback + `phase2b-db-contract.sql` reviewed against `platform/runtime/src/db.ts` | PASS with one Medium finding (below) |
| `git diff --check` (range and working tree) | PASS ΓÇö no whitespace/conflict-marker errors |
| `platform/runtime`: `npm run build` | PASS |
| `platform/runtime`: `npm run typecheck` | PASS |
| `platform/profile-registry`: `npm test` | PASS ΓÇö 16/16 |
| Final `git status --short` | Clean, no tracked modifications |
| Final `git status --short --ignored` | 4 ignored build artifacts only (`node_modules/`, `dist/` under runtime and profile-registry) |

## Findings

**1. Medium ΓÇö outbox-job lease can be prematurely cleared by duplicate-event resurrection.**
`platform/runtime/src/db.ts:301-314` (`claimWebhookEvent`) and `db.ts:404-412` (`enqueueReconciliation`) both use `on conflict (dedupe_key) do update set status = case when status='dead_letter' then 'dead_letter' else 'pending' end, lease_owner=null, lease_expires_at=null, ...`. If the existing row is currently `status='processing'` with an active (non-expired) lease, a duplicate webhook delivery or duplicate enqueue call will force it back to `pending` and clear the lease unconditionally, even though a worker may still be actively processing it. `leaseNextJob` (`db.ts:320-357`) will then pick the same logical job up again immediately, permitting two workers to process the same reconcile job concurrently. No CHECK constraint is violated (the invariant `runtime_outbox_jobs_lease_check` still holds), so this is a logical concurrency gap, not a schema defect. By contrast, `createEntitlementTransition`'s outbox insert (`db.ts:524-534`) correctly uses `on conflict (dedupe_key) do nothing`, avoiding this problem ΓÇö the inconsistency between the three call sites suggests this is unintentional rather than a deliberate resurrection design. Given `upsertReconciliation` is itself idempotent by snapshot hash, actual money-state corruption is unlikely, but duplicate concurrent processing of a lease is exactly the kind of race the Phase 2B brief's idempotency-guarantee requirement is meant to rule out.

**2. Informational ΓÇö cross-repo migration dependency not vendored in this repo.**
`0002`'s header comment and the rollback script both assume a prior, already-applied `0001_billing_core_schema.sql` (schemas `billing_core`/`billing_core_staging`, roles `billing_core_app`/`billing_core_staging_app`, etc.). That baseline is not tracked anywhere in `Gutumrod/stripe-billing`'s history ΓÇö it exists only in the separate House `billing-core` worktree/repo. This satisfies the "0001 untouched" requirement trivially, and matches the recorded decision to "keep 0001 historical baseline unchanged," but it means this repository alone is not self-contained/reproducible for migration replay; that dependency is implicit rather than pinned by commit reference.

**3. No defects found** in the constraint/isolation design itself: cross-product isolation is enforced via a mix of scoped and intentionally-global unique constraints (e.g., the partial unique index on `(provider, provider_customer_id)` and the global `(environment, provider_subscription_id)` uniqueness prevent a Stripe customer/subscription ID from binding to more than one product/account), FK chains correctly gate entitlement transitions behind reconciliation state and reconciliation behind a ready customer mapping, and `runtime_entitlement_test_sink` correctly guards monotonic delivery via `latest_transition_version <` in its `ON CONFLICT` clause. Independently traced every `db.ts` query against the `0002` schema's columns, constraints, and indexes; all align.

## Evidence/artifact paths inspected
- `docs/platform/billing-core/migrations/0002_multi_product_billing_runtime.sql`
- `docs/platform/billing-core/migrations/0002_multi_product_billing_runtime.rollback.sql`
- `docs/platform/billing-core/EVIDENCE-SB01-PHASE-2B-DB-CONTRACT-2026-09-11.md`
- `docs/tasks/TASK-SB01-PHASE-2B.md`
- `platform/runtime/tests/phase2b-db-contract.sql`
- `platform/runtime/src/db.ts`, `platform/runtime/src/types.ts`
- House brief: `.../house-billing-core-20260909/docs/platform/billing-core/BRIEF-SB01-PHASE-2B-DB-CONTRACT-2026-09-11.md`
- House baseline (read-only, for cross-repo comparison only): `.../house-billing-core-20260909/docs/platform/billing-core/migrations/0001_billing_core_schema.sql` (path confirmed only; not diffed, since it is out of this repo's scope and untouched by the target commit)

## Blockers/limitations and unverified claims
- Per dispatch, LAB mutation was not re-run; the LAB apply/rollback narrative in the evidence document (persistent apply, 16-table post-state, role/grant verification, security-advisor filtering) was assessed only for internal consistency against the static SQL, not independently reproduced against a live database. This claim remains **unverified by this QA round**.
- `phase2b-db-contract.sql` is a raw SQL script, not wired into `npm test` (only `tests/*.test.mjs` is executed); it requires a live Postgres connection to run. It was verified by static/manual trace against the `0002` schema's constraints only (documented per-assertion above), not executed.
- No sandbox/DB/provider access was available or used, consistent with the prohibited-scope instructions.

## Git status at stop
- `HEAD`: `3f62fab6c97010bd5311684efc8d7e9d3eece475`
- `git status --short`: clean (no tracked changes)
- Ignored artifacts present (expected, from local build/test runs): `platform/profile-registry/dist/`, `platform/profile-registry/node_modules/`, `platform/runtime/dist/`, `platform/runtime/node_modules/`

## Deviations from dispatch
None. All required checks were executed locally and read-only; no tracked files were modified; no DB/provider/network mutation occurred.

## Verdict
**SB01 PHASE 2B DB CONTRACT ΓÇö PASS WITH ONE MEDIUM FINDING.** The migration, rollback, and runtime `db.ts` calls are internally consistent, isolation-safe, and build/typecheck/regression-clean. One Medium-severity concurrency gap (finding 1) around outbox lease resurrection on duplicate events should be addressed or explicitly risk-accepted before Phase 2C reconciliation/webhook work is built on top of it. This verdict does not authorize Phase 2C.

**Stop checkpoint:** `READY FOR HOUSE/SOL REVIEW ΓÇö INDEPENDENT QA COMPLETE`
