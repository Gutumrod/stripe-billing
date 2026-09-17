# AGENT DISPATCH — SB01 LR-2D — RESUME (remaining deliverables only) — Claude — 2026-09-17

Task: `SB01-LONG-RUN-2C-2F-001`
Runtime: `kanban-external-agent-dispatch v2.5.1` / `RELAY_STANDARD`
Role: `CORE-BUILDER` (bounded resume round)
Selected agent: `agent-claude` (context mode `BUILD`)
Authorization chain: Codex classification `ROUTE: SEND_TO_CLAUDE`
(`docs/relay/ROUTE-SB01-LR-2D-EXECUTOR-CLASSIFY-CODEX-2026-09-17.md`) → first Claude round ended in
`DIRECT_EXECUTOR_TIMEOUT:claude.exe` (new fingerprint `EXECUTOR-CLAUDE-TIMEOUT`, ordinary repairs
0/2) → this resume round.

## 0. Revisions — resolved by command, never inferred

```
git rev-parse 0f85b6e   -> 0f85b6e2213c6ec77f6149fd44d5a74c04029094   (base for this resume)
```
**Re-resolve `git rev-parse HEAD` and `git rev-parse HEAD^` yourself and record them.** If HEAD is
not `0f85b6e2…`, STOP and report — do not proceed on an unexpected revision.

Workspace: `D:\AI-Workspace\runtime\worktrees\sb01-central-billing-20260909`
Branch: `work/sb01-central-billing-pc-20260911`

## 1. What is ALREADY DONE — do not redo it

Your previous round **landed and is committed** as `0f85b6e2…`:

1. `platform/runtime/src/db.ts` — `OUTBOX_LEASE_PRESERVING_CONFLICT_SET` + `resolveOutboxConflict`
   now preserve `completed` exactly like `dead_letter` in every branch (fixes a real LR-2D defect:
   a duplicate/stale event after a completed reconcile resurrected the job to `pending`, which both
   re-processed settled billing state and violated `runtime_outbox_jobs_completion_check`).
   The two affected tests were updated to assert the corrected decision table.
2. `platform/runtime/tests/outbox-lease-reconcile-crash-window-real-db.test.mjs` (real PostgreSQL).
3. `platform/runtime/tests/helpers/lr2d-real-db-fixtures.mjs`.

Independently re-run by Hermes on the committed tree: `npm run build` 0, `npm run typecheck` 0,
`npm test` **58/58 PASS**, `platform/profile-registry` **16/16 PASS**.

**Do not re-author or restyle items 1–3.** They are committed and green. If you believe one of them
is wrong, report it as a finding instead of silently rewriting it.

## 2. What is MISSING — your entire remaining scope

Your previous round was cut off by the 1500 s timeout **before** writing these three deliverables:

1. **`platform/runtime/scripts/run-sb01-lr2d-reconcile-slice.mjs`** — the TEST-gated real-slice
   harness. Model it on `platform/runtime/scripts/run-sb01-lr2c-real-slice.mjs` (read it first; it
   already contains the working patterns for: env gates, masked ids, real Stripe REST helpers, the
   Core HTTP boundary on port 8787, DB counting helpers, and a `[PASS]`/`[FAIL]` recorder plus a
   summary block). It must refuse to run unless `STRIPE_SECRET_KEY` starts `sk_test_`,
   `STRIPE_WEBHOOK_SECRET` starts `whsec_`, and `BILLING_DATABASE_URL` is set.
2. **`docs/platform/billing-core/EVIDENCE-SB01-LR-2D-CLAUDE-2026-09-17.md`** — the builder evidence
   artifact (content spec in §5).
3. **`docs/relay/LR2D-RECONCILE-SLICE-RUN-2026-09-17.log`** — the machine-readable run log produced
   by the harness (one `[PASS]`/`[FAIL]` line per check + summary).

## 3. What the harness must actually prove

The real-Stripe chain that has **not** yet been proven end-to-end. It must demonstrate, through the
live `stripe listen` forward to `http://127.0.0.1:8787/webhooks/stripe`:

1. A real Stripe **TEST** event reaches the Core webhook route and passes **real HMAC signature
   validation** (real `whsec_`), then is **durably claimed** into `runtime_provider_events`
   before any processing.
2. That claim drives the **outbox**: a reconcile job is enqueued for a mapped event (or is
   correctly skipped for an unmapped one — prove both).
3. The reconcile job is **leased and processed**, and reconciliation uses **provider truth** via
   `retrieveSubscription` — matching product / account / amount / currency / provider object.
4. A provider-truth mismatch is **rejected** with the correct `RECONCILE_*_MISMATCH` code and leaves
   no billing-state mutation.
5. A **duplicate delivery** of the same provider event is idempotent: no second provider-event row,
   no second outbox job, no second entitlement transition/sink version.
6. A completed job is **not resurrected** by a later duplicate/stale enqueue (this is precisely the
   defect fixed in `0f85b6e2` — prove it through real execution, not by citing the unit test).
7. Entitlement transition is durable and delivered to the test sink with a **monotonic** version.
8. Cleanup: every provider object and every LAB row created by the run is removed, and the summary
   reports the scoped cleanup counts.

## 4. Fixture route (required, declared, honest)

Stripe's Test backend API has **no payer-side completion route** for a card Checkout session
(proven at LR-2C: `POST /v1/checkout/sessions/:id/confirm` → 404 `Unrecognized request URL`). So a
*paid* subscription at the pinned price cannot be produced through the Core checkout path alone.

**Authorized fixture route:** create the provider-side subscription **directly against the Stripe
TEST API** for a real test customer, using the **pinned profile price** and **correct metadata**
(`wstera_product_id`, `account_id`, `profile_version`, `plan_id`) taken from the PS01/LK01 test
profiles — so real Stripe webhooks (`customer.subscription.created` / `.updated` / `.deleted`)
fire and travel through the live listener into the Core webhook route.

Declare this explicitly in the evidence as a **harness setup step** with its rationale. It simulates
the external world (provider state); it is **not** a command to SB01, **not** a bypass of SB01's
authority model, and **no core authority rule may be relaxed** for it. A reviewer must not be able
to mistake it for a production checkout claim.

A TEST `stripe listen` is running (`pid 33400`, forwarding to `/webhooks/stripe`); its signing
secret matches the vault value. If it has died, start one with `STRIPE_API_KEY` from the environment
and record that you did — never print the generated signing secret.

## 5. Evidence artifact content (required)

Base revision + finishing revision (from real commands); the exact commands run with real output and
exit codes; the observed provider/LAB side-effect counts for each check; the §4 fixture-route
declaration; a §3→evidence map item by item; the committed state of `0f85b6e2` (source fix + 58-test
suite) restated as inherited, not re-claimed; residual gaps stated plainly; explicit confirmation of:
no live/production mutation, no secret value exposed, no schema/migration/dependency change, no
Protected Skill edit.

## 6. Invariants that must not change

- Server-side authority model unchanged; no caller-supplied field becomes authoritative.
- Fail-closed codes intact: `LIVE_WEBHOOK_DENIED`, `WEBHOOK_TIMESTAMP_INVALID`,
  `WEBHOOK_SIGNATURE_INVALID`, `WEBHOOK_IDENTITY_MISSING`, `WEBHOOK_BODY_TOO_LARGE`,
  `LIVE_PROVIDER_OBJECT_DENIED`, `LIVE_JOB_DENIED`, `RECONCILE_*_MISMATCH` family.
- Unmapped intake claims `status='skipped'` with **no** outbox job.
- Reconciliation never trusts caller- or DB-supplied commercial state — provider truth only.
- No schema/migration change, no new dependency, no live Stripe, no production DB, no `.env` edit.
- Boundary: `SB01 = verified billing-derived entitlement transition`; do not absorb product business
  rules (booking availability, allocation, document rules, inventory, redirect mechanics).
- **Do not modify the Protected Skill** `kanban-external-agent-dispatch`
  (`direct_external_executors.py`, `invoke-qwen-worker.ps1`, …). Its current revision is narrowly
  Owner-approved for the secret-scanner fix only. If you think an executor change is needed, STOP
  and report a Decision Gap.
- Do not re-edit `platform/runtime/src/db.ts` unless real execution proves a further defect —
  report the finding with evidence rather than refactoring.

## 7. Allowed write paths

`platform/runtime/scripts/**`, `platform/runtime/tests/**` (additions only),
`platform/runtime/src/**` only if a real executed failure proves a defect, `docs/**` (evidence/log).

Prohibited: credential files or any credential value; live Stripe keys/charges; production DB;
webhook registration; deploy/merge/push; migrations/DDL; `PS01.test.ts`/`LK01.test.ts` pins;
Protected Skill scripts; unrelated dirty/untracked files; LR-2E/LR-2F scope.

## 8. Time budget note (important)

Your previous round ran out of the 1500 s budget. **Write the three deliverables early and update
them as you go**, rather than leaving all writing to the end: create the harness skeleton, then the
evidence file with a status line you keep current, then fill in results. Partial-but-persisted beats
complete-but-lost. If you are running low, finish and save the harness + whatever evidence you have,
and state plainly what remains — do not start anything new.

## 9. Verification you must run and report

```
cd platform/runtime && npm run build          # expect exit 0
cd platform/runtime && npm run typecheck      # expect exit 0
cd platform/runtime && npm test               # report # tests / # pass / # fail
cd platform/profile-registry && npm test      # expect 16/16
git diff --check                              # expect clean
git diff --stat                               # list every changed file
node scripts/run-sb01-lr2d-reconcile-slice.mjs    # from platform/runtime; real slice
```

If a required credential/listener is genuinely unavailable, return `BLOCKED_CREDENTIAL` /
`BLOCKED_LISTENER` with the exact missing item — do not downgrade the evidence bar.

## 10. Stop condition

`READY FOR CODEX LR-2D INDEPENDENT VERIFY` — or an explicit `BLOCKED_*` with the exact blocker.
Do not commit or push (Hermes stages and commits the verified revision). Do not start LR-2E.
