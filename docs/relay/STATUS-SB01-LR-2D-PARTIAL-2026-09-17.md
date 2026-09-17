# STATUS — SB01 LR-2D — PARTIAL / NOT CLOSED — 2026-09-17

Task: `SB01-LONG-RUN-2C-2F-001`
Stage: `LR-2D` (webhook durability + reconciliation)
State: **PARTIAL — work landed and verified green, but the stage is NOT closed.**

This is an **orchestration status record**, not builder evidence. The Builder's own evidence
artifact was never written (see §3), so Hermes does not assert builder conclusions as proven
beyond what Hermes itself executed and observed.

## 1. Revisions (resolved by command)

```
git rev-parse f1324e0   -> stage base revision (branch tip at Claude dispatch)
```
Re-resolve at read time; persisted SHA evidence: `docs/relay/SHA-VERIFICATION-EVIDENCE-2026-09-17.md`.

## 2. What is verified green (executed by Hermes on the returned tree)

| Gate | Command | Result |
|---|---|---|
| Build | `npm run build` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0 |
| Runtime tests | `npm test` | **`# tests 58 / # pass 58 / # fail 0`** |
| Profile registry | `npm test` | `# tests 16 / # pass 16 / # fail 0` |

The runtime suite grew 43 → 58. The 15 new tests execute **real PostgreSQL** (`billing_core_staging`)
and cover, by their own reported names:

- outbox `enqueue → lease → complete` on real Postgres, lease stamped and cleared
- `failJob` exponential backoff → `dead_letter` at `max_attempts`
- duplicate webhook claim after a completed reconcile does **not** re-enqueue (idempotency)
- **two concurrent lease attempts — only one wins (real concurrency)**
- reconcile: matching provider snapshot grants + delivers v1 to the test sink
- reconcile: DB-supplied commercial state that disagrees with provider truth is **overwritten, never merged**
- reconcile provider-truth mismatch rejections: `amountMinor`, `priceId`, `currency`, `product`, metadata `account_id`
- unmapped provider snapshot rejected (`RECONCILE_ACCOUNT_MISMATCH`)
- same provider snapshot processed twice yields no second sink version (idempotency)
- crash-window: webhook claim durable before any processing — a fresh process recovers it
- crash-window: entitlement transition durable before sink delivery — recovers exactly once under forced re-delivery

Log: `D:\AI-Workspace\runtime\qa-temp\relay-evidence\sb01-lr2d\GATE-PARTIAL-npmtest.log`

## 3. Real source defect found and fixed by the Builder (LR-2D scope)

`platform/runtime/src/db.ts` — `OUTBOX_LEASE_PRESERVING_CONFLICT_SET` and its pure mirror
`resolveOutboxConflict`. A duplicate/stale event arriving after its outbox job had already
**completed** resurrected the job to `pending`. Two consequences, both real:

1. already-settled billing state would be re-processed; and
2. because a `completed` row carries a non-null `completed_at`, the row immediately violates
   `runtime_outbox_jobs_completion_check` (`status <> 'completed'` requires `completed_at IS NULL`)
   the next time a worker completes or fails it again.

Fix: treat `completed` like `dead_letter` in every branch (preserve status, `next_attempt_at`,
lease fields); `resolveOutboxConflict` mirror updated and the two affected tests updated to assert
the corrected decision table. This is a genuine defect the LR-2D requirement targets
(duplicate/replay safety), not a redesign.

## 4. Why the stage is NOT closed

Builder execution ended in `DIRECT_EXECUTOR_ERROR: DIRECT_EXECUTOR_TIMEOUT:claude.exe` (1500 s
budget) — a **new issue fingerprint** (`EXECUTOR-CLAUDE-TIMEOUT`), distinct from the Qwen
`EXIT55` fingerprint, so its ordinary-repair counter starts fresh (0/2). The timeout landed after
the source fix and tests were written but **before** the remaining deliverables:

| Missing deliverable | Required by |
|---|---|
| `platform/runtime/scripts/run-sb01-lr2d-reconcile-slice.mjs` (TEST-gated real Stripe slice) | dispatch §4.1 — the real signature-verified webhook + provider re-fetch chain |
| `docs/platform/billing-core/EVIDENCE-SB01-LR-2D-*.md` (builder evidence) | dispatch §4.3 |
| `docs/relay/LR2D-RECONCILE-SLICE-RUN-2026-09-17.log` (run log) | dispatch §4.4 |
| Independent Codex verification at the exact revision | brief §9 / closure contract |

Consequently LR-2D's real-Stripe-signed webhook + outbox-driven provider-truth reconciliation
chain has **not** yet been proven end-to-end through the live listener, and no independent
verification exists. **LR-2D must not be reported as PASS and LR-2E must not be released.**

## 5. Evidence paths

- Dispatch (Claude): `docs/dispatch/AGENT-DISPATCH-SB01-LR-2D-CLAUDE-2026-09-17.md`
- Route authorization: `docs/relay/ROUTE-SB01-LR-2D-EXECUTOR-CLASSIFY-CODEX-2026-09-17.md` (`SEND_TO_CLAUDE`)
- Qwen executor defect: `docs/relay/CHAIN-FAILURE-SB01-LR-2D-QWEN-EXIT55-2026-09-17.md`
- Orchestrator run log: `D:\AI-Workspace\runtime\qa-temp\relay-evidence\sb01-lr2d\exec-claude\.CLAUDE-LR2D-RUN.log`
- Gate log: `D:\AI-Workspace\runtime\qa-temp\relay-evidence\sb01-lr2d\GATE-PARTIAL-npmtest.log`
- Qwen diagnostic artifact (input only, never evidence):
  `D:\AI-Workspace\runtime\qa-temp\relay-evidence\sb01-lr2d\diagnostic\outbox-lease-reconcile-real-db.test.mjs`

No secret value was printed, logged, or persisted. No live Stripe call, no production DB mutation.

## 6. Next action

Resume LR-2D with the remaining deliverables only (harness + evidence + run log), on the exact
current revision, then independent Codex verification at that revision. The source fix and the
58-test real-PostgreSQL suite are already on disk and green — the resumed round must **not** redo
them, and must prove the real Stripe-signed webhook → durable claim → outbox → provider-truth
reconciliation chain through the live `stripe listen` forward.

## 7. Stop condition

`LR-2D INCOMPLETE — EVIDENCE INSUFFICIENT FOR PASS`. No LR-2E release. No Owner round-trip:
this is an ordinary technical/executor-budget defect inside the locked brief.
