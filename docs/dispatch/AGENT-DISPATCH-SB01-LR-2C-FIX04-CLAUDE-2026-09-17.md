# AGENT DISPATCH — SB01 LR-2C FIX-04 — Durable-claim JSONB encoding — Claude — 2026-09-17

Task: `SB01-LONG-RUN-2C-2F-001`
Workflow: `WF-RELAY-01` / Runtime `kanban-external-agent-dispatch v2.5.1`
Work type: `DIRECT-APPROVED` / Release policy `RELAY_STANDARD`
Role: `CORE-BUILDER`
Selected agent: `agent-claude` (context mode `BUILD`)
Base revision (work from exactly this): `ac0290ae08068be04b786db7c42b1f65e08428d9`
Workspace: `D:\AI-Workspace\runtime\worktrees\sb01-central-billing-20260909`
Branch: `work/sb01-central-billing-pc-20260911`

## 1. Why you are here

The LR-2C real Stripe TEST + WSTERA LAB slice passes 27/28 checks and fails exactly one: the
webhook durable claim returns HTTP 500, so **zero** provider events are durably persisted.

Failure record (read this first — full root cause, no re-discovery needed):
`docs/relay/CHAIN-FAILURE-SB01-LR-2C-WEBHOOK-JSONB-2026-09-17.md`
Run evidence: `docs/relay/LR2C-REALSLICE-RUN-2026-09-17.log`

Proven root cause: `JSON.stringify(x)` is passed into a `$n::jsonb` cast / `sql.unsafe` on a
`prepare: false` connection, so `postgres@3.4.5` stores the JSON **text** as a jsonb string
scalar instead of a jsonb object. The live catalog constraint
`runtime_provider_events_hint_envelope_check CHECK (jsonb_typeof(hint_envelope) = 'object')`
correctly rejects it with `PostgresError 23514`, which escapes `sql.begin()` untranslated and
surfaces as the `runtime.ts:175` catch-all `INTERNAL_ERROR` 500.

This is a bounded ordinary repair (**repair attempt 1 of at most 2** for this issue fingerprint).

## 2. Objective

Make the runtime's JSONB writes produce genuine jsonb objects/arrays on a `prepare: false`
connection, so the webhook durable claim succeeds against the real WSTERA LAB database while
preserving every existing contract and invariant.

## 3. Required scope (repair the class, not only the reported site)

Fix all five affected statements in `platform/runtime/src/db.ts`:

| Line | Statement | Affected payload |
|---|---|---|
| 342–343 | `claimWebhookEvent` provider-event INSERT | `hint_envelope`, `normalized_envelope` |
| 361 | `claimWebhookEvent` outbox INSERT | `payload` |
| 565–567 | entitlement transition INSERT | `entitlement_keys` (array), envelope (object) |
| 581 | entitlement outbox INSERT | `payload` |
| 620–621 | entitlement conflict-update path | envelope |

Use the correct pattern already established in the same file (`db.ts:128`, `:186`, `:313`,
`:458`) — the `sql.json(...)` / `tx.json(...)` helper — or an equivalently proven correct
construction. Do not invent a new JSON helper or change the DB driver.

**Also required (this is the reason the suite missed it):** add a test that executes the real
PostgreSQL path for the webhook durable claim (matching the project's existing real-DB test
style, e.g. `tests/outbox-conflict-sql-qualification.test.mjs` shows the source-level pattern;
this new test must actually run SQL, not assert on source strings). It must fail against the
pre-repair encoding and pass after it. If real-DB execution in the test harness is genuinely
impossible, say so explicitly and instead add the strongest executable proof you can plus a
clearly-labelled residual gap — do not silently substitute a string-match test.

## 4. Invariants that must not change

- Authority model untouched: product/environment/price/amount/currency/customer/return-URL/
  profile-version all remain server-derived. No new caller-supplied field may become authoritative.
- `LIVE_WEBHOOK_DENIED`, `WEBHOOK_TIMESTAMP_INVALID`, `WEBHOOK_SIGNATURE_INVALID`,
  `WEBHOOK_IDENTITY_MISSING`, `WEBHOOK_BODY_TOO_LARGE` fail-closed behavior unchanged.
- Unmapped webhook intake must still durably claim with `status='skipped'` and enqueue **no**
  reconcile outbox job.
- FIX-02 (portal `return_ref` allowlist validated **before** `beginOperation`,
  `runtime.ts:366-368`) must remain intact.
- Idempotency/dedupe semantics (`on conflict (provider, provider_event_id) do nothing`,
  `dedupe_key`, `OUTBOX_LEASE_PRESERVING_CONFLICT_SET`) unchanged.
- No schema/migration change. No new dependency. No live Stripe. No production DB.

## 5. Allowed write paths

- `platform/runtime/src/db.ts` (and other `platform/runtime/src/**` only if the same defect class
  is proven there)
- `platform/runtime/tests/**`
- `docs/**` (evidence/return document only)

## 6. Prohibited

- `.env` or any credential file; no secret values in code, tests, logs, evidence, or commit messages.
- Live Stripe keys, live charges, production DB, webhook registration, deploy, merge, push.
- Migrations or schema/DDL changes. Changing `PS01.test.ts` / `LK01.test.ts` pins.
- Widening scope to LR-2D/2E/2F. Unrelated refactoring or formatting sweeps.
- Touching unrelated dirty/untracked files in the worktree.
- Repairing and self-approving: your job is the fix; independent verification is Codex's.

## 7. Verification you must run and report

Exact commands, exact output, exact exit codes:

1. `cd platform/runtime && npm run build` → expect exit 0
2. `cd platform/runtime && npm run typecheck` → expect exit 0
3. `cd platform/runtime && npm test` → expect all pass; report `# tests / # pass / # fail`, and
   report the new test's name and that it exercises real SQL
4. `cd platform/profile-registry && npm test` → expect 16/16
5. `git diff --check` (working tree) → expect clean
6. `git diff --stat` and the intended-diff review: list every changed file

Credentials for step 3's real-DB test are already present in the worker environment
(`BILLING_DATABASE_URL`, Stripe TEST key, `STRIPE_WEBHOOK_SECRET` are seeded by the launcher).
**Never print, echo, log, or commit any credential value** — reference presence only. If a
credential is genuinely absent, stop and report `BLOCKED_CREDENTIAL` instead of weakening the test.

## 8. Required return artifact

Write `docs/platform/billing-core/EVIDENCE-SB01-LR-2C-FIX04-CLAUDE-2026-09-17.md` containing:

- base revision + the exact revision you finished on;
- per-call-site change description (what was wrong, what it is now);
- the changed-file list and intended-diff statement (no prohibited-path change);
- every command from §7 with real output and exit code;
- confirmation that §4 invariants are intact, with the specific check you used for each;
- the new test: name, what it executes, and its pass/fail evidence;
- any residual gap or untested area, stated plainly;
- explicit confirmation: no secret exposed, no live/production mutation, no schema change.

## 9. Stop condition

`READY FOR CODEX LR-2C FIX-04 INDEPENDENT VERIFY` — or `BLOCKED_*` with the exact blocker,
if a required credential/path is genuinely unavailable. Do not continue into LR-2D.
Do not commit or push; Hermes stages and commits the exact verified revision after the
deterministic gate, so that the reviewed SHA is unambiguous.
