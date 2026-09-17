FINAL AUDIT REPORT - SB01 LR-2D

Revision / workspace:
- `git rev-parse HEAD` = `c59fc85d3f996d571ebed68c27f4dad7ac9f9be1`
- `git rev-parse c59fc85` = `c59fc85d3f996d571ebed68c27f4dad7ac9f9be1`
- `git rev-parse c59fc85^` = `7510715175fad3a64cbd69fdd385e93de8ff25fa`
- `origin/work/sb01-central-billing-pc-20260911` = `c59fc85d3f996d571ebed68c27f4dad7ac9f9be1`
- Workspace is detached HEAD. `git status --porcelain=v1 -uall` shows one untracked file: `docs/dispatch/AGENT-DISPATCH-SB01-LR-2D-CODEX-QA-2026-09-17.md`.
- Ignored observed: `platform/runtime/dist/`, `platform/runtime/node_modules/`, `platform/profile-registry/dist/`, `platform/profile-registry/node_modules/`.

Diff scope:
- `7510715..c59fc85` adds only:
  - `docs/platform/billing-core/EVIDENCE-SB01-LR-2D-CLAUDE-2026-09-17.md`
  - `docs/relay/LR2D-RECONCILE-SLICE-RUN-2026-09-17.log`
  - `platform/runtime/scripts/run-sb01-lr2d-reconcile-slice.mjs`
- The source fix is inherited from `0f85b6e2213c6ec77f6149fd44d5a74c04029094`, which changed `platform/runtime/src/db.ts` and added the LR-2D real-Postgres suite.

Claims verified / falsified / unverifiable:

1. Source defect fixed: VERIFIED.
- `platform/runtime/src/db.ts:22-44` preserves both `dead_letter` and `completed` in status, next attempt, lease owner, and lease expiry conflict branches.
- `platform/runtime/src/db.ts:53-64` mirrors the same behavior in `resolveOutboxConflict`.
- `platform/runtime/src/db.ts:363-368` and `platform/runtime/src/db.ts:463-468` use the shared conflict clause on the two reconcile outbox enqueue paths.
- `docs/platform/billing-core/migrations/0002_multi_product_billing_runtime.sql:424-426` contains the completion check requiring `completed_at` only for `completed`.
- Direct execution passed: `node tests/outbox-lease-conflict.test.mjs` = 6/6, and `node tests/outbox-conflict-sql-qualification.test.mjs` = 4/4.

2. Build/typecheck/test claims: PARTIALLY REPRODUCED, NOT FALSIFIED.
- `npm run typecheck` in `platform/runtime` passed exit 0.
- `git diff --check` passed exit 0.
- `npm run build`, `npm test`, and `platform/profile-registry npm test` could not be reproduced through npm because this sandbox is read-only and TypeScript could not write existing `dist` files: `TS5033 EPERM`.
- `node --test tests/*.test.mjs` and profile-registry `node --test tests/*.test.js` also hit `spawn EPERM`.
- Direct single-process profile tests passed: `node tests/profile-registry.test.js` = 8/8 and `node tests/concurrency-scenarios.test.js` = 8/8.
- Persisted evidence claims runtime `58/58` and registry `16/16`; I could not fully rerun those aggregate gates here due sandbox process/write restrictions.

3. Real-Stripe slice: VERIFIED WITH ONE ENVIRONMENT-LIMITED RERUN.
- Persisted log `docs/relay/LR2D-RECONCILE-SLICE-RUN-2026-09-17.log` records 32/32 PASS, exit 0, including real signed subscription create, durable claim, reconcile from provider truth, duplicate idempotency, completed-job non-resurrection, mismatch rejection, unmapped skipped/no outbox, cancel revoke v2, and cleanup.
- I reran `node scripts/run-sb01-lr2d-reconcile-slice.mjs`. It reached real Stripe TEST + WSTERA LAB and passed 30/31 before failing only the unmapped fixture phase because `stripe` CLI was not on PATH in this environment.
- The rerun independently verified live checkout/customer mapping, real subscription event claim, reconcile completion, grant v1, raw-body duplicate replay, no second event/outbox/sink version, completed job still `completed`, foreign-price `RECONCILE_PRICE_MISMATCH` with no mutation, cancellation revoke v2, and cleanup.
- Post-rerun LAB recount for the scoped account/key returned 0 rows in all scoped runtime tables and credential binding.

4. Invariants intact: VERIFIED.
- Server-side authority rejects caller-controlled unknown fields at `platform/runtime/src/runtime.ts:32-47`.
- Test-only runtime/schema gates are at `platform/runtime/src/runtime.ts:75-82`.
- Webhook fail-closed paths are at `platform/runtime/src/webhook.ts:15-27` and `platform/runtime/src/webhook.ts:74-109`.
- Reconcile uses provider truth via `retrieveSubscription` then validates account, price, product, amount, currency, period, and metadata before mutation at `platform/runtime/src/runtime.ts:501-584`.
- Live provider object and live job denial remain at `platform/runtime/src/runtime.ts:502` and `platform/runtime/src/runtime.ts:515-516`.
- No schema, migration, dependency, or control-plane source file changed in `7510715..c59fc85`.
- Protected Skill was not in the repository diff.

5. Declared non-blocking finding: VERIFIED NON-BLOCKING.
- `platform/runtime/src/webhook.ts:118-124` can derive `providerObjectId` as null for mapped non-subscription events.
- `platform/runtime/src/db.ts:359-372` still enqueues reconcile for any mapped event.
- `platform/runtime/src/runtime.ts:501-503` then fails closed with `REQUEST_FIELD_REQUIRED`.
- This consumes queue capacity but does not mutate billing state. It is a valid Decision Gap, not an LR-2D closure blocker.

6. Residual entitlement JSONB gap: VERIFIED AS RESIDUAL, NOT BLOCKING.
- Remaining JSONB persistence sites in `platform/runtime/src/db.ts` use `tx.json` / `this.sql.json`, not `JSON.stringify(...)` bound into `$n::jsonb`: relevant lines include `344-351`, `366-370`, `466`, `570-575`, `586-590`, `619`.
- No remaining `JSON.stringify` + `::jsonb` persistence site was found in `platform/runtime/src/**`.
- Entitlement JSONB sites are source-audited and covered by parity/slice behavior, but there is still no dedicated standalone real-Postgres entitlement JSONB scalar regression test. Non-blocking as declared.

Required §5 checks:
- JSONB unsafe audit: VERIFIED. Only `sql.unsafe` JSON-bearing SQL sites bind JSON through `tx.json`/`sql.json`; `sql.unsafe` at `db.ts:468` injects the shared conflict clause, not user JSON.
- Real concurrency: VERIFIED BY SOURCE TEST and persisted suite. `platform/runtime/tests/outbox-lease-reconcile-crash-window-real-db.test.mjs:268-301` uses two independent `BillingDb` instances and `Promise.all`; `db.ts:382-388` uses `for update skip locked`.
- Crash-window claims: VERIFIED BY SOURCE TEST and persisted suite. Webhook durable-before-processing is tested at `outbox-lease-reconcile-crash-window-real-db.test.mjs:542-598`; entitlement durable-before-sink and forced redelivery exactly-once at `611-673`.
- Duplicate/stale replay: VERIFIED in source and live rerun. Completed job remained `completed`; no completion-check violation occurred.
- Harness gates / secrets / cleanup: VERIFIED. Harness refuses non-`sk_test_` and non-`whsec_`; negative gate runs exited 1 before DB/provider work. Harness logs masked/prefix-only credential metadata. Cleanup counts were printed and my recount showed zero scoped rows after rerun.
- Provider truth over caller/DB state: VERIFIED at `runtime.ts:515-584`; provider snapshot controls mutation and mismatch codes.
- Control Plane boundary: VERIFIED. LR-2D diff does not touch control-plane files or payment-action boundary code.

Findings:
- No blocking product findings.
- Non-blocking Decision Gap: mapped non-subscription events can enqueue guaranteed-fail reconcile jobs (`webhook.ts:118-124`, `db.ts:359-372`, `runtime.ts:501-503`).
- Residual test gap: no dedicated standalone entitlement-path JSONB real-Postgres scalar regression test.

Commands run:
- `git rev-parse HEAD`, `git rev-parse c59fc85`, `git rev-parse c59fc85^`
- `git status --porcelain=v1 -uall`, `git status --porcelain=v1 -uall --ignored=matching`
- `git rev-parse origin/work/sb01-central-billing-pc-20260911`
- `git diff --stat/name-status 7510715..c59fc85`, `git diff --name-status 0f85b6e..c59fc85`
- `rg` audits for conflict clause, JSONB sites, Control Plane, Protected Skill references
- `npm run typecheck` in runtime: pass
- `git diff --check`: pass
- `npm run build`, `npm test`, profile `npm test`: blocked by sandbox `EPERM`
- Direct tests: outbox conflict 6/6, SQL qualification 4/4, profile registry 8/8, profile concurrency 8/8
- Real harness rerun: 30/31, failed only because local `stripe` CLI unavailable for unmapped trigger
- Read-only LAB recount after rerun cleanup: all scoped counts 0

Residual limitations:
- Aggregate npm test/build gates could not be fully rerun because the managed filesystem is read-only and Node test runner child-process spawn is blocked.
- I could not reproduce the unmapped fixture trigger locally because `stripe` CLI is unavailable on PATH, but the persisted 32/32 run proves it and source logic matches the claim.

VERDICT: PASS