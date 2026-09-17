# PHASE R — RECONCILE CURRENT REALITY — SB01 LONG_RUN — 2026-09-17

Task: `SB01-LONG-RUN-2C-2F-001` (no new Task ID — continuation)
Brief: `docs/tasks/BRIEF-SB01-LONG-RUN-COMPLETION-2026-09-17.md`
Owner authorization: YES — execute through `READY_FOR_SOL_OWNER_FINAL_REVIEW`
Orchestrator: Hermes (Clerk/Orchestrator only)

## 1. Repo / worktree / revision

| Field | Value |
|---|---|
| Repository | `Gutumrod/stripe-billing` |
| Worktree | `D:\AI-Workspace\runtime\worktrees\sb01-central-billing-20260909` |
| Branch | `work/sb01-central-billing-pc-20260911` |
| Upstream | `origin/work/sb01-central-billing-pc-20260911` (same SHA) |
| LOCAL HEAD | `ac0290ae08068be04b786db7c42b1f65e08428d9` |
| `origin/work/...` | `ac0290ae08068be04b786db7c42b1f65e08428d9` |
| `origin/feature/central-billing-phase2-runtime` | `e102e3f7679202930cee995b8499b286b8125ab7` |
| Local vs upstream | `0 0` (in sync) — matches brief's "last known HEAD" |
| Dirty/untracked | 40 entries: 1 modified (`docs/tasks/TASK-SB01-LONG-RUN-2C-2F-001.md`, docs-only, uncommitted), 39 untracked worker/log/harness artifacts |

`git clean`/reset/rebase NOT performed (brief §5). Pre-existing dirty/untracked work preserved untouched.

## 2. Skill Proof (brief §3)

| Skill | Path (absolute) | Version | SHA-256 |
|---|---|---|---|
| `software-development/dev-workflow-router` | `D:\AI-Workspace\runtime\hermes-native\data\skills\software-development\dev-workflow-router\SKILL.md` | 1.0.0 | `517e49124bd4f60068f8316bc6e609d25da1349ac044552d8a5e8dce2d338dfa` |
| `devops/kanban-external-agent-dispatch` | `D:\AI-Workspace\runtime\hermes-native\data\skills\devops\kanban-external-agent-dispatch\SKILL.md` | 2.5.1 | `308d22deb31086913f9bfdeb1c34cceb5a13da971dfd9b532c0374bdde1c00db` |
| `software-development/github` | `D:\AI-Workspace\runtime\hermes-native\data\skills\software-development\github\SKILL.md` | 2.0.0 | `8251b2521b1713dce8eff9f2bc9e0ed231c521c3e1fbb18c4767807d81afc4d2` |
| `devops/sdlc-review` (conditional) | `...\data\skills\devops\sdlc-review\SKILL.md` | 1.1.0 | `ce90e8a3e145cce69c62880dc85921700110879f9290952d6cec28218503155f` |
| `software-development/backup-first-workflow` (conditional) | `...\data\skills\software-development\backup-first-workflow\SKILL.md` | — | `9210e7189ddac8c895ae0a4439bd373606e1a610a02e910bca093a4108fcdebf` |

All mandatory skills readable; none missing. No memory-based substitution of an older skill version.

## 3. Runtime-home guard (hard gate)

`pwsh -NoProfile -File scripts\assert-relay-runtime.ps1` →

```json
{"expected_home":"D:\\AI-Workspace\\runtime\\hermes-native\\data",
 "checks":{"process_home_matches":true,"user_home_matches_or_unset":true,
           "skill_version_matches":true,"gateway_home_matches_or_unset":true},
 "ok":true,"expected_version":"2.5.1",
 "skill_sha256":"308D22DEB31086913F9BFDEB1C34CCEB5A13DA971DFD9B532C0374BDDE1C00DB",
 "gateway_home":"D:\\AI-Workspace\\runtime\\hermes-native\\data","gateway_pid":15500}
```
`GUARD_EXIT=0` — **PASS**, fresh (read in this session, matching the on-disk file, not a stale snapshot).

## 4. Executor readiness — probed FRESH this session (once, per brief §6)

`direct_external_executors.readiness(identity, workspace)` — fail-closed contract:

| Identity | Version | Executable health | Auth | Invocation probe | EXECUTOR_READY |
|---|---|---|---|---|---|
| `agent-claude` | 2.1.269 (Claude Code) | PASS | PASS (`json_logged_in_true`) | PASS (`READY`) | **PASS** |
| `agent-agy` | 1.2.3 | PASS | PASS (`agy_models`) | PASS (`READY`) | **PASS** |
| `agent-codex` | codex-cli 0.147.0 | PASS (wrapper sha256:15f77b52cf84…) | PASS (`text_authenticated`) | PASS (`READY`, read-only sandbox) | **PASS** |
| `agent-qwen` | 0.23.3 | PASS (wrapper sha256:ea33c85e1504…) | PASS (`settings:glm-5.3-flash:cloud`) | PASS (`READY`) | **PASS** |
| `agent-opencode` | — | — | — | FAIL | `DIRECT_EXECUTOR_NOT_READY:agent-opencode:invocation_failed` |

Raw evidence: `docs/relay/PHASE-R-EXECUTOR-READINESS-2026-09-17.json`

### Old blocker disposition
Prior blocker (2026-09-12): `QWEN WRAPPER_EXIT 55 / AttachConsole failed` (`@lydell/node-pty-win32-x64`), with LR-2C FIX-01 blocked behind Qwen runtime remediation.

**Disposition: CLOSED — NOT CURRENT.** A fresh canonical readiness probe through the current Relay registry returns `EXECUTOR_READY = PASS` for `agent-qwen` (exit 0, exact `READY` sentinel, no exit-55, no AttachConsole failure). Per brief §6 (probe once; if healthy, close the old blocker with evidence) the 2026-09-12 executor defect is closed with this evidence. No blind retry of a broken executor was required, and no silent agent substitution occurred.

`agent-opencode` is NOT usable: readiness returns `DIRECT_EXECUTOR_NOT_READY:agent-opencode:invocation_failed` (`OPENCODE_PROVIDER_PATH_UNAVAILABLE`). Not used.

> **CORRECTION (appended 2026-09-17, original text preserved above):** an earlier version of this
> line said OpenCode "is not a named production Relay executor". That was **wrong** —
> `agent-opencode` IS in `DIRECT_EXTERNAL_EXECUTORS` (`direct_external_executors.py:54`) with role
> `PRIMARY_GENERAL_IMPLEMENTATION_WORKER` (`SKILL.md:143`) and a present v2.0.3 executable. The line
> quoted from `references/current-routing-evidence.md` is stale history. The correct current status
> is `OPENCODE_PROVIDER_PATH_UNAVAILABLE`. This does not change the PHASE R verdict: the executor was
> and remains unusable, so it was correctly not used. Finding recorded outside SB01 scope at
> `D:\AI-Workspace\runtime\hermes-native\data\housekeeping\RUNTIME-FINDING-opencode-provider-path-2026-09-17.md`.

## 5. Canonical task / doc supersession check

| Source | Status |
|---|---|
| `docs/platform/billing-core/BRIEF-SB01-LONG-RUN-RELAY-PHASE2C-2F-2026-09-12.md` | Not in SB01 repo; canonical copy at `D:\AI-Workspace\runtime\worktrees\house-billing-core-20260909\docs\platform\billing-core\` (read). House canonical, superseded only in *execution mode* (LONG_RUN completion brief). |
| `docs/tasks/TASK-SB01-LONG-RUN-2C-2F-001.md` | Stale checkpoint text (v1.3.0 / runtime v2.3.9); uncommitted local edit. Task ID unchanged, per continuation rule. |
| `docs/tasks/BRIEF-SB01-LONG-RUN-COMPLETION-2026-09-17.md` | **NEWEST AUTHORITY** — LONG_RUN, execution authorization through LR-2F + final verify. No newer instruction superseding it found anywhere under `D:\AI-Workspace` (`find -newermt 2026-09-13` → only this brief). |
| `HANDOFF-SB01-LONG-RUN-SOL-CONTINUATION-2026-09-12.md` | House; confirmed credential-ready state and the "fresh dispatch pinned to exact revision" rule. |

No unresolved conflict between the 2026-09-17 brief and canonical sources. The brief's scope lock (TEST only, no live/production, no PromptPay, no Control mutation) is consistent with the house brief.

## 6. Credential / access presence (no secret values read out)

Vault: `D:\AI-Workspace\.secrets\keys.txt` (+ `registry.tsv`).

| Item | Canonical var | Present | Class / verified |
|---|---|---|---|
| Stripe TEST secret key | `STRIPE_SECRET_KEY_BOOKING2` (registry: `STRIPE__WSTERA_PRODUCTION__QUEUEEASY__STAGING__SECRET_KEY`) | YES | `sk_test_*` — live key NOT used; `/v1/account` → `acct_1U2L8zHB4GRCffd9`, country TH, currency thb, `charges_enabled=false` |
| Stripe TEST webhook secret | `STRIPE_WEBHOOK_SECRET` (registry: `STRIPE__WSTERA_PRODUCTION__SB01_CENTRAL_BILLING__TEST__WEBHOOK_SECRET`) | YES | `whsec_*`, token sha256[:16] `707fbebcc1a65a6b` — **matches the currently active listener secret** |
| WSTERA LAB DB | `BILLING_DATABASE_URL` | YES | `postgresql://postgres.ykxlqnshaaxmzzocpjlj@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres` (sanitized); **connects** |
| Profile Price pins | — | — | PS01 `price_1UDCxyHB4GRCffd9RyaDWZ1c` @ 99000 thb `livemode:false`; LK01 pro `price_1UDCxzHB4GRCffd9a0rUipHY` @ 19900 thb `livemode:false` — match `PS01.test.ts` / `LK01.test.ts` |

Note: `STRIPE_SECRET_KEY` (bare name) does not exist in the vault; the canonical TEST key is `STRIPE_SECRET_KEY_BOOKING2`, which prior runs seeded into `STRIPE_SECRET_KEY` in the child process env only. No credential value was printed, logged, or committed; no `.env` or credential file was modified.

### DB blocker disposition — CLOSED
2026-09-12 diagnostic sequence: (1) `DB_NETWORK_OR_IPV6_BLOCKED` (Direct host IPv6-only), then (2) `DB_AUTH_FAILED` (SQLSTATE 28P01) after the pooler switch. **Both are no longer current**: a fresh read-only probe this session returns `select 1` OK against the Session-Pooler host with the project-ref username. Verified live. No secret rotated by Hermes.

## 7. Target TEST/LAB database applied state (read-only, brief §11 partial)

`billing_core_staging` on WSTERA LAB (PostgreSQL 17.6), 16 relations present:
`audit_events, delivery_jobs, payments, plans, processed_events, runtime_audit_events, runtime_credential_bindings, runtime_entitlement_test_sink, runtime_entitlement_transitions, runtime_operations, runtime_outbox_jobs, runtime_provider_customers, runtime_provider_events, runtime_reconciliation_state, stripe_customers, subscriptions`

- Narrow application roles exist: `billing_core_staging_app(login)`, `billing_core_app(login)`.
- Table grants: `billing_core_staging_app` = 48, `postgres` = 112.
- **`anon` / `authenticated` / `service_role`: ZERO grants** — intended Data API exposure policy = no public exposure of billing runtime tables. Verified from catalog, not from migration source.
- RLS enabled on billing tables = false (server-side app-role access model, not RLS-based).
- Indexes + FK/CHECK constraints present (sampled; full applied-state verification is repeated at the FINAL VERIFY gate).

## 8. Repository baseline at HEAD (re-run this session, not inherited from prior reports)

```
cd platform/runtime
npm run build      -> exit 0
npm run typecheck  -> exit 0
npm test           -> # tests 42 / # pass 42 / # fail 0   (exit 0)
```

FIX-02 (portal `return_ref` allowlist validated **before** `beginOperation`) confirmed present in HEAD `runtime.ts:366-368` — i.e. the QA High finding is genuinely repaired in the current tree, not just claimed. FIX-03 (EOF blank line) verified separately at the diff gate.

## 9. LR-2C current state (honest)

| LR-2C item | Current reality |
|---|---|
| HTTP boundary + authority model | Implemented in HEAD (`platform/runtime/src/http.ts`, `runtime.ts`, `security.ts`) |
| Build / typecheck / 42 tests | PASS at HEAD |
| Negative-authority matrix (19 rows) | PASS on real HTTP boundary, but against **in-process Stripe contract mock + in-memory DB** |
| Real Stripe TEST vertical slice (FIX-01) | **NOT YET PROVEN** — 2026-09-12 attempt died at Qwen exit-55 before executing; harness `platform/runtime/scripts/run-sb01-lr2c-real-slice.mjs` (untracked, 45 KB) exists and is TEST-gated but has no persisted real-run evidence |
| WSTERA LAB persistence proof | DB reachable now; no run evidence yet |
| Codex LR-2C verdict | `FIX_BY_QWEN` (2026-09-12) with FIX-02/FIX-03 repaired; FIX-01 outstanding ⇒ LR-2C not PASS |

⇒ **LR-2C is not closed.** Entry gate for the long-run advance requires a real TEST slice + deterministic gate + independent exact-SHA review.

## 10. Preflight (canonical Relay preflight, brief §2/§3)

```text
AGENT RELAY PREFLIGHT
Canonical skill: D:\AI-Workspace\runtime\hermes-native\data\skills\devops\kanban-external-agent-dispatch\SKILL.md / 2.5.1 / 308D22DEB31086913F9BFDEB1C34CCEB5A13DA971DFD9B532C0374BDDE1C00DB
Hermes runtime home: D:\AI-Workspace\runtime\hermes-native\data  (guard PASS)
Work type: DIRECT-APPROVED
Source of Truth: docs/tasks/BRIEF-SB01-LONG-RUN-COMPLETION-2026-09-17.md; house BRIEF-SB01-LONG-RUN-RELAY-PHASE2C-2F-2026-09-12.md; docs/tasks/TASK-SB01-LONG-RUN-2C-2F-001.md; actual source/tests at exact revision
Implementation Gate: PASS (brief declares execution authorization; Decision gaps = NONE)
Owner Build Approval: YES (brief §Header "Owner authorization: YES", §16)
Release policy: RELAY_STANDARD
Workspace: D:\AI-Workspace\runtime\worktrees\sb01-central-billing-20260909
Git target: work/sb01-central-billing-pc-20260911 @ ac0290ae08068be04b786db7c42b1f65e08428d9
Allowed paths: platform/runtime/src/**, platform/runtime/tests/**, platform/runtime/scripts/**, platform/profile-registry/**, docs/**, migrations (none new expected)
Prohibited paths: .env / credential files; live Stripe surfaces; production DB; Control Plane billing mutation; unrelated dirty/untracked files; relay skill scripts during product work
Execution stages: LR-2C -> LR-2D -> LR-2E -> LR-2F -> FINAL VERIFY (sequential, no fan-out)
Agents: CORE-BUILDER -> agent-claude (Qwen exit-55 legacy, healthy-but-unproven for long real-slice; AGY UI-only by current governance); STAGE-QA/FINAL-AUDITOR -> agent-codex; Hermes -> deterministic gates only
Context mode: BUILD per worker stage; INDEPENDENT-QA for first Codex verification of each material stage; INFORMED-VERIFY for re-verify
QA mode: INDEPENDENT (first) / INFORMED (re-verify)
External CLI health: CLAUDE PASS / AGY PASS / CODEX PASS / QWEN PASS / OPENCODE NOT ADMITTED
Parallelism: NONE — sequential single-writer chain (prevents overlapping write scopes, revision-bound handoff; owner cost rule: never fan out)
Failure behavior: STOP
```

## 11. Entry-gate verdict

```text
PHASE R ENTRY GATES = PASS
- mandatory skills loaded + hashed + runtime-home guard PASS
- executor readiness probed fresh, no stale blocker carried
- credential presence + TEST-only class verified (no values exposed)
- target LAB DB reachable; applied-state catalog verified read-only
- repo/branch/revision/remote parity recorded; dirty state preserved, not cleaned
- no unresolved architecture/security/product conflict; no scope widening required
```

Next: resume **LR-2C** real Stripe TEST vertical slice on the exact current revision — Hermes orchestrates, a healthy named executor performs the substantive work, Codex verifies at the exact SHA. No Owner round-trip required (brief §15).
