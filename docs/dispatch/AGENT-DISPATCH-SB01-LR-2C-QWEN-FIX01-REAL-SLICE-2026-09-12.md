# AGENT DISPATCH — SB01 LR-2C — QWEN FIX-01 REAL TEST VERTICAL-SLICE — 2026-09-12

Task ID: `SB01-LONG-RUN-2C-2F-001` (resume; no new task)
Assigned Role: `REPAIR WORKER — FIX-01 REAL TEST VERTICAL-SLICE`
Selected Agent: `Qwen`
Context Mode: `BUILD` (trusted-repo for authorized real-Test evidence; deterministic path/diff gates)
Workflow: `WF-RELAY-01 v1.2.0`
Runtime: `kanban-external-agent-dispatch v2.3.8`
Work Type: `DIRECT-APPROVED`
Repository: `Gutumrod/stripe-billing`
Workspace: `D:\AI-Workspace\runtime\worktrees\sb01-central-billing-20260909`
Branch / Worktree: `work/sb01-central-billing-pc-20260911` tracking `origin/feature/central-billing-phase2-runtime`
Exact Dispatch HEAD (base): `87dc09480c72ffc3701c655cb4f04166a9cd5c5e`
Reviewed material revision (code) still `7a407cd`; FIX-02/FIX-03 repair `6309a08` in HEAD ancestry.
Expected Stop: `READY FOR CODEX LR-2C INFORMED-VERIFY`

## Source of Truth

1. House brief `docs/platform/billing-core/BRIEF-SB01-LONG-RUN-RELAY-PHASE2C-2F-2026-09-12.md` (House commit `fa0691e0...`).
2. `docs/tasks/TASK-SB01-LONG-RUN-2C-2F-001.md` (checkpoint `LR-2C FIX-01 — REAL TEST CREDS READY`).
3. `docs/relay/RELAY-PLAN-SB01-LONG-RUN-2C-2F-2026-09-12.json`.
4. Canonical Codex INDEPENDENT-QA report `docs/platform/billing-core/CODE-2-QA-REPORT-SB01-LR-2C-2026-09-12.md` (verdict `FIX_BY_QWEN`; FIX-01 open).
5. Existing AGY/Qwen LR-2C evidence, material `7a407cd`, repair `6309a08`.
6. Phase 2B DB contract evidence + WSTERA LAB target.

Do not infer scope from chat history.

## Objective — resolve FIX-01: run a REAL (TEST-only) vertical slice

The QA report FIX-01 requires, through the Core HTTP boundary:
- a valid PS01 Stripe **Test** checkout (not a provider shortcut, not mock);
- durable WSTERA LAB `billing_core_staging` rows for operation/customer/provider mapping;
- Stripe Test object re-fetch as financial truth;
- prove server-side authority (product/env/price/amount/currency/customer/return URL/profile) cannot be overridden by the caller;
- record redacted counts/IDs; no raw tokens; no Live Stripe; no production mutation.

Credentials (TEST-only) are provided to you via the worker environment (do NOT read or persist raw secret values into code/logs/evidence/commits):
- `BILLING_DATABASE_URL` — real WSTERA LAB pooler (verified connect PASS by Hermes; `billing_core_staging` 16 tables).
- `STRIPE_SECRET_KEY` — TEST (`sk_test_...`, matches pinned `acct_1U2L8zHB4GRCffd9`; livemode=false).
- `STRIPE_WEBHOOK_SECRET` — TEST (`whsec_0c9...`).
- A live `stripe listen` (PID 16168) forwards to `http://127.0.0.1:8787/webhooks/stripe` — you may exercise webhook intake/signature against it.

## Allowed Write Scope

- `platform/runtime/src/**` ONLY if a minimal, justified, additive change is required for a real-Test path to be testable/closed, preserving the locked authority model; state the justification in return (prefer NOT modifying src).
- `platform/runtime/tests/**` — add a bounded real-Test integration script/test (e.g. `tests/*real-test*.mjs` or a `scripts/run-sb01-lr2c-real-slice.mjs`) that is TEST-gated and refuses non-`sk_test_`.
- `docs/platform/billing-core/EVIDENCE-SB01-LR-2C-QWEN-2026-09-12.md` — record FIX-01 result (redacted).
- No changes to existing locked fixtures/contracts.

If any real-Test step fails, do NOT downgrade to mock or fabricate evidence. Stop and return a blocked evidence package with the exact failure.

## Explicitly Prohibited

- no Live Stripe key, live charge, production DB/provider mutation, deploy, merge, release;
- no Control Plane implementation; no BK01/MT01/PromptPay work;
- no renaming/altering committed test fixtures to dodge a scanner; no broad stderr whitelist;
- no committing/persisting `STRIPE_SECRET_KEY` / `BILLING_DATABASE_URL` / `STRIPE_WEBHOOK_SECRET` raw values in Git, logs, or evidence (redact to prefix/count only);
- no scope expansion, agent substitution, mock-only downgrade.

## Required Checks Before Return (from exact returned revision)

- `npm run build` PASS; `npm run typecheck` PASS; `npm test` (runtime) PASS; `npm test` (profile-registry) PASS;
- `git diff --check` PASS; `git diff --check 6be6cb... <new_sha>` PASS;
- intended-diff review: no prohibited path, no secret committed;
- commit + push exact revision; branch parity recorded.

Do not claim LR-2C PASS; you are not the verifier. Codex `INFORMED-VERIFY` follows.

## Evidence / Return Contract

Update `docs/platform/billing-core/EVIDENCE-SB01-LR-2C-QWEN-2026-09-12.md` (FIX-01 section) to record:
- exact base revision (`87dc09...`) and returned commit SHA;
- real Test vertical-slice performed: which Stripe Test objects/rows (redacted IDs/counts), that livemode=false;
- WSTERA LAB `billing_core_staging` rows verified for operation/customer/provider mapping (redacted);
- Stripe Test object re-fetch as financial truth done/proven;
- server-side authority non-overridability through the real HTTP boundary;
- if webhook signature/portal exercised via listener: redacted confirmation;
- cleanup/rollback evidence; no Live/production mutation.
- blockers / untested areas; deviation = NONE or exact deviation; actual stop.

Return exact commit SHA, changed files, checks/results, evidence path, per-item resolution, actual stop
= `READY FOR CODEX LR-2C INFORMED-VERIFY` OR `SOL_OWNER_DECISION_REQUIRED`.
