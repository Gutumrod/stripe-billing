# SB01 Phase 2B — R2 SQL Qualification Remediation Evidence

Status: **READY FOR HOUSE/SOL REVIEW R3**
Task ID: `SB01-PHASE-2B`
Workflow: `WF-DEV-01 v1.1.0`
Dispatch: `docs/dispatch/AGENT-DISPATCH-SB01-PHASE-2B-R2-SQL-QUALIFICATION-CLAUDE-2026-09-12.md`
Dispatch Revision: `5b650442c0beb40cdeec58dae1c11dbc210c2eb4`
Material baseline before remediation: `3b52bbbd53d7919c249d607c98b4fbc51601a68f`

## Canonical Source of Truth Read

The remediation round used only the canonical chain required by the dispatch:
1. `docs/tasks/TASK-SB01-PHASE-2B.md`
2. Fresh CP-08 dispatch above
3. House R2 review `REVIEW-SB01-PHASE-2B-HOUSE-SOL-R2-2026-09-12.md` at House commit `f9b05c9fbc2bf72d03d7a0d94c88259386c2a01c`
4. House R2 remediation brief `BRIEF-SB01-PHASE-2B-R2-SQL-QUALIFICATION-REMEDIATION-2026-09-12.md` at House commit `8ba86cea7930222ce3c7e1174933d9f569867063`
5. Prior remediation report and exact reviewed remediation SHA `2cfdfaea25278294d26f66ee88947e0407645402`
6. Actual runtime source/tests on the pinned branch

No chat-history requirement was used as authority.

## Locked Findings Closed

### R2-F1 — SQL qualification

`platform/runtime/src/db.ts` now gives both affected outbox INSERT targets the stable alias `existing_job`. The shared `OUTBOX_LEASE_PRESERVING_CONFLICT_SET` keeps SET LHS targets unqualified and qualifies existing-row RHS reads through `existing_job`:
- `existing_job.status`
- `existing_job.lease_expires_at`
- `existing_job.next_attempt_at`
- `existing_job.lease_owner`

Both `claimWebhookEvent` and `enqueueReconciliation` use the same shared qualified clause.

### R2-F2 — regression coverage

Added `platform/runtime/tests/outbox-conflict-sql-qualification.test.mjs` with source/SQL-contract regressions that fail if:
- existing-row RHS qualification is removed;
- LHS assignment targets are incorrectly qualified;
- `claimWebhookEvent` stops aliasing its target or stops using the shared clause;
- `enqueueReconciliation` stops aliasing its target or stops using the shared clause.

The prior six semantic decision cases remain in `outbox-lease-conflict.test.mjs`.

## Exact Verification Results

Commander independently executed the dispatch-required local checks against the uncommitted Claude-authored draft after the Claude executor hit its account session limit during the verification/commit portion of the same CP-08 round.

- Targeted R2 SQL/call-site regression: **4/4 PASS**
  - `shared conflict SET clause qualifies every existing-row RHS read via existing_job`
  - `shared conflict SET clause leaves LHS assignment targets unqualified`
  - `claimWebhookEvent aliases its outbox INSERT target and uses the shared qualified clause`
  - `enqueueReconciliation aliases its outbox INSERT target and uses the shared qualified clause`
- Existing outbox lease semantic regression: **6/6 PASS**
- Runtime `npm run build`: **PASS**
- Runtime `npm run typecheck`: **PASS**
- Runtime full `npm test`: **10/10 PASS**
- Product Billing Profile Registry `npm test`: **16/16 PASS**
- `git diff --check`: **PASS**
- No LAB/production/database mutation: **PASS**
- No Stripe/provider call: **PASS**
- No migration/schema change: **PASS**
- No Phase 2C / Control Plane Billing / merge / deploy / release work: **PASS**

## Changed Files — Material Remediation

- `platform/runtime/src/db.ts`
- `platform/runtime/tests/outbox-conflict-sql-qualification.test.mjs`
- `docs/platform/billing-core/REPORT-CLAUDE-SB01-PHASE-2B-R2-SQL-QUALIFICATION-REMEDIATION-2026-09-12.md`

## Executor / Procedure Deviation

Claude read the canonical source chain and authored the bounded source/test remediation. Its first invocation was blocked from running npm/node by the Claude Code permission gate; the continuation then hit the Claude subscription session limit before verification/commit completed. No alternate agent was substituted and no source logic was modified by Commander after that limit.

To avoid fabricating test results or waiting outside the current execution turn, Commander ran the exact local verification required by the dispatch against Claude's draft and performed persistence/commit mechanics. This is recorded as a procedural deviation for House/Sol R3 to review; it is **not** a self-approval or a Phase 2B PASS decision.

## Limitations

No PostgreSQL statement was executed. This is intentional and required: the dispatch explicitly prohibits all database mutation, including disposable local PostgreSQL. Proof for R2-F1/R2-F2 is source/string-level plus compile/typecheck/test verification only.

## Stop

Actual stop target: `READY FOR HOUSE/SOL REVIEW R3`.
Phase 2C remains HOLD. House/Sol must review the exact material remediation SHA persisted after this report is committed; this evidence does not self-approve the remediation.

## Post-Commit Pin

- Exact material remediation SHA: `6be6cb36af42ba2cef62a8f070f0bb8d0a5e2895`
- Material push target: `origin/feature/central-billing-phase2-runtime`
- Material remote parity immediately after push: `0/0`
- Material tracked status immediately after push: clean
- House/Sol R3 must review the exact material SHA above. The later checkpoint-only commit records this pin and Task transition; it does not change remediation source logic.
