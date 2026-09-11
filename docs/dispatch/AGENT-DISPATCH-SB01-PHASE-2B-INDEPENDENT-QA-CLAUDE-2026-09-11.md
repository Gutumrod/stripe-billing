# AGENT DISPATCH — SB01-PHASE-2B-INDEPENDENT-QA-CLAUDE

Template Version: 1.0.0
Policy: `policies/AGENT-DISPATCH-POLICY.md` v1.1.0
Dispatch Status: READY

Role: Claude / Independent QA Verifier
Task ID: TASK-SB01-PHASE-2B
Workflow: WF-DEV-01 v1.1.0
Runtime Procedure: N/A
Repository: Gutumrod/stripe-billing
Workspace: D:\AI-Workspace\runtime\reviews\sb01-phase2b-claude-qa-3f62fab
Branch / Worktree: detached verifier worktree
Base / Expected Revision: 3f62fab6c97010bd5311684efc8d7e9d3eece475
Checkpoint Head: 4caef761df984bd7327f3062012bef881d375797
Context Mode: INDEPENDENT-QA
Current Checkpoint: CP-05 INDEPENDENT QA / VERIFY
Expected Stop: READY FOR HOUSE/SOL REVIEW — INDEPENDENT QA COMPLETE

## Independence Rules

- Form the assessment from the exact target revision and pinned contracts.
- Do not use builder conclusions, prior PASS claims, or an expected verdict as premises.
- The prior Codex attempt produced NO QA VERDICT and is irrelevant to technical assessment.
- Codex failure is Windows executor/sandbox infrastructure failure only, not an SB01 defect.
- Do not modify tracked repository files, database state, provider state, profiles, or Product state.
- `changed files` in the verifier worktree must be `NONE`.
## Source of Truth

1. `docs/tasks/TASK-SB01-PHASE-2B.md` — current checkpoint only; not technical evidence.
2. House Phase 2B brief: `D:\AI-Workspace\runtime\worktrees\house-billing-core-20260909\docs\platform\billing-core\BRIEF-SB01-PHASE-2B-DB-CONTRACT-2026-09-11.md`.
3. Exact target revision `3f62fab6c97010bd5311684efc8d7e9d3eece475` in the detached verifier worktree.
4. Runtime persistence source at target: `platform/runtime/src/db.ts` plus relevant callers/types.
5. Target migration, rollback, DB-contract test, and evidence artifacts in that exact revision.
6. Locked Council security/reconciliation/profile-isolation contracts only as needed to resolve requirements.

House/Sol review at House revision `d72c7734ab7a36889b9bdd7153a007f14f22deeb` authorizes this QA round. Its technical conclusions are not evidence for the verifier verdict.

## Objective

Independently determine whether exact Phase 2B material revision `3f62fab...` implements a safe, bounded runtime DB contract consistent with actual SB01 DB calls and locked architecture, and whether its migration/test/rollback artifacts are internally correct.

## Allowed Scope

- Read exact target revision and bounded Git history needed for the Phase 2B diff.
- Read House/Council source contracts required for comparison.
- Run local static/read-only checks and local build/typecheck/tests.
- Local ignored dependency/build artifacts are allowed only when required for verification.
- Inspect SQL constraints, indexes, FK/isolation boundaries, idempotency and rollback semantics.
- Inspect recorded evidence for consistency while independently validating claims where possible.
## Prohibited

- No tracked-file writes in the verifier worktree.
- No DB mutation, including WSTERA LAB apply/rollback/test writes.
- No Stripe/provider calls or provider mutation.
- No Product/Profile state mutation, activation, deploy, release, merge, or live key use.
- No Phase 2C work.
- No sandbox/permission bypass to obtain a verdict.
- No reopening locked architecture unless exact source evidence proves a material contradiction; if so, report and stop.
- Do not treat the Codex executor failure as an SB01 finding.

## Required Verification

- Verify exact HEAD equals `3f62fab6c97010bd5311684efc8d7e9d3eece475` before assessment.
- Review `049b34a..3f62fab` changed files and migration/source contract alignment.
- Verify `0001` is not modified by the target diff.
- Independently inspect `0002`, rollback SQL and `phase2b-db-contract.sql` for correctness and isolation.
- Run `git diff --check`.
- Run runtime build + typecheck and Profile Registry regression if dependencies can be installed without tracked changes.
- Confirm final `git status --short` has no tracked modifications; report ignored artifacts separately if any.
- Do not re-run LAB mutation evidence; assess persisted LAB evidence for internal consistency only.

## Required Return Contract

Return all of:
- exact reviewed revision;
- verifier worktree;
- changed tracked files: `NONE` or explicit failure;
- checks/tests executed and results;
- findings with severity and exact file/line references where applicable;
- evidence/artifact paths inspected;
- blockers/limitations and any unverified claims;
- git status at stop;
- deviations from this dispatch, if any;
- verdict stated without authorizing Phase 2C;
- actual stop checkpoint: `READY FOR HOUSE/SOL REVIEW — INDEPENDENT QA COMPLETE`.

## Stop Condition

Stop at `READY FOR HOUSE/SOL REVIEW — INDEPENDENT QA COMPLETE`.
Do not begin Phase 2C or create downstream authorization.