# AGENT DISPATCH — SB01 LR-2C — CODEX INDEPENDENT QA — 2026-09-12

Task ID: `SB01-LONG-RUN-2C-2F-001`
Assigned Role: `HEAD VERIFIER / CHECKPOINT AUTHORITY`
Selected Agent: `Codex`
Context Mode: `INDEPENDENT-QA`
Workflow: `WF-RELAY-01 v1.2.0`
Runtime: `kanban-external-agent-dispatch v2.3.8`
Work Type: `DIRECT-APPROVED`
Repository: `Gutumrod/stripe-billing`
Workspace: `D:\AI-Workspace\runtime\worktrees\sb01-central-billing-20260909`
Branch / Worktree: `work/sb01-central-billing-pc-20260911` tracking `origin/feature/central-billing-phase2-runtime`
Target Revision — EXACT MATERIAL IMPLEMENTATION: `7a407cda78e4f77a1b328dbcb8689fd8fde2bee5`
Target Revision — BRANCH HEAD (contains 7a407cd + two docs-only pin commits): `e102e3f7679202930cee995b8499b286b8125ab7`
Expected Stop: `CODE-2 ROUTING VERDICT` (exactly one of: PASS | FIX_BY_AGY | FIX_BY_QWEN | SEND_TO_CLAUDE | SOL_OWNER_DECISION_REQUIRED)

## Independence Notice

This is an INDEPENDENT-QA first pass. You are verifying the exact material revision listed above
against the neutral locked requirements below. You must not be influenced by any prior worker PASS
claim, suspected defect hint, implementation rationale, changed-file hint, or expected verdict.
Report your own independent findings from the actual source and evidence.

## Source of Truth — read before verification

1. House brief: `docs/platform/billing-core/BRIEF-SB01-LONG-RUN-RELAY-PHASE2C-2F-2026-09-12.md` (locked at House commit `fa0691e0236346858c4fbaf4cd3f23075dfe5d13`).
2. `docs/relay/RELAY-PLAN-SB01-LONG-RUN-2C-2F-2026-09-12.json`.
3. `docs/tasks/TASK-SB01-LONG-RUN-2C-2F-001.md`.
4. Actual source/tests at the target revision.
5. Existing Phase 2B source/evidence and accepted Phase 2B material SHA `6be6cb36af42ba2cef62a8f070f0bb8d0a5e2895`.

Do not infer scope from chat history.

## LR-2C Objective (neutral locked requirements to verify)

LR-2C = "HTTP + Stripe Test vertical slice". The implementation must:
- establish the SB01 Core HTTP boundary (HTTP entry inside SB01 Core authority);
- exercise a valid PS01 Test checkout through the Core API, not a direct provider shortcut;
- persist/verify operation, customer, and provider mappings in WSTERA LAB;
- re-fetch the Stripe Test object as financial truth where the locked design requires;
- keep product/environment/Price ID/amount/currency/provider-customer/return-URL/profile-version authority server-side;
- prove the caller cannot override Product, environment, Price ID, amount, currency, provider customer, return URLs, or profile version.

## Mandatory negative-authority matrix (fail closed, through the real HTTP/runtime boundary)

For at least: Product ID/code; environment; account identity / invalid account assertion; Stripe Product/Price mapping; amount; currency; Stripe Customer ID; arbitrary success/cancel/portal return URL; profile version; cross-Product credential use; replayed/expired operation authority.
For every denied request, prove no provider object creation and no durable billing side effect.

## Allowed / Prohibited Paths (verifier write scope)

- Allowed write: `docs/platform/billing-core/CODE-2-QA-REPORT-SB01-LR-2C-2026-09-12.md` (your report). You may also create temporary/throwaway local artifacts only if clearly isolated and non-production.
- Prohibited: any product source/test/migration/evidence change; any mutation of `platform/runtime/**`; any commit/push/merge/rebase/reset/clean; any live Stripe, production mutation, deploy, release; any scope widening.
- You are the verifier. Do NOT repair production source. Do NOT patch or rewrite the implementation or the worker evidence files.

## Independent QA Contract

Report (persist to `docs/platform/billing-core/CODE-2-QA-REPORT-SB01-LR-2C-2026-09-12.md`):
- target revision you actually verified;
- exact source paths and evidence you read;
- conformance of the implementation to each LR-2C requirement above;
- independently chosen checks you ran and their actual results (build/typecheck/tests/diff), with output;
- any defect, violation, or evidence gap found;
- risks / untested areas;
- requirement ambiguities;
- one routing verdict: `PASS` | `FIX_BY_AGY` | `FIX_BY_QWEN` | `SEND_TO_CLAUDE` | `SOL_OWNER_DECISION_REQUIRED`.

If you return `FIX_*` or `SEND_TO_CLAUDE`, bind the verdict to the exact SHA/artifact set and include the required acceptance/regression checks for the remediation. If `SOL_OWNER_DECISION_REQUIRED`, state the precise decision needed.

Do not claim this is Owner acceptance. Your verdict is a checkpoint routing decision only.

## Return Contract

Return the exact routing verdict as the first line of your output, plus your report path.
