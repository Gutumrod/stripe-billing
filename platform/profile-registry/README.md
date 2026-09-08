# Product Billing Profile Registry

Phase 1 foundation for WSTERA Central Billing Core.

This package owns only Product Billing Profile contract validation, immutable/versioned registration, exact request-scoped resolution, activation gating, rollback targeting, and account-bound context guards.

It deliberately does **not** perform Stripe API calls, Checkout/Portal creation, webhook handling, reconciliation, entitlement delivery, DB migration/apply, or Product business-state mutation.

## Runtime invariant
Every resolution requires `credentialProductId + environment + profileVersion`. There is no mutable global `current_profile`, `active_product`, or implicit "latest" profile lookup.

Caller-supplied product identity cannot override credential-bound product identity. Account-scoped routes must call `assertAccountBound` after verifying an account-bound assertion.

## Activation
Profiles are registered in a non-active state. `activate()` is the only path to `active` and fails closed unless admission evidence, exact provider mappings for enabled paid rails, and rollback targeting are complete. Live activation is denied by default.

## PS01
`profiles/PS01.test.ts` is Profile #1. It records Founding C2 at THB 990/month but intentionally has no Stripe Test Product/Price mapping or admission evidence yet, so activation must fail until the Stripe Test preflight/admission work is completed.

Canonical human dossier: `D:/AI-Workspace/projects/saas-product-hub/docs/platform/billing-core/profiles/PS01.md`.

Run `npm run typecheck` then `npm test`. The package reuses the existing TypeScript toolchain already present in the stripe-billing repo; it performs no dependency installation.