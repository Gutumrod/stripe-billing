# ROOT-CAUSE — SB01 LR-2C — Codex INDEPENDENT-QA secret_detected — 2026-09-12

Task ID: `SB01-LONG-RUN-2C-2F-001`
Program: `SB01 — WSTERA Central Billing Core`
Workflow / Runtime: `WF-RELAY-01 v1.2.0` / `kanban-external-agent-dispatch v2.3.8`
Status: `ROOT CAUSE DETERMINED — RERUN WOULD HARD-STOP (see below)`

## What triggered the fail-closed

On 2026-09-12 the Codex `INDEPENDENT-QA` dispatch against material revision `7a407cd`
(AGY `f22b01a` + Qwen `negative-authority-matrix.test.mjs` + evidence) was executed through the
canonical driver `direct_external_executors.execute('agent-codex', ..., 'INDEPENDENT-QA')`.

During the run the driver's `_assert_wrapper_logs_secret_free()` scanned the Codex wrapper
`stderr.log` and raised
`DIRECT_EXECUTOR_SECRET_DETECTED:wrapper_log:codex-worker-<stamp>.stderr.log`,
fail-closing and deleting all provenance. The QA report had already been written.

## Root cause — reproduced deterministically

A bounded, non-substantive reproduction of the SAME revision + SAME wrapper + SAME driver produced
two full stderr captures (`codex-worker-20260912-150152-928.stderr.log`,
`codex-worker-20260912-150659-393.stderr.log`). Scanning them with the driver's exact secret regex
gives deterministic hits, entirely from **committed synthetic test-fixture constants** that Codex
echoes into stderr while reading the target source during QA:

- Pattern 0 (`(?i)\b(?:api[_-]?key|...|secret)\b\s*[:=]\s*['"]?[A-Za-z0-9_./+\-=]{12,}`):
  - `secret: TEST_ASSERTION_SECRET`
  - `secret: LK01_ASSERTION_SECRET`
  - `secret: 'entitlement-signing-secret-ps01'`
  - `const secret = input.secret ?? TEST_ASSERTION_SECRET;`
  all sourced from `platform/runtime/tests/http-checkout-slice.test.mjs` and
  `platform/runtime/tests/negative-authority-matrix.test.mjs`.
- Pattern 1 (`\b(?:sk-proj|sk|...)[-_][A-Za-z0-9_-]{12,}`) matching the mock/placeholder
  `sk_test_...` test key line `const TEST_SECRET_KEY = '<mock sk_test_...>';`.

None of these are live credentials. They are synthetic test-only fixtures:
- `TEST_ASSERTION_SECRET = 'super-secret-ps01-account-assertion-key-2026'` (fake value),
- `LK01_ASSERTION_SECRET = 'super-secret-lk01-account-assertion-key-2026'` (fake value),
- `entitlement-signing-secret-ps01` (fake value),
- mock `sk_test_...` key used only by in-memory mock Stripe tests (Codex report confirmed
  zero live Stripe API calls, zero production mutation).

## Why a fresh rerun on the same revision would hard-stop again

- The Owner recovery directive requires a rerun on the **exact same material revision** `7a407cd`.
- The flagged strings are committed inside that revision's test fixtures.
- The canonical driver scans every file under the wrapper log dir with the same regex; Codex reads
  the target source during QA and echoes those fixture lines into stderr.
- Therefore rerunning the same revision through the same driver **deterministically trips**
  `DIRECT_EXECUTOR_SECRET_DETECTED` again (reproduced twice).
- Per the Owner directive, a recurring `secret_detected` on rerun = **HARD STOP → Sol/Owner**.

## Options to actually clear the root cause (need Owner/Sol approval — not Hermes-clerk scope)

Clearing the trigger is NOT possible by a plain rerun because it requires changing either
(A) the secret-scan behavior in the canonical driver, or (B) the committed fixture names/values in
the material revision — both are outside the Hermes-clerk scope and the Owner pinned the exact
revision for rerun.

1. **Relax/clarify the driver secret scan (skill change).** Update `direct_external_executors.py`
   secret scan to not treat synthetic `sk_test_...` placeholder keys and test-fixture constants as
   secrets (e.g. allowlist `sk_test_`, scope the `secret:` pattern to env-like assignments, or mark
   test-fixture identifiers). This is a Skill Governance + Owner Approval change; after it the same
   revision can be rerun and would pass the scan.
2. **Neutralize the flagged fixtures (source change), worker-scoped.** Have Qwen/AGY rename/neutralize
   the test constant names/values so they no longer match the regex (still deterministic proof), then
   re-gate and rerun Codex. This changes the material revision (Owner must approve a revised SHA).
3. **Whitelist this wrapper-log as known-benign for this run** (driver operational exception
   recorded by Owner), letting a fresh INDEPENDENT-QA run complete with full provenance. Requires an
   explicit Owner recovery exception to the fail-closed rule.

Hermes does not choose among these; Sol/Owner decides. No silent retry, no scan bypass, no revision
change, and no canonicalization of the old (provenance-less) QA report occurs without this decision.

## Reference artifacts

- Surviving (non-canonical, provenance-less) QA report: `docs/platform/billing-core/CODE-2-QA-REPORT-SB01-LR-2C-2026-09-12.md` (verdict FIX_BY_QWEN — NOT canonical).
- Repro stderr captures (diagnostic): temp dir `codex_qa_probe_logs` (`150152`, `150659`).
- Chain failure record: `docs/relay/CHAIN-FAILURE-SB01-LR-2C-CODEX-SECRET-DETECTED-2026-09-12.md`.
