# TASK-SB01-PHASE-2B

Status: READY_FOR_HOUSE_SOL_REVIEW_R3
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
Current Worker: House/Sol Review
Current Checkpoint: CP-08 R2 SQL QUALIFICATION REMEDIATION COMPLETE / RETURNED TO HOUSE-SOL REVIEW R3
Latest House Review: House `docs/platform/billing-core/REVIEW-SB01-PHASE-2B-HOUSE-SOL-R2-2026-09-12.md` at `f9b05c9fbc2bf72d03d7a0d94c88259386c2a01c`
Current House Brief: House `docs/platform/billing-core/BRIEF-SB01-PHASE-2B-R2-SQL-QUALIFICATION-REMEDIATION-2026-09-12.md` at `8ba86cea7930222ce3c7e1174933d9f569867063`
Latest Dispatch: `docs/dispatch/AGENT-DISPATCH-SB01-PHASE-2B-R2-SQL-QUALIFICATION-CLAUDE-2026-09-12.md`
Dispatch Revision: `5b650442c0beb40cdeec58dae1c11dbc210c2eb4`
Expected Stop: HOUSE/SOL REVIEW R3 DECISION - PHASE 2C REMAINS HOLD
Next Allowed Action: House/Sol R3 reviews exact material remediation SHA `6be6cb36af42ba2cef62a8f070f0bb8d0a5e2895`; no Phase 2C execution before explicit acceptance.

## Objective

Close only House/Sol R2 findings R2-F1 and R2-F2: make the shared outbox duplicate-conflict SQL unambiguous for PostgreSQL while preserving the intended lease/dead-letter semantics, and add regression coverage tied to the actual SQL/call-site qualification contract.

## Authority / Flow

- Task ID remains `SB01-PHASE-2B`.
- Workflow remains `WF-DEV-01 v1.1.0`.
- Owner authorized the bounded R2 remediation round after House/Sol R2.
- Claude is the remediation worker for this round.
- Fresh dispatch `5b650442c0beb40cdeec58dae1c11dbc210c2eb4` is the sole execution authority for CP-08.
- Builder may not approve its own result.
- Phase 2C remains HOLD until House/Sol accepts Phase 2B closure.

## Source of Truth

1. This Task checkpoint for current authority/checkpoint.
2. Fresh dispatch `docs/dispatch/AGENT-DISPATCH-SB01-PHASE-2B-R2-SQL-QUALIFICATION-CLAUDE-2026-09-12.md` at `5b650442c0beb40cdeec58dae1c11dbc210c2eb4`.
3. House R2 review at House commit `f9b05c9fbc2bf72d03d7a0d94c88259386c2a01c`.
4. House R2 remediation brief at House commit `8ba86cea7930222ce3c7e1174933d9f569867063`.
5. Previous remediation report and exact remediation SHA `2cfdfaea25278294d26f66ee88947e0407645402`.
6. Actual source/tests on the pinned branch/revision.

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
| CP-08 R2 SQL Qualification Remediation | COMPLETE / RETURNED | Claude -> House/Sol | remediation `6be6cb3` + evidence report; stop `READY FOR HOUSE/SOL REVIEW R3` |

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

## Remediation Return

- Exact remediation SHA: `6be6cb36af42ba2cef62a8f070f0bb8d0a5e2895`.
- Changed files: `platform/runtime/src/db.ts`, `platform/runtime/tests/outbox-conflict-sql-qualification.test.mjs`, `docs/platform/billing-core/REPORT-CLAUDE-SB01-PHASE-2B-R2-SQL-QUALIFICATION-REMEDIATION-2026-09-12.md`.
- Targeted SQL/call-site regression: 4/4 PASS.
- Lease semantic regression: 6/6 PASS.
- Runtime build: PASS.
- Runtime typecheck: PASS.
- Runtime full test: 10/10 PASS.
- Profile Registry: 16/16 PASS.
- `git diff --check`: PASS.
- Evidence path: `docs/platform/billing-core/REPORT-CLAUDE-SB01-PHASE-2B-R2-SQL-QUALIFICATION-REMEDIATION-2026-09-12.md`.
- Procedural deviation: Claude authored source/test remediation but hit subscription session limit during verification/commit continuation; Commander executed required verification and persistence mechanics without altering remediation source logic.
- Material push parity: 0/0.
- Actual stop: `READY FOR HOUSE/SOL REVIEW R3`.

## Next Action

House/Sol R3 review only against exact material remediation SHA `6be6cb36af42ba2cef62a8f070f0bb8d0a5e2895`. Phase 2C remains HOLD; no merge/deploy/provider/database/Control Plane Billing action is authorized.