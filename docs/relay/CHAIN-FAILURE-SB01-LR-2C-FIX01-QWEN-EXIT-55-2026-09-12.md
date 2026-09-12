# CHAIN FAILURE — SB01 LR-2C FIX-01 — Qwen real-slice failed twice (exit 55) — 2026-09-12

Task ID: `SB01-LONG-RUN-2C-2F-001`
Program: `SB01 — WSTERA Central Billing Core`
Workflow / Runtime: `WF-RELAY-01 v1.2.0` / `kanban-external-agent-dispatch v2.3.8`
Work Type: `DIRECT-APPROVED` | Release Policy: `RELAY_STANDARD`

```text
Stage: LR-2C FIX-01 — Qwen REAL (TEST-only) vertical slice
Selected agent: agent-qwen
Invocation contract 1 (canonical): run_qwen_lr2c_fix01.py -> direct_external_executors.execute(...)
  -> invoke-qwen-worker.ps1 -Mode trusted-repo -> qwen CLI (glm-5.3-flash:cloud)
Exit code 1: DIRECT_EXECUTOR_EXIT:agent-qwen:55  (qwen worker process exited 55 before doing work)
Timeout state: not timed-out (worker exited)
Expected artifact: Qwen FIX-01 evidence + exact returned SHA + provenance
Observed artifact: none; output removed by driver fail-closed; no commit; HEAD unchanged a4f02e0

Invocation contract 2 (diagnostic, wrapper-direct): diag_qwen_fix01.py -> invoke-qwen-worker.ps1 -Mode trusted-repo
  (run WITHOUT the relay driver to capture qwen stderr/root-cause)
Exit code: wrapper observed qwen worker also failed; qwen-fix01.probe.out.txt = 0 bytes (worker ended incomplete)
Observed: Qwen worker confirmed creds present (sk_test_ len107, whsec_0c len70, pooler host aws-1-ap-southeast-1),
  surveyed runtime source, began real-slice work, then ended without writing full output or committing.
  Temp QWEN_HOME removed by wrapper after exit. No FIX-01 evidence commit; HEAD unchanged a4f02e0.

Root cause of exit 55: undetermined. Both runs fail on the qwen worker process itself (not DB/Stripe/cred,
  not a secret-scan; R2 confirmed credentials present). R2 observed the worker partially run real-slice then
  ended without a completed artifact. No silent retry attempted beyond the bounded diagnostic.
```

## Current state (verified from disk/git)

- HEAD: `a4f02e0` (dispatch commit); branch `work/sb01-central-billing-pc-20260911`, parity 0/0 vs origin work.
- No FIX-01 evidence/commit produced by either Qwen run.
- `platform/runtime/scripts/run-sb01-lr2c-real-slice.mjs` exists but is UNTRACKED (the real-Test runner Qwen
  wrote; contains a known `/v1/v1/events` double-prefix bug Qwen identified but did not finish fixing/committing).
- `docs/platform/billing-core/DIAGNOSTIC-SB01-LR-2C-DB-CONNECTION-CLAUDE-2026-09-12.md` untracked (Claude
  credential diagnostic; separately surfaced a DB password conflict that Hermes later re-verified as CONNECT_OK
  against the current vault).
- Credentials ready + verified (Hermes): BILLING_DATABASE_URL connect PASS; sk_test_ present; whsec_ present;
  stripe listener PID 16168 alive forwarding to http://127.0.0.1:8787/webhooks/stripe.
- A real Stripe TEST + WSTERA LAB billing_core_staging mutation may have been partially started by Qwen run 2
  before the worker ended. Left unresolved; Hermes did NOT execute additional provider/LAB mutations after the
  failure (fail-closed).

## Recovery decision required (Owner / Sol)

Options (do NOT pick for Owner):
- **A**: Dispatch a fresh Qwen FIX-01 run through the canonical driver, having Qwen (a) reuse/inspect the
  existing untracked `run-sb01-lr2c-real-slice.mjs`, fix its `/v1/v1/events` double-prefix bug, (b) run the real
  slice, (c) commit evidence. Before that, optionally inspect/clean any partially-created Stripe Test / LAB rows
  from run 2 if Owner authorizes a cleanup pass.
- **B**: First diagnose the qwen exit-55 root cause (bounded: run a trivial qwen trusted-repo invocation and
  capture stderr) before any real-slice retry or cleanup.
- **C**: Treat repeated worker exit-55 as SOL_OWNER_DECISION_REQUIRED and stop FIX-01 pending deeper executor
  investigation.

Hermes does not silently retry a material stage failure.
