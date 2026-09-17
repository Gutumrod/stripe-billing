# BLOCKER — SB01 LR-2E — Builder unavailable (verified executor/limit issue) — 2026-09-17

Task: `SB01-LONG-RUN-2C-2F-001`
Stage: `LR-2E` (entitlement + multi-product isolation)
State: `BLOCKED_EXTERNAL_ACCESS` — **temporary, time-bounded, safe route exists** (not an Owner stop)

## 1. What happened

LR-2E was dispatched to `agent-claude` (the healthy admissible `CORE-BUILDER` established during
LR-2D). The stage failed immediately:

```
DIRECT_EXECUTOR_ERROR: DIRECT_EXECUTOR_EXIT:agent-claude:1
```

No stdout/stderr was persisted by the driver on the nonzero-exit path, so the cause was diagnosed
by re-running the **exact same wrapper flags** directly and capturing output.

## 2. Proven cause (deterministic, reproduced twice)

Direct invocation of the same executable with the same flags, once with a trivial prompt and once
with the full LR-2E prompt:

```
TINY prompt : exit=1  stdout="You've hit your session limit · resets 11:20pm (Asia/Bangkok)"
FULL prompt : exit=1  stdout="You've hit your session limit · resets 11:20pm (Asia/Bangkok)"
stderr      : SessionEnd hook [...vault-snapshot.mjs --on=end] failed: Hook cancelled
```

Both fail **identically**, including with a prompt that asks nothing but a sentinel word. Therefore
this is an **account-wide Claude session limit**, not a prompt-size, repo, dispatch, or product
problem. `stderr` content is a non-fatal SessionEnd hook warning; the operative signal is the
stdout session-limit message.

Verified at: `2026-09-17 21:44 Asia/Bangkok`. Reset time reported by the CLI: **23:20
Asia/Bangkok** → ~95 minutes away at the time of writing.

## 3. Fresh executor readiness at the moment of blocking

Full canonical readiness probe re-run **once**, read-only:

| Identity | Readiness | Note |
|---|---|---|
| `agent-claude` | **NOT READY** — `invocation_failed` | session limit (above) |
| `agent-qwen` | READY (`0.23.3`) | readiness only — **substantive execution still proven-broken** (exit 55, `docs/relay/CHAIN-FAILURE-SB01-LR-2D-QWEN-EXIT55-2026-09-17.md`) |
| `agent-agy` | READY (`1.2.5`) | admissible only as `UI-UX-SPECIALIST` (presentation layer); LR-2E is backend/DB/entitlement → NOT admissible |
| `agent-codex` | READY (`codex-cli 0.147.0`) | designated independent verifier → using it as builder would break reviewer independence for this stage |
| `agent-opencode` | **NOT READY** — `invocation_failed` (`OPENCODE_PROVIDER_PATH_UNAVAILABLE`) | **superseded row — see §9 CORRECTION** |

So there is currently **no admissible `CORE-BUILDER`** for LR-2E. This is a genuine (temporary)
capacity blocker, not a routing preference.

## 4. Why this is NOT an Owner stop condition

Brief §15 lists the Owner-stop cases. This matches none of them irrecoverably:

1. *"required external access/credential is genuinely unavailable and no safe authorized route
   exists"* — a safe authorized route **does** exist: the same approved builder becomes available at
   the CLI-reported reset time. Nothing needs provisioning; nothing is permanently unavailable.
2. No irreversible/live/production action is required.
3. No canonical-source conflict exists.
4. No scope widening or invariant change is required.
5. The final Sol/Owner hard stop has not been reached.

Per brief §15 Hermes therefore continues mechanically rather than interrupting the Owner: the stage
is held fail-closed and a **scheduled resume** is registered for after the reset window, so the
long-run continues without a chat round-trip.

## 5. Repair-cycle accounting

- Issue Fingerprint: `EXECUTOR-CLAUDE-SESSION-LIMIT` (distinct from `EXECUTOR-CLAUDE-TIMEOUT`,
  which is tracked separately with its own 0/2 counter).
- This is an **external capacity limit, not a technical defect** → ordinary-repair counters do not
  apply, and no repair attempt is proposed (there is nothing to repair: retrying before reset would
  simply fail identically, which the two probes above already demonstrate).
- **No blind retry was performed** after the limit was identified. The two direct probes were
  diagnostic (bounded, non-substantive), not repair attempts.

## 6. State that must be preserved for the resume

- Stage base revision: `16c29f5435d83f079f4872ff91a14e849159c9f4` (resolve with `git rev-parse`).
- Dispatch (complete, unchanged): `docs/dispatch/AGENT-DISPATCH-SB01-LR-2E-CLAUDE-2026-09-17.md`
- Prior phases: LR-2C and LR-2D both CLOSED / PASS.
- Gates at base: build 0 / typecheck 0 / runtime 58/58 / profile-registry 16/16.
- Stripe TEST listener: `pid 33400`, forwarding to `http://127.0.0.1:8787/webhooks/stripe`.
  **It will not survive a ~95-minute wait.** The launcher re-creates/validates a listener and
  compares the generated secret against the vault value before dispatch, so the resume round is
  self-sufficient; if a new listener secret differs from the vault, the child env uses the live
  listener secret and the vault discrepancy is reported (not silently rewritten).
- Nothing from LR-2E has been produced yet; there is no partial artifact to preserve or clean.

## 7. Resume instruction (mechanical, no Owner decision needed)

After 23:20 Asia/Bangkok, re-dispatch `docs/dispatch/AGENT-DISPATCH-SB01-LR-2E-CLAUDE-2026-09-17.md`
to `agent-claude` at the then-current revision, then run the deterministic gate and a fresh
`agent-codex` independent verification at the exact returned SHA. If Claude is still limited at
resume, re-probe readiness and hold again rather than burning a dispatch.

## 8. Stop condition

`LR-2E HELD — BLOCKED_EXTERNAL_ACCESS (builder session limit, resets 23:20 Asia/Bangkok)`.
LR-2F must not be released. No Owner round-trip required: a safe authorized route exists and is
scheduled.

---

## 9. CORRECTION / RECONCILIATION — OpenCode classification (appended 2026-09-17, after Owner review)

**Appended, not rewritten.** §3's original table row for `agent-opencode` was accurate for the
moment it was written (the probe did return `invocation_failed` and the executor was not usable),
but its **stated reason was wrong**. The row is retained above and marked superseded; the correct
facts are:

- Agent Relay = `kanban-external-agent-dispatch` **v2.5.1**.
- `agent-opencode` **IS** in `DIRECT_EXTERNAL_EXECUTORS` (`direct_external_executors.py:54` →
  `"agent-opencode": "opencode-cli"`) — the earlier claim that it is absent from the registry was
  **incorrect**.
- Declared role = `PRIMARY_GENERAL_IMPLEMENTATION_WORKER` (`SKILL.md:143`).
- Executable present, version **v2.0.3** (`D:\AI-Workspace\runtime\opencode\bin\opencode.cmd`).
- Ollama model registry lists `deepseek-v4.1-flash:cloud`.
- Current status = **`OPENCODE_PROVIDER_PATH_UNAVAILABLE`** — **not** `OPENCODE_NOT_ADMITTED`.

Re-verified this session (exact readiness probe): `DIRECT_EXECUTOR_NOT_READY:agent-opencode:invocation_failed`
in 0.3 s (fail-closed). Root cause is two-layered and was reproduced:

1. **cwd/PWD handling** — `opencode` attempts to change directory to the MSYS-form path
   (`/d/AI-Workspace/...`) even when Windows-form `cwd` is supplied; overriding the inherited MSYS
   `PWD` env var moved execution past this point.
2. **provider authentication** — past layer 1, the run fails with
   `{"type":"provider.auth","message":"Unauthorized","status":401}`. Ollama itself is up
   (`http://127.0.0.1:11434/api/tags` → HTTP 200) and no usable `ollama` provider credential/session
   is configured for OpenCode.

Also recorded (Owner-reported, confirmed): a readiness **timeout can leak a child
`opencode.exe`** (`…\bin\opencode.exe serve --service`, observed pid 26308) because the driver's
`subprocess.run(timeout=…)` does not reap grandchildren.

Disposition:
- Recorded as a **separate Relay runtime defect / housekeeping item outside SB01** —
  `D:\AI-Workspace\runtime\hermes-native\data\housekeeping\RUNTIME-FINDING-opencode-provider-path-2026-09-17.md`.
- **Scope NOT widened**: no repair attempted now; the Protected Skill was **not** modified
  (sha256 still exactly `DBBD20A1AC5F9F930338FF87571683BE9F264082B096B547B16BDB6F54A63417`), and the
  OpenCode model pin was **not** changed to bypass the problem.

Routing rules remain unchanged: Claude session limit = external temporary blocker; OpenCode provider
path = unavailable; Qwen exit-55 path = unavailable per existing evidence; Codex stays the
independent verifier; AGY must not be used for backend/database/security-contract work. LR-2E resume
stays scheduled; LR-2C and LR-2D are **not** reopened.
