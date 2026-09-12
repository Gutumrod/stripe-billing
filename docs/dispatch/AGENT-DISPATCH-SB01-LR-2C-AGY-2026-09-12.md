# AGENT DISPATCH — SB01 LR-2C — AGY — 2026-09-12

Task ID: `SB01-LONG-RUN-2C-2F-001`
Assigned Role: `CORE-BUILDER / PRIMARY WORKER`
Selected Agent: `AGY`
Context Mode: `BUILD`
Workflow: `WF-RELAY-01 v1.2.0`
Runtime: `kanban-external-agent-dispatch v2.3.8`
Work Type: `DIRECT-APPROVED`
Repository: `Gutumrod/stripe-billing`
Workspace: `D:\AI-Workspace\runtime\worktrees\sb01-central-billing-20260909`
Branch / Worktree: `work/sb01-central-billing-pc-20260911` tracking `origin/feature/central-billing-phase2-runtime`
Dispatch Base Revision: `ea9778e972c4ce1658c871d85f5841d344d99995`
Expected Stop: `READY FOR QWEN LR-2C HANDOFF`

## Source of Truth

1. House brief `docs/platform/billing-core/BRIEF-SB01-LONG-RUN-RELAY-PHASE2C-2F-2026-09-12.md` at House commit `fa0691e0236346858c4fbaf4cd3f23075dfe5d13`.
2. `docs/tasks/TASK-SB01-LONG-RUN-2C-2F-001.md`.
3. `docs/relay/RELAY-PLAN-SB01-LONG-RUN-2C-2F-2026-09-12.json`.
4. Existing Phase 2A/2B source and evidence, including accepted Phase 2B material SHA `6be6cb36af42ba2cef62a8f070f0bb8d0a5e2895`.
5. Actual source/tests at dispatch base revision.

Do not infer scope from chat history.

## Objective

Implement the AGY portion of LR-2C: establish the SB01 Core HTTP boundary needed for a valid PS01 Stripe Test checkout vertical slice while preserving the locked Central Billing authority model.

The implementation must keep product/environment/price/amount/currency/customer/return URL/profile authority server-side. The caller must not be able to override provider truth or billing profile mappings.

This is the first worker pass only. Qwen will receive a fresh later dispatch against AGY's exact returned SHA for bounded negative-authority/test/evidence expansion before Codex independent verification.

## Allowed Work

- `platform/runtime/src/**`
- `platform/runtime/tests/**` only for minimal direct regressions required to keep AGY's source change coherent and testable
- `platform/runtime/package.json` / lockfile only if a directly required dependency is necessary and justified in the return evidence
- `docs/platform/billing-core/EVIDENCE-SB01-LR-2C-AGY-2026-09-12.md`

AGY may read the broader repository and locked Source of Truth as needed, but may write only the authorized scope above.

## Required LR-2C Implementation Properties

- HTTP entry remains inside SB01 Core authority.
- Valid PS01 Test checkout flows through SB01 Core, not a direct provider shortcut.
- Product/environment/profile/Stripe Product+Price/amount/currency/provider customer/return URLs remain derived from verified server-side context and locked profile data.
- Operation/customer/provider mapping persistence uses the existing Phase 2B DB contract; no schema redesign.
- Provider object re-fetch path is available/used as financial truth where required by the locked design.
- Invalid or spoofed caller fields fail closed.
- No live Stripe mode, production mutation, or Control Plane payment mutation.

## Explicitly Prohibited

- no Phase 2D/2E/2F work;
- no database migration or schema redesign;
- no live Stripe keys, live charges, or production deployment;
- no Product Billing Profile activation/change outside locked Test requirements;
- no Control Plane implementation;
- no BK01/MT01/PromptPay work;
- no merge/release/deploy;
- no architecture/business/security decision invention;
- no scope expansion or agent substitution;
- no secret values in code, logs, evidence, commit messages, or return payload.

If LR-2C requires a migration/schema change, new billing authority decision, production mutation, or architecture contradiction, STOP and return a blocked evidence package. Do not invent a workaround.

## Required Checks Before Return

At minimum, from the actual returned revision:
- runtime build PASS;
- runtime typecheck PASS;
- relevant runtime tests PASS;
- existing baseline runtime suite remains green;
- Product Billing Profile Registry regression remains green where applicable;
- `git diff --check` PASS;
- inspect intended diff and confirm no prohibited path changes;
- commit and push exact revision;
- branch parity recorded.

Do not claim LR-2C PASS. AGY is not the verifier.

## Required Evidence Artifact

Create/update:
`docs/platform/billing-core/EVIDENCE-SB01-LR-2C-AGY-2026-09-12.md`

Evidence must state:
- exact base revision;
- exact returned commit SHA;
- changed files;
- implementation summary tied to LR-2C requirements;
- tests/checks with exact results;
- Stripe Test/LAB operations actually performed, if any;
- confirmation of no live/production mutation;
- blockers/untested areas;
- any deviation from dispatch;
- git status and branch parity;
- actual stop checkpoint.

## Return Contract

Return to Hermes with:
- exact commit SHA;
- branch/worktree;
- changed files;
- checks/results;
- evidence path;
- blockers/limitations;
- git status;
- deviation = NONE or exact deviation;
- actual stop = `READY FOR QWEN LR-2C HANDOFF`.

Hermes must persist the return and update the Task checkpoint before creating the fresh Qwen LR-2C dispatch. AGY must not dispatch Qwen or Codex itself.