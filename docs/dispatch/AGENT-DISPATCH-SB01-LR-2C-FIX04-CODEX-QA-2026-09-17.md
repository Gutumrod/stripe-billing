# AGENT DISPATCH — SB01 LR-2C — INDEPENDENT QA (first pass) — Codex — 2026-09-17

Task: `SB01-LONG-RUN-2C-2F-001`
Workflow: `WF-RELAY-01` / Runtime `kanban-external-agent-dispatch v2.5.1`
Work type: `DIRECT-APPROVED` / Release policy `RELAY_STANDARD`
Role: `FINAL-AUDITOR` / independent checkpoint verifier
Selected agent: `agent-codex` (context mode `INDEPENDENT-QA`)
Target revision (exact, verify against this): `4b2beb1ee2c05b154b5a306026dfa13d000ad913`
Repair material revision: `d47033bf2bc0bcbd2fc1dbfa5ad7edb6e2bbf3f6` (parent of the target)
Workspace: `D:\AI-Workspace\runtime\worktrees\sb01-central-billing-20260909`
Branch: `work/sb01-central-billing-pc-20260911`
Repository: `Gutumrod/stripe-billing`

## 1. Your job

Independently verify whether **LR-2C** is actually closable at this revision. Do not repair
anything — you are the verifier, not the builder. Treat every claim below as a **claim to
verify**, not as proof. Inspect the real source, the real diff, and the real test execution.

Return exactly ONE routing verdict:

- `PASS`
- `FIX_BY_AGY`
- `FIX_BY_QWEN`
- `SEND_TO_CLAUDE`
- `SOL_OWNER_DECISION_REQUIRED`

Bind your verdict to the exact SHA. If not `PASS`, include the finding set plus the required
acceptance/regression checks for the remediation.

## 2. What LR-2C must prove (locked requirement, not a hint)

`authenticated product request -> product/account assertion -> billing profile -> server-owned
provider/price mapping -> durable operation -> Stripe TEST -> webhook -> signature validation ->
provider event persistence -> idempotent processing -> billing transition -> entitlement/outbox
evidence`

Verify every HTTP surface that actually exists and is in scope (checkout / subscription status /
entitlements / portal / webhook). Negative-authority coverage must include the applicable cases:
unknown/unauthorized product; wrong product/account; arbitrary account/Price selection attempt;
invalid credential binding/profile mismatch; live credential attempt; malformed return reference;
invalid webhook signature; duplicate provider event. Durability ordering must hold: no
financial/provider side effect may outrun the durable local intent/operation contract.

## 3. Claims made by this round (verify or falsify each)

1. `platform/runtime/src/db.ts`: five statements previously passed `JSON.stringify(x)` into a
   `$n::jsonb` cast on the `prepare:false` connection, storing JSON *text* as a jsonb string
   scalar and violating `runtime_provider_events_hint_envelope_check`
   (`jsonb_typeof(...) = 'object'`) with `PostgresError 23514`. Repair replaces them with
   `tx.json(...)`.
   - Verify from source, and independently confirm the semantic difference yourself against the
     live database if you can (e.g. `jsonb_typeof` of the two binding styles).
2. A new test `platform/runtime/tests/webhook-durable-claim-jsonb-real-db.test.mjs` executes real
   SQL (no DB mock) and fails against the pre-repair encoding with the same 23514.
   - Re-run it. Confirm it actually executes on real PostgreSQL and asserts `jsonb_typeof`.
   - Confirm the test cleans up after itself and leaves no residual WSTERA LAB rows.
3. `npm run build` / `npm run typecheck` / `npm test` (43/43) / `platform/profile-registry`
   `npm test` (16/16) / `git diff --check` all pass at this revision.
   - Re-run them yourself. The 42→43 delta must be exactly the new test.
4. The real Stripe TEST + WSTERA LAB slice passes 45/45 with the real `stripe listen` forward.
   - The claim is that the previously failing leg now returns **200** instead of **500**.
   - Evidence: `docs/relay/LR2C-REALSLICE-RUN-2026-09-17.log`. If you re-run it, a TEST-mode
     Stripe CLI listener forwarding to `http://127.0.0.1:8787/webhooks/stripe` must be running;
     the harness is `platform/runtime/scripts/run-sb01-lr2c-real-slice.mjs`. Credentials are
     present in your environment as env vars — **never print, echo, or log their values**.
5. Invariants claimed intact: server-side authority derivation; fail-closed codes
   (`LIVE_WEBHOOK_DENIED`, `WEBHOOK_TIMESTAMP_INVALID`, `WEBHOOK_SIGNATURE_INVALID`,
   `WEBHOOK_IDENTITY_MISSING`, `WEBHOOK_BODY_TOO_LARGE`); unmapped intake claims
   `status='skipped'` with NO outbox job; FIX-02 portal `return_ref` allowlist validated before
   `beginOperation`; idempotency/dedupe and `OUTBOX_LEASE_PRESERVING_CONFLICT_SET` unchanged;
   no schema/migration/dependency change.
6. Declared residual gap (judge whether it blocks LR-2C closure): the three entitlement-path
   call sites (pre-fix lines 565–567, 581, 620–621) received the same class of fix but have **no**
   dedicated real-Postgres regression test this round; entitlement persistence is proven only by
   parity plus the existing in-memory/source-level tests.

## 4. Things you must check that are NOT asserted by the builder

- Does the repair leave any other `JSON.stringify` + `::jsonb` (or `sql.unsafe` JSON parameter)
  site anywhere in `platform/runtime/src/**` that can still store a jsonb string scalar?
  Enumerate them yourself and report any you find.
- Does `POST /webhooks/stripe` now return a durable-claim result, and does a **duplicate**
  delivery of the same provider event id remain correctly idempotent (no second row, no second
  outbox job)?
- Is `INTERNAL_ERROR` still reachable from the webhook path for any non-`BillingRuntimeError`
  database failure — i.e. does an infrastructure error still surface as a 500 that Stripe will
  retry (fail-closed), rather than a silent 200 that would lose the event? Report the current
  behavior explicitly.
- Ordering/durability: confirm the durable local intent/operation row is written before any
  provider side effect on the checkout path, and that webhook persistence precedes processing.
- Security/authority: confirm no caller-supplied field became authoritative, no new path reads
  provider credentials, and the Control Plane boundary (`canExecutePaymentActions = false`,
  read-only, no billing mutation) is not weakened anywhere in this diff.

## 5. Context mode and independence

You are in `INDEPENDENT-QA`. The evidence documents listed above are available, but do not treat
their narratives as proof — inspect the actual diff, source, and executed tests. The persisted
builder report is:
`docs/platform/billing-core/EVIDENCE-SB01-LR-2C-FIX04-CLAUDE-2026-09-17.md`
The failure record you should independently confirm or falsify:
`docs/relay/CHAIN-FAILURE-SB01-LR-2C-WEBHOOK-JSONB-2026-09-17.md`

If you conclude this pass is contaminated by prior conclusions, say so explicitly.

## 6. Allowed write paths

- Your verification report only, written to:
  `docs/platform/billing-core/CODE-2-QA-REPORT-SB01-LR-2C-FIX04-2026-09-17.md`
- Explicitly authorized temporary test/runtime artifacts.

**You must not edit production source, tests, migrations, or configuration — not even
temporarily and even if reverted.** A defect you find returns to the responsible builder.

## 7. Prohibited

Live Stripe keys/charges, production DB mutation, webhook registration, deploy, merge, push,
schema/DDL change, credential-value exposure, unrelated dirty/untracked file cleanup, scope
widening into LR-2D/2E/2F.

## 8. Required report content

- exact revision verified (`git rev-parse HEAD`, `git status --porcelain`) and remote parity;
- each claim from §3 marked verified / falsified / unverifiable, with the evidence you used;
- the checks you ran independently, with commands and real results;
- findings ordered by severity with file:line;
- untested areas and residual risk, stated plainly;
- for each §4 item, the observed behavior;
- one routing verdict, bound to the exact SHA, plus required acceptance/regression checks if not
  `PASS`.

## 9. Stop condition

Report + exactly one verdict. Do not advance to LR-2D. Do not commit or push.
