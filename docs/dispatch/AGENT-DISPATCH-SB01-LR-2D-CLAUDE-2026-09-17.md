# AGENT DISPATCH — SB01 LR-2D — Webhook Durability + Reconciliation — Claude — 2026-09-17

Task: `SB01-LONG-RUN-2C-2F-001`
Runtime: `kanban-external-agent-dispatch v2.5.1` / `RELAY_STANDARD`
Role: `CORE-BUILDER` (bounded, one difficult-work round authorized by Codex route)
Selected agent: `agent-claude` (context mode `BUILD`)
Authorization chain: LR-2D → `agent-qwen` proved executor defect (exit 55) →
Codex classification **`ROUTE: SEND_TO_CLAUDE`** (`docs/relay/ROUTE-SB01-LR-2D-EXECUTOR-CLASSIFY-CODEX-2026-09-17.md`)

## 0. Revisions — resolved by command, never inferred

```
git rev-parse 041aa49   -> 041aa496aa2c88734c02a362570ac444aaecd660   (base revision for this stage)
git rev-parse 041aa49^  -> (resolve and record yourself)
```
Persisted: `docs/relay/SHA-VERIFICATION-EVIDENCE-2026-09-17.md`.
**Re-resolve `git rev-parse HEAD` yourself and record it. If HEAD is not the base above, STOP and report.**

Workspace: `D:\AI-Workspace\runtime\worktrees\sb01-central-billing-20260909`
Branch: `work/sb01-central-billing-pc-20260911`

## 1. Inherited context (verified — do not redo)

- LR-2C is **CLOSED / PASS** at `4b2beb1ee2c05b154b5a306026dfa13d000ad913`
  (`docs/relay/PHASE-CLOSURE-LR-2C-SB01-2026-09-17.md`). Gates at HEAD: build 0 / typecheck 0 /
  runtime 43/43 / profile-registry 16/16; real slice 45/45.
- LR-2D's first attempt died on the Qwen executor defect. A **partial, unverified** test file was
  produced and has been moved out of the repo. Diagnostic copy (input only, NOT evidence, NOT a
  starting deliverable you must preserve verbatim):
  `D:\AI-Workspace\runtime\qa-temp\relay-evidence\sb01-lr2d\diagnostic\outbox-lease-reconcile-real-db.test.mjs`
  You may read it for ideas, but you own whatever you ship and must verify it by execution.
- The LR-2D implementation **already exists** in source; your job is to prove it by real execution
  and repair only defects that real execution exposes.

## 2. Objective

Prove correctness under duplicate, delayed, out-of-order and partially failed provider/event
execution, with **real executed evidence** (real PostgreSQL + real Stripe TEST):

1. Real Stripe signature verification on the webhook route (real `whsec_`).
2. Durable provider-event persistence **before** any processing.
3. Event uniqueness / idempotency / replay: a duplicate delivery of the same `provider_event_id`
   must not create a second provider-event row, must not enqueue a second reconcile job, and must
   not produce a second entitlement transition or sink version.
4. Outbox semantics: enqueue → lease → complete; failure → `failed` with backoff →
   `dead_letter` after `max_attempts`; `lease_owner`/`lease_expires_at` invariant respected.
5. Lease/concurrency safety — **no double execution**: two concurrent lease attempts must not both
   process the same job (prove with a real concurrent lease attempt).
6. Provider re-fetch reconciliation using **provider truth**: `retrieveSubscription`; match product /
   account / amount / currency / provider object; **reject** mismatching state.
7. Crash-window recovery without double charge or corrupt state: durable operation before provider
   call; provider success before local finalization; webhook persistence before processing;
   entitlement transition before downstream delivery.

## 3. Fixture route (honest, declared — read carefully)

LR-2C proved with real probe evidence that Stripe's Test backend API has **no payer-side completion
route** for a card Checkout session (`POST /v1/checkout/sessions/:id/confirm` → 404
`Unrecognized request URL`). A *paid* subscription with the pinned price therefore cannot be
produced through the Core checkout path alone.

**Authorized test-fixture route:** create the provider-side subscription **directly against the
Stripe TEST API** for a real test customer, using the **pinned profile price** and **correct
metadata** (`wstera_product_id`, `account_id`, `profile_version`, `plan_id`) from the PS01/LK01 test
profiles. This simulates the external world (the provider's own state); it is **not** a command to
SB01 and **not** a bypass of SB01's authority model. Stripe then emits a real
`customer.subscription.created` webhook, which the live `stripe listen` forwards to the Core webhook
route — producing a genuine signature-verified, durably-claimed, outbox-driven,
provider-truth-reconciled chain.

State this route explicitly in your evidence as a **declared harness setup step** with its
rationale, so no reviewer can mistake it for a production checkout claim. **No core authority rule
may be relaxed to accommodate it.**

A TEST `stripe listen` is already running (forwarding to `http://127.0.0.1:8787/webhooks/stripe`)
and its signing secret matches the vault value. If it has died, start one with `STRIPE_API_KEY`
from the environment and record that you did — never print the generated signing secret.

## 4. Deliverables

1. A real-execution harness (`platform/runtime/scripts/run-sb01-lr2d-reconcile-slice.mjs`), in the
   style of `run-sb01-lr2c-real-slice.mjs`, TEST-gated: it must refuse to run unless
   `STRIPE_SECRET_KEY` starts `sk_test_`, `STRIPE_WEBHOOK_SECRET` starts `whsec_`, and
   `BILLING_DATABASE_URL` is set. Never print/echo/log/persist a credential value; mask provider
   object ids.
2. Executable tests that really run (real PostgreSQL / real provider) for §2 items 3–7, in the
   style of `tests/webhook-durable-claim-jsonb-real-db.test.mjs` (which executes real SQL). Do not
   substitute source-string assertions for execution.
3. Evidence: `docs/platform/billing-core/EVIDENCE-SB01-LR-2D-CLAUDE-2026-09-17.md` — base +
   finishing revision; exact commands with real output and exit codes; observed provider/LAB
   side-effect counts per check; the §3 fixture-route declaration; a §2→evidence map; residual gaps
   stated plainly; explicit no-live/no-production-mutation and no-secret-exposed confirmation.
4. Machine-readable run log: `docs/relay/LR2D-RECONCILE-SLICE-RUN-2026-09-17.log` — one
   `[PASS]`/`[FAIL]` line per check plus a summary block.

## 5. Invariants that must not change

- Server-side authority model unchanged; no caller-supplied field becomes authoritative.
- Fail-closed codes intact: `LIVE_WEBHOOK_DENIED`, `WEBHOOK_TIMESTAMP_INVALID`,
  `WEBHOOK_SIGNATURE_INVALID`, `WEBHOOK_IDENTITY_MISSING`, `WEBHOOK_BODY_TOO_LARGE`,
  `LIVE_PROVIDER_OBJECT_DENIED`, `LIVE_JOB_DENIED`, and the `RECONCILE_*_MISMATCH` family.
- Unmapped intake still claims `status='skipped'` with **no** outbox job.
- Reconciliation must never trust caller- or DB-supplied commercial state — provider truth only.
- `OUTBOX_LEASE_PRESERVING_CONFLICT_SET` lease semantics, `dedupe_key`, and
  `on conflict (provider_event_id) do nothing` unchanged unless a real executed failure proves them
  wrong (report it; do not silently redesign).
- No schema/migration change, no new dependency, no live Stripe, no production DB, no `.env` edit.
- Boundary: `SB01 = verified billing-derived entitlement transition`; do **not** absorb product
  business rules (booking availability, allocation, document rules, inventory, redirect mechanics).
- **Do not modify the Protected Skill** `kanban-external-agent-dispatch`
  (`direct_external_executors.py`, `invoke-qwen-worker.ps1`, etc.). Its current revision was
  narrowly Owner-approved for the secret-scanner fix only. If you believe an executor change is
  required, STOP and report a Decision Gap instead.

## 6. Allowed write paths

`platform/runtime/tests/**`, `platform/runtime/scripts/**`, `platform/runtime/src/**` **only** where
a real executed failure proves a defect, `docs/**` (evidence/log only).

Prohibited: credential files or any credential value; live Stripe keys/charges; production DB;
webhook registration; deploy/merge/push; migrations/DDL; `PS01.test.ts`/`LK01.test.ts` pins;
Protected Skill scripts; unrelated dirty/untracked files; LR-2E/LR-2F scope.

## 7. Verification you must run and report

```
cd platform/runtime && npm run build          # expect exit 0
cd platform/runtime && npm run typecheck      # expect exit 0
cd platform/runtime && npm test               # report # tests / # pass / # fail (expect all pass)
cd platform/profile-registry && npm test      # expect 16/16
git diff --check                              # expect clean
git diff --stat                               # list every changed file
node scripts/run-sb01-lr2d-reconcile-slice.mjs    # your real slice, from platform/runtime
```

`BILLING_DATABASE_URL`, `STRIPE_SECRET_KEY` (TEST) and `STRIPE_WEBHOOK_SECRET` are provided as env
vars. If a required credential/listener is genuinely unavailable, return `BLOCKED_CREDENTIAL` /
`BLOCKED_LISTENER` with the exact missing item — do **not** downgrade the evidence bar.

## 8. Stop condition

`READY FOR CODEX LR-2D INDEPENDENT VERIFY` — or an explicit `BLOCKED_*` with the exact blocker.
Do not commit or push (Hermes stages and commits the verified revision). Do not start LR-2E.
