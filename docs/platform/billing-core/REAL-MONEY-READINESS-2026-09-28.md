# SB01 Real-Money Readiness — 2026-09-28

Task: `HOUSE-SB01-REAL-MONEY`  
Branch: `codex/sb01-real-money-20260928`  
Classification: engineering work in progress; **not ready to deploy or accept money**.

## Verified changes in this branch

- Runtime selection accepts `BILLING_ENVIRONMENT=test` or exactly `production`. `production` maps to the internal `live` environment and defaults to `billing_core`; the Stripe adapter requires the matching key prefix. Test remains bound to `billing_core_staging` and rejects live keys, live provider objects, and live webhooks.
- Checkout supports profile-pinned fixed currency prices and requires `locale=th` with THB or `locale=en` with USD. It does not convert currency. Legacy profiles without a currency map continue to resolve only their profile currency.
- Added an unactivated PS01 pricing candidate (profile version 2) with the A-10 monthly/launch-annual prices and a 7-day refund-window data field. Only its Pro monthly THB price points at an existing Stripe TEST Price. All other prices remain unmapped. Annual launch plans have no sales window and are rejected by checkout.
- Added a Stripe Checkout `mode=payment` adapter operation and route selection for profile-pinned one-time plans. There is no active one-time plan or durable one-time entitlement implementation in this branch.
- Existing Control read projection was not changed; it remains read-only and exposes no payment action authority.

## Phase gates

| Phase / gate | State | Evidence or blocker |
|---|---|---|
| Phase 0 preflight | PASS | See Vault report. Base `a7d6583` selected over destructive WIP `9c5e1be`; reuse and MT01 checks passed. |
| Phase 1 G1 environment gate | PARTIAL | Test key/object/webhook rejection remains. Production mode is code-gated by exact environment, `billing_core`, and `sk_live_` prefix. No live profile, production credential, deployed host, DB, or live verification is present. |
| Phase 1 G7 refund revoke | BLOCKED | Subscription cancellation already reconciles to revoke. `charge.refunded` is not yet linked through durable refund reconciliation; no policy-backed monotonic refund transition exists yet. |
| Phase 1 G8 PS01 profile | PARTIAL | Versioned A-10 pricing candidate exists, but three monthly/annual price mappings and all production mappings are absent. Profile is pending and annual offers cannot pass without an approved launch start/end. |
| Phase 1 G9 control projection | PASS (existing) | Existing LR-2F-A implementation and accepted projection tests remain intact; `canExecutePaymentActions` remains false. |
| Phase 2 G4 USD | PARTIAL | Fixed THB/USD amounts are represented; locale mismatch is rejected. USD Stripe Price mapping and a mapped checkout/reconciliation proof are absent. |
| Phase 3 G5 one-time | PARTIAL | `mode=payment` adapter path exists. Missing durable purchase/license entitlement, 12-month update expiry, refund revocation, and Module Hub price prevents activation. |
| Phase 4 runbook / release | BLOCKED | Runtime is still Node `server.mjs`, not the locked Cloudflare Hono Worker + `scheduled()` host. No production migration/deploy is authorized or performed. Readiness ceiling is below BUILD_PASS. |
| G6 PromptPay | OUT OF SCOPE | No implementation; add to later plan as directed. |

## Verification

- `npm ci`: PASS; lockfile install, zero reported vulnerabilities.
- `npm run typecheck`: PASS.
- Focused checkout, authority, mode, and new Stripe adapter tests: 36/36 PASS.
- Full runtime suite: 70 PASS; 3 real-Postgres test files fail before test execution with `BLOCKED_CREDENTIAL: BILLING_DATABASE_URL` (LR-2D, LR-2E, webhook JSONB). No remote/LAB database was used.
- Stripe integration: mock only. The secret file had no SB01/stripe-billing test key; a Booking2 test key was detected by label only and was not loaded or used. No live key was read or used.
- No database migration was applied, no Stripe API was called, no production host was changed, and no deployment occurred.

## Owner actions before a future production release

1. Provide/review Stripe TEST Price mappings for PS01 Starter/Pro monthly and annual THB/USD and webhook/database test access. Do not create or activate production Prices from this worker.
2. Set the actual first-sale launch window for the annual launch offer; without that window the annual plans stay closed.
3. Resolve the Module Hub one-time price and any year-two update-renewal rule before a priced Module Hub profile can be activated.
4. Implement and independently verify `charge.refunded` reconciliation, monotonic entitlement revocation, and durable one-time source-license/update entitlement state with negative and replay tests.
5. Port/adapt the runtime to the locked Cloudflare Hono Worker + internal scheduled execution contract and qualify it against the existing Project A schemas/roles. Preserve the read-only Control contract.
6. Only after code review, prepare the Owner-operated production runbook: secrets by name only, safe-forward migration order and pre-migration dump, rollback, and click-by-click deploy instructions. Owner performs all production DB/host/Stripe-live actions.

## Release decision

**HOLD — do not deploy or accept payment.** The verified code advances guarded mode selection, fixed-currency profile data, and a generic one-time Checkout request, but G7, complete price mappings, durable one-time entitlements, production hosting, database integration evidence, and independent review remain open. This document records current implementation evidence; it does not authorize production actions.
