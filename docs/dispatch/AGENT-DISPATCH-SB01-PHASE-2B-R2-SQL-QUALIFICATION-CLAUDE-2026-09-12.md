# AGENT DISPATCH — SB01-PHASE-2B R2 SQL QUALIFICATION REMEDIATION — CLAUDE

Policy: `policies/AGENT-DISPATCH-POLICY.md` v1.1.0
Dispatch Status: READY

Task ID: `SB01-PHASE-2B`
Assigned Role: `Claude / Remediation Agent`
Workflow: `WF-DEV-01 v1.1.0`
Runtime Procedure: N/A
Repository: `Gutumrod/stripe-billing`
Workspace: `D:\AI-Workspace\runtime\worktrees\sb01-central-billing-20260909`
Branch / Worktree: `work/sb01-central-billing-pc-20260911` tracking `origin/feature/central-billing-phase2-runtime`
Base / Expected Revision: `7abfcd0c414bec6a765ac6bef739c3b3f72674af`
Context Mode: `REMEDIATION`
Current Checkpoint: `CP-08 R2 SQL QUALIFICATION REMEDIATION`
Expected Stop: `READY FOR HOUSE/SOL REVIEW R3`

## Source of Truth

Read in this precedence order before editing:
1. `docs/tasks/TASK-SB01-PHASE-2B.md` at the pinned base revision.
2. House R2 review: `docs/platform/billing-core/REVIEW-SB01-PHASE-2B-HOUSE-SOL-R2-2026-09-12.md` at House commit `f9b05c9fbc2bf72d03d7a0d94c88259386c2a01c`.
3. House remediation brief: `docs/platform/billing-core/BRIEF-SB01-PHASE-2B-R2-SQL-QUALIFICATION-REMEDIATION-2026-09-12.md` at House commit `8ba86cea7930222ce3c7e1174933d9f569867063`.
4. Previous remediation report: `docs/platform/billing-core/REPORT-CLAUDE-SB01-PHASE-2B-OUTBOX-LEASE-REMEDIATION-2026-09-12.md`.
5. Actual runtime source/tests at this pinned branch/revision.

Do not infer requirements from chat history.

## Pinned Review Package

House/Sol R2 reviewed exact remediation SHA:
`2cfdfaea25278294d26f66ee88947e0407645402`

House/Sol R2 verdict:
`REMEDIATE_SOURCE`

Locked findings:
- `R2-F1 HIGH / RELEASE BLOCKER`: unqualified existing-row RHS references inside the shared `ON CONFLICT DO UPDATE` clause can be ambiguous in PostgreSQL.
- `R2-F2 MEDIUM / REGRESSION GAP`: current tests verify only the pure mirror helper and do not prove the actual SQL/call-site qualification contract.

No additional product/architecture redesign is authorized.

## Objective

Close R2-F1 and R2-F2 in one bounded remediation round while preserving the intended Phase 2B outbox semantics.

Required end state:
- actual PostgreSQL conflict SQL is unambiguous;
- both affected call sites use one shared qualified clause;
- active unexpired `processing` lease remains intact;
- `dead_letter` stays fail-closed;
- expired/non-active recovery behavior remains unchanged;
- regression detects loss of target-row qualification or call-site divergence.

## Allowed Work

You may modify only as required:
- `platform/runtime/src/db.ts`
- `platform/runtime/tests/outbox-lease-conflict.test.mjs`
- one additional narrowly scoped runtime test file if needed to prove SQL/call-site qualification
- one new remediation evidence/report file under `docs/platform/billing-core/`

Recommended source shape:
- assign a stable alias to each outbox INSERT target, e.g. `INSERT INTO ... AS existing_job`;
- keep SET target columns on the LHS unqualified;
- qualify existing-row RHS references via the target alias, e.g. `existing_job.status`, `existing_job.lease_expires_at`, etc.;
- retain a single shared conflict clause used by both `claimWebhookEvent` and `enqueueReconciliation`.

You may choose an equivalent PostgreSQL-valid implementation if it stays within the locked behavior and scope.

## Required Regression / Proof

The return must include tests that cover the actual SQL/call-site contract, not only `resolveOutboxConflict`.

At minimum prove:
1. shared conflict SQL contains explicit target-row qualification for existing-row RHS reads;
2. both affected call sites embed/use that same shared qualified conflict clause;
3. a regression removing the qualifier or breaking shared-clause usage would fail;
4. current semantic cases remain covered: active lease, dead-letter, expired lease, pending, failed, completed.

Do not claim live PostgreSQL execution unless you actually execute PostgreSQL.

No database mutation of any kind is authorized in this dispatch, including LAB, production, external provider databases, or disposable local PostgreSQL. If executed-query proof becomes necessary, STOP/BLOCK and return that request to House/Owner rather than creating a database yourself.

## Required Verification

Run and report exact results for:
- targeted R2 SQL/call-site regression
- full runtime `npm test`
- runtime `npm run build`
- runtime `npm run typecheck`
- Product Billing Profile Registry `npm test` expecting 16/16 PASS
- `git diff --check`
- final tracked `git status`

After verification:
- commit the bounded remediation;
- push to `origin/feature/central-billing-phase2-runtime`;
- verify remote parity `0/0`;
- persist one evidence report tied to the exact remediation SHA.

## Prohibited Actions

- Do not start Phase 2C.
- Do not mutate LAB, production, or any database.
- Do not call Stripe/provider APIs.
- Do not activate/change Product Billing Profiles.
- Do not implement Control Plane Billing behavior.
- Do not change migrations/schema.
- Do not merge, deploy, release, or authorize downstream work.
- Do not open Council.
- Do not reuse or modify the previous Claude remediation dispatch as authority for this round.
- Do not self-approve the remediation.
- Do not expand into unrelated cleanup/refactor.

## Required Return Contract

Return all of the following:
- exact remediation commit SHA;
- branch/worktree;
- exact changed files;
- targeted R2 regression test names and exact results;
- runtime build result;
- runtime typecheck result;
- runtime full test result;
- Profile Registry result;
- `git diff --check` result;
- evidence/report path;
- blockers/limitations;
- deviations from brief/dispatch;
- final tracked git status;
- push result + remote parity;
- actual stop checkpoint `READY FOR HOUSE/SOL REVIEW R3`.

## Stop Condition

Stop at:
`READY FOR HOUSE/SOL REVIEW R3`

This dispatch does not authorize Phase 2C, merge, deploy, release, database mutation, provider mutation, or self-approval.