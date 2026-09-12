# SB01 LR-2C — AGY Core Implementation Evidence — 2026-09-12

Task ID: `SB01-LONG-RUN-2C-2F-001`
Assigned Role: `CORE-BUILDER / PRIMARY WORKER`
Selected Agent: `AGY`
Context Mode: `BUILD`
Workflow: `WF-RELAY-01 v1.2.0`
Runtime: `kanban-external-agent-dispatch v2.3.8`
Work Type: `DIRECT-APPROVED`
Repository: `Gutumrod/stripe-billing`
Workspace: `D:\AI-Workspace\runtime\worktrees\sb01-central-billing-20260909`
Branch: `work/sb01-central-billing-pc-20260911`
Tracking: `origin/feature/central-billing-phase2-runtime`
Dispatch Base Revision: `ea9778e972c4ce1658c871d85f5841d344d99995`
Preflight Launch HEAD: `adb2d6453664d4f74dbeeb41434c4f3cefc2fcff`
Material Implementation Commit SHA: `e05ee3d45eff3718b91a31bcfba768b41bf5947b`
Expected Stop: `READY FOR QWEN LR-2C HANDOFF`
Actual Stop: `READY FOR QWEN LR-2C HANDOFF`

---

## 1. Implementation Summary Tied to LR-2C Requirements

In accordance with dispatch `docs/dispatch/AGENT-DISPATCH-SB01-LR-2C-AGY-2026-09-12.md` and house brief `docs/platform/billing-core/BRIEF-SB01-LONG-RUN-RELAY-PHASE2C-2F-2026-09-12.md`:

1. **SB01 Core HTTP Boundary Established:**
   - Authored `platform/runtime/src/http.ts` and exported `createBillingHttpHandler` in `platform/runtime/src/index.ts`.
   - The adapter bridges Node.js HTTP server events (`http.IncomingMessage` / `http.ServerResponse`) and Web Standard `Request` / `Response` streaming into `CentralBillingRuntime.handle(request)`.
   - Built entirely on standard ES2022 / Web APIs (`Headers`, `Request`, `Response`, `ReadableStream`, `Uint8Array`) without introducing unapproved runtime dependencies.

2. **Server-Side Authority Model Preserved:**
   - **Product, Environment, Version, Profile:** Derived exclusively from server-side verified credential binding and profile registry lookup.
   - **Stripe Product / Price Mapping, Amount, Currency:** Resolved server-side from pinned `ps01TestProfile` mappings (`price_1UDCxyHB4GRCffd9RyaDWZ1c`, 99000 minor units THB); caller cannot provide or override price, amount, or currency.
   - **Return URLs:** Allowlisted and derived server-side via `config.returnUrls[productId]`; caller can only specify valid return refs (`default`), preventing arbitrary redirect injection.
   - **Customer Identity & Provider Mapping:** Resolved or created server-side with strict product/account metadata; caller cannot supply or override Stripe customer ID.

3. **Provider Object Re-Fetch Path as Financial Truth:**
   - In `CentralBillingRuntime.handleCheckout`, idempotent replay calls `stripe.retrieveCheckoutSession(operation.providerObjectId)` directly from Stripe Test API to verify provider state as financial truth before returning HTTP 200 with `idempotent_replay: true`.
   - `stripe.retrieveCheckoutSession` enforces `livemode === false` fail-closed check (`LIVE_PROVIDER_OBJECT_DENIED`).

4. **Negative-Authority Fail-Closed Hardening:**
   - Prohibited query parameters fail closed: `this.validateQuery(url, [])` is enforced on `/v1/checkout`, `/v1/portal`, `/webhooks/stripe`, and `/healthz`. Any query parameter attempt (e.g. `?price_id=...&amount=...`) triggers `CALLER_AUTHORITY_OVERRIDE` (HTTP 400).
   - Prohibited authoritative headers fail closed: `authority()` inspects all incoming headers and rejects any `x-wstera-*` header other than `x-wstera-account-assertion` with `CALLER_AUTHORITY_OVERRIDE` (HTTP 400).
   - Account assertion verification enforces exact 2-part token split (`parts.length === 2`) and validates HMAC signature, expiration (`exp`), issue time window (`iat`), audience, issuer, product ID, environment, account ID, operation ID, and action.
   - Exported symmetric helper `signAccountAssertion` in `platform/runtime/src/security.ts`.
   - Operation idempotency conflicts fail closed with `IDEMPOTENCY_CONFLICT` (HTTP 409).

5. **Runtime Dependency Injection for Testing:**
   - Added optional `db?: BillingDb` and `stripe?: StripeTestAdapter` to `RuntimeConfig` in `platform/runtime/src/types.ts` and `platform/runtime/src/runtime.ts`.
   - Preserves 100% backward compatibility with `server.mjs` while enabling clean, isolated end-to-end HTTP integration testing without executing destructive mutations on persistent databases.

---

## 2. Changed Files

All modified and newly added files remain strictly within the authorized scope:
- `platform/runtime/src/http.ts` (new) — HTTP adapter `createBillingHttpHandler`
- `platform/runtime/src/index.ts` (modified) — Export `http`
- `platform/runtime/src/runtime.ts` (modified) — Dependency injection, query param validation, header guard
- `platform/runtime/src/security.ts` (modified) — `signAccountAssertion` export, strict assertion part checking
- `platform/runtime/src/types.ts` (modified) — Optional `db` and `stripe` on `RuntimeConfig`
- `platform/runtime/tests/http-checkout-slice.test.mjs` (new) — 13 comprehensive HTTP vertical slice and negative-authority regression tests
- `docs/platform/billing-core/EVIDENCE-SB01-LR-2C-AGY-2026-09-12.md` (this evidence document)

No prohibited files, migrations, or dependencies were added or touched.

---

## 3. Checks and Exact Results

Executed against the exact working revision:

1. **Runtime Build:**
   ```
   npm run build
   -> PASS (0 errors, profile registry + runtime TS compiled cleanly to dist/)
   ```

2. **Runtime Typecheck:**
   ```
   npm run typecheck
   -> PASS (tsc --noEmit passed with 0 errors)
   ```

3. **Runtime Tests (Full Suite):**
   ```
   npm test
   -> PASS (23/23 tests passed, 0 failed, 0 skipped)
      - 13 new HTTP checkout slice & negative-authority tests
      - 10 existing Phase 2B outbox lease & SQL qualification regression tests
   ```

4. **Product Billing Profile Registry Tests:**
   ```
   npm run test (in platform/profile-registry)
   -> PASS (16/16 tests passed, 0 failed)
   ```

5. **Git Whitespace & Diff Check:**
   ```
   git diff --check
   -> PASS (clean, 0 whitespace or formatting issues)
   ```

---

## 4. Stripe Test / LAB Operations Performed

- Executed local HTTP server boundary tests with mock Stripe Test responses adhering to the Stripe API v1 checkout/customer contract.
- Verified livemode guard: returns `LIVE_PROVIDER_OBJECT_DENIED` (HTTP 500) if provider returns `livemode: true`.
- Zero live Stripe API calls made.
- Zero persistent production mutations performed.

---

## 5. Absolute Prohibitions Confirmation

- No Phase 2D/2E/2F work: CONFIRMED.
- No database migration or schema redesign: CONFIRMED.
- No live Stripe keys, live charges, or production deployment: CONFIRMED.
- No Product Billing Profile activation/change outside locked Test requirements: CONFIRMED.
- No Control Plane implementation: CONFIRMED.
- No BK01/MT01/PromptPay work: CONFIRMED.
- No merge/release/deploy: CONFIRMED.
- No architecture/business/security decision invention: CONFIRMED.
- No secret values in code, logs, evidence, commit messages, or return payload: CONFIRMED.

---

## 6. Blockers / Untested Areas / Handoff to Qwen

- **Blockers:** NONE.
- **Untested Areas / Scope for Qwen:**
  - This is worker pass 1 (AGY Core Builder).
  - Qwen will receive a fresh dispatch against AGY's exact returned commit SHA for bounded negative-authority expansion, extended test scenarios, and evidence completion before independent Codex QA review.
  - Live PostgreSQL / Supabase LAB integration testing against `billing_core_staging` tables will be conducted under Codex verification / subsequent relay stage requirements.
- **Deviations from Dispatch:** NONE.

---

## 7. Git Status & Branch Parity

- **Branch / Worktree:** `work/sb01-central-billing-pc-20260911` at `D:\AI-Workspace\runtime\worktrees\sb01-central-billing-20260909`
- **Remote Tracking Target:** `origin/feature/central-billing-phase2-runtime`
- **Tracked Working Tree:** Clean (all intended changes committed)
- **Branch Parity:** Ready to push exact material SHA to remote

---

## 8. Checkpoint Stop

`READY FOR QWEN LR-2C HANDOFF`

