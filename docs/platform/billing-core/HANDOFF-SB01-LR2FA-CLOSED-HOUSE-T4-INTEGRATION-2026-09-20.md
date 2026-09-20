# HANDOFF — SB01 LR-2F-A CLOSED / HOUSE T4 INTEGRATION

Date: 2026-09-20
Product: SB01 — Central Billing Core
Repository: `Gutumrod/stripe-billing`
Branch: `work/sb01-central-billing-pc-20260911`
Implementation revision: `96abe085004f61a029d2519615ec8aa575384b89`
Status: `LR-2F-A CLOSED / PASS`
Next ownership: `WSTERA House / Control integration`

## Purpose

This file is the durable handoff for the point where SB01 stops its independent LR-2F-A lane.

The current House LONG_RUN is already active separately. Do not use this handoff to start a second
writer against House or Control while that run is still active.

The next combined House/SB01 continuation brief may consume this handoff after the current House run
reaches its own stop point.
## Canonical closure state

SB01 terminal state for this phase:

```text
LR-2F-A_SB01_READ_CONTRACT_READY_FOR_CONTROL_INTEGRATION_REVIEW
READY_FOR_SOL_OWNER_LR2F_B_CONTROL_INTEGRATION_DECISION
```

Owner/Sol disposition:

```text
LR-2F-A = ACCEPTED / CLOSED / PASS
LR-2F-B separate SB01 implementation lane = DO NOT START
House T4 = integration owner
Production activation = NOT AUTHORIZED
```

Phase state:

- LR-2C — CLOSED / PASS
- LR-2D — CLOSED / PASS
- LR-2E — CLOSED / PASS
- LR-2F-A — CLOSED / PASS
- LR-2F-B — not started as a separate SB01 lane
## Exact reviewed and persisted implementation

Final product implementation commit:

`96abe085004f61a029d2519615ec8aa575384b89`

The post-commit closure evidence verifies:

- local/remote parity
- committed source content matches the Codex-R3-reviewed product source
- build PASS
- typecheck PASS
- control-read projection suite 25/25 PASS
- negative-authority matrix 19/19 PASS
- SQLSTATE evidence 0 mismatches
- unknown-product 404 path verified
- shared legacy error envelope preserved
- Control-local retryable/degraded behavior verified
- secret scan clean
- no Control repository mutation

Codex final closure:

```text
R3 = PASS
BLOCKERS = 0
DEFECTS = 0
```
## Approved Control-facing contract

Endpoint:

`GET /v1/billing/control/snapshot`

Addressing contract:

`product + environment + explicit accountId -> account-scoped billing snapshot`

Product-wide enumeration is not authorized.

Authorization requires the dedicated:

`control_read`

scope plus the account assertion bound to:

- product
- environment
- account
- operation_id
- action

SB01 remains `productId` native.
## Locked authority boundary

The approved direction is:

```text
Control -> SB01 approved read projection -> SB01/provider truth
```

Never:

```text
Control -> Stripe/provider directly
Control -> billing database mutation
Control -> payment execution
```

Invariant:

`canExecutePaymentActions = false`

Control does not receive authority for checkout, subscription mutation, refund, PromptPay execution,
provider/webhook secrets, reconciliation/outbox ownership, entitlement mutation, or direct financial writes.
## Work that remains after SB01 LR-2F-A

The remaining integration work belongs to House/Control, not to a parallel SB01 implementation lane.

When the next House continuation run reaches the financial-read integration stage, it must:

1. consume the exact accepted SB01 contract at the implementation revision above;
2. implement the concrete Control transport for `GET /v1/billing/control/snapshot`;
3. resolve `productCode -> productId` on the Control side;
4. map raw SB01 `providerStatus` into the Control display/status vocabulary;
5. handle total SB01 transport unavailability on the Control side;
6. provision/use the required per-product `control_read` credential and assertion trust;
7. prove full direction `Control -> SB01 approved read projection`;
8. prove the prohibited mutation/provider/payment paths remain impossible.

Do not redesign SB01 as part of that integration unless a new material defect is independently proven.
## House sequencing rule

The current House LONG_RUN owns the sequence:

```text
T1/B1
 -> T2/B2
 -> T3/B3
 -> T4/B4  [consume SB01 here]
 -> T5/B5
 -> T6/B6
 -> Owner House closure
```

SB01 dependency interpretation from this point:

```text
SB01 LR-2F dependency = AVAILABLE / ACCEPTED
House T4 execution     = wait for prior House stages and review batches
```

Therefore SB01 itself is not a blocker anymore. The remaining wait is House sequencing.
## Disclosed limitations to carry forward

These are accepted LR-2F-A disclosures and must not disappear from later Production Readiness work:

- some DB qualification evidence carries older revision provenance;
- some real-Postgres suites were not part of the final revision-bound independent run;
- migration ledger provenance for `0002_multi_product_billing_runtime` is absent;
- a dead `UNKNOWN_PRODUCT` branch/comment remains cosmetic;
- Control repository advanced independently during SB01 work.

These do not invalidate the accepted read contract, but the next production-readiness brief must
explicitly disposition them rather than silently dropping them.
## Primary evidence

Local closure package:

`D:\AI-Workspace\runtime\reviews\sb01-lr2fa-native-swarm\LR2FA-OWNER-SOL-CLOSURE-PACKAGE.md`

Independent final review:

`D:\AI-Workspace\runtime\reviews\sb01-lr2fa-native-swarm\evidence\STAGE-G3-CODEX-R3-CLOSURE.md`

Post-commit identity/parity proof:

`D:\AI-Workspace\runtime\reviews\sb01-lr2fa-native-swarm\evidence\STAGE-G5-POST-COMMIT-CLOSURE.md`

Future work must re-verify the exact repository state rather than trusting paths alone.
## Contract invalidation rule

If any material change occurs to the accepted SB01 projection schema, transport semantics,
authorization contract, failure semantics, or authority boundary, the House T4 dependency acceptance
is invalidated and must be reviewed again.

A documentation-only handoff commit after `96abe085...` does not change the accepted implementation
revision. The implementation revision remains the source anchor unless product source changes.

## Next brief rule

After the current House LONG_RUN reaches its stop point, create a new file-backed Hermes LONG_RUN
brief/manifest that:

- reads the final House closure state first;
- reads this SB01 handoff and exact implementation revision;
- avoids overlapping writers;
- includes the remaining SB01-to-Control integration inside the House critical path;
- preserves the read-only billing authority boundary;
- carries all disclosed limitations into Production Readiness;
- requires independent review at the financial-read boundary;
- does not authorize Stripe Live, PromptPay expansion, or Control payment authority by implication.

Until that new brief is created and approved, SB01 remains stopped at LR-2F-A CLOSED / PASS.

## Mandatory Hermes execution engine for the next combined run

The next Hermes LONG_RUN that consumes this handoff must load the installed
`hermes-native-swarm` skill before executing any work unit from the new brief.

Startup gate requirements:

1. locate the installed `hermes-native-swarm` skill;
2. read its `SKILL.md` and active execution contract;
3. verify the installed version / source identity before use;
4. record that identity in the new run preflight evidence;
5. use `hermes-native-swarm` as the ordinary execution engine for work units authorized by the brief;
6. preserve the existing worker/reviewer boundaries, retry fingerprints, review gates, and escalation policy;
7. do not silently fall back to a different execution engine if Native Swarm cannot be loaded or verified.

If the Native Swarm startup gate fails, the new combined run must stop fail-closed and record the
exact blocker instead of beginning implementation through an unapproved substitute path.

This requirement does not authorize modification or reinstall of the skill. Any skill defect or
revision requirement remains a separate revision-bound task unless the future brief explicitly authorizes it.
