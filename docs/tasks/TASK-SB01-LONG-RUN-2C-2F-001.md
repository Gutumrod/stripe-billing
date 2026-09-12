# TASK — SB01-LONG-RUN-2C-2F-001

Status: `BLOCKED — LR-2C FIX-01 QWEN REAL-SLICE FAILED x2 (exit 55) — RECOVERY DECISION REQUIRED`
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
Current Worker: `(FIX-01 real-slice failed — no Qwen evidence)`
Current Checkpoint: `FIX-01 QWEN REAL-SLICE FAILED x2 (exit 55) — no evidence/provenance produced`
Expected Stop: `OWNER/SOL: recovery decision for FIX-01 (A retry | B diagnose exit-55 | C hard-stop)`
Next Allowed Action: Owner selects recovery path. Hermes does NOT silently retry a material stage failure.

## LR-2C FIX-01 State After Qwen Exit-55 (verified, 2026-09-12)

- Credentials READY + verified (Hermes): BILLING_DATABASE_URL connect PASS; sk_test_ present;
  whsec_ present; stripe listener PID 16168 alive forwarding to 8787.
- **Run 1** via dee.execute -> DIRECT_EXECUTOR_EXIT:agent-qwen:55 (worker exited before work); no evidence, no commit.
- **Run 2** wrapper-direct diagnostic -> qwen worker confirmed creds present, began real-slice, ended without
  full output (probe.out.txt = 0 bytes) or commit. A real Stripe TEST/LAB mutation may have been partially
  started before the worker ended; Hermes did NOT execute further mutations (fail-closed).
- No FIX-01 evidence/commit; HEAD `79df229`; `run-sb01-lr2c-real-slice.mjs` untracked (has known /v1/v1/events
  double-prefix bug Qwen identified but did not finish committing).
- Chain-failure record: `docs/relay/CHAIN-FAILURE-SB01-LR-2C-FIX01-QWEN-EXIT-55-2026-09-12.md` (commit `79df229`).
- FIX-02/FIX-03 already repaired + gate green (`6309a08`). FIX-01 remains open.
- Root cause of exit 55 undetermined (both runs fail on qwen process, not creds).

## Recovery options (Owner / Sol)

- **A**: fresh Qwen FIX-01 via canonical driver, reuse/fix `run-sb01-lr2c-real-slice.mjs` (/v1/v1/events bug),
  run real slice, commit evidence; optionally clean partial Stripe/LAB rows first if Owner authorizes.
- **B**: diagnose qwen exit-55 root cause (bounded trivial trusted-repo invocation, capture stderr) before retry.
- **C**: treat repeated exit-55 as SOL_OWNER_DECISION_REQUIRED and stop FIX-01 pending deeper executor investigation.
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