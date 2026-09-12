# TASK-SB01-PHASE-2B

Status: `PHASE_2B_CLOSED_LONG_RUN_BRIEF_READY_EXECUTION_HOLD`
Workflow ID: `WF-DEV-01`
Workflow Spec Version: `1.1.0`
Runtime Procedure: `N/A`
Repository: `Gutumrod/stripe-billing`
Workspace: `D:\AI-Workspace\runtime\worktrees\sb01-central-billing-20260909`
Branch / Worktree: `work/sb01-central-billing-pc-20260911` tracking `origin/feature/central-billing-phase2-runtime`
Base Commit: `049b34aedf97b6b42ed97dae8d0c833513efee3c`
Accepted Phase 2B Material SHA: `6be6cb36af42ba2cef62a8f070f0bb8d0a5e2895`
Owner: `Free`
Commander: `Sol`
Current Worker: `Sol / House Commander`
Current Checkpoint: `CP-09 PHASE 2B CLOSED / LONG-RUN RELAY PREPARATION HOLD`
Expected Stop: `BRIEF READY — EXECUTION HOLD`

## Phase 2B closure

House/Sol R3 verdict: `PASS / PHASE 2B CLOSED`.

Canonical House review:
`docs/platform/billing-core/REVIEW-SB01-PHASE-2B-HOUSE-SOL-R3-2026-09-12.md`

House review commit:
`1737840e46b639a966a256bf4f264a544f0a5f62`

Independent exact-SHA verification on `6be6cb36af42ba2cef62a8f070f0bb8d0a5e2895`:
- runtime build: PASS
- runtime typecheck: PASS
- runtime tests: 10/10 PASS
- Product Billing Profile Registry: 16/16 PASS
- `git diff --check`: PASS
- tracked review worktree: clean

R2-F1 SQL qualification blocker and R2-F2 regression-coverage gap are closed.

## Long-Run pilot preparation

Owner approved preparation of SB01 as the first Long-Run Relay pilot covering Phase 2C through Phase 2F, with normal stage checkpoints advanced by Hermes without Owner chat handoff and a final hard stop for Sol/Owner review at Phase 2F.

Canonical House Long-Run brief:
`docs/platform/billing-core/BRIEF-SB01-LONG-RUN-RELAY-PHASE2C-2F-2026-09-12.md`

House brief commit:
`850caf8c3d00a923697a9c4f2dab5007bbccefef`

Intended orchestration flow:
- Hermes = orchestrate/gate/track only
- AGY = primary builder per stage, subject to readiness/role-fit
- Codex = revision-bound checkpoint verifier
- QA defect first returns to original Builder per Relay runtime contract
- one AGY repair opportunity
- Claude precision remediation only under the bounded escalation conditions in the Long-Run brief
- fresh Codex verification after remediation
- automatic stage advance only after deterministic gate + Codex PASS
- final hard stop: `READY FOR SOL/OWNER REVIEW — SB01 PHASE 2F PROJECTION CONTRACT`

## Execution HOLD — Relay runtime parity

Execution is NOT authorized yet.

Observed during preparation:
- Workflow Registry / `WF-RELAY-01 v1.2.0` records `kanban-external-agent-dispatch v2.3.6`.
- Canonical Windows runtime file currently declares `kanban-external-agent-dispatch v2.3.8`.
- Runtime path: `D:\AI-Workspace\runtime\hermes-native\data\skills\devops\kanban-external-agent-dispatch\SKILL.md`.
- Observed SHA-256: `F8AFFA7C0430FA645581129BB01B60C5AF2BEA2CA36CD1C5C9E853CA2B4CD809`.

Relay preflight requires this mismatch to fail closed. Do not run Hermes, materialize production execution cards, or dispatch substantive agents until canonical workflow/runtime parity is resolved and fresh-session verification passes.

## Prohibited while HOLD

- No Phase 2C execution.
- No Hermes Long-Run launch.
- No substantive AGY/Claude/Codex execution for Phase 2C-2F.
- No LAB/production/database mutation.
- No Stripe/provider call.
- No Control Plane Billing work.
- No merge/release/deploy.
- No silent runtime downgrade or workflow reinterpretation.

## Next allowed action

Preparation/governance only:
1. resolve and persist canonical `WF-RELAY-01` / `kanban-external-agent-dispatch` version parity;
2. fresh-session verify the resolved runtime path/version/hash;
3. materialize a revision-pinned Relay plan/task graph from the House Long-Run brief;
4. present the launch packet to Owner;
5. execute only after explicit launch instruction.
