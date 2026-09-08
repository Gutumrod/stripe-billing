# Product Billing Profile Registry

Phase 1 foundation for WSTERA Central Billing Core.

This package owns Product Billing Profile validation, immutable/versioned registration, exact request-scoped resolution, activation gating, rollback targeting, account-bound context guards, and non-production isolation/concurrency fixtures.

It deliberately does **not** own production Checkout/Portal, webhook processing, reconciliation, entitlement delivery, DB migration/apply, or Product business-state mutation.

## Runtime invariant
Every resolution requires `credentialProductId + environment + profileVersion`. There is no mutable global `current_profile`, `active_product`, or implicit latest-profile lookup.

Caller-supplied product identity cannot override credential-bound product identity. Account-scoped routes must call `assertAccountBound` after verifying an account-bound assertion.

## Current Test profiles
- `profiles/PS01.test.ts` — Pawstia Founding C2 THB 990/month; real Stripe Test Product/Price mapping; still `pending_validation`.
- `profiles/LK01.test.ts` — WSTERA Link Free/Pro/Business baseline; real Stripe Test Product/Price mappings; still `pending_validation`; Test mapping does not approve public pricing.

Activation remains blocked until admission evidence and downstream contracts are complete. Live activation is denied by default.

## Verification
Local deterministic matrix: `tests/concurrency-scenarios.test.js` plus registry negatives. Current result: 16/16 PASS.

Provider runner: `scripts/run-stripe-test-concurrency.mjs`. It refuses non-`sk_test_` keys, creates Test customers/subscriptions, refetches status, executes sequential/concurrent subscribe/cancel scenarios, and cleans up customers. No secret is stored in this repository.

Human dossiers and evidence live under `docs/platform/billing-core/` in the parent SaaS Product Hub repository.