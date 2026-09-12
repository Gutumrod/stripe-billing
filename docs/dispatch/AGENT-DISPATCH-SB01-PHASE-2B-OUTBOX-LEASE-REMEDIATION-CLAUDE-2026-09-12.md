# AGENT DISPATCH — SB01-PHASE-2B OUTBOX LEASE REMEDIATION — CLAUDE

Template Version: 1.0.0
Policy: `policies/AGENT-DISPATCH-POLICY.md` v1.0.0
Dispatch Status: READY

Role: Claude / Remediation Agent
Task ID: SB01-PHASE-2B
Workflow: WF-DEV-01 v1.1.0
Runtime Procedure: N/A
Repository: Gutumrod/stripe-billing
Workspace: D:\AI-Workspace\runtime\worktrees\sb01-central-billing-20260909
Branch / Worktree: work/sb01-central-billing-pc-20260911 tracking `origin/feature/central-billing-phase2-runtime`
Base / Expected Revision: `c042fbfb3555635fa1e155e2ee641be4bdc00d60` coordination baseline; no material source change is allowed before this dispatch is pinned by the Task checkpoint
Context Mode: REMEDIATION
Current Checkpoint: CP-06 OUTBOX ACTIVE-LEASE REMEDIATION
Expected Stop: READY FOR HOUSE/SOL REVIEW R2

## Pinned Review / Defect Package

- Exact implementation target reviewed by Independent QA: `3f62fab6c97010bd5311684efc8d7e9d3eece475`.
- Returned SB01 checkpoint before remediation: `8c9d8a576f8076299978b401806e7fcf826337c8`.
- House review document: `D:\AI-Workspace\runtime\worktrees\house-billing-core-20260909\docs\platform\billing-core\REVIEW-SB01-PHASE-2B-CLAUDE-QA-DISPOSITION-2026-09-12.md`.
- House review commit: `1f000a69182a689fc2f2a8ed54b8c686455dabc4`.
- House remediation brief: `D:\AI-Workspace\runtime\worktrees\house-billing-core-20260909\docs\platform\billing-core\BRIEF-SB01-PHASE-2B-OUTBOX-LEASE-REMEDIATION-2026-09-12.md`.
- House remediation brief commit: `5a4f9c11166434b5f831ed27799d90271b8ea6f7`.
- Canonical handoff: `D:\AI-Workspace\runtime\worktrees\house-billing-core-20260909\docs\platform\billing-core\HANDOFF-SB01-PHASE-2B-OUTBOX-LEASE-REMEDIATION-2026-09-12.md` at `5862bf2d58409650572cf258ee0c7bce26eb207a`.
- Claude Independent-QA report in this repo: `docs/platform/billing-core/REPORT-CLAUDE-SB01-PHASE-2B-INDEPENDENT-QA-2026-09-12.md` at report commit `1fbbffb1aed3f9c51d947f461e2d539f5eb6417a`.

## Source of Truth

Read in this precedence order before editing:
1. `docs/tasks/TASK-SB01-PHASE-2B.md` for current checkpoint/authority only.
2. Canonical House handoff at commit `5862bf2d58409650572cf258ee0c7bce26eb207a`.
3. House disposition review at commit `1f000a69182a689fc2f2a8ed54b8c686455dabc4`.
4. House remediation brief at commit `5a4f9c11166434b5f831ed27799d90271b8ea6f7`.
5. Actual runtime source/tests in this working branch.

Do not infer missing requirements from chat history.

## Complete Defect Set

One bounded Medium defect only:
- `platform/runtime/src/db.ts` path `claimWebhookEvent` can, on duplicate `dedupe_key`, reset an actively leased `processing` outbox job to `pending` and clear `lease_owner` / `lease_expires_at`.
- `platform/runtime/src/db.ts` path `enqueueReconciliation` has the same active-lease invalidation behavior.
- This permits a second worker to lease the same logical job while the first worker still holds an unexpired lease.

Required invariant: duplicate webhook/enqueue activity must not invalidate an unexpired `processing` lease or make that logical job immediately leaseable by another worker. `dead_letter` remains fail-closed. Existing idempotency/isolation and normal completion/failure/legitimate lease-expiry-recovery semantics must not regress.

## Objective

Close the complete bounded active-lease race in one remediation round, add targeted regression coverage proving both affected duplicate-conflict paths preserve an unexpired processing lease, and return evidence tied to an exact remediation commit.

## Allowed Scope

- Modify `platform/runtime/src/db.ts` only as needed for this invariant.
- Add or modify local runtime tests needed to reproduce the pre-fix active-lease duplicate race and prove post-fix behavior for both affected paths.
- Add one remediation evidence/report artifact under `docs/platform/billing-core/`.
- Use local build/test tooling and ignored build/dependency artifacts as needed.
- Commit and push the bounded remediation to the current task branch after all required checks pass.

## Prohibited

- Do not start or implement Phase 2C.
- Do not reuse or modify the Independent-QA dispatch as authority for this round.
- Do not mutate WSTERA LAB, production, or any database.
- Do not call Stripe/provider or use live/test provider APIs.
- Do not activate/change Product Billing Profiles.
- Do not change Control Plane billing behavior.
- Do not modify Phase 2B migrations/schema unless a strict schema blocker is proven; if found, STOP/BLOCK and return evidence to House/Sol instead of redesigning.
- Do not broaden into webhook/reconciliation feature development.
- Do not merge, release, deploy, or authorize Phase 2C.
- Do not update the canonical Task checkpoint; Commander/Sol owns checkpoint transition after your return.

## Required Regression / Verification

- Targeted active-lease duplicate regression covering `claimWebhookEvent`: PASS.
- Targeted active-lease duplicate regression covering `enqueueReconciliation`: PASS.
- Demonstrate that an existing `processing` job with unexpired lease retains `status`, `lease_owner`, and `lease_expires_at` after duplicate activity.
- Verify `dead_letter` remains fail-closed and is not resurrected.
- Verify normal non-active states / legitimate lease expiry-recovery behavior required by existing code is not unintentionally broken.
- Runtime `npm run build`: PASS.
- Runtime `npm run typecheck`: PASS.
- Product Billing Profile registry `npm test`: 16/16 PASS.
- `git diff --check`: PASS.
- Final tracked git status: clean after commit.
- No LAB/DB/provider mutation.

## Required Return Contract

Return all of:
- exact remediation commit SHA;
- branch/worktree;
- exact changed files;
- targeted regression checks and exact results;
- runtime build/typecheck results;
- profile-registry regression result;
- `git diff --check` result;
- evidence/report path;
- blockers/limitations;
- final git status and remote parity if push is performed;
- deviations from this dispatch, if any;
- actual stop checkpoint `READY FOR HOUSE/SOL REVIEW R2`.

## Stop Condition

Stop at `READY FOR HOUSE/SOL REVIEW R2`.

This is not PASS authority. Do not begin Phase 2C, merge, deploy, release, or create downstream authorization.
