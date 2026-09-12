# CHAIN FAILURE — SB01 LR-2C — CODEX INDEPENDENT-QA — Secret-Detected Fail-Closed

Task ID: `SB01-LONG-RUN-2C-2F-001`
Date: 2026-09-12
Program: `SB01 — WSTERA Central Billing Core`
Workflow / Runtime: `WF-RELAY-01 v1.2.0` / `kanban-external-agent-dispatch v2.3.8`
Work Type: `DIRECT-APPROVED` | Release Policy: `RELAY_STANDARD`

```text
Stage: LR-2C CODEX INDEPENDENT-QA
Selected agent: agent-codex
Invocation contract: relay driver execute(identity='agent-codex', context_mode='INDEPENDENT-QA')
  -> invoke-codex-worker.ps1 -PromptFile <dispatch> -Workdir <sb01 worktree>
  -> codex exec --ephemeral --skip-git-repo-check --cd <workdir>
     --sandbox danger-full-access -o <output> - (secrets redacted)
Exit code: not persisted (driver fail-closed, provenance removed)
Timeout state: NOT timed-out (Codex completed; driver flagged wrapper log)
Expected artifact: CODE-2-QA-REPORT-SB01-LR-2C-2026-09-12.md + provenance
  (invocation.json, stdout/stderr sha256, wrapper-logs)
Observed artifact: CODE-2-QA-REPORT-SB01-LR-2C-2026-09-12.md existed (20619 bytes, verdict FIX_BY_QWEN)
  BUT provenance (agent-codex.invocation.json / stdout.txt / stderr.txt / wrapper-logs/) removed
  by driver finally-block after DIRECT_EXECUTOR_SECRET_DETECTED raise.
Allowed/prohibited-path impact: Codex wrote QA report + created untracked helper files in
  docs/platform/billing-core/ (allowed scope); wrapper-logs removed; no source/test mutation.
Reason for stop: agent-codex readiness/execute raised
  DIRECT_EXECUTOR_SECRET_DETECTED:wrapper_log:codex-worker-<stamp>.stderr.log
  (driver fail-closed; raw trigger value not exposed; logs destroyed by design).
Context contamination: N/A — INDEPENDENT-QA first pass ran independently; report persisted before
  flag; report itself states it read the task checkpoint (which contained Qwen PASS/gate PASS claims)
  as artifact verification, so it was not perfectly blind to those docs (Codex-recorded limitation).
Recovery decision required: Owner must choose the recovery policy before any retry / evidence reuse:
  (A) accept the surviving QA report as the checkpoint result and route its FIX_BY_QWEN; or
  (B) record recovery decision then re-run Codex INDEPENDENT-QA on the same revision to regenerate
      a report with full provenance; or
  (C) hard-stop: treat LR-2C Codex evidence as non-canonical until the secret-detect trigger source
      is investigated (investigation constrained by fail-closed rule).
```

## Factual Summary

- PRE-01 preflight PASS and both worker stages (AGY `f22b01a` resolved at `9001795`, Qwen `7a407cd`) completed; deterministic gate PASS at returned revision (build/typecheck 42 tests + registry 16 + diff-check clean).
- Codex INDEPENDENT-QA dispatch released against composite material revision `7a407cd` / branch HEAD `e102e3f`.
- Codex completed its work and wrote `docs/platform/billing-core/CODE-2-QA-REPORT-SB01-LR-2C-2026-09-12.md` (20619 B) with routing verdict **`FIX_BY_QWEN`**.
- During execute() cleanup the driver's `_assert_wrapper_logs_secret_free()` flagged
  `DIRECT_EXECUTOR_SECRET_DETECTED:wrapper_log:codex-worker-...stderr.log`; driver fail-closed and
  deleted all provenance artifacts. Only the QA report file survived.
- No source/test file was mutated by this driver failure. Branch parity was `0/0` before the run and
  remains at dispatch commit `2675dfe` (no post-dispatch worker commit occurred before this stop).

## The QA Report Content (surviving artifact)

The report independently verifies the exact material revision and returns a concrete
`FIX_BY_QWEN` verdict with four findings (2 High / 1 Medium / 1 Low):

1. **High — LR-2C lacks WSTERA LAB + real Stripe Test vertical-slice evidence.** Committed evidence is
   mock-only (zero live Stripe calls, InMemoryBillingDb, no `.env`, runtime env vars absent).
   Does not satisfy "Stripe Test vertical slice" + "persist/verify in WSTERA LAB".
2. **High — Denied portal return-ref creates durable operation/audit state.** `/v1/portal` validates the
   allowlisted return ref inside the try after `beginOperation`; a denied ref writes
   `failOperation` + audit rows → conflicts with "no durable billing side effect" for denied requests.
3. **Medium — Replayed operation authority not proven fail-closed.** Locked matrix lists
   "replayed/expired operation authority" as fail-closed; current tests positively accept exact
   idempotent replay and no nonce/assertion replay guard is persisted.
4. **Low — AGY evidence artifact has a trailing blank line at EOF** (`EVIDENCE-SB01-LR-2C-AGY...md:153`),
   failing `git show --check` on the material chain.

Report includes target-revision/ancestry checks, full build/typecheck/test results, a required
remediation acceptance set, and explicit requirement ambiguities (idempotent replay semantics,
denial-ledger semantics).

## Status / Blockers

- **Blocked:** LR-2C Codex independent-verification provenance is incomplete (driver fail-closed removed it).
- **Not advanced:** No FIX_BY_QWEN remediation dispatched, no silent retry, no stage advance. No commit/push
  of new worker work occurred after dispatch commit `2675dfe`.
- Hermes does not accept the surviving QA report as canonical release evidence without an explicit Owner recovery decision.

## Owner Decision Required

Owner must select a recovery policy (A / B / C above). Until then this stage is HOLD.
