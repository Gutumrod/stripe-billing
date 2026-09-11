# AGENT DISPATCH — SB01-PHASE-2B-INDEPENDENT-QA

Template Version: 1.0.0
Policy: `AGENT-DISPATCH-POLICY.md` v1.1.0
Dispatch Status: READY

Role: Codex / Independent QA Verifier
Task ID: TASK-SB01-PHASE-2B
Workflow: WF-DEV-01 v1.1.0
Runtime Procedure: N/A
Repository: Gutumrod/stripe-billing
Workspace: D:\AI-Workspace\runtime\reviews\sb01-phase2b-independent-qa-3f62fab
Branch / Worktree: detached verifier worktree
Base / Expected Revision: 3f62fab6c97010bd5311684efc8d7e9d3eece475
Checkpoint Head: 4caef761df984bd7327f3062012bef881d375797
Context Mode: INDEPENDENT-QA
Current Checkpoint: CP-05 INDEPENDENT QA / VERIFY
Expected Stop: READY FOR HOUSE/SOL REVIEW

## Independence Rules

- Form the technical assessment from the exact target revision and source contracts.
- Do not use builder conclusions, prior PASS claims, or expected verdict as premises.
- Do not modify repository files, database state, provider state, profiles, or Product state.
- If prior-review conclusions are encountered, record that fact and continue evidence-first.
- `changed files` must be `NONE`.
## Source of Truth

Use these in order for the technical assessment:

1. House Phase 2B brief: `D:\AI-Workspace\runtime\worktrees\house-billing-core-20260909\docs\platform\billing-core\BRIEF-SB01-PHASE-2B-DB-CONTRACT-2026-09-11.md`
2. Exact target revision `3f62fab6c97010bd5311684efc8d7e9d3eece475` in the verifier worktree.
3. Runtime persistence source at target revision: `platform/runtime/src/db.ts` and relevant runtime types/callers.
4. Target migration/test/rollback artifacts under `docs/platform/billing-core/` and `platform/runtime/tests/`.
5. Locked Council contracts only where needed to resolve a requirement: security, reconciliation, Product Billing Profile isolation.

The House/Sol review at House revision `d72c7734ab7a36889b9bdd7153a007f14f22deeb` supplies the authority for this QA round. Do not use its technical conclusions as evidence for the QA verdict.

## Objective

Independently determine whether the exact Phase 2B material revision implements a safe, bounded runtime DB contract consistent with actual SB01 DB calls and locked architecture, and whether its migration/test/rollback artifacts are internally correct. Stop with a review finding set; do not authorize or start Phase 2C.

## Allowed Scope

- Read the exact target revision and Git history needed to understand the Phase 2B diff.
- Read House/Council source contracts needed for requirement comparison.
- Run read-only/static commands and local build/typecheck/tests that do not mutate tracked files.
- Inspect migration SQL, constraints, indexes, FK/isolation model, idempotency semantics and rollback SQL.
- Inspect recorded evidence for consistency, but independently validate claims where possible.
## Prohibited

- No tracked-file edits, commits, pushes, merges or branch movement from the verifier worktree.
- No WSTERA LAB or production DB mutation.
- No Stripe/provider call or provider mutation.
- No Product Billing Profile activation.
- No BK01 migration, PromptPay work, Control Plane billing mutation, deploy or Phase 2C execution.
- Do not reopen locked architecture unless exact source evidence establishes a contradiction; then report and stop.

## Required Verification

- Confirm target HEAD is exactly `3f62fab6c97010bd5311684efc8d7e9d3eece475` and worktree starts/ends clean.
- Review `049b34a..3f62fab` bounded diff and confirm material files are Phase 2B-only.
- Derive required DB surface from actual runtime calls and compare with `0002`.
- Review Product/account/environment uniqueness, FKs, idempotency, outbox and entitlement isolation.
- Review prod/staging symmetry, role/grant intent and rollback correctness.
- Run `git diff --check`, runtime build/typecheck, and relevant deterministic tests when possible without tracked mutation.
- Distinguish verified source facts from evidence-only claims that cannot be independently re-executed read-only.

## Required Return Contract

Return exact reviewed revision, verifier worktree, changed files=`NONE`, checks/results, findings by severity, evidence/artifact paths inspected, blockers/limitations, git status, any deviation/context contamination, and actual stop checkpoint.

## Stop Condition

Stop at `READY FOR HOUSE/SOL REVIEW — INDEPENDENT QA COMPLETE`.

This dispatch does not authorize Phase 2C.