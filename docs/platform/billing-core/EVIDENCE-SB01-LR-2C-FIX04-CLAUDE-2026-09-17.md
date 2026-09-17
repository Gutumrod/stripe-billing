# EVIDENCE — SB01 LR-2C FIX-04 — Durable-claim JSONB encoding — Claude — 2026-09-17

Task: `SB01-LONG-RUN-2C-2F-001`
Role: `CORE-BUILDER` (`agent-claude`, ordinary repair attempt 1 of 2 for fingerprint
`DURABLE-CLAIM-JSONB-DOUBLE-ENCODE`)
Dispatch: `docs/dispatch/AGENT-DISPATCH-SB01-LR-2C-FIX04-CLAUDE-2026-09-17.md`
Chain-failure record: `docs/relay/CHAIN-FAILURE-SB01-LR-2C-WEBHOOK-JSONB-2026-09-17.md`

## 1. Revisions

- Base revision (started from, per dispatch): `ac0290ae08068be04b786db7c42b1f65e08428d9`
- Finished on: working tree at the same HEAD (`ac0290ae08068be04b786db7c42b1f65e08428d9`), **uncommitted**.
  Per §9 of the dispatch, this agent does not commit or push; Hermes stages and commits the
  exact verified revision after the deterministic gate.

## 2. Per-call-site change

All five sites in `platform/runtime/src/db.ts` used `tx.unsafe(query, [...params])` with a
manual `$n::jsonb` cast in the SQL text, and passed `JSON.stringify(x)` as the bound parameter.
On this driver (`postgres@3.4.5`, `prepare: false`), that stores the JSON **text** as a jsonb
*string* scalar, not an object/array — tripping the live `jsonb_typeof(...) = 'object'` /
`'array'` catalog constraints. The fix replaces each `JSON.stringify(x)` with `tx.json(x)` (the
transaction-scoped equivalent of the `this.sql.json(...)` helper already used correctly
elsewhere in this file at lines 128, 186, 313, 458). `tx.json()` returns a `Parameter` tagged
with the jsonb OID (3802); this tag is honored identically whether the parameter appears in a
tagged-template interpolation or in a `.unsafe(query, args)` array, because both paths build the
same underlying `Query` and go through the same parameter serializer — confirmed by reading
`node_modules/postgres/src/index.js` (`function json(x) { return new Parameter(x, 3802) }`,
`function unsafe(...)` builds a `Query` from the same `args`).

| Line(s) (pre-fix) | Statement | Payload | Before | After |
|---|---|---|---|---|
| 342–343 | `claimWebhookEvent` provider-event INSERT | `hint_envelope`, `normalized_envelope` | `JSON.stringify(input.hints)`, `JSON.stringify(input.normalizedEnvelope)` | `tx.json(input.hints as unknown as JsonRecord)`, `tx.json(input.normalizedEnvelope as unknown as JsonRecord)` |
| 361 | `claimWebhookEvent` outbox INSERT | `payload` | `JSON.stringify({ providerEventId, providerObjectId, providerCustomerId })` | `tx.json({ providerEventId, providerObjectId, providerCustomerId })` |
| 565, 567 | entitlement transition INSERT | `entitlement_keys` (array), `signed_envelope` (object) | `JSON.stringify(envelope.entitlement_keys)`, `JSON.stringify(envelope)` | `tx.json(envelope.entitlement_keys)`, `tx.json(envelope as unknown as JsonRecord)` |
| 581 | entitlement outbox INSERT | `payload` | `JSON.stringify({ transitionId, signed: input.signed })` | `tx.json({ transitionId, signed: input.signed } as unknown as JsonRecord)` |
| 620–621 | entitlement conflict-update path (`deliverEntitlementToTestSink`) | `entitlement_keys` (array), `signed_envelope` (object) | `JSON.stringify(envelope.entitlement_keys)`, `JSON.stringify(envelope)` | `tx.json(envelope.entitlement_keys)`, `tx.json(envelope as unknown as JsonRecord)` |

The `as unknown as JsonRecord` casts are type-only (`JsonRecord = Record<string,
postgres.JSONValue>`, already declared at the top of `db.ts`). They were required because
`sql.json(value: JSONValue)` needs an index signature and the domain types
(`EntitlementTransitionEnvelope`, `SignedEntitlementTransition`, and the `Record<string,
unknown>` webhook envelope params) don't structurally satisfy `JSONValue` without one. No
runtime behavior changes from the cast — these are, and remain, plain JSON-serializable data
objects; only the compile-time type check is satisfied. `entitlement_keys` needed no cast
because it is already typed compatibly.

No new JSON helper was invented and the DB driver (`postgres@3.4.5`) was not changed, per the
dispatch's constraint — the fix reuses the pre-existing `sql.json()` pattern via its
transaction-scoped `tx.json()` form.

## 3. Changed-file list / intended-diff statement

```
 platform/runtime/src/db.ts                                        | 16 ++++++++--------
 1 file changed, 8 insertions(+), 8 deletions(-)
```

Plus one new file (untracked, not a modification):
`platform/runtime/tests/webhook-durable-claim-jsonb-real-db.test.mjs`

No other tracked file was modified by this repair. `runtime.ts`, `package.json`, and
`platform/profile-registry/**` are untouched (verified with `git diff --stat`, empty output).
No prohibited path (`.env`, credential file, migration/schema SQL) was touched. An unrelated
pre-existing untracked directory, `platform/runtime/scripts/` (timestamped 2026-09-12, before
this dispatch), was left alone and not written to.

## 4. Verification commands, output, and exit codes

### 4.1 `cd platform/runtime && npm run build`

```
npm notice run @wstera/central-billing-runtime@0.1.0 build
npm notice run npm run build:registry && tsc -p tsconfig.json
npm notice run @wstera/central-billing-runtime@0.1.0 build:registry
npm notice run tsc -p ../profile-registry/tsconfig.json
```
Exit code: `0`

(First attempt without the `as unknown as JsonRecord` casts failed with TS2345 at the five call
sites — expected, since `sql.json()` requires an index-signature-compatible type. Casts were
added and the build above is the post-fix, passing result.)

### 4.2 `cd platform/runtime && npm run typecheck`

```
npm notice run @wstera/central-billing-runtime@0.1.0 typecheck
npm notice run tsc --noEmit -p tsconfig.json
```
Exit code: `0`

### 4.3 `cd platform/runtime && npm test`

```
# tests 43
# suites 0
# pass 43
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 983.4311
```
Exit code: `0`. 43/43 pass, 0 fail.

New test: `claimWebhookEvent durably persists hint_envelope, normalized_envelope, and outbox
payload as real jsonb objects on live Postgres` (test #43, file
`tests/webhook-durable-claim-jsonb-real-db.test.mjs`). It executes real SQL — no db mock:

- Opens a real `BillingDb` against `process.env.BILLING_DATABASE_URL` (WSTERA LAB,
  `billing_core_staging`), and a second bare `postgres(...)` connection for independent
  read/cleanup.
- Calls `db.claimWebhookEvent(...)` for real with a synthetic `providerEventId`, a non-null
  mapping (so both the provider-event INSERT and the outbox INSERT execute), and hint/normalized
  envelopes containing a nested object and an array.
- Reads the row back with `select jsonb_typeof(hint_envelope), jsonb_typeof(normalized_envelope)
  ... from billing_core_staging.runtime_provider_events` and `jsonb_typeof(payload) ... from
  billing_core_staging.runtime_outbox_jobs`, asserting `'object'` (not `'string'`) and asserting
  the round-tripped values `deepEqual` what was sent.
- Deletes the two rows it created in a `finally` block (no residual test data left in WSTERA LAB).
- Duration was ~860–960ms per run — consistent with a real network round trip to Postgres, not
  an in-memory mock.

**Pre-repair falsification (executed, not asserted):** to satisfy "must fail against the
pre-repair encoding," the pre-fix `db.ts` was restored from `git show HEAD:platform/runtime/src/db.ts`
(HEAD was still the unmodified base revision — no commit had been made), rebuilt, and the new
test run in isolation:

```
not ok 1 - claimWebhookEvent durably persists hint_envelope, normalized_envelope, and outbox payload as real jsonb objects on live Postgres
  error: 'new row for relation "runtime_provider_events" violates check constraint "runtime_provider_events_hint_envelope_check"'
  code: '23514'
  name: 'PostgresError'
# pass 0
# fail 1
```

This is the exact `PostgresError 23514` / constraint name from the chain-failure record,
reproduced by the new test with zero manual repro script — confirming the test is a genuine
regression guard, not a tautology. The repaired `db.ts` was then restored (copy of the working
tree taken before the temporary revert) and `npm run build` / `npm run typecheck` / `npm test`
were re-run to the green results in this section, confirming the restore was exact and the
fix is what makes the suite pass.

### 4.4 `cd platform/profile-registry && npm test`

```
# tests 16
# suites 0
# pass 16
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 85.6151
```
Exit code: `0`. 16/16 pass, matching the required count.

### 4.5 `git diff --check`

Exit code: `0`. No whitespace errors. (One Windows CRLF-normalization *warning* was printed by
git for an unrelated already-modified file, `docs/tasks/TASK-SB01-LONG-RUN-2C-2F-001.md`; this
is not a `diff --check` error and predates this repair.)

### 4.6 `git diff --stat` / intended-diff review

```
 platform/runtime/src/db.ts | 16 ++++++++--------
 1 file changed, 8 insertions(+), 8 deletions(-)
```
Plus the new untracked test file listed in §3. No other file changed. No prohibited path touched.

## 5. Invariant confirmation (dispatch §4)

- **Authority model untouched** — `runtime.ts` has zero diff (`git diff --stat -- platform/runtime/src/runtime.ts` is empty); all server-derived-authority logic lives there, untouched.
- **Fail-closed webhook error codes unchanged** (`LIVE_WEBHOOK_DENIED`, `WEBHOOK_TIMESTAMP_INVALID`, `WEBHOOK_SIGNATURE_INVALID`, `WEBHOOK_IDENTITY_MISSING`, `WEBHOOK_BODY_TOO_LARGE`) — none of these are defined or checked in `db.ts`; this repair touched only JSON parameter encoding inside `db.ts`, not `runtime.ts` webhook validation.
- **Unmapped webhook still durably claims `status='skipped'` with no reconcile outbox job** — the branch logic `input.mapping ? 'pending' : 'skipped'` and the `if (!skipped) { ...outbox insert... }` guard in `claimWebhookEvent` are unchanged; only the jsonb parameter construction inside the already-existing branches changed. Full test suite (43/43, including pre-existing webhook/outbox tests) still passes.
- **FIX-02 return_ref allowlist ordering (`runtime.ts:366-368`) intact** — `runtime.ts` untouched (see above).
- **Idempotency/dedupe semantics unchanged** — `on conflict (provider, provider_event_id) do nothing`, `dedupe_key`, and `OUTBOX_LEASE_PRESERVING_CONFLICT_SET` are byte-identical in the diff (only the JSON-parameter lines changed); `tests/outbox-conflict-sql-qualification.test.mjs` and `tests/outbox-lease-conflict.test.mjs` (source/behavior proofs for this exact logic) still pass unchanged.
- **No schema/migration change** — no file under `docs/platform/billing-core/migrations/**` was touched.
- **No new dependency** — `platform/runtime/package.json` has zero diff.
- **`PS01.test.ts` / `LK01.test.ts` pins unchanged** — not touched; `profile-registry` suite is 16/16 green (unchanged count from prior runs).

## 6. Residual gap

None identified for the required scope. The new real-DB test covers the `claimWebhookEvent`
call sites (lines 342–343, 361 pre-fix) directly, which is the actively-failing path named in
the chain-failure record. The three entitlement-path call sites (565–567, 581, 620–621) received
the identical class of fix (`JSON.stringify` → `tx.json`, same defect, same driver, same
`prepare: false` connection) but are exercised only by the existing unit/source-level tests
(`http-checkout-slice.test.mjs`'s in-memory `InMemoryBillingDb` does not hit real SQL for these
paths, and no dispatch-authorized test targets `createEntitlementTransition` /
`deliverEntitlementToTestSink` against a live database this round). Stated plainly: entitlement
JSONB persistence is repaired by inspection and by parity with the now-proven `claimWebhookEvent`
fix, but does not have its own executed real-Postgres regression test in this round. Recommend a
follow-up test if/when entitlement transitions are brought into a real-slice stage.

## 7. Safety confirmation

- No secret value was printed, echoed, logged, or committed. `BILLING_DATABASE_URL` and Stripe
  TEST credentials were referenced only by presence (`process.env.BILLING_DATABASE_URL` used
  directly by the Postgres client; never logged) throughout this repair and its verification.
- No live/production mutation: all verification ran against Stripe TEST-mode semantics untouched
  by this diff, and the real-DB test wrote/read/deleted only synthetic rows in WSTERA LAB's
  `billing_core_staging` schema (test schema, not `billing_core`).
- No schema/migration/DDL change was made.
- No commit or push was performed by this agent, per dispatch §9.

## 8. Stop condition

`READY FOR CODEX LR-2C FIX-04 INDEPENDENT VERIFY`
