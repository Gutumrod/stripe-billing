# DIAGNOSTIC — SB01 LR-2C — QWEN EXIT-55 ROOT CAUSE — 2026-09-12

Task ID: `SB01-LONG-RUN-2C-2F-001`
Owner: `Free` | Commander/Final Verify: `Sol` | Orchestrator: `Hermes`
Workflow / Runtime: `WF-RELAY-01 v1.2.0` / `kanban-external-agent-dispatch v2.3.8`
Checkpoint: `QWEN EXIT-55 DIAGNOSTIC COMPLETE`
Decision: `Recovery B — bounded diagnostic ONLY (no FIX-01 retry, no task change, no mutation)`

## Owner/Sol directive (persisted)

Run a trivial `agent-qwen` invocation through the canonical trusted-repo execution path, capture
exit code + sanitized stdout/stderr + provenance, no Stripe/WSTERA-LAB mutation, do not touch pending
FIX-01 source/evidence, do not delete untracked FIX-01 files, no agent fallback. Goal: determine whether
exit-55 is the Qwen Windows headless/ConPTY executor path and identify the canonical remediation target.

## Diagnostic performed (canonical trusted-repo execution path)

Invoked `invoke-qwen-worker.ps1 -Mode trusted-repo` with a trivial prompt (no provider/LAB mutation),
executed through the same wrapper the relay driver uses (`direct_external_executors.execute` path),
capturing process exit + stderr + output file.

## Result: executor path = FAIL (reproduced, deterministic)

- Wrapper process exit: **55**
- stdout: empty
- stderr (sanitized / secrets redacted):
  ```
  Warning: running headless with --yolo / approval-mode=yolo and no sandbox...
  ...\@qwen-code\qwen-code\node_modules\@lydell\node-pty-win32-x64\lib\conpty_console_list_agent.js:13
  var consoleProcessList = getConsoleProcessList(shellPid);
                          ^
  Error: AttachConsole failed
      at Object.<anonymous> (...node-pty-win32-x64\lib\conpty_console_list_agent.js:13:26)
      at Module._compile ...
  Node.js v22.23.2
  Run aborted:
  ```
- Output file: 0 bytes (`qwen-fix01.probe.out.txt`).

## Root cause (deterministic, not inferred)

Qwen's interactive/tooling runtime loads `@lydell/node-pty-win32-x64` (a ConPTY dependency). In its
`conpty_console_list_agent.js` it calls `getConsoleProcessList(shellPid)`, which on Windows requires an
attached console. The relay executor spawns qwen detached with `CREATE_NO_WINDOW` (headless, no console).
`AttachConsole` then fails → the agent errors → qwen aborts with exit 55. This reproduces on both the
canonical `dee.execute` run and the wrapper-direct diagnostic.

This matches the Owner's known evidence exactly:
- `agent-qwen:55`
- `@file:"lydell/node-pty-win32-x64"` / `Error: AttachConsole failed`

The failure is **not** caused by credentials (DB/Stripe/webhook all verified present), not by the
FIX-01 real-slice code, not by a secret-scan. It is the **Windows headless/no-console ConPTY executor path**.

## Canonical remediation target

The canonical remediation is in the executor launch path, not in Qwen's project source:
- `direct_external_executors._run` uses `creationflags = CREATE_NO_WINDOW`. For `agent-qwen` (Windows)
  the process must be attached to a real console (or run inside a PTY/`CREATE_NEW_CONSOLE` / allocation
  of a console) so `conpty_console_list_agent` can resolve the console process list. Alternatively, set
  the qwen/`node-pty`-safe env that avoids the console-list attach agent (validate against the wrapper
  and `@lydell/node-pty-win32-x64` semantics) — but NOT a broad stderr whitelist or fixture rename.
- The wrapper `invoke-qwen-worker.ps1` is the surface where console/pty attachment settings can be made
  explicit; the direct executor passes `creationflags=CREATE_NO_WINDOW` which is the concrete lever.

This is a **runtime/skill remediation** requiring Owner/Sol approval before altering the executor path.

## Consequence per Recovery B

- Executor path FAIL → persist blocker and **stop SB01 FIX-01 for runtime remediation before any retry**.
- Do NOT advance LR-2D.
- No FIX-01 source/evidence was touched; no Stripe/WSTERA-LAB mutation was executed in this diagnostic;
  no untracked FIX-01 file deleted; no agent fallback.

## Recommended next route (to Sol)

1. Approve a bounded remediation of the Qwen Windows executor console/pty attachment (canonical target
   `direct_external_executors._run` `CREATE_NO_WINDOW` for `agent-qwen`, or wrapper pty/console handling),
   then re-run a trivial readonly qwen probe through `dee.execute`.
2. Only after the executor probe passes do we re-dispatch the real Qwen FIX-01 (fresh, still no auto-retry;
   Sol releases it).
3. LR-2D remains gated behind LR-2C PASS.

## Provenance

- Hermes executed the diagnostic; no secret value exposed (probe output sanitized).
- Command surface: `invoke-qwen-worker.ps1 -Mode trusted-repo` (same as relay driver) with a trivial prompt.
- Exit evidence: `WRAPPER_EXIT 55` captured in `.diag-qwen-fix01-console.log`.
