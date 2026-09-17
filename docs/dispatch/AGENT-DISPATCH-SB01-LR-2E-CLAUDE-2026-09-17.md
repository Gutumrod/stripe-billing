# AGENT DISPATCH — SB01 LR-2E — Entitlement + Multi-Product Isolation — Claude — 2026-09-17

Task: `SB01-LONG-RUN-2C-2F-001`
Runtime: `kanban-external-agent-dispatch v2.5.1` / `RELAY_STANDARD`
Role: `CORE-BUILDER` (real-execution proof + bounded repair)
Selected agent: `agent-claude` (context mode `BUILD`)
Authorization: LR-2D closed PASS (`docs/relay/PHASE-CLOSURE-LR-2D-SB01-2026-09-17.md`); brief §9
authorizes LR-2E release without an Owner round-trip. `agent-qwen` remains blocked by a proven
executor defect (exit 55), so the healthy admissible builder is used; this is recorded, not a
silent substitution.

## 0. Revisions — resolved by command, never inferred

```
git rev-parse da44ad1   -> da44ad1699a7b4a3391018841fb0cc67a1bbb082   (base for this stage)
git rev-parse da44ad1^  -> (resolve and record yourself)
```
**Re-resolve `git rev-parse HEAD` yourself. If HEAD is not `da44ad16…`, STOP and report.**
Persisted SHA evidence: `docs/relay/SHA-VERIFICATION-EVIDENCE-2026-09-17.md`.

Workspace: `D:\AI-Workspace\runtime\worktrees\sb01-central-billing-20260909`
Branch: `work/sb01-central-billing-pc-20260911`

## 1. Inherited state (verified — do not redo)

LR-2C and LR-2D are both CLOSED / PASS. Current gates: build 0 / typecheck 0 / runtime **58/58** /
profile-registry **16/16**. The real Stripe TEST slice harnesses exist:
`platform/runtime/scripts/run-sb01-lr2c-real-slice.mjs` and
`platform/runtime/scripts/run-sb01-lr2d-reconcile-slice.mjs` — read the LR-2D one first; it has the
working patterns for env gates, real Stripe REST helpers, the Core HTTP boundary, DB counting,
masked ids, and the `[PASS]`/`[FAIL]` + summary recorder. Reuse them rather than reinventing.

Reusable fixtures already exist: `platform/runtime/tests/helpers/lr2d-real-db-fixtures.mjs`.

Two real products are registered and supported by the current registry — use them, do not invent
pricing:
- `PS01` (Pawstia PMS): product `prd_c3a024781f4e4079815b2399cfe330e0`, plan `founding-c2`,
  price `price_1UDCxyHB4GRCffd9RyaDWZ1c` @ 99000 THB, entitlement key `commercial_access`
- `LK01` (WSTERA Link): product `prd_f4be6d1a9b544632a527e0e15e485622`, plans `free`/`pro`/`business`
  with prices `price_1UDCxzHB4GRCffd9a0rUipHY` (pro, 19900 THB) / `price_1UDCxzHB4GRCffd97bC6KI4h`
  (business, 59000 THB), entitlement keys `links.free`/`links.pro`/`links.business`

**Also required by this stage — close the outstanding residual gap:** the entitlement-path JSONB
sites (`db.ts` `createEntitlementTransition` / `deliverEntitlementToTestSink`) still have **no
dedicated real-PostgreSQL regression test**; they were fixed by parity only. LR-2E must add one
that actually executes against real PostgreSQL and asserts the persisted `jsonb_typeof` for
`entitlement_keys` (array) and `signed_envelope` (object), plus the sink write.

## 2. Objective — prove SB01 serves multiple products without cross-product/account contamination

Verify isolation across the **actual schema/contract dimensions**: `product_id`, `account_id`,
`environment`, provider identifiers, operation keys, reconciliation state, entitlement transitions,
outbox `dedupe_key`, and idempotency keys.

Prove each of the following with real execution:

1. **Product A cannot read or mutate Product B billing state through authorized interfaces.**
   A PS01-scoped credential/assertion must not reach LK01 reconciliation state, subscription state,
   entitlement projection, or provider customer mapping — and vice versa. Test the actual read
   routes (`/v1/subscription/status`, `/v1/entitlements`, `/v1/portal`) and the checkout route.
2. **Account A cannot resolve Account B credentials/provider authority.** Credential binding is
   pinned per product+environment+profile version; an assertion bound to another product, account,
   action, or `operation_id` must fail closed.
3. **Provider identifiers and idempotency keys cannot collide across boundaries incorrectly.**
   Two products using the **same account text** must not share provider customer mapping,
   subscription state, outbox `dedupe_key`, reconciliation row, or entitlement sink row. Prove the
   DB-level scoping actually separates them.
4. **Entitlement transitions are durable, signed as the contract requires, idempotent, retry-safe,
   auditable and correctly scoped:**
   - signed/idempotent/monotonic versioning proven through real PostgreSQL
   - a replayed/duplicate delivery must not double-apply or regress the sink version
   - an out-of-order (lower) `transition_version` must be rejected as stale, not applied
   - signature verification must reject a tampered envelope and a wrong-product signing key
   - monotonicity: grant v1 → revoke v2 proven end-to-end (LR-2D already showed grant v1 → revoke v2
     for one product; LR-2E must show it **per product without cross-contamination**)

## 3. Boundary that must hold (explicit)

```
SB01 = verified billing-derived entitlement transition
Product = domain-specific entitlement enforcement
```

SB01 must **not** absorb product business rules — booking availability, room allocation, document
rules, inventory behaviour, redirect mechanics. If any test seems to require such a rule inside
SB01, STOP and report a Decision Gap instead of implementing it.

## 4. Deliverables

1. Real-PostgreSQL isolation + entitlement tests (execute real SQL; no DB mocks, no source-string
   assertions). Follow the style of
   `platform/runtime/tests/outbox-lease-reconcile-crash-window-real-db.test.mjs`.
2. A TEST-gated real slice harness for LR-2E, e.g.
   `platform/runtime/scripts/run-sb01-lr2e-isolation-slice.mjs`, proving PS01 + LK01 through the
   **actual runtime path** with real Stripe TEST objects and real signed webhooks via the live
   `stripe listen` forward. It must refuse to run unless `STRIPE_SECRET_KEY` starts `sk_test_`,
   `STRIPE_WEBHOOK_SECRET` starts `whsec_`, and `BILLING_DATABASE_URL` is set. Never print/echo/log
   a credential value; mask provider object ids.
3. Evidence `docs/platform/billing-core/EVIDENCE-SB01-LR-2E-CLAUDE-2026-09-17.md`: base +
   finishing revision; exact commands with real output and exit codes; observed side-effect counts
   per check; the fixture-route declaration (see §5); a §2→evidence map; the entitlement real-DB
   test result; residual gaps stated plainly; explicit no-live/no-production-mutation and
   no-secret-exposed confirmation.
4. Machine-readable run log `docs/relay/LR2E-ISOLATION-SLICE-RUN-2026-09-17.log`.

## 5. Fixture route (required, declared)

Same honest route as LR-2D: Stripe's Test backend API has no payer-side completion route for card
Checkout sessions, so provider-side subscriptions are created **directly against the Stripe TEST
API** for real test customers using the **pinned profile prices** and correct metadata
(`wstera_product_id`, `account_id`, `profile_version`, `plan_id`) — one set per product — so real
`customer.subscription.*` webhooks fire through the live listener into the Core webhook route.

Declare this explicitly as a harness setup step with its rationale. It simulates the external world
(provider state); it is **not** a command to SB01, **not** a bypass of the authority model, and **no
core authority rule may be relaxed for it**.

A TEST `stripe listen` is running and forwarding to `http://127.0.0.1:8787/webhooks/stripe`. If it
has died, start one with `STRIPE_API_KEY` from the environment and record that you did — never print
the generated signing secret.

## 6. Invariants that must not change

- Server-side authority model; no caller-supplied field becomes authoritative.
- Fail-closed codes intact, including `ENTITLEMENT_SIGNATURE_INVALID`,
  `ENTITLEMENT_REPLAY_WINDOW`, `ENTITLEMENT_KEY_MISMATCH`, `ENTITLEMENT_JOB_SCOPE_MISMATCH`,
  `CREDENTIAL_ENV_MISMATCH`, `ACCOUNT_ASSERTION_MISMATCH`, `PROFILE_NOT_ADMISSIBLE`,
  `RETURN_REF_DENIED`, plus the webhook and `RECONCILE_*_MISMATCH` families.
- `getCustomerByAccount` / `getCustomerByProviderId` / `getSubscriptionState` /
  `getEntitlementProjection` remain scoped by `(environment, product_id, account_id)`.
- Entitlement signing keys stay per-product (`productId` + `environment`).
- Provider truth over caller/DB commercial state (LR-2D invariant).
- Unmapped intake `skipped` with no outbox job; outbox `completed` preservation (LR-2D fix).
- No schema/migration change, no new dependency, no live Stripe, no production DB, no `.env` edit.
- **Do not modify the Protected Skill** `kanban-external-agent-dispatch`. Its revision is narrowly
  Owner-approved for the secret-scanner fix only. If you think an executor change is needed, STOP
  and report a Decision Gap.

## 7. Allowed write paths

`platform/runtime/tests/**`, `platform/runtime/scripts/**`, `platform/runtime/src/**` **only** where
a real executed failure proves a defect, `docs/**` (evidence/log).

Prohibited: credential files or any credential value; live Stripe keys/charges; production DB;
webhook registration; deploy/merge/push; migrations/DDL; `PS01.test.ts`/`LK01.test.ts` pins;
Protected Skill scripts; unrelated dirty/untracked files; LR-2F scope.

## 8. Time budget (learned from LR-2D — important)

A previous round hit the 1500 s executor timeout and lost unwritten deliverables. **Write artifacts
early and keep them current**: create the harness skeleton, then the evidence file with a live status
line, then fill in results as you go. Persisted-and-partial beats complete-but-lost. If the budget
runs low, save the harness plus whatever evidence exists and state plainly what remains.

## 9. Verification you must run and report

```
cd platform/runtime && npm run build          # expect exit 0
cd platform/runtime && npm run typecheck      # expect exit 0
cd platform/runtime && npm test               # report # tests / # pass / # fail
cd platform/profile-registry && npm test      # expect 16/16
git diff --check                              # expect clean
git diff --stat                               # list every changed file
node scripts/run-sb01-lr2e-isolation-slice.mjs    # from platform/runtime; real slice
```

If a required credential/listener is genuinely unavailable, return `BLOCKED_CREDENTIAL` /
`BLOCKED_LISTENER` with the exact missing item — do not downgrade the evidence bar.

## 10. Stop condition

`READY FOR CODEX LR-2E INDEPENDENT VERIFY` — or an explicit `BLOCKED_*` with the exact blocker.
Do not commit or push (Hermes stages and commits the verified revision). Do not start LR-2F.
