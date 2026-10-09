# E2E-001 — Happy path

## Objective

Prove that an ordinary production Job completes end-to-end with no lifecycle intervention after one bootstrap command.

## Trigger

No fault injection. Start one fresh Job with `job create --initial-plan` against a clean source branch.

## Required flow

Planner → implementation worker → authoritative terminal success → independent immutable-head Review → local Git merge → Job `COMPLETED`.

When the production daemon has GitHub integration enabled and the Job has an external PR binding, the external PR must also reach `MERGED`. GitHub is not allowed to override SQLite lifecycle authority, but a production Happy Path is not complete until enabled external integration converges successfully.

## PASS

- initial Planner succeeds
- implementation succeeds
- independent Review approves the current immutable source head
- local merge succeeds with durable receipt
- Job is `COMPLETED`
- zero manual plan/retry/reconcile/unblock/review/merge after bootstrap
- if GitHub integration is enabled for this Job, PR state is `MERGED`

## FAIL

Any manual lifecycle nudge is needed, the Job stalls/fails, Review or local merge does not complete, or enabled GitHub integration fails to converge to PR `MERGED`.
