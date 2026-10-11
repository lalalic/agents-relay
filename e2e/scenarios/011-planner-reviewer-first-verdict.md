# E2E-011 — Planner-created reviewer first verdict

## Objective

Prove production SQLite lifecycle handling for a reviewer created by Planner,
rather than by the automatic final-review gate.

## Required flow

The initial Planner creates an implementation Task and a dependent reviewer
Task in its structured next_tasks response. The reviewer must have a frozen
reviewHeadSha and planningDecisionId, with null initial Job review, and must
publish the first trustworthy terminal review verdict with
data.outcome.head_sha matching its immutable head. Relay persists the Task
terminal state, clears execution/lease, and binds review evidence atomically.

## PASS

- Planner-created reviewer starts with null Job review.
- Reviewer's first correlated verdict reaches durable approved outcome.
- Reviewer Task is SUCCEEDED with executionId and lease cleared.
- Local merge succeeds and Job COMPLETED without manual intervention.
- An incorrect generation or duplicate verdict never overwrites the result.

<!-- PLANNER-CONTRACT:START -->
## Mandatory Planner contract

Create the implementation Task and a dependent reviewer Task in structured
next_tasks; do not rely on the normal final-review gate to create the first
reviewer. The reviewer must review the implementation's immutable local SHA
and report a canonical review.approved or review.changes_required event
including data.outcome.head_sha. Do not pre-create Job review or manually
reconcile/merge. No test injection is needed.
<!-- PLANNER-CONTRACT:END -->
