# TASK-SB01-PHASE-2B

Status: HOUSE_SOL_R2_REMEDIATE_SOURCE
Workflow ID: WF-DEV-01
Workflow Spec Version: 1.1.0
Runtime Procedure: N/A
Repository: Gutumrod/stripe-billing
Workspace: D:\AI-Workspace\runtime\worktrees\sb01-central-billing-20260909
Branch / Worktree: work/sb01-central-billing-pc-20260911
Base Commit: 049b34aedf97b6b42ed97dae8d0c833513efee3c
Review Target Commit: 3f62fab6c97010bd5311684efc8d7e9d3eece475
Returned Checkpoint Commit: 8c9d8a576f8076299978b401806e7fcf826337c8
Remediation Commit Reviewed R2: 2cfdfaea25278294d26f66ee88947e0407645402
Returned R2 Checkpoint Commit: ca3b9e28c898deabc99ae1f9b86dc3e7ed606d70
Owner: Free
Commander: Sol
Current Worker: Sol / House Commander
Current Checkpoint: CP-07 HOUSE/SOL REVIEW R2 / REMEDIATE_SOURCE
Latest Dispatch: docs/dispatch/AGENT-DISPATCH-SB01-PHASE-2B-OUTBOX-LEASE-REMEDIATION-CLAUDE-2026-09-12.md
Dispatch Revision: 8c0b79bff3844e7b64f904caf9dcfb6725e125d2
Latest House Review: House `docs/platform/billing-core/REVIEW-SB01-PHASE-2B-HOUSE-SOL-R2-2026-09-12.md` at `f9b05c9fbc2bf72d03d7a0d94c88259386c2a01c`
Expected Stop: OWNER DECISION / NEXT BOUNDED REMEDIATION AUTHORIZATION
Next Allowed Action: Owner decides whether to authorize the bounded R2 SQL-qualification remediation round. If authorized, House must create a fresh remediation brief and fresh Agent Dispatch Packet before any source edit. Phase 2C remains HOLD.

## Objective

Close only the House/Sol-rejected Phase 2B outbox active-lease defect, preserve all existing Phase 2B isolation/idempotency contracts, and obtain exact revision-bound evidence sufficient for House/Sol acceptance. Phase 2C remains HOLD until Phase 2B closes.

## Source of Truth

- Canonical House handoff: `docs/platform/billing-core/HANDOFF-SB01-PHASE-2B-OUTBOX-LEASE-REMEDIATION-2026-09-12.md` at House commit `5862bf2d58409650572cf258ee0c7bce26eb207a`.
- Initial House disposition review: House `docs/platform/billing-core/REVIEW-SB01-PHASE-2B-CLAUDE-QA-DISPOSITION-2026-09-12.md` at `1f000a69182a689fc2f2a8ed54b8c686455dabc4`.
- Initial House remediation brief: House `docs/platform/billing-core/BRIEF-SB01-PHASE-2B-OUTBOX-LEASE-REMEDIATION-2026-09-12.md` at `5a4f9c11166434b5f831ed27799d90271b8ea6f7`.
- Claude Independent-QA report: `docs/platform/billing-core/REPORT-CLAUDE-SB01-PHASE-2B-INDEPENDENT-QA-2026-09-12.md` at report commit `1fbbffb1aed3f9c51d947f461e2d539f5eb6417a`.
- Exact implementation target initially reviewed: `3f62fab6c97010bd5311684efc8d7e9d3eece475`.
- First remediation return: `2cfdfaea25278294d26f66ee88947e0407645402`.
- House/Sol R2 review: House `docs/platform/billing-core/REVIEW-SB01-PHASE-2B-HOUSE-SOL-R2-2026-09-12.md` at `f9b05c9fbc2bf72d03d7a0d94c88259386c2a01c`.

## Checkpoints

| Checkpoint | Status | Worker | Dispatch / Evidence | Stop / Result |
|---|---|---|---|---|
| CP-01 Flow Selection | PASS | Sol | WF-DEV-01 v1.1.0 | bounded Phase 2B |
| CP-02 Brief Lock | PASS | Sol | Phase 2B DB-contract brief | ENTRY PASS |
| CP-03 DB Contract + LAB Proof | TECHNICALLY_COMPLETE | Sol | Phase 2B evidence | independent QA required |
| CP-04 House/Sol Review | REMEDIATE_SOURCE | House/Sol | House disposition `1f000a6` + brief `5a4f9c1` | active-lease race must be fixed |
| CP-05 Independent QA / Verify | COMPLETE | Claude | report `1fbbffb` | PASS WITH ONE MEDIUM FINDING |
| CP-06 Outbox Active-Lease Remediation | COMPLETE / RETURNED | Claude → House/Sol | remediation `2cfdfae` + remediation report | READY FOR HOUSE/SOL REVIEW R2 |
| CP-07 House/Sol Review R2 | REMEDIATE_SOURCE | Sol / House | House review `f9b05c9` | SQL conflict clause runtime-validity defect; Phase 2C HOLD |

## R2 Findings

### R2-F1 — HIGH / RELEASE BLOCKER

The remediation introduced `OUTBOX_LEASE_PRESERVING_CONFLICT_SET` with unqualified existing-row references on the RHS of `ON CONFLICT DO UPDATE`, including `status`, `lease_expires_at`, `next_attempt_at`, and `lease_owner`.

PostgreSQL makes both the existing target row and `excluded` proposed row visible in this context. Unqualified RHS columns are ambiguous. The material remediation therefore can compile and pass pure helper tests while the actual duplicate-conflict SQL fails when executed.

Required correction: qualify all existing-row RHS references through an explicit target alias (recommended) or equivalent unambiguous target-row qualifier while keeping the SET target columns on the LHS valid.

### R2-F2 — MEDIUM / REGRESSION COVERAGE GAP

The six new tests exercise only the manually mirrored `resolveOutboxConflict` helper. They do not execute `claimWebhookEvent`, `enqueueReconciliation`, or the actual SQL conflict clause. This gap allowed R2-F1 to pass the reported regression suite.

The next remediation return must add proof tied to the actual SQL/call-site contract, not only the helper mirror.

## Independent R2 Verification

House reviewed exact remediation SHA `2cfdfaea25278294d26f66ee88947e0407645402` in detached worktree:
`D:\AI-Workspace\runtime\reviews\sb01-phase2b-house-r2-2cfdfae`

Results:
- runtime build: PASS
- runtime typecheck: PASS
- runtime tests: 6/6 PASS
- Profile Registry: 16/16 PASS
- `git diff --check`: PASS
- tracked review worktree status: clean
- exact remediation SHA and returned checkpoint are on `origin/feature/central-billing-phase2-runtime`

These green checks do not override R2-F1 because none executes PostgreSQL name resolution for the actual `ON CONFLICT` clause.

## Prohibited

- No Phase 2C implementation.
- No LAB/production mutation.
- No Stripe/provider calls.
- No Product Billing Profile activation.
- No Control Plane billing work.
- No migration/schema redesign unless separately authorized.
- No merge/release/deploy.
- No source remediation before fresh brief + fresh dispatch + Owner authorization.

## Required Next Remediation Contract

Keep Task ID `SB01-PHASE-2B` and Workflow `WF-DEV-01 v1.1.0`.

The next bounded remediation must:
1. make the shared `ON CONFLICT DO UPDATE` clause unambiguous by qualifying existing-row references;
2. preserve active unexpired `processing` leases and `dead_letter` fail-closed behavior;
3. preserve expired/non-active recovery behavior;
4. add regression that would fail if actual SQL/call-site qualification regresses;
5. return exact SHA, changed files, verification evidence, clean status, and remote parity;
6. stop for House/Sol review again;
7. not begin Phase 2C.

A disposable local PostgreSQL contract test may be proposed in the next brief but requires explicit authorization before any database mutation, even local/disposable.

## Next Action

Wait for Owner authorization. If authorized, House creates a fresh bounded remediation brief and a fresh Agent Dispatch Packet. Do not reuse the prior Claude dispatch. Phase 2C remains HOLD.