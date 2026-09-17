# CHAIN FAILURE — SB01 LR-2C — Webhook durable claim fails on real WSTERA LAB — 2026-09-17

Task: `SB01-LONG-RUN-2C-2F-001`
Stage: `LR-2C` (real Stripe TEST + WSTERA LAB vertical slice)
Runtime: `kanban-external-agent-dispatch v2.5.1`
Reporter: Hermes (deterministic gate / orchestrator — diagnosis only, no source repair)
Issue Fingerprint: `DURABLE-CLAIM-JSONB-DOUBLE-ENCODE | runtime_provider_events.hint_envelope | webhook durable claim | PostgresError 23514 jsonb_typeof=string`

## 1. Symptom

On the real TEST slice (`docs/relay/LR2C-REALSLICE-RUN-2026-09-17.log`):

```
[PASS] stripe trigger fixtures generated real Test events :: triggered=2
{"level":"error","event":"billing.request.failed","path":"/webhooks/stripe","code":"INTERNAL_ERROR","status":500}
[FAIL] real Stripe Test webhook events delivered via stripe listen → Core HTTP intake :: events=0 types=
# HARNESS_EXIT=1
```

27 PASS / 1 FAIL. The listener log proves the events really were delivered:

```
2026-09-17 18:58:15   --> checkout.session.completed [evt_1UGdxGHB4GRCffd97lY0cldN]
2026-09-17 18:58:15  <--  [500] POST http://127.0.0.1:8787/webhooks/stripe
2026-09-17 18:58:18   --> checkout.session.completed [evt_1UGdxKHB4GRCffd9NfIdsOmj]
2026-09-17 18:58:19  <--  [500] POST http://127.0.0.1:8787/webhooks/stripe
```

So: real Stripe TEST event → real `stripe listen` forward → real HMAC-signed POST → **HTTP 500** → 0 durable provider-event rows.

Exact failed operation: `POST /webhooks/stripe` → `CentralBillingRuntime.handleWebhook` → `BillingDb.claimWebhookEvent` → INSERT into `billing_core_staging.runtime_provider_events`.

Exit/timeout: harness exit 1 (not a timeout). Revision: `ac0290ae08068be04b786db7c42b1f65e08428d9`.

## 2. Root cause (proven, not inferred)

`PostgresError` `code=23514`:
`new row for relation "runtime_provider_events" violates check constraint "runtime_provider_events_hint_envelope_check"`

Applied constraint (read from the live catalog, not from migration source):
`CHECK ((jsonb_typeof(hint_envelope) = 'object'::text))`

Mechanism — double JSON encoding on a `prepare: false` connection (confirmed experimentally against the live DB):

| Variant | Expression | `jsonb_typeof` result |
|---|---|---|
| A | `sql.unsafe("select $1::jsonb", [JSON.stringify({})])` | **string** ← current code path |
| B | `sql.unsafe("select $1::jsonb", ['{}'])` | **string** |
| C | `sql.unsafe("select $1", [JSON.stringify({})])` | **string** |
| D | `` sql`select ${sql.json({})}` `` | **object** ← correct |
| E | `sql.unsafe("select $1::jsonb", [{a:1}])` | **object** |

`postgres@3.4.5` with `prepare: false` serialises JS values itself; passing an already-`JSON.stringify`-ed JS string into a `$n::jsonb` cast therefore stores the JSON **text** as a jsonb string scalar (`"{}"`), never as a jsonb object. The DB contract correctly rejects it. This is a data-integrity guard working as designed — the caller is wrong, not the constraint.

Reproduced three independent ways (`repro_webhook.mjs`, all with code 23514):
1. real Stripe TEST event (`evt_…`) via `runtime.handleWebhook` directly;
2. minimal synthetic unmapped `checkout.session.completed`;
3. `runtime.db.claimWebhookEvent` called directly with a clean envelope (isolates SQL, rules out signature/JSON parsing).

HTTP layer confirmed: `[C:http-boundary] status= 500 body= {"error":"INTERNAL_ERROR","message":"Unexpected billing runtime error"}`.
The 500 is the catch-all non-`BillingRuntimeError` branch at `platform/runtime/src/runtime.ts:175` — `claimWebhookEvent` wraps its work in `sql.begin()` with no error translation, so a `PostgresError` escapes as `INTERNAL_ERROR`.

## 3. Defect class (all affected call sites — same fingerprint, one repair)

`platform/runtime/src/db.ts` — `JSON.stringify(...)` passed into a `$n::jsonb` cast or `sql.unsafe` in a `prepare:false` context:

| Line | Statement | Column / payload | Constraint at risk |
|---|---|---|---|
| 342–343 | `claimWebhookEvent` INSERT | `hint_envelope`, `normalized_envelope` | `_hint_envelope_check`, `_normalized_envelope_check` → **active failure** |
| 361 | `claimWebhookEvent` outbox INSERT | `payload` | `runtime_outbox_jobs.payload` object check |
| 565–567 | entitlement transition INSERT | `entitlement_keys`, envelope | `jsonb_typeof = 'array'` / `'object'` |
| 581 | entitlement outbox INSERT | `payload` | object check |
| 620–621 | entitlement conflict-update path | envelope | as above |

Correct pattern already present in the same file (so this is a regression in style, not a new decision): `db.ts:128`, `:186`, `:313`, `:458` use `${this.sql.json(...)}`.

Why the deterministic suite did not catch it: `npm test` is 42/42 green, but `tests/outbox-conflict-sql-qualification.test.mjs` states explicitly *"No PostgreSQL statement is executed here (none is authorized this round); this is source/string-level proof only."* The suite has no real-PostgreSQL execution of `claimWebhookEvent`. Green unit tests without runtime/DB evidence are explicitly insufficient under the house brief.

## 4. Impact on LR-2C

- LR-2C cannot close: the required `Stripe TEST → webhook → signature validation → durable provider-event persistence → idempotent processing` leg fails at durable persistence.
- Any webhook (mapped or unmapped) would 500 and return to Stripe for retry → durable claim is impossible → LR-2D (replay/duplicate/out-of-order/lease) cannot be built on top.
- Severity: High (blocks the critical path, not merely cosmetic). No live/production exposure: TEST mode only, live boot guard untouched.

## 5. Repair cycle accounting

- Issue Fingerprint: `DURABLE-CLAIM-JSONB-DOUBLE-ENCODE`
- Initial failure = **diagnosis only, not a repair attempt** (Relay failure protocol v2.5.1).
- Ordinary repairs used so far: **0 / 2**.
- No blind retry was performed, and no executor was re-dispatched against the same failing state.

### Routing decision (explicit, no silent substitution)

The responsible builder of `db.ts` (AGY) is not admissible for this defect under current governance: Relay v2.5.1 restricts ordinary `agent-agy` stages to `role=UI-UX-SPECIALIST`, which excludes backend/DB/data-contract changes; this defect is exactly that class. Qwen is healthy (`EXECUTOR_READY = PASS`) but is the test/evidence worker for this stage and has no proven real-PostgreSQL repair evidence.

Selected: `agent-claude` as `CORE-BUILDER` for **one bounded ordinary repair** (`docs/dispatch/AGENT-DISPATCH-SB01-LR-2C-FIX04-CLAUDE-2026-09-17.md`), because it is the only currently healthy named executor whose role can own this change class. Recorded here so the replacement routing is explicit and auditable; nothing was relabelled or hidden. Independent verification remains mandatory and is assigned to `agent-codex` at the exact post-repair SHA.

## 6. Evidence paths

- Run log: `docs/relay/LR2C-REALSLICE-RUN-2026-09-17.log` (harness sha256 `bb97624c3a8e5d4db3a6026b69d7a3b82ebacdb1bad0b7b4f8b377913cc0096a`)
- Listener log: `%LOCALAPPDATA%\Temp\sb01-relay-probe\stripe-listen.log` (PID 16572; secret value not recorded)
- Repro: `%LOCALAPPDATA%\Temp\sb01-relay-probe\repro_webhook.mjs`
- JSONB semantics probe: `%LOCALAPPDATA%\Temp\sb01-relay-probe\jsonb_probe.mjs`
- Applied-constraint catalog read: `%LOCALAPPDATA%\Temp\sb01-relay-probe\dbconstraint.mjs`
- Reconcile checkpoint: `docs/relay/PHASE-R-RECONCILE-SB01-2026-09-17.md`

No secret values were printed, logged, or committed at any point. No source, schema, migration, or credential was mutated during diagnosis.

## 7. Environment / provenance

| Item | Value |
|---|---|
| Worktree | `D:\AI-Workspace\runtime\worktrees\sb01-central-billing-20260909` |
| Branch | `work/sb01-central-billing-pc-20260911` |
| HEAD at failure | `ac0290ae08068be04b786db7c42b1f65e08428d9` |
| DB | WSTERA LAB (`billing_core_staging`, PostgreSQL 17.6) via session pooler |
| Provider | Stripe TEST (`acct_1U2L8zHB4GRCffd9`, `livemode=false`) |
| Live/production mutation | NONE |

## 8. Stop condition

`TECHNICAL_REMEDIATION_REQUIRED` → one bounded ordinary repair → deterministic gate re-run → fresh `agent-codex` exact-SHA verification. No LR-2D release before LR-2C PASS. No Owner round-trip required: this is an ordinary technical defect inside the locked brief, not an authority/scope/contract change.
