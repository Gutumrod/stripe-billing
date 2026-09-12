# TASK-SB01-PHASE-2B

Status: CLAUDE_R2_REMEDIATION_PREP
Workflow ID: WF-DEV-01
Workflow Spec Version: 1.1.0
Runtime Procedure: N/A
Repository: Gutumrod/stripe-billing
Workspace: D:\AI-Workspace\runtime\worktrees\sb01-central-billing-20260909
Branch / Worktree: work/sb01-central-billing-pc-20260911 tracking `origin/feature/central-billing-phase2-runtime`
Base Commit: 049b34aedf97b6b42ed97dae8d0c833513efee3c
Original Review Target Commit: 3f62fab6c97010bd5311684efc8d7e9d3eece475
First Remediation Commit Reviewed R2: 2cfdfaea25278294d26f66ee88947e0407645402
R2 Verdict Checkpoint: d6e5a30d419706dc3a405015158d0ff6ceb7568c
Owner: Free
Commander: Sol
Current Worker: Claude / Remediation Agent
Current Checkpoint: CP-08 R2 SQL QUALIFICATION REMEDIATION / DISPATCH PREP
Latest House Review: House `docs/platform/billing-core/REVIEW-SB01-PHASE-2B-HOUSE-SOL-R2-2026-09-12.md` at `f9b05c9fbc2bf72d03d7a0d94c88259386c2a01c`
Current House Brief: House `docs/platform/billing-core/BRIEF-SB01-PHASE-2B-R2-SQL-QUALIFICATION-REMEDIATION-2026-09-12.md` at `8ba86cea7930222ce3c7e1174933d9f569867063`
Latest Dispatch: PENDING FRESH CLAUDE R2 REMEDIATION DISPATCH
Expected Stop: READY FOR HOUSE/SOL REVIEW R3
Next Allowed Action: Create and pin one fresh Claude remediation dispatch for CP-08; then Claude may execute only that bounded dispatch. Phase 2C remains HOLD.

## Objective

Close only House/Sol R2 findings R2-F1 and R2-F2: make the shared outbox duplicate-conflict SQL unambiguous for PostgreSQL while preserving the intended lease/dead-letter semantics, and add regression coverage tied to the actual SQL/call-site qualification contract.

## Authority / Flow

- Task ID remains `SB01-PHASE-2B`.
- Workflow remains `WF-DEV-01 v1.1.0`.
- Owner authorized the bounded R2 remediation round after House/Sol R2.
- Claude is the remediation worker for this round.
- Builder may not approve its own result.
- Phase 2C remains HOLD until House/Sol accepts Phase 2B closure.

## Source of Truth

1. This Task checkpoint for current authority/checkpoint.
2. House R2 review at House commit `f9b05c9fbc2bf72d03d7a0d94c88259386c2a01c`.
3. House R2 remediation brief at House commit `8ba86cea7930222ce3c7e1174933d9f569867063`.
4. Previous remediation report and exact remediation SHA `2cfdfaea25278294d26f66ee88947e0407645402`.
5. Actual source/tests on the pinned branch/revision.

Do not infer scope from chat history.

## Checkpoints

| Checkpoint | Status | Worker | Evidence / Stop |
|---|---|---|---|
| CP-01 Flow Selection | PASS | Sol | WF-DEV-01 v1.1.0 |
| CP-02 Brief Lock | PASS | Sol | Phase 2B brief |
| CP-03 DB Contract + LAB Proof | TECHNICALLY_COMPLETE | Sol | Phase 2B evidence |
| CP-04 House/Sol Review | REMEDIATE_SOURCE | Sol | active-lease race |
| CP-05 Independent QA | COMPLETE | Claude | one Medium finding |
| CP-06 First Lease Remediation | COMPLETE / RETURNED | Claude | `2cfdfae` |
| CP-07 House/Sol Review R2 | REMEDIATE_SOURCE | Sol | R2-F1 SQL ambiguity + R2-F2 test gap |
| CP-08 R2 SQL Qualification Remediation | DISPATCH_PREP | Claude | fresh dispatch required; stop `READY FOR HOUSE/SOL REVIEW R3` |

## Locked Defect Set

### R2-F1 — HIGH / RELEASE BLOCKER
`OUTBOX_LEASE_PRESERVING_CONFLICT_SET` uses unqualified existing-row RHS references inside `ON CONFLICT DO UPDATE`, so the actual PostgreSQL statement may fail on ambiguous column resolution.

### R2-F2 — MEDIUM / REGRESSION GAP
Current six-case tests exercise only a manually mirrored pure helper and do not prove the actual SQL/call-site qualification contract.

## Required End State

- Both `claimWebhookEvent` and `enqueueReconciliation` use one shared PostgreSQL-valid qualified conflict clause.
- Active unexpired `processing` lease is preserved.
- `dead_letter` remains fail-closed.
- Expired/non-active recovery behavior is preserved.
- Regression fails if target-row qualification is removed or either call site diverges from the shared clause.

## Prohibited

- No Phase 2C.
- No LAB/production/database mutation.
- No Stripe/provider calls.
- No Product Billing Profile activation/change.
- No Control Plane Billing work.
- No migration/schema redesign.
- No merge/release/deploy.
- No Council rerun.
- No reuse of prior remediation dispatch.

## Required Return

Exact remediation SHA; branch/worktree; changed files; targeted regression results; runtime build/typecheck/test results; Profile Registry 16/16; `git diff --check`; evidence path; blockers/limitations; deviations; clean tracked status; push + remote parity; actual stop `READY FOR HOUSE/SOL REVIEW R3`.

## Next Action

Fresh Claude R2 remediation dispatch must be created and pinned before source execution.