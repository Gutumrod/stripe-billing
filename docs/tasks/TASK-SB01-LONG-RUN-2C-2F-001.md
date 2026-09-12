# TASK — SB01-LONG-RUN-2C-2F-001

Status: `HARD STOP — LR-2C CODEX QA ROOT-CAUSE NEEDS SOL/OWNER DECISION — RECOVERY = B (BLOCKED)`
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
Current Worker: `Codex (LR-2C head verifier — rerun blocked by deterministic false positive)`
Current Checkpoint: `HARD STOP — ROOT CAUSE DETERMINED (test-fixture FP); rerun on exact revision 7a407cd would trip again`
Expected Stop: `SOL/OWNER DECISION: HOW TO CLEAR ROOT CAUSE (A | B | C | other)`
Next Allowed Action: Sol/Owner selects how to clear the Codex secret-scan false positive before Hermes reruns INDEPENDENT-QA. No rerun, no scan bypass, no skill patch, no revision change without that decision.

## LR-2C Recovery Directive (Owner, 2026-09-12) — decision = B with precondition

Owner mandated:
- Persist recovery: Codex LR-2C QA = **INVALID / NON-CANONICAL** due to `DIRECT_EXECUTOR_SECRET_DETECTED`.
- Do **NOT** forward the old QA report to Codex on a fresh round (preserve INDEPENDENT-QA).
- Investigate and clear the root cause of `secret_detected` in wrapper/stderr BEFORE rerun.
- Rerun Codex on the **exact original revision** with a fresh INDEPENDENT-QA.
- Only the new report + full provenance is canonical.
- If `secret_detected` recurs on rerun -> **HARD STOP to Sol/Owner**.

## Root Cause (determined + reproduced, 2026-09-12)

`DIRECT_EXECUTOR_SECRET_DETECTED:wrapper_log:codex-worker-<stamp>.stderr.log` is a **false positive**
from the driver's secret regex matching **committed synthetic test-fixture constants** in material
revision `7a407cd` that Codex echoes into stderr while reading target source during QA:
- Pattern 0: `secret: TEST_ASSERTION_SECRET`, `secret: LK01_ASSERTION_SECRET`,
  `secret: 'entitlement-signing-secret-ps01'`, `const secret = input.secret ?? TEST_ASSERTION_SECRET;`
- Pattern 1: `const TEST_SECRET_KEY = '<mock sk_test_...>'`

Values are synthetic (`super-secret-ps01-account-assertion-key-2026`, `entitlement-signing-secret-ps01`,
mock `sk_test_...`), not live credentials (Codex report: zero live Stripe calls, zero production mutation).
Reproduced deterministically twice (diagnostic stderr `codex_qa_probe_logs/150152`, `150659`).
Because rerun must be on the exact revision `7a407cd` and the fixtures are committed within it,
a plain same-driver rerun WILL trip `secret_detected` again => Owner's own rule triggers HARD STOP.

Clearing the root cause is outside Hermes-clerk scope. Sol/Owner must choose one:
- **A** = Skill Governance: patch `direct_external_executors.py` secret-scan to not treat synthetic
  `sk_test_`/test-fixture constants as secrets (Owner approval required before skill patch), then rerun exact revision.
- **B** = Worker-scoped: Qwen/AGY neutralize the committed fixture constant names/values so they no
  longer match the regex, then Owner approves the revised SHA before rerun (NOTE: changes material revision).
- **C** = Driver operational exception: Owner records this wrapper-log as known-benign whitelist,
  then rerun INDEPENDENT-QA to completion with full provenance on the same revision.

Root-cause record: `docs/relay/ROOT-CAUSE-SB01-LR-2C-CODEX-SECRET-DETECTED-2026-09-12.md` (commit `a2cb1d4`).

## Status / Blockers

- **HARD STOP.** No rerun, no silent retry, no scan bypass, no skill patch, no revision change,
  no canonicalization of the old (provenance-less) QA report without Sol/Owner decision.
- Branch parity at `a2cb1d4` `0/0` ahead/behind `origin/feature/central-billing-phase2-runtime`? (verify)
Initial Materialized Dispatch: `docs/dispatch/AGENT-DISPATCH-SB01-LR-2C-AGY-2026-09-12.md`
Initial Dispatch Revision: `1b5ca31711aa362481aefec840576af188389f61`

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

First substantive dispatch after PRE-01 PASS is `docs/dispatch/AGENT-DISPATCH-SB01-LR-2C-AGY-2026-09-12.md` at dispatch revision `1b5ca31711aa362481aefec840576af188389f61`. Hermes must not release it before PRE-01 PASS and explicit Owner launch.