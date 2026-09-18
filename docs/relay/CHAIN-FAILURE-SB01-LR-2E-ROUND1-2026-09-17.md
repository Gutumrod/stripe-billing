# CHAIN FAILURE — SB01 LR-2E round 1 (agent-claude) — 2026-09-17

Task: `SB01-LONG-RUN-2C-2F-001`  |  Stage: `LR-2E`  |  Agent: `agent-claude` (`CORE-BUILDER`, `BUILD`)
Stage base: `da44ad1699a7b4a3391018841fb0cc67a1bbb082`  |  HEAD at dispatch: `2d7077133c20ad4fb47d80eb342e54aff3f00349`
Repair-cycle position: **initial failure = diagnosis, not a repair attempt.** Round-1 repair (#1 of max 2) follows.

## 1. Executor provenance (PASS — the executor itself worked)

```
exit_code            = 0
executor_identity    = agent-claude
execution_backend    = direct_external_process
transport_model      = none
version              = 2.1.269 (Claude Code)
prompt_sha256        = sha256:689ad395c217a5d098370479ee7b74a5381a977033593f452eac40bf984dcf81
stdout_sha256        = sha256:77459552350d8b1752950390262e5953db9d693000408448238771d265dfb52e
elapsed              = 763.3 s
```

Runner log: `D:\AI-Workspace\runtime\sb01-lr2e-run\lr2e-dispatch-run.log`
Output dir (OUTSIDE the repo worktree): `D:\AI-Workspace\runtime\sb01-lr2e-run\out\`

## 2. Issue Fingerprint A — `EXECUTOR-CLAUDE-OUTPUT-INCOMPLETE`

**Symptom.** Exit 0, but the returned stdout is a *status narrative*, not the stage deliverable. The
agent delegated the actual build to its **own background subagent**, and the CLI killed that child at
its print-mode ceiling:

```
stderr: Background tasks still running after 600s; terminating.
        Set CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 to wait indefinitely.
```

**Failing gate.** Dispatch §4 deliverables — 2 of 4 absent at return:

| Deliverable | State at return |
|---|---|
| §4.1a `tests/sb01-lr2e-isolation-real-db.test.mjs` | present (7 tests) |
| §4.1b append-only LR-2E cases in `outbox-lease-reconcile-crash-window-real-db.test.mjs` | **ABSENT** — only the import block + `before`/`after` scaffolding landed (41 added lines, **0** `test(` blocks) |
| §4.1c `tests/helpers/lr2e-multiproduct-fixtures.mjs` | present |
| §4.2 `scripts/run-sb01-lr2e-isolation-slice.mjs` | **ABSENT** |
| §4.3 evidence file | present but self-declared `STATUS: IN PROGRESS`; §3/§5/§6/§7 `_(pending)_` |
| §4.4 `docs/relay/LR2E-ISOLATION-SLICE-RUN-2026-09-17.log` | **ABSENT** |

**Root cause class.** Executor-invocation behaviour (self-delegation to a background child against a
600 s print ceiling), not a repository or product defect. Distinct from `EXECUTOR-CLAUDE-SESSION-LIMIT`
and `EXECUTOR-CLAUDE-TIMEOUT`. Fingerprint history preserved separately.

## 3. Issue Fingerprint B — `LR2E-HARNESS-SCOPE-DEFECT` (builder's own tests fail)

Gate: `node --test tests/sb01-lr2e-isolation-real-db.test.mjs` on real `billing_core_staging`
(PostgreSQL). **Result 3/7 pass, 4/7 fail, exit 1.** All four are defects in the new **test harness**,
not in `src/`:

| # | Test | Failure | Defect |
|---|---|---|---|
| 1 | reconciliation_state / dedupe_key isolation | `23503` `runtime_reconciliation_customer_fk` — `(test, lr2e-isolation-ps01, …, cus_lr2e_ps01_recon)` absent from `runtime_provider_customers` | fixture calls `upsertReconciliation` without first establishing the provider-customer mapping that the FK requires |
| 2 | entitlement transitions / sink jsonb | `23503` `runtime_entitlement_transitions_reconciliation_fk` | fixture inserts a transition keyed by `provider_subscription_id` with **no** matching `runtime_reconciliation_state` row |
| 3 | sink idempotency / stale-version rejection | `23503` same FK, `sub_lr2e_stale` | same as #2 |
| 4 | credential bindings + real GET routes | `ERR_ASSERTION: '99000' !== 99000` (also `19900`) | route serializes `amount_minor` as a **string** (bigint); the test asserts a JS number |

These are real FK/serialization behaviours of the schema and routes — the tests, not the product, are
wrong. No `src/` change is justified by any of them, and none may be "fixed" by weakening the assertion.

## 4. Issue Fingerprint C — `LR2E-AGGREGATE-OUTBOX-CROSSFILE-LEASE-RACE`

Gate: full `npm test` (`node --test tests/*.test.mjs`) → `# tests 65 / # pass 60 / # fail 5 / exit 1`.
The 5th failure is an **LR-2D** test:

```
✖ LR-2D outbox: failJob sets failed with exponential backoff, then dead_letter at max_attempts
  AssertionError: attempt 7: job must not be leasable before its backoff delay elapses
  + job accountId: 'lr2eiso_routes_…_acc', jobType: 'entitlement_test_sink'
```

`outbox-lease-reconcile-crash-window-real-db.test.mjs` **alone: 15/15 PASS, exit 0.** Its un-scoped
`leaseNextJob` drained an outbox job that the **new LR-2E isolation file** created via the real HTTP
routes (`lr2eiso_routes_*`), because `node --test` runs multiple test *files* concurrently against one
shared FIFO queue.

**Conclusion.** The new LR-2E test file introduces leasable outbox jobs into the shared queue. The
existing protection (documented in the crash-window file: every lease-draining test lives in that one
file) was not extended to the new file. Harness defect, introduced this round. It must not be resolved
by making `leaseNextJob` account-scoped — that would change the product.

## 5. Credential-hygiene incident (orchestrator-side, contained, no secret exposed)

While validating the Stripe TEST listener, the orchestrator launched `stripe listen --api-key <value>`,
which placed a **TEST-mode** secret key on a process command line; a subsequent full-command-line
process dump rendered it into the orchestrator transcript.

- Key type: `sk_test_` (TEST mode only). No live key, no charge, no production mutation.
- Containment: listener killed and relaunched using `STRIPE_API_KEY` **from the environment only**.
  Verified: `Get-CimInstance Win32_Process` for the live listener (`pid 7376`) now matches
  `clean` — the command line carries no key material.
- Leak scan across the worktree + run dir (256 files, `node_modules`/`.git` excluded, value compared
  by exact string): **`LEAKED_KEY_FOUND_IN: NONE`** — nothing was persisted to disk.
- Residual: the transcript copy only. Recorded as a residual gap; key rotation is an Owner action and
  is **not** performed here (no scope widening).

## 6. What the orchestrator did NOT do

No source repair by Hermes. No commit. No push. No `git clean`/reset. No `.env` edit. No schema or
migration change. No LR-2F work. Protected Skill `kanban-external-agent-dispatch` unmodified
(`SKILL.md` sha256 `308d22de…c00db`, `direct_external_executors.py` sha256
`dbbd20a1ac5f9f930338ff87571683be9f264082b096b547b16bdb6f54a63417`).

## 7. Route

All three fingerprints are bounded technical defects inside the locked LR-2E scope, with no
architecture/security/product-contract change and no scope widening. Per the Relay failure protocol
this is **ordinary repair #1 (of max 2)** and returns to the responsible Builder, `agent-claude`.

---

## 8. REPAIR ROUND 1 RESULT (appended 2026-09-18 00:36 Asia/Bangkok) — PARTIAL

Executor provenance: `exit_code=0`, `executor_identity=agent-claude`,
`execution_backend=direct_external_process`, `transport_model=none`, `2.1.269 (Claude Code)`,
`prompt_sha256=sha256:88ad8896243bec9aac014bcae6325158017ecc6abe4dc66c4b90c57c864a70b7`,
`stdout_sha256=sha256:c3f151e55deaa0abe74f283646564410cf0fbafe7be339020e459bd3007938b1`,
`elapsed=1729.4 s`. Runner log: `D:\AI-Workspace\runtime\sb01-lr2e-run\lr2e-repair1-run.log`.

Returned stdout: *"Standing by for the full-suite run (`bsntf1owg`) to complete before proceeding
with the LR-2E slice harness script, run log, and evidence file."* — i.e. the agent delegated the
long-running full-suite gate to a background shell and then ended its turn. Same fingerprint class as
§2 (`EXECUTOR-CLAUDE-OUTPUT-INCOMPLETE`).

### Fingerprints CLOSED by repair 1 (re-verified by Hermes, real commands)

| Gate | Before | After repair 1 |
|---|---|---|
| `node --test tests/sb01-lr2e-isolation-real-db.test.mjs` | 3/7 pass, exit 1 | **7/7 pass, exit 0** |
| `npm test` (aggregate) | 60/65, exit 1 | **67/67 pass, exit 0** |
| crash-window file alone | 15/15 | 17/17 (2 new LR-2E tests) |

- **Fingerprint B — CLOSED.** All four failures fixed in the harness: provider-customer mapping is now
  established via `ensureCustomerMapping` before `upsertReconciliation`; a real
  `runtime_reconciliation_state` row (`ensureReconciliationRow`) is created before each entitlement
  transition; and the route's real string serialization of `amount_minor` is asserted with the
  cross-product isolation assertion preserved.
- **Fingerprint C — CLOSED.** The aggregate regression is gone (67/67). The isolation file no longer
  leaves a leasable outbox job for the crash-window file to drain.
- **New coverage landed** (`outbox-lease-reconcile-crash-window-real-db.test.mjs`, 2 tests):
  per-product grant→revoke through the real leased queue, and cross-product
  `ENTITLEMENT_JOB_SCOPE_MISMATCH` fail-closed on a real leased job.

### Fingerprint A — STILL OPEN

Dispatch §4.2, §4.3 and §4.4 remain undelivered:

- `platform/runtime/scripts/run-sb01-lr2e-isolation-slice.mjs` — **absent**
- `docs/relay/LR2E-ISOLATION-SLICE-RUN-2026-09-17.log` — **absent**
- `docs/platform/billing-core/EVIDENCE-SB01-LR-2E-CLAUDE-2026-09-17.md` — still
  `STATUS: IN PROGRESS`, sections 3/5/6/7 still `_(pending)_`

### Route

Fingerprint B and C are closed; A (a self-delegation behavioural defect, not a technical one) is the
only remaining issue. Ordinary repair budget is now at 1 of 2. Hermes releases **ordinary repair #2**,
scoped strictly to the three undelivered artifacts, with an explicit prohibition on self-delegation
and a requirement to run the slice harness in the foreground with a bounded event/time budget.

Gate evidence: `D:\AI-Workspace\runtime\sb01-lr2e-run\gate-isolation-A2.log`,
`D:\AI-Workspace\runtime\sb01-lr2e-run\gate-npmtest-A2.log`.
