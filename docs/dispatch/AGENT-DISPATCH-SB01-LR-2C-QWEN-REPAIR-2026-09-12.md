# AGENT DISPATCH — SB01 LR-2C — QWEN REPAIR — 2026-09-12

Task ID: `SB01-LONG-RUN-2C-2F-001`
Assigned Role: `REPAIR WORKER (FIX_BY_QWEN route from fresh INDEPENDENT-QA)`
Selected Agent: `Qwen`
Context Mode: `BUILD` (trusted-repo for authorized bounded remediation/evidence; deterministic path/diff gates)
Workflow: `WF-RELAY-01 v1.2.0`
Runtime: `kanban-external-agent-dispatch v2.3.8`
Work Type: `DIRECT-APPROVED`
Repository: `Gutumrod/stripe-billing`
Workspace: `D:\AI-Workspace\runtime\worktrees\sb01-central-billing-20260909`
Branch / Worktree: `work/sb01-central-billing-pc-20260911` tracking `origin/feature/central-billing-phase2-runtime`
Reviewed Material SHA (bind target): `7a407cda78e4f77a1b328dbcb8689fd8fde2bee5`
Reviewed Branch Head: `e102e3f7679202930cee995b8499b286b8125ab7`
Expected Stop: `READY FOR CODEX LR-2C INFORMED-VERIFY`

## Source of Truth

1. House brief `docs/platform/billing-core/BRIEF-SB01-LONG-RUN-RELAY-PHASE2C-2F-2026-09-12.md` at House commit `fa0691e0236346858c4fbaf4cd3f23075dfe5d13`.
2. `docs/tasks/TASK-SB01-LONG-RUN-2C-2F-001.md`.
3. `docs/relay/RELAY-PLAN-SB01-LONG-RUN-2C-2F-2026-09-12.json`.
4. Fresh canonical Codex INDEPENDENT-QA report: `docs/platform/billing-core/CODE-2-QA-REPORT-SB01-LR-2C-2026-09-12.md` (verdict `FIX_BY_QWEN`).
5. Existing AGY/Qwen LR-2C evidence and material revision `7a407cd`.
6. Accepted Phase 2B material SHA `6be6cb36af42ba2cef62a8f070f0bb8d0a5e2895`.

Do not infer scope from chat history.

## Objective — repair the three findings from the fresh canonical QA report

### FIX-01 (High) — LR-2C real LAB/Stripe-Test vertical-slice evidence is missing
- The QA report requires a bounded TEST-only evidence path that starts the Core HTTP boundary and performs a valid PS01 Stripe **Test** checkout, verifies WSTERA LAB operation/customer/provider mapping rows, and re-fetches the Stripe Test checkout session as financial truth.
- CRITICAL CONSTRAINT: If WSTERA LAB (`billing_core_staging`) or Stripe **Test-only** credentials are **intentionally unavailable** to you in this worker environment, do NOT fabricate. STOP and return a blocked evidence package marked `SOL_OWNER_DECISION_REQUIRED` explaining exactly which credential is missing. Do NOT downgrade the LR-2C acceptance bar to mock-only.
- If credentials ARE available: run a bounded real Test vertical-slice, record redacted counts/IDs (no raw tokens), no live Stripe keys, no production mutation.

### FIX-02 (High) — Denied portal return URL creates a durable operation side effect
- `platform/runtime/src/runtime.ts:366-383` calls `db.beginOperation` before `returnUrl(..., 'portal', returnRef)` for `/v1/portal`. Validate the portal `return_ref` allowlist BEFORE `beginOperation`, so an arbitrary/unallowlisted portal return ref creates NO new `/v1/portal` operation row, NO audit row, NO provider/customer side effect.
- Update `platform/runtime/tests/negative-authority-matrix.test.mjs` (around lines 864-870) so the denied-portal test asserts zero new operation/audit/customer/provider row for an arbitrary portal return ref.
- Preserve existing idempotency behavior for valid portal requests.

### FIX-03 (Low) — Material range diff-check is not clean from accepted Phase 2B baseline
- `git diff --check 6be6cb36af42ba2cef62a8f070f0bb8d0a5e2895 <new_sha>` fails on
  `docs/platform/billing-core/EVIDENCE-SB01-LR-2C-AGY-2026-09-12.md:153: new blank line at EOF`.
- Remove only the introduced trailing blank line at EOF in that AGY evidence file (whitespace-only,
  no content/behavior change). Do not rename or alter any fixture constant.

## Allowed Write Scope

- `platform/runtime/src/runtime.ts` ONLY for the FIX-02 portal `beginOperation` ordering (bounded, authority-preserving).
- `platform/runtime/tests/negative-authority-matrix.test.mjs` for the FIX-02 denied-portal assertion update.
- `docs/platform/billing-core/EVIDENCE-SB01-LR-2C-AGY-2026-09-12.md` whitespace EOF only (FIX-03).
- `docs/platform/billing-core/EVIDENCE-SB01-LR-2C-QWEN-2026-09-12.md` — update to record the repairs.
- New bounded test/evidence file under `platform/runtime/tests/` or `docs/platform/billing-core/` if the FIX-01 real Test path requires a runner; keep it explicit and non-production.

If any repair requires a migration/schema change, new billing-authority decision, production mutation, architecture contradiction, or a real credential you cannot obtain, STOP and return a blocked evidence package. Do not invent a workaround.

## Explicitly Prohibited

- no Phase 2D/2E/2F work;
- no live Stripe keys, live charges, production DB/provider mutation, deploy, merge, release;
- no Control Plane implementation; no BK01/MT01/PromptPay work;
- no renaming/altering committed test-fixture constants merely to dodge a secret scanner;
- no broad stderr whitelist addition;
- no scope expansion or agent substitution;
- no secret values in code, logs, evidence, commit messages, or return payload.

## Required Checks Before Return (from exact returned revision)

- `npm run build` PASS; `npm run typecheck` PASS; `npm test` (runtime) PASS; `npm test` (profile-registry) PASS;
- `git diff --check` PASS;
- `git diff --check 6be6cb36af42ba2cef62a8f070f0bb8d0a5e2895 <new_sha>` PASS (FIX-03 resolved);
- inspect intended diff: no prohibited-path change, fixture constants unchanged;
- commit and push exact revision; branch parity recorded.

Do not claim LR-2C PASS. You are not the verifier; Codex `INFORMED-VERIFY` follows.

## Required Evidence Artifact

Update `docs/platform/billing-core/EVIDENCE-SB01-LR-2C-QWEN-2026-09-12.md` to record:
- exact base revision (`7a407cd`);
- exact returned commit SHA;
- changed files;
- per-finding: what was changed and actual check results;
- FIX-01: if you ran a real Test path, redacted evidence counts/IDs and that it was Test-only; if you could NOT (credential unavailable), the exact missing credential + blocked marker `SOL_OWNER_DECISION_REQUIRED`;
- FIX-02: proof the denied portal return ref now creates no operation/audit/customer/provider row;
- FIX-03: proof the material-range diff-check is now clean;
- blockers / untested areas; deviation = NONE or exact deviation; actual stop.

## Return Contract

Return to Hermes with:
- exact commit SHA;
- changed files;
- checks/results;
- evidence path;
- per-finding resolution status (FIX-01 / FIX-02 / FIX-03);
- if any finding was blocked (`SOL_OWNER_DECISION_REQUIRED`), state it explicitly;
- deviation;
- actual stop = `READY FOR CODEX LR-2C INFORMED-VERIFY` OR `SOL_OWNER_DECISION_REQUIRED`.
