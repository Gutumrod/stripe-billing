# AGENT DISPATCH — SB01 LR-2D — EXECUTOR DEFECT CLASSIFICATION — Codex — 2026-09-17

Task: `SB01-LONG-RUN-2C-2F-001`
Runtime: `kanban-external-agent-dispatch v2.5.1` / `RELAY_STANDARD`
Role: `FINAL-AUDITOR` / failure classification authority (NOT a builder, NOT a reviewer of product code here)
Selected agent: `agent-codex` (context mode `INDEPENDENT-QA`)

## 1. Revisions — resolved by command

```
git rev-parse a894478    -> a894478...  (branch tip at LR-2D dispatch; re-resolve yourself)
```
Persisted SHA evidence: `docs/relay/SHA-VERIFICATION-EVIDENCE-2026-09-17.md`.
Workspace: `D:\AI-Workspace\runtime\reviews\sb01-lr2d-classify` (clean detached worktree at the
branch tip — provided so your read-only sandbox has a stable, non-dirty tree).
**Resolve `git rev-parse HEAD` yourself and record it.** Never accept a revision string from this
document without checking it.

## 2. What happened (facts only)

LR-2D was dispatched to `agent-qwen` as `CORE-BUILDER` (`context_mode=BUILD`, timeout 1500 s).

- **Readiness preflight: PASS.** version `0.23.3`, auth `qwen_provider_prerequisites`
  (`settings:glm-5.3-flash:cloud`), invocation probe exit 0 with exact sentinel `READY`,
  wrapper sha256 `ea33c85e1504769a270b4021e3c362d7b9a53459931376ee12d452f527e5a771`.
- **Substantive run: FAIL.** `DIRECT_EXECUTOR_ERROR: DIRECT_EXECUTOR_EXIT:agent-qwen:55`.
  The driver is fail-closed: it removes the output file and raises before persisting
  `agent-qwen.stdout.txt` / `agent-qwen.stderr.txt`, so **no wrapper stderr capture exists** for
  this run.
- Partial work existed on disk when it died:
  `platform/runtime/tests/outbox-lease-reconcile-real-db.test.mjs` (553 lines, real-SQL harness).
  It was moved out of the repo because it is unverified/incomplete — preserved at
  `D:\AI-Workspace\runtime\qa-temp\relay-evidence\sb01-lr2d\diagnostic\outbox-lease-reconcile-real-db.test.mjs`.
  Treat it as **diagnostic input only**, never as evidence.
- Prior same-class record (2026-09-12), root-caused at the time:
  `@lydell/node-pty-win32-x64/lib/conpty_console_list_agent.js:13` → `getConsoleProcessList(shellPid)`
  → `Error: AttachConsole failed` → qwen abort exit 55; cause: the relay executor spawns qwen with
  `CREATE_NO_WINDOW` (headless, no console) while qwen's ConPTY console-list agent requires an
  attached Windows console. See `docs/relay/DIAGNOSTIC-SB01-LR-2C-QWEN-EXIT55-2026-09-12.md`.

Full incident record: `docs/relay/CHAIN-FAILURE-SB01-LR-2D-QWEN-EXIT55-2026-09-17.md`.

## 3. Your job — classify, do not repair

The brief's failure protocol makes this a required classification step **before** any automatic
Claude escalation. Decide and return exactly one route:

- `SEND_TO_CLAUDE` — the defect is a proven executor/runtime defect, and the correct continuation is
  one bounded Claude `CORE-BUILDER` round for LR-2D.
- `RETRY_QWEN` — you have evidence that exit 55 here is transient/flaky and a single bounded retry
  with a concrete changed condition is technically justified. If you choose this, you must state the
  exact changed condition (not "try again").
- `SOL_OWNER_DECISION_REQUIRED` — reserve for a genuine authority/scope boundary, not for a
  technical executor defect.

Judge these specific questions:

1. Does the readiness PASS + substantive exit 55 asymmetry support the previously root-caused
   `AttachConsole`/ConPTY explanation, or is new evidence needed? State what evidence is missing and
   whether it is obtainable read-only.
2. Is the defect in the **executor/launcher path** (driver spawn flags, wrapper) rather than in
   Qwen's product behavior? Note that `direct_external_executors.py` is a **Protected Skill** whose
   exact current revision `DBBD20A1AC5F9F930338FF87571683BE9F264082B096B547B16BDB6F54A63417` was
   approved by the Owner **narrowly** for the secret-scanner remediation only. Any further change
   to it needs new Owner authorization — so prefer a continuation route that does NOT require
   editing the Protected Skill.
3. Given the role-admissibility table below, is `SEND_TO_CLAUDE` the correct continuation?

| Candidate | Admissible as LR-2D `CORE-BUILDER`? |
|---|---|
| `agent-qwen` | proven executor defect at substantive execution |
| `agent-agy` | no — Relay v2.5.1 limits ordinary AGY to `UI-UX-SPECIALIST` (backend/DB excluded) |
| `agent-codex` | no — it is the independent verifier; using it as builder breaks reviewer independence |
| `agent-claude` | yes — healthy (2.1.269), proven `CORE-BUILDER` on this repo at LR-2C FIX-04 |
| `agent-opencode` | no — not in the named production Relay executor registry; readiness fails |

## 4. Report channel

Put your complete classification report in your **final stdout answer**, ending with exactly one line:

```
ROUTE: SEND_TO_CLAUDE
```
(or `RETRY_QWEN` / `SOL_OWNER_DECISION_REQUIRED`.)

## 5. Allowed / prohibited

- Allowed: read-only inspection of the workspace, the cited evidence files, the diagnostic artifact,
  and the Protected Skill scripts (`direct_external_executors.py`, `invoke-qwen-worker.ps1`) —
  reading is fine, **editing is prohibited**; running read-only git/node commands.
- Prohibited: editing any file; editing the Protected Skill; live Stripe/production mutation;
  printing/echoing/logging any credential value; retrying the Qwen substantive run yourself;
  building LR-2D yourself.

## 6. Stop condition

Classification report + exactly one route line. No repair, no commit, no push.
