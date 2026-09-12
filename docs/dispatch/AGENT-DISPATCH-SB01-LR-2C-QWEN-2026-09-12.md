# AGENT DISPATCH — SB01 LR-2C — QWEN — 2026-09-12

Task ID: `SB01-LONG-RUN-2C-2F-001`
Assigned Role: `SECONDARY WORKER / NEGATIVE-AUTHORITY + TEST EVIDENCE EXPANSION`
Selected Agent: `Qwen`
Context Mode: `BUILD` (trusted-repo for authorized evidence/test expansion)
Workflow: `WF-RELAY-01 v1.2.0`
Runtime: `kanban-external-agent-dispatch v2.3.8`
Work Type: `DIRECT-APPROVED`
Repository: `Gutumrod/stripe-billing`
Workspace: `D:\AI-Workspace\runtime\worktrees\sb01-central-billing-20260909`
Branch / Worktree: `work/sb01-central-billing-pc-20260911` tracking `origin/feature/central-billing-phase2-runtime`
AGY Returned Revision (pin): `f22b01af309a769c642a3318c56c841fb88d82c0` (AGY exact returned commit SHA, confirmed by AGY return stdout/provenance)
Dispatch Base Revision: `f22b01a` (AGY LR-2C implement commit; branch HEAD at `9001795` with evidence SHA correction, code tree identical to `f22b01a`)
Expected Stop: `READY FOR CODEX LR-2C INDEPENDENT QA`

## Source of Truth

1. House brief `docs/platform/billing-core/BRIEF-SB01-LONG-RUN-RELAY-PHASE2C-2F-2026-09-12.md` at House commit `fa0691e0236346858c4fbaf4cd3f23075dfe5d13`.
2. `docs/tasks/TASK-SB01-LONG-RUN-2C-2F-001.md`.
3. `docs/relay/RELAY-PLAN-SB01-LONG-RUN-2C-2F-2026-09-12.json`.
4. AGY LR-2C agent dispatch `docs/dispatch/AGENT-DISPATCH-SB01-LR-2C-AGY-2026-09-12.md` and AGY evidence `docs/platform/billing-core/EVIDENCE-SB01-LR-2C-AGY-2026-09-12.md`.
5. Existing Phase 2A/2B source and evidence, including accepted Phase 2B material SHA `6be6cb36af42ba2cef62a8f070f0bb8d0a5e2895`.
6. Actual source/tests at dispatch base revision.

Do not infer scope from chat history.

## Objective

This is worker pass 2 of LR-2C. AGY (pass 1) established the SB01 Core HTTP boundary and PS01 Stripe Test checkout slice at commit `f22b01a`. Your role is **bounded negative-authority / test / evidence expansion** on top of AGY's exact returned SHA — NOT reimplementation of the HTTP boundary.

Produce additional tests and evidence that prove, through the real HTTP/runtime boundary, that the caller cannot override or spoof server-side authority. Cover the mandatory negative-authority matrix from the House brief where applicable to LR-2C scope:
- Product ID/code;
- environment;
- account identity / invalid account assertion;
- Stripe Product/Price mapping;
- amount;
- currency;
- Stripe Customer ID;
- arbitrary success/cancel/portal return URL;
- profile version;
- cross-Product credential use;
- replayed/expired operation authority.

For every denied request, prove no provider object creation and no durable billing side effect.

Keep the existing AGY implementation intact. Do not redesign the HTTP boundary or change its server-side authority model.

## Allowed Work (write scope)

- `platform/runtime/tests/**` — add/expand negative-authority and evidence tests.
- `docs/platform/billing-core/EVIDENCE-SB01-LR-2C-QWEN-2026-09-12.md` — your evidence artifact.
- `platform/runtime/src/**` ONLY if a minimal, justified, additive change is required to make a negative-authority path testable/closed, and only if it does NOT alter AGY's locked authority model; state the justification in your return.

You may read the broader repository and locked Source of Truth.

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
- no silent rewrite of AGY's HTTP boundary or its server-side authority behavior;
- no secret values in code, logs, evidence, commit messages, or return payload.

If LR-2C requires a migration/schema change, new billing authority decision, production mutation, or architecture contradiction, STOP and return a blocked evidence package. Do not invent a workaround.

## Required Checks Before Return

At minimum, from the exact combined revision (AGY `f22b01a` + your additions):
- runtime build PASS;
- runtime typecheck PASS;
- relevant runtime tests PASS (AGY's 23 + your negative-authority additions);
- existing baseline runtime suite remains green;
- Product Billing Profile Registry regression remains green where applicable;
- `git diff --check` PASS;
- inspect intended diff and confirm no prohibited path changes;
- commit and push exact revision;
- branch parity recorded.

Do not claim LR-2C PASS. You are not the verifier.

## Required Evidence Artifact

Create/update:
`docs/platform/billing-core/EVIDENCE-SB01-LR-2C-QWEN-2026-09-12.md`

Evidence must state:
- exact base revision (`f22b01a`);
- exact returned commit SHA;
- changed files;
- negative-authority test/evidence summary tied to LR-2C requirements;
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
- actual stop = `READY FOR CODEX LR-2C INDEPENDENT QA`.

Hermes must persist the return and update the Task checkpoint before dispatching Codex `INDEPENDENT-QA`.
