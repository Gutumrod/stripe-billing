# TASK — SB01-LONG-RUN-2C-2F-001

Status: `LR-2C FIX-01 — REAL TEST CREDS READY — AWAITING QWEN DISPATCH`
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
Current Worker: `Qwen (FIX-01 real TEST vertical-slice — dispatch ready)`
Current Checkpoint: `LR-2C FIX-01 — REAL TEST CREDS READY + VERIFIED`
Expected Stop: `READY FOR QWEN FIX-01 REAL VERTICAL-SLICE DISPATCH`
Next Allowed Action: Hermes releases fresh Qwen FIX-01 dispatch on exact current HEAD; after Qwen returns + deterministic gate PASS, dispatches fresh Codex verification.

## LR-2C FIX-01 CREDENTIAL READINESS (verified fail-closed, 2026-09-12)

All required TEST-only credentials verified against live system + canonical vault `D:\AI-Workspace\.secrets\keys.txt`:

1. **`BILLING_DATABASE_URL`** — CONNECT PASS. Read-only probe via WSTERA LAB `aws-1-ap-southeast-1.pooler.supabase.com`: `CONNECT_OK row0={"ok":1}`; `billing_core_staging` and `billing_core` each 16 tables (0001+0002 migrations applied). DSN read from vault (owner-provisioned), not inferred; temp DSN removed after probe.
2. **Stripe TEST key** — PRESENT & correct: `sk_test_...` matching pinned `acct_1U2L8zHB4GRCffd9` (matrix evidence). Test only, livemode=false expected.
3. **`STRIPE_WEBHOOK_SECRET`** — PRESENT, real (70 chars, `whsec_0c9...`), NOT placeholder. Owner provisioned 2026-09-12 (registry row `STRIPE__WSTERA_PRODUCTION__SB01_CENTRAL_BILLING__TEST__WEBHOOK_SECRET`).
4. **Stripe listener PID 16168** — ALIVE, command line confirms `stripe.exe listen --forward-to http://127.0.0.1:8787/webhooks/stripe --events checkout.session.completed,...`. Forward target is the Core HTTP webhook route.
5. No Live Stripe, no production mutation, no mock-only downgrade.

## LR-2C State (persisted)

- PRE-01 preflight PASS (`adb2d64`); AGY implement `f22b01a`; Qwen expansion `7a407cd`; canonical Codex INDEPENDENT-QA `FIX_BY_QWEN` (report 15:55); Qwen repair FIX-02/FIX-03 done + gate green (`6309a08`).
- FIX-01 remains open, now unblocked by provisioned real TEST creds.
- Branch parity `0/0` vs `origin/work/sb01-central-billing-pc-20260911` at HEAD `dc9d5cf`. No new task created; this resumes Task SB01-LONG-RUN-2C-2F-001.
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