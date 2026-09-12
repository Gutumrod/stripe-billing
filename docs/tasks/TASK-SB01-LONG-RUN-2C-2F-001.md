# TASK — SB01-LONG-RUN-2C-2F-001

Status: `LR-2C FAIL-CLOSED — AWAITING REAL TEST CREDS (STRIPE_WEBHOOK_SECRET + BILLING_DATABASE_URL) — HOLD`
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
Current Worker: `Hermes (clerk) — fail-closed awaiting provisioned real TEST creds`
Current Checkpoint: `HOLD — FIX-01 requires real STRIPE_WEBHOOK_SECRET + canonical WSTERA LAB BILLING_DATABASE_URL`
Expected Stop: `OWNER/SOL: provision + verify the two TEST creds, then continue Qwen FIX-01`
Next Allowed Action: No Qwen dispatch, no re-scope, no mock-only downgrade until both real TEST creds are provisioned and Hermes has verified them (connectivity + signature) fail-closed.

## LR-2C Owner Decision (2026-09-12, reaffirmed)

Owner decided **A — KEEP REAL TEST VERTICAL-SLICE**:
- Do NOT re-scope FIX-01 to mock-only.
- Keep LR-2C fail-closed until the real TEST-only `STRIPE_WEBHOOK_SECRET` and the canonical WSTERA LAB
  `BILLING_DATABASE_URL` are provisioned AND verified.
- Do NOT fabricate, infer, or persist secrets in Git/logs/evidence.
- Once both credentials are valid: continue Qwen FIX-01 on the real vertical slice, run deterministic
  gates, then fresh Codex verification on the exact returned revision.

## Credential audit (Hermes, real, no fabrication)

Checked against canonical vault `D:\AI-Workspace\.secrets\keys.txt` and live probes:
- `STRIPE_SECRET_KEY` (Test) — PRESENT & matches pinned `acct_1U2L8zHB4GRCffd9` (matrix evidence).
- `STRIPE_WEBHOOK_SECRET` (Test) — **ABSENT / placeholder**: vault line = comment
  `STRIPE_WEBHOOK_SECRET_BOOKING2= -- not issued yet. Generated when the webhook endpoint is...`.
- `BILLING_DATABASE_URL` (WSTERA LAB) — **no canonical DSN in vault**; a DSN assembled from
  `postgres.ykxlqnshaaxmzzocpjlj` did NOT connect (`ENOTFOUND tenant/user ... not found`).
- Hermes did NOT commit/copy any secret; temp DSN removed after probe.

Per Owner decision, Hermes remains fail-closed and will NOT dispatch Qwen FIX-01 until a real
`STRIPE_WEBHOOK_SECRET` and a connectivity-verified canonical `BILLING_DATABASE_URL` are provided.

## Blocked artifacts

- FIX-02/FIX-03 already repaired + gate green (build/typecheck/runtime 42-42/registry 16-16/diff-check
  clean at `6309a08`); repair material `e61a8f7`.
- Fresh canonical Codex INDEPENDENT-QA (full provenance) verdict `FIX_BY_QWEN` (report 15:55).
- FIX-01 remains open pending the two real TEST creds above.
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