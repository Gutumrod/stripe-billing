# Module Reuse Check — HOUSE-SB01-REAL-MONEY

## Decision

- Module Reuse Check: COMPLETE
- MT01 Bootstrap Check: PASS
- Reuse Gate: PASS
- Target: `Gutumrod/stripe-billing` at pre-build base `a7d65834326b22a460d0d0cb12dab2b4e657232b`
- Canonical Module Hub source inspected: `Gutumrod/modules-hub` `origin/main` at `f9dee01ecb797baa634e0e2a6a1498fdfdd8df37`
- MT01 reference inspected: `saas-product-hub/products/multi-tenant-ai` `master` at `92139cfa4697fbade1a023d76dc4734dd82d5862`; local checkout is behind origin and contains unrelated dirty/untracked work, so it was read-only and no files were copied from it.

## Source-of-Truth References

- `docs/platform/BILLING_CORE_PLAN.md` (locked central billing architecture; Project A dedicated schema, Hono/Cloudflare Worker, scheduled handler, private schema, profile authority)
- `docs/platform/PORTFOLIO_PRODUCTION_MASTER_PLAN.md` (R3, §§3.2, 3.4, 4, 10)
- `docs/platform/MODULE-REUSE-POLICY.md`
- `docs/platform/billing-core/HANDOFF-SB01-LR2FA-CLOSED-HOUSE-T4-INTEGRATION-2026-09-20.md` at implementation `96abe085004f61a029d2519615ec8aa575384b89`
- `platform/runtime/src/{runtime,db,stripe,webhook}.ts`, `platform/profile-registry/src/*`, migrations and current runtime tests on base SHA above
- `D:\AI-Workspace\vault\06-Agent-Logs\WSTERA-House\STATUS-HOUSE.md` L-03/L-07/L-10/L-11, CD-01–CD-04, Addendum A-2/A-9/A-10/A-11
- Task-specific Owner-approved brief `D:\AI-Workspace\vault\06-Agent-Logs\WSTERA-House\briefs\codex-parallel-20260927\13-SB01-CENTRAL-BILLING-REAL-MONEY.md`
- `D:\AI-Workspace\vault\06-Agent-Logs\WSTERA-House\refs\MODULE-HUB-COMMERCIAL-RULES-LOCKED-2026-09-24.md` (perpetual source license; 12 months of included updates; prices, pack membership, renewal price and checkout/delivery mechanics remain open)
- The referenced path `docs/council-billing-core-multiproduct-2026-09-07/OWNER-DIRECTIVE-CONTROL-PLANE-BILLING-BOUNDARY-2026-09-11.md` is absent from the current SaaS Product Hub checkout and Vault file list. The actual boundary is independently recorded in `STATUS-HOUSE.md` L-03 and `docs/platform/BILLING_CORE_PLAN.md`; this check relies on those available canonical records and does not recreate or invent the missing directive.

## MT01 Bootstrap Check

MT01 is applicable as the internal SaaS/backend reference per Module Reuse Policy §4. Inspected MT01 root README, `docs/CURRENT_STATUS.md`, `server/src/routes/payment-demo.ts`, `server/src/app.ts`, `server/src/lib/payments.ts`, and the webhook/subscription/tenant-context module surfaces.

- Tenant/auth seam: the reference server has tenant context and auth/provider modules, but the example routes are Express and are not the central billing service's runtime identity contract.
- Webhook seam: MT01 mounts raw-body Stripe verification and demonstrates webhook mapping; README/CURRENT_STATUS explicitly mark the server as an in-memory/demo reference with no production database.
- Central-platform seam: no durable, production-shaped SB01 adapter or billing database is provided by MT01; its payment demo is not a substitute for SB01.
- SB01 already owns credential-pinned product/environment identity, account assertions, profile resolution, raw-body signature verification, durable event claim/outbox, reconciliation, and the read-only Control projection.

**Result: PASS as a reference check.** Keep the existing SB01 identity and persistence contracts. Do not copy MT01 runtime code or add a runtime dependency on the sellable source product.

## Required Capabilities and Module Decisions

| Capability | Candidate inspected | Classification | Evidence and decision |
|---|---|---|---|
| Request-scoped product/account/environment identity | Existing SB01 profile registry + credential/assertion boundary | USE (existing destination-owned capability) | Exact product/environment/profile/account scope is already enforced by SB01; preserve it and do not substitute an MT01/demo resolver. |
| Subscription checkout / portal and provider mapping | Existing SB01 `StripeTestAdapter` + versioned profile registry | USE + ADAPT (existing destination-owned capability) | Current SB01 is the reviewed central payment authority and resolves price from a pinned profile. Extend it in place; products still send a package identifier only. |
| Stripe payment/refund abstraction | Module Hub `modules/payment` v0.1.1, source `f9dee01` | REJECT WITH JUSTIFICATION | Current canonical `stripe-adapter.ts` still passes `request.paymentId` directly as `payment_intent` and maps missing event/payment identifiers to `evt_unknown`/`unknown_id` (verified at source lines ~312, 346, 392); checkout uses amount/inline `price_data`, not the locked versioned price mapping; module tests mock `fetch` only and provide no durable multi-product ledger, reconciliation, or entitlement transition. These conflicts/defects make a straight copy unsafe for money flows. Copying/owning it and repairing all boundaries would duplicate or bypass the existing SB01 provider/ledger architecture. |
| Subscription/entitlement engine | Module Hub `modules/subscription` v0.1.0 and MT01 copy | REJECT WITH JUSTIFICATION | Account-only repository interface and module-local lifecycle do not carry SB01's product/environment/profile-version/provider event identity or atomic DB/outbox transaction boundary. SB01 already has the platform-owned authoritative lifecycle. |
| Webhook signature receiver | Module Hub `webhook-receiver` v0.1.0 and MT01 copy | NOT APPLICABLE | Signature verification is already handled on the raw body by SB01; the reusable receiver delegates persistence/idempotency to an injected store and cannot replace SB01's atomic claim/outbox. Keep its existing verified ingress and avoid a second receiver layer. |
| Audit log | Module Hub `audit-log` v0.1.0 | NOT APPLICABLE | The money transition audit must commit atomically with the SB01 event/operation ledger. A separate generic writer would weaken this invariant. |
| Refund → monotonic entitlement revoke/reconcile | Existing SB01 transition + outbox + reconciliation primitives | USE + ADAPT | Extend the destination-owned financial lifecycle with refund facts while preserving event dedupe, provider re-fetch, monotonic transition order, and durable delivery. Refund policy is a versioned profile reference, not a shared constant. |
| Multi-currency/versioned package prices | Existing profile registry | USE + ADAPT | Extend the existing registry contract and admission tests; fixed THB/USD amounts come only from Owner A-2/A-10. Do not add automatic FX conversion. |
| `one_time` Module Hub purchase | Existing SB01 runtime + Stripe Checkout adapter | USE + ADAPT | Use the central profile and account-scoped ledger, with mode derived from the server-owned plan. Do not delegate source-product entitlements to MT01 or the generic Module Hub in-memory module. Locked commercial rules grant perpetual use of the purchased source/version plus 12 months of updates. Prices, packs, renewal after year one, license/legal text, and delivery mechanics remain open; no active priced Module Hub profile may be created from guesses. |
| Hosting/server runtime | `BILLING_CORE_PLAN.md` Hono/Workers design vs current Node adapter | MISSING CAPABILITY / RELEASE BLOCKER | Current repo has Node `server.mjs` and `postgres` dependency, no Worker manifest/Hono runtime; the locked target is Hono on Cloudflare Worker with internal `scheduled()`. No deployment claim can be made from this branch until a separate compatibility/adapter proof exists. This feature branch must keep migrations and local tests offline. |

## Missing Capabilities

- Environment-gated production mode with a production-only live credential/object path while default/test configurations remain fail-closed for live objects.
- Versioned PS01 prices in THB and USD with profile-owned plan identifiers and customer-visible locale/currency binding.
- Subscription refund event intake, provider-truth reconciliation, and idempotent monotonic entitlement revoke.
- A bounded, auditable one-time checkout and permanent purchase entitlement delivery for Module Hub, subject to its current commercial/update entitlement rules.
- Worker/Hono deployment adapter and Project A staging role/schema activation remain separately gated by the locked infrastructure plan and Owner actions.

## Provenance Plan

- No Module Hub or MT01 files are copied into `stripe-billing`; therefore no cross-repository runtime dependency or copied-module provenance record is created.
- Implementation extends the existing destination-owned SB01 runtime/profile registry. Keep upstream fixes in Module Hub as a separate upstream task; do not patch Module Hub inline.
- If a later independently reviewed task selects a reusable module, copy the full reviewed module into `platform/runtime/vendor/modules/`, record immutable source SHA/version/date/local delta here, and verify the copy; do not use a filesystem dependency.

## Gate Rationale

The accepted boundary is central platform → versioned profile → Stripe → reconciliation → entitlement adapter → product-owned state. This phase adds missing financial models to the existing central authority while preserving identity, atomic durability, and read-only Control. `Reuse Gate: PASS` authorizes only the listed source/runtime scope; it does not authorize production secrets, DB apply, Worker deployment, Stripe live, PromptPay, or Control mutation capability.

## Round 2 pre-build delta — 2026-09-28

The Round 2 implementation remains in `Gutumrod/stripe-billing` on the task-owned branch based at `569517aa39eb58d84e6a72cf32f4fd601a03cd2f`. The earlier hosting row above records the prior-round state and is superseded by this delta:

| Capability | Current decision/evidence |
|---|---|
| Hono + Cloudflare Worker | USE + ADAPT existing SB01 runtime; Hono `fetch` delegates to `CentralBillingRuntime`, and internal `scheduled()` drains at most 20 jobs. No module reuse applies. |
| Postgres in Worker/local | USE existing `postgres@3.4.5` adapter via Hyperdrive; disposable embedded PostgreSQL is used only for localhost tests. No hosted DB or Docker. |
| Module Hub catalog identity | Product IDs follow the eight `modules-hub/modules/<slug>` folder names; the only bundle ID is `module-hub-bundle-8`. The storefront `saasProductCatalog` contains only ServiceBooking, ClientCRM, StockPilot, and FlowAutomate, so none of the eight Module Hub SKUs is listed there. Folder names govern as Owner directed; report the catalog gap. |
| Stripe TEST catalog script | Destination-owned script constructs Stripe TEST Products/Prices from versioned profile data and rejects any key outside the `sk_test_`/`rk_test_` prefixes. It is not executed in this task. |
| Migration 0001 | Exact copy from `saas-product-hub` at `94ce432121b7bc79914fe22c976dab83745b8e50`; byte hash and source path are recorded in `MIGRATION-PROVENANCE-0001.md`. Copy is used for disposable local qualification only. |

The earlier `Reuse Gate: PASS` still applies: the Worker framework is a hosting adapter around existing SB01 capability, not a copied shared billing/payment module. This delta does not authorize a real deploy, hosted migration, Stripe API call, or profile activation.
