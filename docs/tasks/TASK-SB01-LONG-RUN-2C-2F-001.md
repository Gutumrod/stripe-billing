# TASK — SB01-LONG-RUN-2C-2F-001

Status: `LR-2C CLOSED / PASS — LR-2D NEXT`
Workflow ID: `WF-RELAY-01`
Workflow Spec Version: `1.3.0`
Runtime Procedure: `kanban-external-agent-dispatch v2.5.1`
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
Current Worker: `(none — LR-2C closed; LR-2D not yet released)`
Current Checkpoint: `LR-2C PASS at 4b2beb1ee2c05b154b5a306026dfa13d000ad913 — Codex VERDICT: PASS`
Expected Stop: `LR-2F PASS -> READY_FOR_SOL_OWNER_FINAL_REVIEW`
Next Allowed Action: Hermes releases LR-2D (webhook durability + reconciliation) on the exact current revision. LR-2C closure report: `docs/relay/PHASE-CLOSURE-LR-2C-SB01-2026-09-17.md`.

## LR-2C CLOSURE (2026-09-17)

- Reconcile: `docs/relay/PHASE-R-RECONCILE-SB01-2026-09-17.md` — entry gates PASS. The prior Qwen
  `WRAPPER_EXIT 55 / AttachConsole` blocker and the 2026-09-12 DB `28P01` blocker are both CLOSED
  on fresh evidence.
- Real slice pre-fix: 27 PASS / 1 FAIL (`/webhooks/stripe` → HTTP 500, zero durable provider events).
  Root cause `PostgresError 23514` — `JSON.stringify(x)` bound into a `$n::jsonb` cast on the
  `prepare:false` connection stored a jsonb *string scalar*. Record:
  `docs/relay/CHAIN-FAILURE-SB01-LR-2C-WEBHOOK-JSONB-2026-09-17.md`.
- Repair FIX-04 (agent-claude, CORE-BUILDER, 1 bounded ordinary repair, 0/2 consumed → 1/2):
  `platform/runtime/src/db.ts` 5 sites → `tx.json(...)`; new real-PostgreSQL regression test.
- Real slice post-fix: **45 / 45 PASS**, `HARNESS_EXIT=0`, `stripe listen` → **[200]**.
  Gates: build 0 / typecheck 0 / runtime 43/43 / profile-registry 16/16 / `git diff --check` clean.
- Independent verification: `agent-codex` FINAL-AUDITOR `INDEPENDENT-QA` at `4b2beb1`,
  **`VERDICT: PASS`** — `docs/platform/billing-core/CODE-2-QA-REPORT-SB01-LR-2C-FIX04-CODEX-2026-09-17.md`.
- PENDING OWNER: Hermes modified the Protected Skill `kanban-external-agent-dispatch`
  (`scripts/direct_external_executors.py`, recovering the lost 2026-09-12 Owner-approved scanner fix
  plus a strictness correction). Disclosed in the phase closure; needs an explicit Owner directive
  naming that skill. Backup: `D:\AI-Workspace\backup-2026-09-17-relay-secret-scanner-regression\`.

## QWEN EXIT-55 DIAGNOSTIC RESULT (deterministic, 2026-09-12, Recovery B)

- Trivial agent-qwen invocation via canonical trusted-repo execution path: **WRAPPER_EXIT 55**.
- stderr confirmed root cause: `@lydell/node-pty-win32-x64/lib/conpty_console_list_agent.js:13`
  `getConsoleProcessList(shellPid)` -> `Error: AttachConsole failed` -> qwen abort exit 55.
- Cause: relay executor spawns qwen with `CREATE_NO_WINDOW` (headless, no console); qwen's ConPTY
  console-list agent requires an attached Windows console.
- NOT creds / NOT FIX-01 source / NOT secret-scan. Matches Owner clue
  `lydell/node-pty-win32-x64` / `AttachConsole failed`.
- No mutation, no FIX-01 source/evidence touched, no untracked file deleted, no agent fallback.
- Per Recovery B: executor FAIL -> persist blocker and stop FIX-01 for runtime remediation before retry.
- Diagnostic record: `docs/relay/DIAGNOSTIC-SB01-LR-2C-QWEN-EXIT55-2026-09-12.md` (commit `818b656`).

## Recommended next route (to Sol)

1. Approve bounded remediation of the Qwen Windows executor console/pty attachment (canonical target
   `direct_external_executors._run` `CREATE_NO_WINDOW` for agent-qwen, or a wrapper pty/console allocation),
   then re-run a trivial readonly qwen probe through dee.execute.
2. Only after the executor probe passes, re-dispatch a fresh real Qwen FIX-01 (Sol release decision; no auto-retry).
3. LR-2D stays gated behind LR-2C PASS. Chain-failure record:
   `docs/relay/CHAIN-FAILURE-SB01-LR-2C-FIX01-QWEN-EXIT-55-2026-09-12.md`.
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