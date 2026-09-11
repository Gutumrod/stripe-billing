# SB01 Phase 2B — Runtime DB Contract Evidence

Date: 2026-09-11 (Asia/Bangkok)
Workflow: `WF-DEV-01` v1.1.0
Entry baseline: `049b34aedf97b6b42ed97dae8d0c833513efee3c`
Target: WSTERA LAB `ykxlqnshaaxmzzocpjlj` only
Verdict: `SB01 PHASE 2B DB CONTRACT PASS / READY FOR PHASE 2C REVIEW`

## Source / migration
- Runtime DB calls reviewed from `platform/runtime/src/db.ts`.
- Historical `0001_billing_core_schema.sql` remained unchanged and was applied first from House canonical source.
- Forward migration: `docs/platform/billing-core/migrations/0002_multi_product_billing_runtime.sql`.
- `0002` adds 9 `runtime_*` tables to both `billing_core` and `billing_core_staging`.
- Initial transactional dry-run exposed two generated CHECK-name collisions; only those migration naming defects were repaired before apply.

## LAB evidence
- Pre-apply shared schemas present: `local_service`, `ps01`, `ps01_internal`; no billing schemas.
- Transactional `0001 + 0002` dry-run: PASS and rolled back cleanly.
- Persistent LAB apply: `0001=APPLIED`, `0002=APPLIED`.
- Post-apply: 16 tables per billing schema, including 9 runtime tables each.
- Production/staging column, constraint, and index normalized equivalence: zero diff.
- All Billing Core foreign keys remain inside their own billing schema; no FK reaches shared Product schemas.
- `local_service`, `ps01`, and `ps01_internal` remain present.

## Authority / isolation
- `billing_core_app`: USAGE only on `billing_core`, no CREATE; SELECT/INSERT/UPDATE on 16 tables.
- `billing_core_staging_app`: USAGE only on staging, no CREATE; SELECT/INSERT/UPDATE on 16 tables.
- `anon`, `authenticated`, and `service_role`: no USAGE on either billing schema.
- Runtime provider-event/audit DELETE checks for both app roles: false.
- Transactional DB contract test proves operation idempotency, credential Product binding, same-account cross-Product isolation, provider-customer uniqueness, provider live/test consistency, outbox dedupe, reconciliation isolation, and entitlement FK isolation.
- Test transaction rolled back; persistent Phase-2B fixture count = 0.

## Security advisor disposition
Project-wide `supabase db advisors --type security --fail-on error` is not globally clean because of pre-existing findings in `local_service` and existing project configuration. Filtered review found `ADVISOR_BILLING_CORE_MATCHES=0`; Phase 2B introduced no advisor finding under `billing_core*`. These unrelated findings were not modified or waived by SB01.

## Rollback / cleanup
- Rollback candidate: `docs/platform/billing-core/migrations/0002_multi_product_billing_runtime.rollback.sql`.
- It drops only the 9 runtime tables in each billing schema, preserves `0001` baseline objects/roles, and does not use CASCADE.
- Transactional rollback rehearsal: PASS; rehearsal rolled back and all 9 runtime tables per schema remained afterward.
- No Phase-2B test fixtures remain.

## Local verification
- `npm run build`: PASS.
- `npm run typecheck`: PASS.
- Product Billing Profile regression: 16/16 PASS.
- `git diff --check`: PASS before checkpoint creation.

## Boundary
No production mutation, live Stripe/provider call, Product Billing Profile activation, BK01/MT01/PromptPay integration, Control Plane billing mutation, or Phase 2C HTTP/Stripe Test execution occurred.

Next action: House/Sol review this exact Phase 2B Git checkpoint. Phase 2C remains HOLD until explicit review authorization.