# PHASE CLOSURE — LR-2D — SB01 LONG_RUN — 2026-09-17

Task: `SB01-LONG-RUN-2C-2F-001` (continued, same Task ID)
Brief: `docs/tasks/BRIEF-SB01-LONG-RUN-COMPLETION-2026-09-17.md`
Orchestrator: Hermes (Clerk/Orchestrator only — no source repair by Hermes)

## Phase state

```text
Phase: LR-2D — Webhook durability + reconciliation
State: CLOSED / PASS (independent verification PASS at exact revision)
Repo: Gutumrod/stripe-billing
Branch: work/sb01-central-billing-pc-20260911
```

## Revision binding (all resolved by command)

| Ref | Value |
|---|---|
| Reviewed target | `c59fc85d3f996d571ebed68c27f4dad7ac9f9be1` |
| Target parent | `7510715175fad3a64cbd69fdd385e93de8ff25fa` |
| Source-fix commit (round 1) | `0f85b6e2213c6ec77f6149fd44d5a74c04029094` |
| Stage base (Claude dispatch) | `f1324e0` |
| Remote `origin/work/sb01-central-billing-pc-20260911` | `c59fc85d3f996d571ebed68c27f4dad7ac9f9be1` (pushed) |
| Reviewed in clean worktree | `D:\AI-Workspace\runtime\reviews\sb01-lr2d-exact` @ `c59fc85d` (detached, no modified tracked files) |

## Files changed

Round 1 (`0f85b6e2`):
- `platform/runtime/src/db.ts` (M) — outbox conflict clause + pure mirror
- `platform/runtime/tests/outbox-lease-reconcile-crash-window-real-db.test.mjs` (A)
- `platform/runtime/tests/helpers/lr2d-real-db-fixtures.mjs` (A)
- `platform/runtime/tests/outbox-conflict-sql-qualification.test.mjs` (M), `outbox-lease-conflict.test.mjs` (M)

Round 2 (`c59fc85d`):
- `platform/runtime/scripts/run-sb01-lr2d-reconcile-slice.mjs` (A)
- `docs/platform/billing-core/EVIDENCE-SB01-LR-2D-CLAUDE-2026-09-17.md` (A)
- `docs/relay/LR2D-RECONCILE-SLICE-RUN-2026-09-17.log` (A)

## Source defect found and fixed

`OUTBOX_LEASE_PRESERVING_CONFLICT_SET` (and its hand-mirrored `resolveOutboxConflict`) resurrected a
**completed** outbox job to `pending` when a duplicate/stale event re-arrived with the same
`dedupe_key`. Two real consequences:

1. already-settled billing state would be re-processed; and
2. because a `completed` row carries a non-null `completed_at`, the row violates
   `runtime_outbox_jobs_completion_check` (`status <> 'completed'` requires `completed_at IS NULL`)
   the next time a worker completes or fails it.

Fix: treat `completed` exactly like `dead_letter` in every branch (preserve status,
`next_attempt_at`, `lease_owner`, `lease_expires_at`). Proven by real execution, not just by the
unit test (see the 32/32 slice, check 17).

## Commands and results (HERMES-run, on the committed tree, clean exact-target worktree)

| Check | Command | Result |
|---|---|---|
| Build | `npm run build` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0 |
| Runtime tests | `npm test` | **`# tests 58 / # pass 58 / # fail 0`** (was 43) |
| Profile registry | `npm test` | `# tests 16 / # pass 16 / # fail 0` |
| Whitespace | `git diff --check` | clean |
| Real Stripe TEST + LAB slice | `node scripts/run-sb01-lr2d-reconcile-slice.mjs` | **32 / 32 PASS, 0 FAIL, exit 0** |

## Real provider evidence (Stripe TEST only)

Live `stripe listen` forward to `http://127.0.0.1:8787/webhooks/stripe`; real HMAC-signed deliveries
answered **HTTP 200** (no 500s in the LR-2D run):

- real `customer.subscription.created` → durable claim (`status=pending`) → reconcile outbox job
  enqueued **before** processing → lease → reconcile against **provider truth**
  (`retrieveSubscription`) → `runtime_reconciliation_state` matches real price
  (`price_1UDCxy…WZ1c`), amount 99000, currency THB, version 1, status `active`
- entitlement **grant v1** delivered to the test sink with keys `["commercial_access"]`
- **duplicate delivery**: 200 with `duplicate=true`, **no** second provider-event row, **no** second
  outbox job, **no** second sink version; completed job stayed `completed` (the `0f85b6e2` fix,
  proven by real execution)
- **provider-truth mismatch** (foreign real price): job `failed` with `RECONCILE_PRICE_MISMATCH`,
  reconciliation state row absent, existing sink version undisturbed
- **unmapped intake**: durably claimed `status=skipped`, **zero** reconcile outbox jobs
- real cancellation → `customer.subscription.deleted` → reconcile `completed` → state
  `canceled` version **2** → sink **revoke v2** (monotonic, 2 > 1)
- cleanup: 2 subscriptions + 1 customer deleted; 40 scoped LAB rows deleted; post-run recount shows
  all scoped counts back to baseline

## Fixture route (declared, not hidden)

Because Stripe's Test backend API has no payer-side completion route for card Checkout sessions
(proven at LR-2C), the paid provider subscription for this slice was created **directly against the
Stripe TEST API** for a real test customer using the **pinned profile price** and correct metadata.
This simulates the external world (provider state); it is not a command to SB01, not a bypass of
SB01's authority model, and **no core authority rule was relaxed for it**. Recorded in the evidence
artifact as a harness setup step.

## Database evidence (WSTERA LAB, read-only verification)

`billing_core_staging` on PostgreSQL 17.6. The slice created and then removed real rows in
`runtime_provider_events`, `runtime_outbox_jobs`, `runtime_reconciliation_state`,
`runtime_entitlement_transitions`, `runtime_entitlement_test_sink`, `runtime_audit_events`,
`runtime_provider_customers`, `runtime_operations`, `runtime_credential_bindings`. Reviewer
independently recounted the scoped row counts after the rerun and confirmed zero remain.

## Security / authority checks

- Server-side authority model unchanged; no caller-supplied field became authoritative.
- Provider truth over caller/DB commercial state — verified independently by the reviewer
  (`runtime.ts:515-584`).
- Fail-closed codes intact (webhook + `LIVE_*` + `RECONCILE_*_MISMATCH`).
- Unmapped intake `skipped` with no outbox job.
- No schema/migration/dependency change; no `.env` edit.
- Secret scan of LR-2D artifacts: only locally generated synthetic signer seeds
  (`crypto.randomUUID()`-derived) were flagged by the broad pattern; no vault credential value
  appears anywhere. Verified against the Owner-approved synthetic-secret classifier.
- Control Plane boundary untouched by this diff.
- Protected Skill `kanban-external-agent-dispatch` NOT modified in this phase.

## Reviewer / verdict

- Reviewer: `agent-codex` (FINAL-AUDITOR, `INDEPENDENT-QA`), direct external process provenance.
- Report: `docs/platform/billing-core/CODE-2-QA-REPORT-SB01-LR-2D-CODEX-2026-09-17.md`
- **`VERDICT: PASS`** at `c59fc85d3f996d571ebed68c27f4dad7ac9f9be1`.
- Reviewer's own re-run: `30/31` — the single miss was only because the `stripe` CLI was unavailable
  in its sandbox for the unmapped-fixture trigger; the persisted 32/32 run and matching source logic
  cover it.
- Reviewer's residual limitation: aggregate `npm run build` / `npm test` could not be re-run in its
  read-only sandbox (EPERM); Hermes ran them in the same clean exact-target worktree and the
  results are recorded above. Direct per-file tests reproduced: outbox conflict 6/6, SQL
  qualification 4/4, profile registry 8/8, profile concurrency 8/8.
- Non-blocking finding recorded, not fixed (outside the bounded round): mapped event types that
  cannot derive a `providerObjectId` (e.g. `payment_method.attached`) are durably claimed and
  enqueue a reconcile job that then fails fail-closed with `REQUEST_FIELD_REQUIRED` — no
  billing-state mutation, but it consumes queue capacity. Recorded as a Decision Gap for explicit
  follow-up rather than silently changed.

## Executor defect chain handled this phase (no silent substitution)

1. `agent-qwen` readiness PASS → substantive run **exit 55** (known Windows ConPTY/`AttachConsole`
   class). Record: `docs/relay/CHAIN-FAILURE-SB01-LR-2D-QWEN-EXIT55-2026-09-17.md`.
2. Codex classification → **`ROUTE: SEND_TO_CLAUDE`**
   (`docs/relay/ROUTE-SB01-LR-2D-EXECUTOR-CLASSIFY-CODEX-2026-09-17.md`); role-admissibility table
   recorded (AGY UI-only, Codex must stay verifier, OpenCode not admitted).
3. `agent-claude` round 1 → **`DIRECT_EXECUTOR_TIMEOUT:claude.exe`** (new fingerprint
   `EXECUTOR-CLAUDE-TIMEOUT`) after the source fix + tests landed; partial status record
   `docs/relay/STATUS-SB01-LR-2D-PARTIAL-2026-09-17.md`.
4. Bounded resume round (remaining deliverables only) → harness + evidence + run log, 32/32 PASS.

No blind retry of a broken executor; no silent agent substitution; every replacement routing
explicit and recorded.

## Known limitations

- Mapped non-subscription events can enqueue guaranteed-fail reconcile jobs (non-blocking; Decision
  Gap recorded).
- Entitlement-path JSONB sites still have no dedicated standalone real-PostgreSQL regression test
  (covered by parity + the LR-2D suite + this real slice).
- `platform/runtime/scripts/` (both LR-2C and LR-2D harnesses) remains untracked in the working
  worktree by design; the LR-2D harness is now committed, the LR-2C one is not yet.
- Stripe CLI listener secret is ephemeral per listener session; a dead listener must fail closed.

## Next phase

**LR-2E — entitlement + multi-product isolation** (PS01 + LK01) on the exact current revision.
Released now that LR-2D is independently PASSed.
