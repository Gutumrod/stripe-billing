Classification report: SB01 LR-2D executor defect

Verified current review worktree HEAD by command:

`041aa496aa2c88734c02a362570ac444aaecd660`

Worktree status was detached and clean for this review workspace.

Evidence inspected read-only:
- `docs/relay/CHAIN-FAILURE-SB01-LR-2D-QWEN-EXIT55-2026-09-17.md`
- `docs/relay/DIAGNOSTIC-SB01-LR-2C-QWEN-EXIT55-2026-09-12.md`
- `docs/relay/SHA-VERIFICATION-EVIDENCE-2026-09-17.md`
- `docs/relay/PHASE-R-EXECUTOR-READINESS-2026-09-17.json`
- current Protected Skill hash and selected launcher/script lines
- preserved diagnostic artifact presence only

Findings:

1. The readiness PASS + substantive exit 55 asymmetry supports the prior AttachConsole/ConPTY explanation strongly enough for routing. Current readiness evidence shows Qwen executable/auth/invocation probe PASS with exact `READY`, wrapper version/hash recorded, then the substantive BUILD run failed with `DIRECT_EXECUTOR_EXIT:agent-qwen:55`. That matches the prior same-class failure where stderr proved `@lydell/node-pty-win32-x64` -> `getConsoleProcessList(shellPid)` -> `AttachConsole failed`.

2. The missing evidence is current LR-2D wrapper stderr showing the exact AttachConsole stack again. It is not obtainable read-only from this incident because the driver removes output/stderr artifacts and raises before persistence on nonzero exit. Obtaining fresh stderr would require another Qwen execution/diagnostic run, which is outside this classification brief and explicitly prohibited. It is not needed for route classification because the current failure fingerprint, old deterministic root cause, and current launcher path are aligned.

3. The defect is in the executor/launcher path, not product behavior. Current `direct_external_executors.py` hash matches the protected approved revision `DBBD20A1AC5F9F930338FF87571683BE9F264082B096B547B16BDB6F54A63417`. Its `_run` still uses `subprocess.CREATE_NO_WINDOW`, and its failure path raises `DIRECT_EXECUTOR_EXIT` before persisting stderr. The Qwen wrapper uses a low-risk `readiness` mode for the sentinel probe but `trusted-repo` uses substantive `--approval-mode yolo` with tools, matching the surface that previously triggered the Windows ConPTY console attach failure.

4. No Protected Skill repair is authorized here. Changing `direct_external_executors.py` or `invoke-qwen-worker.ps1` would require new Owner authorization and is unnecessary for continuation because a healthy admissible builder exists.

5. Role admissibility resolves to Claude. Qwen is blocked by proven substantive executor failure. AGY is UI-only and backend/DB excluded. Codex is the independent verifier and must not become builder. OpenCode is not admitted. Claude is healthy and admissible as bounded `CORE-BUILDER`.

Decision: this is a proven executor/runtime defect for Qwen in the substantive execution path. A blind Qwen retry is not technically justified because no changed condition exists. Owner decision is not required for routing because no Protected Skill repair or scope expansion is needed to continue.

ROUTE: SEND_TO_CLAUDE