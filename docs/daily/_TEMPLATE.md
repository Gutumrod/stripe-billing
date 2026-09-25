# Daily Project Log — YYYY-MM-DD

**Project:** <project-name>
**Agent/Owner:** <agent-or-person>
**Branch:** <branch-or-N/A>
**HEAD:** <commit-sha-or-N/A>
**Working tree:** <clean / uncommitted changes summary>

## Rules
- Read Source of Truth, `HANDOFF.md` if present, and the newest daily log before starting.
- Update one `YYYY-MM-DD.md` per project per Asia/Bangkok day; multiple sessions update the same file.
- Record verified facts only. Do not mark `Done` without evidence.
- Daily logs are history, not Source of Truth. Update authoritative docs when a real decision/gate/architecture changes.
- Never record secrets, tokens, passwords, API keys, or connection strings.
- `Next` must let another agent resume immediately; `Blocked` must state the dependency and unblock condition.

## Done Today
- <completed work + concrete outcome>

## Current State
- <phase / gate / runtime / deployment / branch state at end of work>

## Decisions Made
- <decision and scope, or `None`>

## Open
- <unfinished work>

## Blocked
- <dependency + reason + exact unblock condition, or `None`>

## Next
1. <first executable action next session>
2. <second action>
3. <third action if needed>

## Do Not Repeat
- <already completed/reviewed/approved work, or `None`>

## Evidence
- Commit/HEAD: <sha or N/A>
- PR: <url/number or N/A>
- Tests: <command + result or N/A>
- Review: <review artifact or N/A>
- Relevant docs: <paths>
- Deploy/runtime: <state or N/A>

---

# Filled Example

## Done Today
- Added a scoped database role migration draft and verified the app no longer requires an owner-level runtime role.

## Current State
- Security remediation implemented on `feature/example`; not deployed; review pending.

## Decisions Made
- Runtime DB access is limited to the application-owned schema; admin/owner credentials are not used by the app.

## Open
- Independent review and migration apply gate.

## Blocked
- Production apply is blocked until independent review passes and the migration owner approves execution.

## Next
1. Read the review brief and current migration draft.
2. Run the independent review without changing production.
3. Reconcile findings into the authoritative security contract.

## Do Not Repeat
- Initial architecture decision and previous final review are already closed.

## Evidence
- Commit/HEAD: `abc1234`
- PR: `#42`
- Tests: `npm test` — PASS
- Review: `docs/reviews/EXAMPLE_REVIEW.md`
- Relevant docs: `HANDOFF.md`, `docs/SECURITY_CONTRACT.md`
- Deploy/runtime: Not deployed