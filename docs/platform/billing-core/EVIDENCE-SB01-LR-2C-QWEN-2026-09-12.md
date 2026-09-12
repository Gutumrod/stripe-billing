# SB01 LR-2C — Qwen Negative-Authority / Test / Evidence Expansion — 2026-09-12

Task ID: `SB01-LONG-RUN-2C-2F-001`
Assigned Role: `SECONDARY WORKER / NEGATIVE-AUTHORITY + TEST EVIDENCE EXPANSION`
Selected Agent: `Qwen`
Context Mode: `BUILD`
Workflow: `WF-RELAY-01 v1.2.0`
Runtime: `kanban-external-agent-dispatch v2.3.8`
Work Type: `DIRECT-APPROVED`
Repository: `Gutumrod/stripe-billing`
Workspace: `D:\AI-Workspace\runtime\worktrees\sb01-central-billing-20260909`
Branch: `work/sb01-central-billing-pc-20260911`
Tracking: `origin/feature/central-billing-phase2-runtime`
AGY Returned Revision (Base): `f22b01af309a769c642a3318c56c841fb88d82c0`
Qwen Expansion Commit SHA: `PENDING_FINAL_COMMIT_SHA`
Expected Stop: `READY FOR CODEX LR-2C INDEPENDENT QA`
Actual Stop: `READY FOR CODEX LR-2C INDEPENDENT QA`

---

## 1. Base Revision

All Qwen work was layered on top of AGY's exact returned commit `f22b01a`
(`feat(sb01): establish HTTP boundary and PS01 Test checkout slice`), the same
code tree confirmed at branch HEAD `9001795` (evidence-only SHA correction).
AGY's locked HTTP boundary, authority model, and 23-test baseline were **not**
modified. The working diff against `f22b01a` contains exactly one file:
the new negative-authority test module.

## 2. Changed Files

- `platform/runtime/tests/negative-authority-matrix.test.mjs` (new) — 19 negative-authority tests through the real HTTP boundary (`createBillingHttpHandler` + Node `http` server + `fetch`).
- `docs/platform/billing-core/EVIDENCE-SB01-LR-2C-QWEN-2026-09-12.md` (this evidence).

No `platform/runtime/src/**` changes were required: every negative path in the
LR-2C matrix is provably closed by AGY's existing implementation, so the
allowed-but-conditional src write scope was **not exercised** (deviation NONE).

## 3. Negative-Authority Matrix Coverage (LR-2C scope)

Each row states the caller attempt, the fail-closed outcome, and the proof of
no provider object creation / no durable billing side effect:

| # | Matrix row | Caller attempt | Fail-closed result | Side-effect proof |
|---|---|---|---|---|
| 1 | Product ID/code — credential is pinned to its own profile | LK01 token+assertion drives checkout; product, Stripe Price (`price_1UDCxzHB4GRCffd9a0rUipHY`), customer metadata all derived from LK01 credential binding; no PS01-scoped DB row | 201 via LK01 profile only (positive-control inversion) | no `test:<PS01>:acc_lk01_test_01:/v1/checkout:...` operation, no PS01 customer mapping |
| 2 | Product ID in body | `product_id: <LK01 id>` in checkout body | HTTP 400 `CALLER_AUTHORITY_OVERRIDE` | 0 Stripe sessions, 0 customers, 0 operation rows |
| 3 | Stripe Product/Price mapping — cross-product plan | PS01 credential requests `plan_id: pro` (LK01-only plan) | HTTP 409 `PLAN_NOT_CHECKOUT_ELIGIBLE` | 0 sessions, 0 customers, 0 operation rows |
| 4 | Environment — live credential | `environment: 'live'` credential binding | HTTP 403 `CREDENTIAL_ENV_MISMATCH` | 0 sessions, 0 customers, 0 operation rows |
| 5 | Environment — runtime constructor | live env / non-staging schema | throws `LIVE_RUNTIME_DENIED` / `PHASE2_SCHEMA_DENIED` before any I/O | runtime cannot be constructed |
| 6 | Environment — assertion claim spoof | assertion `environment: 'live'` vs test credential | HTTP 403 `ACCOUNT_ASSERTION_MISMATCH` | 0 sessions, 0 customers, 0 operation rows |
| 7 | Account identity — assertion/request mismatch | assertion bound to different `account_id` | HTTP 403 `ACCOUNT_ASSERTION_MISMATCH` | 0 sessions, 0 customers, 0 operations, 0 customer rows |
| 8 | Account identity — action binding | assertion `action: 'portal'` replayed on checkout route | HTTP 403 `ACCOUNT_ASSERTION_MISMATCH` | 0 sessions, 0 customers, 0 operations |
| 9 | Account identity — operation binding | assertion `operation_id` ≠ body `operation_id` | HTTP 403 `ACCOUNT_ASSERTION_MISMATCH` | 0 sessions, 0 customers, 0 operations |
| 10 | Expired/invalid operation authority (time) | future-issued assertion (`iat` in future) and over-long lifetime (`exp-iat > 300`) | HTTP 401 `ACCOUNT_ASSERTION_EXPIRED` / `ACCOUNT_ASSERTION_INVALID` | 0 sessions, 0 customers, 0 operations |
| 11 | Read route — account identity | status read with mismatched `account_id` query vs assertion | HTTP 403 `ACCOUNT_ASSERTION_MISMATCH` | 0 audit events |
| 12 | Stripe Customer ID — missing mapping | portal for account with no customer mapping | HTTP 404 `PORTAL_CUSTOMER_NOT_FOUND` | 0 sessions, 0 customers, 0 operations, 0 customer rows |
| 13 | Arbitrary portal return URL | `return_ref: 'https://evil.example/pwn'` | HTTP 400 `RETURN_REF_DENIED` | 0 new sessions, 0 additional customers; idempotency ledger records `failed`/`RETURN_REF_DENIED` only (no completion) |
| 14 | Stripe Customer ID / return URL / profile version / amount in body | `customer`, `return_url`, `profile_version`, `amountMinor` in checkout body | HTTP 400 `CALLER_AUTHORITY_OVERRIDE` (4 variants) | 0 sessions, 0 customers, 0 operations, 0 customer rows |
| 15 | Cross-Product credential use (credential level) | LK01 bearer token with PS01-signed assertion | HTTP 401 `ACCOUNT_ASSERTION_INVALID` | 0 sessions, 0 customers, 0 operations |
| 16 | Webhook livemode denial | validly-signed Stripe event with `livemode: true` | HTTP 403 `LIVE_WEBHOOK_DENIED` | 0 sessions, 0 customers, 0 durable webhook intake, 0 audit |
| 17 | Webhook replay/stale timestamp | validly-signed event with `t` 600 s stale | HTTP 400 `WEBHOOK_TIMESTAMP_INVALID` | 0 sessions, 0 customers, 0 durable claims |
| 18 | Query-parameter spoofing on all routes | `?price_id=...` on `/healthz` and `/v1/portal` | HTTP 400 `CALLER_AUTHORITY_OVERRIDE` | 0 sessions, 0 customers, 0 operations |
| 19 | Profile version — credential pinning | credential `profileVersion: 2` against registry holding only v1 | `initialize()` fails closed with profile-resolution error; runtime never boots | 0 sessions, 0 customers, 0 operations |

Complementing AGY's 13 tests (which already cover body `price_id`/`amount`/
`currency`/`customer_id`/`success_url` overrides, checkout query spoofing,
prohibited `x-wstera-*` headers, missing/tampered assertion, cross-product
assertion, expired assertion, live-provider-object denial), the mandatory
matrix is now covered end-to-end through the real HTTP boundary.

## 4. Checks and Exact Results

Executed at the combined revision (AGY `f22b01a` + Qwen test/evidence additions):

1. **Runtime build:** `npm run build` — PASS (0 errors).
2. **Runtime typecheck:** `npm run typecheck` (`tsc --noEmit`) — PASS (0 errors).
3. **Runtime tests:** `npm test` — **42/42 PASS** (23 AGY baseline: 13 HTTP
   slice + 10 Phase 2B outbox/SQL regression; 19 new negative-authority; 0
   failed, 0 skipped).
4. **Product Billing Profile Registry:** `npm test` in `platform/profile-registry`
   — **16/16 PASS**.
5. **`git diff --check`** — PASS (clean).

## 5. Stripe Test / LAB Operations Performed

- Local in-process Stripe Test contract mock (form-encoded `URLSearchParams`
  over an injected `fetch`), adhering to the Stripe API v1
  customer/checkout/portal contract, as established by AGY's slice harness.
- Validly HMAC-signed (locally, with the Test webhook secret from AGY's
  harness) webhook fixtures for livemode and stale-timestamp denial paths.
- Zero network Stripe API calls; zero live keys; zero charges; zero persistent
  mutations (in-memory DB harness only).

## 6. No Live / Production Mutation Confirmation

- No live Stripe keys, charges, or production deployment: CONFIRMED.
- No database migration or schema change: CONFIRMED.
- No Control Plane implementation or mutation: CONFIRMED.
- No Product Billing Profile activation or change: CONFIRMED.
- No Phase 2D/2E/2F work, BK01/MT01/PromptPay work, merge/release/deploy: CONFIRMED.
- No secret values in code, logs, evidence, commit messages, or return payload:
  CONFIRMED (only AGY's existing harness-local Test constants reused).

## 7. AGY Implementation Integrity

- `platform/runtime/src/**` untouched: verified by working-tree diff (only the
  new test file + this evidence are changes vs `f22b01a`).
- No redesign of the HTTP boundary; no change to server-side authority
  resolution, allowlists, or fail-closed error codes.
- Baseline suite remained green throughout (23/23 before expansion; 42/42 after).

## 8. Blockers / Untested Areas

- Blockers: NONE.
- Untested / out of LR-2C scope: live PostgreSQL `billing_core_staging`
  persistence (remains Codex/subsequent-stage scope per AGY evidence);
  webhook durability/reconciliation internals (LR-2D); entitlement
  monotonicity (LR-2E). Portal success-path Stripe call is mocked at the
  same contract level as checkout; no live portal session was created.
- Note: the denied portal attempt is recorded in the operation idempotency
  ledger as `failed` (`RETURN_REF_DENIED`) before the allowlist check; this is
  AGY's existing behavior and is now explicitly evidenced (test 13). It is a
  denial record, not a billing side effect: no provider object and no
  completion projection.

## 9. Deviations from Dispatch

NONE. The conditional `platform/runtime/src/**` allowance was not used.

## 10. Git Status & Branch Parity

- Branch `work/sb01-central-billing-pc-20260911` → push target
  `origin/feature/central-billing-phase2-runtime`.
- Tracked working tree: clean after the expansion commit.
- Branch parity: recorded at return time (see return payload / task checkpoint).
- Untracked Hermes runtime logs/dispatch scratch files were left untouched.

## 11. Checkpoint Stop

`READY FOR CODEX LR-2C INDEPENDENT QA`