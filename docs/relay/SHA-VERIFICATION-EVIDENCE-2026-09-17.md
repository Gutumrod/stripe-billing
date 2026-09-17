# SHA / REVISION VERIFICATION EVIDENCE — SB01 LONG_RUN — 2026-09-17

Owner invariant (2026-09-17, binding from now on):

> * SHA ทุกตัวที่ใช้ใน dispatch / evidence / review ต้องได้จาก command จริง เช่น `git rev-parse`
> * ห้าม manually reconstruct / autocomplete / infer full SHA
> * ก่อน reviewer dispatch ต้อง verify target SHA + parent SHA programmatically และ persist evidence

This file is the persisted evidence for that invariant. Every value below came from a command
executed in this session; no value is reconstructed, autocompleted, or inferred.

## 1. Protected Skill remediation — exact revision approval

Owner directive approved the exact remediation and exact file revision. Verified by command:

```
sha256sum scripts/direct_external_executors.py
```

| Field | Value |
|---|---|
| Approved SHA-256 (Owner) | `DBBD20A1AC5F9F930338FF87571683BE9F264082B096B547B16BDB6F54A63417` |
| Actual SHA-256 (command) | `DBBD20A1AC5F9F930338FF87571683BE9F264082B096B547B16BDB6F54A63417` |
| Match | **YES — exact** |
| File | `D:\AI-Workspace\runtime\hermes-native\data\skills\devops\kanban-external-agent-dispatch\scripts\direct_external_executors.py` |
| Backup before remediation | `D:\AI-Workspace\backup-2026-09-17-relay-secret-scanner-regression\` |

Live regression at the approved revision (`python test_secret_scanner.py`, exit 0):

```
SECRET SCANNER REGRESSION: PASS
  false-positive (synthetic) cases not raised: 6
  real-credential cases fail-closed: 8
```

Approval scope recorded: **narrow, exact remediation + exact revision only.** Not a blanket
permission. Any future Protected Skill change outside a bounded, explicitly authorized technical
recovery must stop for Owner approval first. Hermes will not self-approve such a change again.

## 2. LR-2C integrity incident — closed

The fabricated-SHA integrity incident (rev-1 QA dispatch contained inferred expanded SHA strings)
is acknowledged by the Owner and **closed for LR-2C** after the corrected dispatch and review.

Corrected values, verified programmatically:

```
git rev-parse 4b2beb1     -> 4b2beb1ee2c05b154b5a306026dfa13d000ad913
git rev-parse 4b2beb1^    -> d47033b9ab7d1f20017310888a65f40991d3a167
```

## 3. LR-2C closure revisions — verified by command

| Ref | Value (from `git rev-parse`) |
|---|---|
| Reviewed target | `4b2beb1ee2c05b154b5a306026dfa13d000ad913` |
| Repair material (= target^) | `d47033b9ab7d1f20017310888a65f40991d3a167` |
| Closure commit / branch tip | `9c2cc490fdbccee305d73e9466e17c3dc26bc724` |
| `origin/work/sb01-central-billing-pc-20260911` | equal to local tip at push time |

LR-2C state: **CLOSED / PASS** per the exact reviewed target and the persisted closure evidence
(`docs/relay/PHASE-CLOSURE-LR-2C-SB01-2026-09-17.md`). Not to be reopened.

## 4. Enforcement procedure (Hermes, from this point on)

Before every reviewer/worker dispatch and every evidence artifact that quotes a revision:

1. Resolve the revision with a real command (`git rev-parse <ref>`), never from memory or pattern.
2. Verify the parent/related revision the same way, in the same command batch.
3. Persist the resolved values to this file (or the phase's evidence file) before dispatch.
4. Where a short SHA is used, resolve the full 40-char value and store both.
5. If a command fails to resolve, treat it as a blocker — never substitute a plausible value.

Incident class: **fabricated/inferred revision strings.** Root cause: writing expanded SHAs from
recall instead of resolving them. Prevention: rule 1–5 above, executed as a batch before dispatch.
