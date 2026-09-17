# CHAIN FAILURE — SB01 LR-2D — Qwen executor EXIT 55 at substantive execution — 2026-09-17

Task: `SB01-LONG-RUN-2C-2F-001`
Stage: `LR-2D` (webhook durability + reconciliation)
Runtime: `kanban-external-agent-dispatch v2.5.1`
Reporter: Hermes (orchestrator — diagnosis only, no source repair)
Issue Fingerprint: `EXECUTOR-QWEN-EXIT55-SUBSTANTIVE-RUN | agent-qwen | direct wrapper execution | wrapper exit 55 after readiness PASS`

## 1. Symptom

```
DIRECT_EXECUTOR_ERROR: DIRECT_EXECUTOR_EXIT:agent-qwen:55
```

- Stage: `agent-qwen` as `CORE-BUILDER`, `context_mode=BUILD`, timeout 1500 s.
- Base revision `a894478` (branch tip at dispatch), workspace
  `D:\AI-Workspace\runtime\worktrees\sb01-central-billing-20260909`.
- The wrapper returned exit **55**; the executor is fail-closed, so it removed the output file and
  raised. `agent-qwen.stdout.txt` / `agent-qwen.stderr.txt` were **not** persisted on this path
  (the driver raises before writing them), so no wrapper stderr capture exists for this run.

## 2. Readiness vs substantive execution — the decisive evidence

Per brief §6, readiness was probed **once** before dispatch, using the canonical contract:

| Layer | Result |
|---|---|
| Executable health | PASS — `qwen.cmd` resolved, version `0.23.3` |
| Auth/session | PASS — `qwen_provider_prerequisites`, `settings:glm-5.3-flash:cloud` |
| Non-substantive invocation probe | PASS — exit 0, exact normalized sentinel `READY` |
| Wrapper sha256 | `sha256:ea33c85e1504769a270b4021e3c362d7b9a53459931376ee12d452f527e5a771` |
| **Substantive BUILD run** | **FAIL — wrapper exit 55** |

So the current state is: **`agent-qwen` readiness = PASS, substantive execution = FAIL.** This is
the same outcome class as the 2026-09-12 `WRAPPER_EXIT 55 / AttachConsole`
(`@lydell/node-pty-win32-x64`) blocker, now re-established on current evidence rather than assumed:
the readiness probe (short, plan-mode, no tools) succeeds, while the long substantive BUILD run
dies with 55.

Partial work before the failure: the worker had created
`platform/runtime/tests/outbox-lease-reconcile-real-db.test.mjs` (553 lines, real-SQL harness,
written against `BILLING_DATABASE_URL` / `billing_core_staging`). **It is unverified and
incomplete** — the run never finished, and no evidence artifact was produced. It is preserved as
**diagnostic input only** (see §5), NOT as a deliverable and NOT as admissible evidence.

## 3. Repair-cycle accounting

- Issue Fingerprint: `EXECUTOR-QWEN-EXIT55-SUBSTANTIVE-RUN`
- Initial failure = **diagnosis, not a repair attempt**.
- Ordinary repairs consumed for this fingerprint: **0 / 2**.
- **No blind retry was performed.** Per brief §6 the broken executor was not re-invoked.

## 4. Routing decision required (Relay failure protocol is authority)

Brief §12: *"proven executor/runtime defect must not be blindly retried by the broken executor…
Persist the diagnostic package and route directly to Codex; Codex may return `SEND_TO_CLAUDE`
without consuming two meaningless ordinary retries."*

Brief §6: *"If the same executor defect remains, do not blindly retry it; follow current Relay
fail-closed routing and continue SB01 through an explicitly approved healthy role where policy
permits."*

Role-admissibility check at this moment (explicit, no silent substitution):

| Candidate | Status for LR-2D `CORE-BUILDER` |
|---|---|
| `agent-qwen` | NOT admissible — proven executor defect at substantive execution |
| `agent-agy` | NOT admissible — Relay v2.5.1 restricts ordinary AGY stages to `role=UI-UX-SPECIALIST` (presentation layer only); LR-2D is backend/DB/reconciliation |
| `agent-codex` | Healthy, but is the designated independent verifier — using it as builder would break reviewer independence for this stage |
| `agent-claude` | Healthy; proven CORE-BUILDER on this repo (LR-2C FIX-04). House role map allows Claude as difficult-work closer only on Codex `SEND_TO_CLAUDE` or explicit Sol authorization |
| `agent-opencode` | NOT admissible — not in the named production Relay executor registry; readiness probe fails |

Therefore the correct next step is a **Codex classification dispatch** for this executor defect.
On `SEND_TO_CLAUDE`, one bounded Claude LR-2D build round is authorized, then Codex verifies at the
exact returned SHA. No stage was released on the failed worker's output.

## 5. Evidence paths

- Dispatch: `docs/dispatch/AGENT-DISPATCH-SB01-LR-2D-QWEN-2026-09-17.md`
- Orchestrator run log: `D:\AI-Workspace\runtime\qa-temp\relay-evidence\sb01-lr2d\exec\.QWEN-LR2D-RUN.log`
- Preserved partial artifact (diagnostic only):
  `D:\AI-Workspace\runtime\qa-temp\relay-evidence\sb01-lr2d\diagnostic\outbox-lease-reconcile-real-db.test.mjs`
- Prior same-class record: `docs/relay/DIAGNOSTIC-SB01-LR-2C-QWEN-EXIT55-2026-09-12.md`
  (`@lydell/node-pty-win32-x64/lib/conpty_console_list_agent.js` → `getConsoleProcessList` →
  `AttachConsole failed`), and `docs/relay/CHAIN-FAILURE-SB01-LR-2C-FIX01-QWEN-EXIT-55-2026-09-12.md`
- SHA evidence: `docs/relay/SHA-VERIFICATION-EVIDENCE-2026-09-17.md` (`a894478…`, resolved by command)

No secret value was printed, logged, or persisted. No source, schema, migration or credential was
mutated. The Stripe TEST listener (`pid 33400`) is running; its signing secret matches the vault
value for this session.

## 6. Stop condition

`TECHNICAL_REMEDIATION_REQUIRED` → Codex classification → bounded Claude build (on
`SEND_TO_CLAUDE`) → deterministic gate → fresh Codex exact-SHA verification. No LR-2E release
before LR-2D PASS. No Owner round-trip: this is an ordinary technical/executor defect inside the
locked brief.
