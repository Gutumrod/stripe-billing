# TASK-SB01-PHASE-2B

Status: REMEDIATION_DISPATCH_CREATED_PENDING_PIN
Workflow ID: WF-DEV-01
Workflow Spec Version: 1.1.0
Runtime Procedure: N/A
Repository: Gutumrod/stripe-billing
Workspace: D:\AI-Workspace\runtime\worktrees\sb01-central-billing-20260909
Branch / Worktree: work/sb01-central-billing-pc-20260911
Base Commit: 049b34aedf97b6b42ed97dae8d0c833513efee3c
Review Target Commit: 3f62fab6c97010bd5311684efc8d7e9d3eece475
Returned Checkpoint Commit: 8c9d8a576f8076299978b401806e7fcf826337c8
Current Commit: 8c9d8a576f8076299978b401806e7fcf826337c8
Owner: Free
Commander: Sol
Current Worker: Claude / Remediation Agent
Current Checkpoint: CP-06 OUTBOX ACTIVE-LEASE REMEDIATION / DISPATCH REQUIRED
Latest Dispatch: docs/dispatch/AGENT-DISPATCH-SB01-PHASE-2B-OUTBOX-LEASE-REMEDIATION-CLAUDE-2026-09-12.md
Dispatch Revision: PENDING
Expected Stop: READY FOR HOUSE/SOL REVIEW R2
Next Allowed Action: Pin the fresh Claude remediation dispatch revision in this Task checkpoint; no material remediation before that gate passes.

## Objective

Close only the House/Sol-rejected Medium outbox active-lease race from Phase 2B, preserve all existing Phase 2B isolation/idempotency contracts, and return exact remediation evidence for House/Sol R2. Phase 2C remains HOLD.

## Source of Truth

- Canonical handoff: House `docs/platform/billing-core/HANDOFF-SB01-PHASE-2B-OUTBOX-LEASE-REMEDIATION-2026-09-12.md` at `5862bf2d58409650572cf258ee0c7bce26eb207a`.
- House disposition review: `docs/platform/billing-core/REVIEW-SB01-PHASE-2B-CLAUDE-QA-DISPOSITION-2026-09-12.md` at `1f000a69182a689fc2f2a8ed54b8c686455dabc4`.
- House remediation brief: `docs/platform/billing-core/BRIEF-SB01-PHASE-2B-OUTBOX-LEASE-REMEDIATION-2026-09-12.md` at `5a4f9c11166434b5f831ed27799d90271b8ea6f7`.
- Claude QA report: `docs/platform/billing-core/REPORT-CLAUDE-SB01-PHASE-2B-INDEPENDENT-QA-2026-09-12.md` at report commit `1fbbffb1aed3f9c51d947f461e2d539f5eb6417a`.
- Exact implementation target reviewed: `3f62fab6c97010bd5311684efc8d7e9d3eece475`.
- Returned SB01 checkpoint baseline: `8c9d8a576f8076299978b401806e7fcf826337c8`.

## Checkpoints

| Checkpoint | Status | Worker | Dispatch / Evidence | Stop / Result |
|---|---|---|---|---|
| CP-01 Flow Selection | PASS | Sol | WF-DEV-01 v1.1.0 | bounded Phase 2B |
| CP-02 Brief Lock | PASS | Sol | Phase 2B DB-contract brief | ENTRY PASS |
| CP-03 DB Contract + LAB Proof | TECHNICALLY_COMPLETE | Sol | Phase 2B evidence | independent QA required |
| CP-04 House/Sol Review | REMEDIATE_SOURCE | House/Sol | House disposition `1f000a6` + brief `5a4f9c1` | Medium active-lease race must be fixed |
| CP-05 Independent QA / Verify | COMPLETE | Claude | report `1fbbffb` | PASS WITH ONE MEDIUM FINDING |
| CP-06 Outbox Active-Lease Remediation | DISPATCH_CREATED_PENDING_PIN | Claude | fresh remediation dispatch created; revision pin pending | stop READY FOR HOUSE/SOL REVIEW R2 |

## Bounded Defect Contract

- Affected runtime paths: `claimWebhookEvent` and `enqueueReconciliation` in `platform/runtime/src/db.ts`.
- Duplicate event/enqueue activity must not clear or invalidate an unexpired `processing` lease.
- `dead_letter` must remain fail-closed.
- Existing idempotency, isolation, completion/failure, and legitimate lease-expiry/recovery behavior must not regress.
- Add targeted regression coverage reproducing the active-lease duplicate case and proving lease preservation.

## Prohibited

- No Phase 2C implementation.
- No LAB/production mutation.
- No Stripe/provider calls.
- No Product Billing Profile activation.
- No Control Plane billing work.
- No migration/schema redesign unless a blocker is proven and returned to House/Sol.
- No merge/release/deploy.

## Required Return

Exact remediation SHA; changed files; targeted regression result; runtime build; runtime typecheck; profile-registry 16/16; `git diff --check`; final git status; evidence path; blockers/deviations; actual stop `READY FOR HOUSE/SOL REVIEW R2`.

## Next Action

Create a fresh Claude Remediation Agent Dispatch Packet under canonical dispatch policy. Do not reuse the Independent-QA dispatch. Phase 2C remains HOLD.
