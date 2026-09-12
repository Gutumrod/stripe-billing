# TASK — SB01-LONG-RUN-2C-2F-001

Status: `READY_FOR_OWNER_LAUNCH`
Workflow ID: `WF-RELAY-01`
Workflow Spec Version: `1.2.0`
Runtime Procedure: `kanban-external-agent-dispatch v2.3.8`
Work Type: `DIRECT-APPROVED`
Release Policy: `RELAY_STANDARD`
Repository: `Gutumrod/stripe-billing`
Workspace: `D:\AI-Workspace\runtime\worktrees\sb01-central-billing-20260909`
Branch / Worktree: `work/sb01-central-billing-pc-20260911` tracking `origin/feature/central-billing-phase2-runtime`
Execution Starting Revision: `6e91973556767823bb69888da70b034a161671f0`
Accepted Phase 2B Material SHA: `6be6cb36af42ba2cef62a8f070f0bb8d0a5e2895`
Owner: `Free`
Commander / Final Verify: `Sol`
Orchestrator: `Hermes`
Current Worker: `Sol / Launch Preparation`
Current Checkpoint: `CP-00 LONG-RUN LAUNCH PACKET MATERIALIZATION`
Expected Stop: `OWNER LAUNCH REQUIRED`
Next Allowed Action: Owner explicitly launches this packet through Hermes. Hermes must run PRE-01 fail-closed preflight before releasing substantive work.

## Canonical Source of Truth

1. House brief: `docs/platform/billing-core/BRIEF-SB01-LONG-RUN-RELAY-PHASE2C-2F-2026-09-12.md` at House commit `fa0691e0236346858c4fbaf4cd3f23075dfe5d13`.
2. Relay plan: `docs/relay/RELAY-PLAN-SB01-LONG-RUN-2C-2F-2026-09-12.json`.
3. House Phase 2B R3 closure and prior Phase 2A/2B evidence.
4. Actual source/tests at the exact stage revision.
5. `WF-RELAY-01 v1.2.0` + runtime `kanban-external-agent-dispatch v2.3.8`.

Chat history is not execution authority.

## Locked Roles

- Hermes = Orchestrator / Clerk only; no source implementation or quality judgment.
- AGY + Qwen = primary workers / implementation labor.
- Codex = head verifier and routing authority after each material stage revision.
- Claude = difficult-work closer only when Codex returns `SEND_TO_CLAUDE` or Sol explicitly authorizes a hard closure packet.
- Sol = Commander / Architect / Final Verify.
- Owner = Final Authority.

## Stage Route

Default stage sequence is intentionally sequential to avoid overlapping writes:
`AGY -> Qwen -> deterministic gate -> Codex`.

Codex returns exactly one route: `PASS`, `FIX_BY_AGY`, `FIX_BY_QWEN`, `SEND_TO_CLAUDE`, or `SOL_OWNER_DECISION_REQUIRED`.

A `PASS` on LR-2C/LR-2D/LR-2E lets Hermes release the next already-authorized phase. LR-2F `PASS` does not advance further; it hard-stops for Sol/Owner.

## Long-Run Checkpoints

- PRE-01: Hermes complete Relay preflight; substantive release prohibited until PASS.
- LR-2C: HTTP + Stripe Test vertical slice -> Codex checkpoint.
- LR-2D: webhook durability + reconciliation -> Codex checkpoint.
- LR-2E: entitlement + multi-Product isolation -> Codex checkpoint.
- LR-2F: Control read-contract projection -> Codex checkpoint -> hard stop.

Final hard stop:
`READY FOR SOL/OWNER REVIEW — SB01 PHASE 2F PROJECTION CONTRACT`

## Repair Guard

Per material phase: one ordinary bounded repair selected by Codex -> Codex reverify -> if difficult/substantive, one Claude closure round -> Codex reverify -> still not PASS = `SOL_OWNER_DECISION_REQUIRED`.

No silent retry, agent substitution, strategy mutation, unlimited loops, merge, release, deploy, live Stripe, production mutation, Control payment mutation, BK01/MT01/PromptPay expansion, or Council reopening without a genuine decision gap.

## Launch Boundary

This Task is prepared but not running. Owner launch authorizes Hermes orchestration and PRE-01 only. PRE-01 must pin the current branch/revision, exact runtime path/version/hash, executor readiness, allowed/prohibited paths, context modes, stage graph, and failure behavior = STOP.

First substantive dispatch after PRE-01 PASS is the fresh AGY LR-2C dispatch referenced by this Task once its commit is pinned.