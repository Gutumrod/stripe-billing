# TASK — SB01-LONG-RUN-2C-2F-001

Status: `LR-2C HARD STOP — FIX-01 REQUIRES SOL/OWNER DECISION (FIX-02/FIX-03 REPAIRED + GATE GREEN)`
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
Current Worker: `Qwen (repair — FIX-02/FIX-03 done; FIX-01 blocked)`
Current Checkpoint: `LR-2C QWEN REPAIR RETURNED SOL_OWNER_DECISION_REQUIRED (FIX-01 Test creds absent)`
Expected Stop: `SOL/OWNER DECISION: provision Test creds to close FIX-01 OR re-scope LR-2C`
Next Allowed Action: Sol/Owner decides how to close FIX-01 (provision BILLING_DATABASE_URL + Stripe Test STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET, or explicit re-scope). No advance to Codex INFORMED-VERIFY / LR-2D until then.

## LR-2C QWEN REPAIR State (persisted 2026-09-12)

- Fresh canonical Codex INDEPENDENT-QA (full provenance) verdict `FIX_BY_QWEN` findings F1(High)/F2(High)/F3(Low).
- Qwen repair dispatch released; Qwen returned at branch HEAD `6309a08`.
- **FIX-02 REPAIRED:** `runtime.ts` now validates portal return-ref allowlist BEFORE `beginOperation` (3 lines, before any durable write); denied-portal test (`negative-authority-matrix.test.mjs`) asserts 0 new `/v1/portal` op rows + 0 portal audits for arbitrary return ref; idempotency for valid portal preserved.
- **FIX-03 REPAIRED:** trailing blank line at EOF removed from `EVIDENCE-SB01-LR-2C-AGY...`; `git diff --check 6be6cb..6309a08` PASS.
- **FIX-01 BLOCKED → SOL_OWNER_DECISION_REQUIRED:** Worker probed environment; `BILLING_DATABASE_URL` (WSTERA LAB billing_core_staging), `STRIPE_SECRET_KEY` (Test), `STRIPE_WEBHOOK_SECRET` (Test) all ABSENT; no `.env` at repo root or `platform/runtime/`; only `.env.example` template. `server.mjs` requires all three. Hermes verified absence independently (env vars ABSENT, no .env on disk). Per dispatch critical constraint: no fabrication, no mock-only downgrade.
- **Gate (Hermes, at returned revision `6309a08`):** build PASS (0), typecheck PASS (0), runtime tests 42/42 PASS, profile-registry 16/16 PASS, `git diff --check 6be6cb..6309a08` clean. Fixture constants unchanged; no prohibited-path change.
- Repair material SHA (FIX-02/FIX-03): `e61a8f7`; evidence-record commit: `6309a08`.
- Branch parity `0/0` vs `origin/work/sb01-central-billing-pc-20260911`.

## Decision Required

Sol/Owner must choose:
- **A**: Provision the three Test-only credentials (WSTERA LAB `billing_core_staging` `BILLING_DATABASE_URL`, Stripe Test `STRIPE_SECRET_KEY`, Stripe Test `STRIPE_WEBHOOK_SECRET`) so Qwen can run the real Test vertical-slice; then Codex INFORMED-VERIFY.
- **B**: Explicitly re-scope LR-2C FIX-01 (owner-approved exception to mock-only for the real provider/LAB slice) — requires a Sol/Owner decision recorded, not a Hermes call.
- **C**: Other.
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