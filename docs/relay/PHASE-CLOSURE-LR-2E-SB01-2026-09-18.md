# PHASE CLOSURE — LR-2E — SB01 LONG_RUN — 2026-09-18

Task: `SB01-LONG-RUN-2C-2F-001` (continued, same Task ID)
Brief: `docs/tasks/BRIEF-SB01-LONG-RUN-COMPLETION-2026-09-17.md`
Orchestrator: Hermes (Clerk/Orchestrator only — no source repair by Hermes)

## Phase state

```text
Phase: LR-2E — Entitlement + multi-product isolation
State: CLOSED / PASS (independent verification PASS at exact revision)
Repo: Gutumrod/stripe-billing
Branch: work/sb01-central-billing-pc-20260911
```

## Revision binding (all resolved by command)

| Ref | Value |
|---|---|
| Reviewed target | `cd7363cf661e69e19e4ee207824cd354110e1180` |
| Target parent | `2d7077133c20ad4fb47d80eb342e54aff3f00349` |
| Stage base (dispatch) | `da44ad1699a7b4a3391018841fb0cc67a1bbb082` |
| Remote `origin/work/sb01-central-billing-pc-20260911` | `cd7363cf661e69e19e4ee207824cd354110e1180` (pushed) |
| Reviewed in clean worktree | `D:\AI-Workspace\runtime\reviews\sb01-lr2e-exact` @ `cd7363c` (detached, no modified tracked files) |

## Files changed

**No `platform/runtime/src/**` change** — independently confirmed: `git diff --stat cd7363c^..cd7363c -- platform/runtime/src` is empty. LR-2E is test + harness + evidence only.

- `platform/runtime/tests/sb01-lr2e-isolation-real-db.test.mjs` (A)
- `platform/runtime/tests/helpers/lr2e-multiproduct-fixtures.mjs` (A)
- `platform/runtime/tests/outbox-lease-reconcile-crash-window-real-db.test.mjs` (M — append-only, +166 lines: 2 new LR-2E tests)
- `platform/runtime/scripts/run-sb01-lr2e-isolation-slice.mjs` (A)
- `docs/relay/LR2E-ISOLATION-SLICE-RUN-2026-09-17.log` (A)
- `docs/platform/billing-core/EVIDENCE-SB01-LR-2E-CLAUDE-2026-09-17.md` (A)
- `docs/relay/CHAIN-FAILURE-SB01-LR-2E-ROUND1-2026-09-17.md` (A)

## Commands and results (HERMES-run, on the committed tree)

| Check | Command | Result |
|---|---|---|
| Build | `npm run build` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0 |
| Runtime tests | `npm test` | **`# tests 67 / # pass 67 / # fail 0`** (was 58) |
| Profile registry | `npm test` | `# tests 16 / # pass 16 / # fail 0` |
| Whitespace | `git diff --check` | clean |
| Secret scan (LR-2E artifacts) | 5 patterns incl. `sk_live_`/`whsec_`/`eyJ`/keyword-assignment | **0 hits** |
| Real isolation slice | `node scripts/run-sb01-lr2e-isolation-slice.mjs` | **40 / 40 PASS, 0 FAIL**, exit 0 |

## The isolation proof (the strongest evidence in this phase)

Both products ran through the **real runtime path using the IDENTICAL `account_id` literal**
(`acc_lr2e_shared_7fdeaace`), and were provably separated on every dimension:

| Dimension | PS01 | LK01 |
|---|---|---|
| Real Stripe customer | `cus_VHI0T6sq…mHJk` | `cus_VHI0Bbbm…fZUF` — **distinct** |
| Real subscription | `sub_1UGjQ6HB…GoCN` (99000 THB, pinned) | `sub_1UGjQ9HB…xtVO` (19900 THB, pinned) |
| Provider event | `evt_1UGjQ9HB…Y5qi` | `evt_1UGjQBHB…ZoBu` |
| Outbox `dedupe_key` | `stripe:evt_1UGjQ9HB4…` | `stripe:evt_1UGjQBHB4…` — **distinct literals** |
| `reconciliation_state` | v1, active, 99000 THB | v1, active, 19900 THB — own row |
| Entitlement sink | `grant v1` `["commercial_access"]` | `grant v1` `["links.pro"]` — **2 independent rows** |
| `/v1/subscription/status` | plan `founding-c2` | plan `pro` — never leaks the other |
| `/v1/entitlements` | only `commercial_access` | only `links.pro` |
| After PS01 cancel | `revoke v2`, keys cleared | **still `grant v1` `links.pro` — untouched** |

Cross-account authority: a **PS01-signed assertion presented with an LK01 credential for the same
`account_id`** is rejected **401 `ACCOUNT_ASSERTION_INVALID`**, fail-closed, no data returned.

Replay: a duplicate PS01 delivery returned 200 `duplicate=true`, created **no** second provider-event
row, **no** second outbox job, **no** second sink version, and left LK01's sink untouched.

The reviewer independently confirmed isolation is **schema-level**, not merely application-level, by
running SQL tests that assert two product-scoped rows exist for the shared `account_id`.

## Residual gap CLOSED

The previously-declared gap (entitlement-path JSONB sites having no dedicated real-PostgreSQL
regression test) is now closed: the LR-2E suite executes real SQL and asserts persisted
`jsonb_typeof` for `entitlement_keys` (array) and `signed_envelope` (object), plus sink writes. The
reviewer verified these tests genuinely execute SQL rather than asserting on source strings.

## Executor / repair chain (recorded, no silent substitution)

LR-2E took **two bounded ordinary repairs** (budget 2/2, no escalation required):

| Round | Fingerprints | Outcome |
|---|---|---|
| 1 (diagnosis + repair 1) | A `EXECUTOR-CLAUDE-OUTPUT-INCOMPLETE` (agent self-delegated to a background subagent; CLI killed it at the 600 s print ceiling); B `LR2E-HARNESS-SCOPE-DEFECT`; C `LR2E-AGGREGATE-OUTBOX-CROSSFILE-LEASE-RACE` | B and C **CLOSED** (isolation file 3/7 → 7/7, aggregate 60/65 → 67/67). A **STILL OPEN** — the three slice deliverables were absent. |
| 2 (repair 2) | A only | **CLOSED** — harness, run log and evidence delivered; evidence now `STATUS: COMPLETE`; slice 40/40. |

Prior context: LR-2E was first blocked by an account-wide Claude session limit
(`docs/relay/BLOCKER-SB01-LR-2E-EXECUTOR-LIMIT-2026-09-17.md`), resumed on schedule. Full chain
record: `docs/relay/CHAIN-FAILURE-SB01-LR-2E-ROUND1-2026-09-17.md`.

No blind retry of a broken executor; no silent agent substitution; OpenCode/Qwen remained
unavailable and unused.

## Reviewer / verdict

- Reviewer: `agent-codex` (FINAL-AUDITOR, `INDEPENDENT-QA`), direct external process provenance.
- Report: `docs/platform/billing-core/CODE-2-QA-REPORT-SB01-LR-2E-CODEX-2026-09-18.md`
- **`VERDICT: PASS`** at `cd7363cf661e69e19e4ee207824cd354110e1180`.
- Reviewer findings: **no blocking product/security findings.** One Low workspace-hygiene note: the
  untracked QA dispatch doc is present in the **review** worktree (not the product repo, not
  affecting HEAD parity or the committed diff). Recorded, not a blocker.
- Reviewer's independently reproduced results: typecheck 0; runtime direct tests **67/67**; profile
  **16/16**; LR-2E real-DB isolation **7/7**; outbox/reconcile/crash-window **17/17**; webhook JSONB
  **1/1**; `git diff --check` clean; LR-2D invariants re-run green.
- Reviewer's residual limitation: aggregate `npm run build` / `npm test` reproduced `EPERM` in its
  read-only sandbox; Hermes ran them in the clean exact-target worktree with the results above. The
  reviewer also did not re-run the full live harness to completion (command timeout) and relied on
  the committed 40/40 log — stated plainly rather than hidden.

## Known limitations

- `platform/runtime/scripts/` (all slice harnesses) remains untracked in the working worktree by
  design except where committed.
- The Claude CLI's 600 s background-task print ceiling can truncate output when the builder
  self-delegates; the dispatch now explicitly prohibits self-delegation and requires foreground
  execution with a bounded budget.
- OpenCode remains `OPENCODE_PROVIDER_PATH_UNAVAILABLE` (separate housekeeping item).
- Qwen remains unavailable for substantive execution (exit 55).

## Next phase

**LR-2F — Control Plane read projection** on the exact current revision. LR-2F is a **HARD STOP** for
production activation: passing it does not authorize Live Stripe, production cutover, or PromptPay
expansion. The Control implementation to inspect is
`D:\AI-Workspace\projects\saas-product-hub\apps\hub-web\server\control-plane\adapters\billing-core-adapter.ts`
(`canExecutePaymentActions: false`, currently `UnconfiguredBillingCoreAdapter`).
