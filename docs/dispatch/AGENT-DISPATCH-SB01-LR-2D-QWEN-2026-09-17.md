# AGENT DISPATCH — SB01 LR-2D — Webhook Durability + Reconciliation — Qwen — 2026-09-17

Task: `SB01-LONG-RUN-2C-2F-001`
Workflow: `WF-RELAY-01` / Runtime `kanban-external-agent-dispatch v2.5.1`
Work type: `DIRECT-APPROVED` / Release policy `RELAY_STANDARD`
Role: `CORE-BUILDER` (bounded test + evidence authoring on the existing implementation)
Selected agent: `agent-qwen` (context mode `BUILD`)

## 0. Revisions — resolved by command, never inferred

```
git rev-parse 9c2cc49    -> 9c2cc490fdbccee305d73e9466e17c3dc26bc724   (base for this stage)
git rev-parse 9c2cc49^   -> 0181842ceeeabf78636b6f515cb6de557e29ca8f
```
Persisted: `docs/relay/SHA-VERIFICATION-EVIDENCE-2026-09-17.md`.
**Re-read `git rev-parse HEAD` yourself and record it. If HEAD is not the base revision above, STOP
and report — do not proceed on an unexpected revision.**

Workspace: `D:\AI-Workspace\runtime\worktrees\sb01-central-billing-20260909`
Branch: `work/sb01-central-billing-pc-20260911`

## 1. Context you inherit (verified, do not redo)

- LR-2C is **CLOSED / PASS** at `4b2beb1ee2c05b154b5a306026dfa13d000ad913`; closure report
  `docs/relay/PHASE-CLOSURE-LR-2C-SB01-2026-09-17.md`.
- Current gates at HEAD: build 0 / typecheck 0 / runtime 43/43 / profile-registry 16/16.
- Real Stripe TEST + WSTERA LAB slice = 45/45 (`docs/relay/LR2C-REALSLICE-RUN-2026-09-17.log`).
- The implementation for this stage **already exists** in source — your job is to prove it with
  real execution and evidence, and repair only defects that real execution exposes.
  Existing surface: `runtime.ts` `processOneJob` / `processReconcileJob` (`~line 501`),
  `webhook.ts` `verifyStripeWebhook`, `db.ts` `claimWebhookEvent` / `leaseNextJob` / `failJob` /
  `completeJob` / `enqueueReconciliation` / `upsertReconciliation` / `createEntitlementTransition` /
  `deliverEntitlementToTestSink` / `markProviderEventComplete` / `markProviderEventError`.
- Applied LAB schema is present with **zero rows** in `runtime_outbox_jobs`,
  `runtime_reconciliation_state`, `runtime_entitlement_transitions`, `runtime_entitlement_test_sink`
  (clean baseline). Exact column lists were read from the live catalog — inspect them yourself
  rather than trusting this summary.

## 2. Objective — prove correctness under duplicate, delayed, out-of-order and partially failed execution

Produce **real executed evidence** (not source-string assertions) for:

1. **Real Stripe signature verification** on the webhook route (real `whsec_` from a live
   `stripe listen` session).
2. **Durable provider-event persistence** before any processing.
3. **Event uniqueness / idempotency / replay:** a duplicate delivery of the *same*
   `provider_event_id` must not create a second provider-event row, must not enqueue a second
   reconcile job, and must not produce a second entitlement transition or sink version.
4. **Outbox semantics:** enqueue → lease → complete, plus failure → `failed` with backoff →
   `dead_letter` after `max_attempts`; `lease_owner`/`lease_expires_at` invariant respected.
5. **Lease/concurrency safety — no double execution:** two concurrent workers leasing the same
   queue must not both process the same job (prove with a real concurrent lease attempt).
6. **Provider re-fetch reconciliation:** reconciliation must use provider truth —
   `retrieveSubscription`, matching product / account / amount / currency / provider object, and
   must **reject** caller- or DB-supplied commercial state that disagrees with the provider.
7. **Crash-window recovery without double charge or corrupt state:** durable op before provider
   call; provider success before local finalization; webhook persistence before processing;
   entitlement transition before downstream delivery.

## 3. Required real-stripe fixture setup (read carefully — this is the honest route)

LR-2C established, with real probe evidence, that Stripe's Test backend API has **no payer-side
completion route** for a card Checkout session (`POST /v1/checkout/sessions/:id/confirm` → 404
`Unrecognized request URL`). Therefore a *paid* subscription with the pinned price cannot be
produced through the Core checkout path alone.

**Authorized test-fixture route:** create the provider-side subscription directly against the
Stripe TEST API for a real test customer, using the **pinned profile price** and **correct
metadata** (`wstera_product_id`, `account_id`, `profile_version`, `plan_id`) from PS01/LK01 test
profiles. This simulates the external world (the provider's own state), it is **not** a command to
SB01 and **not** a bypass of SB01's authority model. Stripe then emits a **real**
`customer.subscription.created` webhook, which the live `stripe listen` forwards to the Core
webhook route — giving a genuine signature-verified, durably-claimed, outbox-driven,
provider-truth-reconciled chain.

You must state this fixture route explicitly in your evidence as a **declared harness setup step**
with its rationale, so no reviewer can mistake it for a production checkout claim. No core
authority rule may be relaxed to accommodate it.

## 4. Deliverables

1. A real-execution harness extending the established pattern of
   `platform/runtime/scripts/run-sb01-lr2c-real-slice.mjs` (you may add
   `platform/runtime/scripts/run-sb01-lr2d-reconcile-slice.mjs`), TEST-gated: it must refuse to run
   unless `STRIPE_SECRET_KEY` starts `sk_test_`, `STRIPE_WEBHOOK_SECRET` starts `whsec_`, and
   `BILLING_DATABASE_URL` is set. Never print, echo, log, or persist a credential value; mask all
   provider object ids in output.
2. Executable tests that actually run (real PostgreSQL / real provider), covering §2 items 3, 4, 5
   and the reconciliation rejection paths. Prefer adding to `platform/runtime/tests/**` in the
   style of `tests/webhook-durable-claim-jsonb-real-db.test.mjs` (which executes real SQL). Do not
   substitute source-string assertions for execution.
3. Evidence artifact
   `docs/platform/billing-core/EVIDENCE-SB01-LR-2D-QWEN-2026-09-17.md` containing: base revision +
   finishing revision; the exact commands with real output and exit codes; the observed
   provider/LAB side-effect counts for each check; the fixture-route declaration from §3; a
   per-item map from §2 to the evidence; any residual gap stated plainly.
4. A machine-readable run log at `docs/relay/LR2D-RECONCILE-SLICE-RUN-2026-09-17.log` (same
   convention as the LR-2C real-slice log: one `[PASS]`/`[FAIL]` line per check plus a summary).

## 5. Invariants that must not change

- Server-side authority model unchanged; no caller-supplied field becomes authoritative.
- Fail-closed codes intact: `LIVE_WEBHOOK_DENIED`, `WEBHOOK_TIMESTAMP_INVALID`,
  `WEBHOOK_SIGNATURE_INVALID`, `WEBHOOK_IDENTITY_MISSING`, `WEBHOOK_BODY_TOO_LARGE`,
  `LIVE_PROVIDER_OBJECT_DENIED`, `LIVE_JOB_DENIED`, and the `RECONCILE_*_MISMATCH` family.
- Unmapped intake still claims `status='skipped'` with **no** outbox job.
- Reconciliation must never trust caller-supplied commercial state — provider truth only.
- `OUTBOX_LEASE_PRESERVING_CONFLICT_SET` lease semantics, `dedupe_key`, and
  `on conflict (provider_event_id) do nothing` unchanged unless a real executed failure proves
  they are wrong (report it, do not silently redesign).
- No schema/migration change, no new dependency, no live Stripe, no production DB.
- Entitlement transitions stay scoped to `SB01 = verified billing-derived transition`;
  do not absorb product business rules (booking/allocation/inventory/redirect mechanics).

## 6. Allowed write paths

- `platform/runtime/tests/**`, `platform/runtime/scripts/**`
- `platform/runtime/src/**` **only** where a real executed failure proves a defect (bounded fix)
- `docs/**` (evidence/log only)

Prohibited: `.env` or any credential file; credential values anywhere; live Stripe keys/charges;
production DB; webhook registration; deploy/merge/push; migrations/DDL; changing
`PS01.test.ts`/`LK01.test.ts` pins; touching unrelated dirty/untracked files;
LR-2E/LR-2F scope.

## 7. Verification you must run and report (exact commands, exact results)

```
cd platform/runtime && npm run build          # expect exit 0
cd platform/runtime && npm run typecheck      # expect exit 0
cd platform/runtime && npm test               # expect all pass; report # tests / # pass / # fail
cd platform/profile-registry && npm test      # expect 16/16
git diff --check                              # expect clean
git diff --stat                               # list every changed file
node platform/runtime/scripts/run-sb01-lr2d-reconcile-slice.mjs   # your real slice
```

The environment already provides `BILLING_DATABASE_URL`, `STRIPE_SECRET_KEY` (TEST) and
`STRIPE_WEBHOOK_SECRET` as env vars. A TEST `stripe listen` forwarding to
`http://127.0.0.1:8787/webhooks/stripe` must be running for the webhook legs; if it is not, start
one (`stripe listen --forward-to ...`) with `STRIPE_API_KEY` from the environment and record that
you did — never print the generated signing secret.

If a required credential or listener is genuinely unavailable, stop and return
`BLOCKED_CREDENTIAL` / `BLOCKED_LISTENER` with the exact missing item — do **not** downgrade the
evidence bar or fabricate a result.

## 8. Stop condition

`READY FOR CODEX LR-2D INDEPENDENT VERIFY` — or an explicit `BLOCKED_*` with the exact blocker.
Do not commit or push (Hermes stages and commits the verified revision). Do not start LR-2E.
