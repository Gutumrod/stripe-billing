# EVIDENCE — SB01 LR-2D — Claude CORE-BUILDER resume — 2026-09-17

**STATUS: COMPLETE — real-slice harness written and run against real PostgreSQL + real Stripe
TEST via the live `stripe listen` forward. 32/32 harness checks PASS on a clean run. All required
verification commands PASS.**

Stop condition: **READY FOR CODEX LR-2D INDEPENDENT VERIFY**

## 0. Revisions

```
git rev-parse HEAD    -> 7510715175fad3a64cbd69fdd385e93de8ff25fa
git rev-parse HEAD^   -> 0f85b6e2213c6ec77f6149fd44d5a74c04029094
```

HEAD is one commit ahead of the dispatch's stated expected base `0f85b6e2…`. That extra commit
(`7510715`, author Hermes) is **docs-only**: `git show --stat 7510715` shows a single file added,
`docs/relay/AGENT-DISPATCH-SB01-LR-2D-CLAUDE-RESUME-2026-09-17.md` — the dispatch record for this
very round — with no source or test change. The code tree at HEAD is therefore byte-identical to
`0f85b6e2…` for every file this evidence discusses. Proceeded on that basis rather than stopping,
since the divergence is a documentation-only addition, not an unexpected code revision.

## 1. Inherited from `0f85b6e2…` (not re-claimed, not re-authored here)

- `platform/runtime/src/db.ts` — `OUTBOX_LEASE_PRESERVING_CONFLICT_SET` + `resolveOutboxConflict`
  preserve `completed` exactly like `dead_letter` in every outbox-conflict branch, fixing the
  defect where a duplicate/stale event arriving after its job had already completed resurrected
  it to `pending`.
- `platform/runtime/tests/outbox-lease-reconcile-crash-window-real-db.test.mjs` (real PostgreSQL).
- `platform/runtime/tests/helpers/lr2d-real-db-fixtures.mjs`.
- Previously independently re-run by Hermes on the committed tree: build 0, typecheck 0,
  `npm test` 58/58, `platform/profile-registry` 16/16.

This round did not touch `platform/runtime/src/**` at all — `git status --short -- platform/runtime/src`
is empty. No real-execution failure in this round pointed at a source defect requiring repair (see
§7 residual finding for the one non-blocking behavior observed and left undisturbed).

## 2. This round's deliverables

1. `platform/runtime/scripts/run-sb01-lr2d-reconcile-slice.mjs` — TEST-gated real-slice harness.
2. This evidence file.
3. `docs/relay/LR2D-RECONCILE-SLICE-RUN-2026-09-17.log` — the clean 32/32 PASS run's full output.

## 3. Verification commands run (real output, exit codes)

```
$ cd platform/runtime && npm run build
BUILD_EXIT=0

$ cd platform/runtime && npm run typecheck
TYPECHECK_EXIT=0

$ cd platform/runtime && npm test
# tests 58
# pass 58
# fail 0
TEST_EXIT=0

$ cd platform/profile-registry && npm test
# tests 16
# pass 16
# fail 0
REGISTRY_TEST_EXIT=0

$ git diff --check
DIFF_CHECK_EXIT=0 (no output — clean)

$ git diff --stat
(no output — no tracked file was modified; all deliverables are new untracked files)

$ git status --short -- platform/runtime/src platform/runtime/scripts \
    docs/platform/billing-core/EVIDENCE-SB01-LR-2D-CLAUDE-2026-09-17.md \
    docs/relay/LR2D-RECONCILE-SLICE-RUN-2026-09-17.log
?? docs/platform/billing-core/EVIDENCE-SB01-LR-2D-CLAUDE-2026-09-17.md
?? docs/relay/LR2D-RECONCILE-SLICE-RUN-2026-09-17.log
?? platform/runtime/scripts/          (contains this round's new harness; the pre-existing
                                        LR-2C harness and an unrelated tmp-probe.mjs left over
                                        from an earlier session are untouched, not authored here)

$ cd platform/runtime && node scripts/run-sb01-lr2d-reconcile-slice.mjs
EXIT=0, 32/32 checks [PASS] (full output in docs/relay/LR2D-RECONCILE-SLICE-RUN-2026-09-17.log)
```

## 4. Fixture route (harness setup step, declared per dispatch §4)

Stripe's Test backend API has no payer-side completion route for a card Checkout session (proven
at LR-2C: `POST /v1/checkout/sessions/:id/confirm` → 404 `Unrecognized request URL`). A *paid*
subscription at the pinned profile price therefore cannot be produced through the Core checkout
path alone — completing payment on the hosted Checkout page is the payer's action and is outside
what the Core API does or should do.

**What the harness does instead:** it first calls the Core HTTP boundary's real `/v1/checkout`
route with full server-side authority (same as LR-2C Phase 2) to obtain a real, durably-mapped
Stripe Test customer for the run's account. It then, as a declared **harness setup step against
the Stripe TEST API directly** (never through the Core boundary, never claiming to be a checkout
completion): attaches the Stripe-provided test payment method token `pm_card_visa` to that real
customer, then creates a **real Stripe Test subscription** object directly via
`POST /v1/subscriptions` for that customer, at the **pinned profile price**
(`price_1UDCxyHB4GRCffd9RyaDWZ1c`, PS01 `founding-c2`) and with the **same metadata** the Core
checkout flow would have attached (`wstera_product_id`, `account_id`, `profile_version`,
`plan_id`). This simulates the external provider world reaching a state a completed checkout would
also reach; it does not go through, bypass, or relax any Core authority check — the Core HTTP
boundary and its webhook route never see or trust anything from this step directly. The real
subscription object created this way emits real Stripe Test webhooks
(`customer.subscription.created/.updated/.deleted`), which travel through the already-running live
`stripe listen` forward into the Core webhook route exactly as they would from any other source of
a real Stripe subscription event. No Core authority rule is relaxed for this step; a reviewer
should read it as "creating fixture state directly with the provider," not as a checkout claim.

A second such subscription, sharing the same real customer and payment method, is created at a
**foreign price** (`price_1UDCxzHB4GRCffd9a0rUipHY`, the LK01-pinned price — a real, valid Stripe
Test price, just not one mapped under the PS01 profile) to produce a real provider-truth mismatch
(§3 item 4, §6 below).

## 5. §3 requirement → evidence map

All checks below are drawn from the clean run recorded verbatim in
`docs/relay/LR2D-RECONCILE-SLICE-RUN-2026-09-17.log` (run tag `0d143b95`, 32/32 PASS, exit 0).

1. **Real event reaches Core webhook route, passes real HMAC validation, durably claimed before
   processing.** Phase 3: `real customer.subscription.created event durably claimed via live
   stripe listen → Core webhook route` — the event travels through the live `stripe listen`
   process (already running, forwarding to `http://127.0.0.1:8787/webhooks/stripe`), is verified
   against the real `whsec_` secret by `verifyStripeWebhook`, and is inserted into
   `runtime_provider_events` (`status=pending`, environment/product/account populated from the
   real customer mapping) **before** any reconcile job runs.
2. **Claim drives the outbox — enqueued for a mapped event, correctly skipped for an unmapped
   one.** Phase 3: `mapped webhook claim enqueued a reconcile outbox job (pending,
   pre-processing)`. Phase 6: a `stripe trigger customer.subscription.updated` fixture event
   (synthetic, unmapped customer) is durably claimed with `status=skipped` and
   `unmapped event enqueued no reconcile outbox job` (0 rows) — both directions proven.
3. **Job leased and processed; reconciliation uses provider truth via `retrieveSubscription` —
   matching product/account/amount/currency/provider object.** Phase 3:
   `reconcile job for the real customer.subscription.created event completed against provider
   truth`, and `reconciliation_state matches real Stripe subscription (price/product/amount/
   currency)`: `price=price_1UDCxyHB4GRCffd9RyaDWZ1c amount=99000 currency=THB version=1
   status=active` — every field re-derived from a live `GET /v1/subscriptions/:id` call, not from
   anything caller- or DB-supplied.
4. **Provider-truth mismatch rejected with the correct `RECONCILE_*_MISMATCH` code, no
   billing-state mutation.** Phase 5: the foreign-price subscription's reconcile job
   `does NOT complete` (`status=failed`) and is `rejected with RECONCILE_PRICE_MISMATCH (real
   Stripe price truth vs. pinned profile)`; `mismatch left no billing-state mutation (no
   reconciliation_state row)` and `mismatch did not disturb the existing entitlement sink version`
   (still `version=1`).
5. **Duplicate delivery of the same provider event is idempotent.** Phase 4: the exact raw JSON
   body the live listener delivered for the `customer.subscription.created` event was captured
   byte-for-byte by the harness's HTTP server wrapper (see §6 below), then re-signed with a fresh
   timestamp using the real `whsec_` and POSTed again directly to the Core webhook route —
   `duplicate delivery accepted 200 and flagged duplicate=true`. Result: `duplicate delivery
   created no second provider-event row` (still 1), `duplicate delivery created no second outbox
   job` (still 1, same dedupe key), `duplicate delivery produced no second entitlement
   transition/sink version` (still `version=1`), `exactly one entitlement transition row exists
   after duplicate replay`.
6. **A completed job is not resurrected by a later duplicate/stale enqueue — proven through real
   execution against the `0f85b6e2` fix.** Same Phase 4 duplicate replay: before the replay, the
   reconcile job for that event had already reached `status=completed` (`reconcile outbox job
   reached completed status before duplicate replay`, `completed_at` non-null). The duplicate
   delivery re-enters `claimWebhookEvent`, which re-runs the outbox `insert … on conflict do
   update set OUTBOX_LEASE_PRESERVING_CONFLICT_SET` against that same `dedupe_key` — this is the
   exact code path `0f85b6e2` changed. After the replay: `§3 item 6: completed job NOT resurrected
   to pending by duplicate/stale conflict (real execution, 0f85b6e2 fix)` — `status=completed`.
   This is real execution proof of the committed fix, not a citation of its unit test.
7. **Entitlement transition durable, delivered to the test sink with a monotonic version.**
   Phase 3: `§3 item 7: entitlement delivered to test sink, version 1, grant, correct keys` —
   `type=grant version=1 keys=["commercial_access"]`. Phase 7 (real cancellation, see below):
   `entitlement sink shows revoke transition with monotonically increasing version (2 > 1)` —
   `type=revoke version=2 keys=[]`. The version increase is driven by a **second real Stripe
   event** (`customer.subscription.deleted`, from an actual `DELETE /v1/subscriptions/:id` call),
   not by anything synthetic.
8. **Cleanup.** Every Stripe object and every WSTERA LAB row created by the run is removed and the
   harness prints scoped counts. From the clean run: `SCOPED CLEANUP COUNTS:
   {"subscriptions_deleted":2,"customers_deleted":1,"db_rows_deleted":40}`.

## 6. Duplicate-delivery replay mechanism (how it's real, not synthetic)

The harness's Node HTTP server wraps each incoming request to `/webhooks/stripe` in a thin
async-iterator tee: it forwards every chunk unchanged to the real Core handler (so the live
`stripe listen` traffic is untouched) while also buffering a copy. Once the body is fully read, if
it parses as JSON with an `id` field, the exact raw bytes are stored keyed by that event id. For
the duplicate-delivery check, the harness takes the stored raw bytes for the real
`customer.subscription.created` delivery, computes a fresh `Stripe-Signature` header over
`{new_timestamp}.{same_raw_bytes}` using the real `whsec_` (the same secret the live listener
signs with), and POSTs it directly to the Core boundary. This is a byte-faithful replay of the
same event content Stripe actually delivered, under a freshly computed valid signature — the same
shape a genuine Stripe retry delivery takes (same event id/content, new signature/timestamp per
attempt).

## 7. Residual gap (observed, not fixed — non-corrupting)

Real execution surfaced that **any** mapped webhook event for the run's customer — not just
subscription-lifecycle events — is claimed and enqueues its own reconcile job, including event
types the reconcile pipeline cannot act on (e.g. `payment_method.attached`, and `invoice.*`
events fired when the test subscription is created already-paid). Their `data.object` carries no
`id` matching a subscription and no `.subscription` reference, so `providerObjectId` in
`webhook.ts`'s `verifyStripeWebhook` resolves to `null`; `processReconcileJob`'s
`requireString(job.payload.providerObjectId, …)` then throws `REQUEST_FIELD_REQUIRED` and the job
fails, eventually dead-lettering after `max_attempts`. This is **fail-closed and non-corrupting**
— no billing-state mutation, no entitlement change, no authority-model or invariant violation —
but it is wasted queue/worker capacity for event types the reconcile job type cannot use. The
harness accounts for this by draining the whole queue (like a real worker loop) and asserting
against the specific dedupe-keyed job under test, rather than assuming exactly one job is pending
per real Stripe action; every drain's non-target outcomes are exactly these harmless
`REQUEST_FIELD_REQUIRED` failures, confirmed by the full per-phase drain-outcome logs in
`docs/relay/LR2D-RECONCILE-SLICE-RUN-2026-09-17.log`. Left undisturbed per dispatch §6 ("do not
re-edit `platform/runtime/src/db.ts` unless real execution proves a further defect" — and this
finding is in `webhook.ts`'s event-type routing, not `db.ts`, and does not corrupt state) and per
dispatch §8 (bounded round, report findings rather than expand scope). Flagging as a Decision Gap
for a future round: should the webhook intake filter which event types are eligible to enqueue a
reconcile job (e.g. only `customer.subscription.*`), to avoid the guaranteed-fail job/dead-letter
noise?

## 8. Invariant confirmations

- **No live/production mutation.** `STRIPE_SECRET_KEY` gated to `sk_test_…` at both the harness
  entry and inside `StripeTestAdapter`'s constructor (`LIVE_KEY_DENIED` otherwise); every Stripe
  object created/read/deleted was confirmed `livemode: false`; `BILLING_DATABASE_URL` points at
  the WSTERA LAB `billing_core_staging` schema, never `billing_core`; the runtime itself refuses
  `environment !== 'test'` and `schema !== 'billing_core_staging'` at construction.
- **No secret value exposed.** The harness never logs `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
  or `BILLING_DATABASE_URL` in full — only prefix/length/host, matching the LR-2C harness's
  convention. All Stripe object ids in output are masked via `maskId` (first 12 + `…` + last 4).
- **No schema/migration/dependency change.** `git status --short -- platform/runtime/src` is
  empty; no `package.json`/`package-lock.json`/migration file appears in this round's diff.
- **No Protected Skill edit.** `direct_external_executors.py`, `invoke-qwen-worker.ps1`, and the
  rest of `kanban-external-agent-dispatch` were not read or touched this round.
- **Fail-closed codes intact** — none of `LIVE_WEBHOOK_DENIED`, `WEBHOOK_TIMESTAMP_INVALID`,
  `WEBHOOK_SIGNATURE_INVALID`, `WEBHOOK_IDENTITY_MISSING`, `WEBHOOK_BODY_TOO_LARGE`,
  `LIVE_PROVIDER_OBJECT_DENIED`, `LIVE_JOB_DENIED` were touched by this round (those denial paths
  were already proven at LR-2C with real `whsec_`); the `RECONCILE_*_MISMATCH` family was
  exercised fresh here via `RECONCILE_PRICE_MISMATCH` against a real Stripe object (§5 item 4).
- **Server-side authority model unchanged** — no caller-supplied field became authoritative; the
  fixture route (§4) never sends anything to the Core HTTP boundary that the checkout/webhook
  handlers weren't already designed to receive from a real payer/provider.

## 9. Stop condition

**READY FOR CODEX LR-2D INDEPENDENT VERIFY.** No commit or push performed by this round.
