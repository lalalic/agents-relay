# E2E-011 — Durable implementation-thread ownership

## Objective

Prove that a normal autonomous Job configured with `implementationThreadId` routes at least two distinct executable implementation Tasks as separate ChatGPT `new-turn` executions in exactly that same thread. The reviewer must use a different durable `reviewerThreadId`. The Job must complete through the normal independent review and local merge path without manual lifecycle actions after bootstrap.

## PASS

- Job snapshot durably records non-empty, distinct `implementationThreadId` and `reviewerThreadId` values
- at least two distinct executable implementation Tasks succeed
- each has a distinct execution generation, authoritative `task.started` and terminal events, and durable ChatGPT thread-delivery evidence
- both implementation deliveries use `kind: new-turn`, `threadSource: implementation`, and exactly the Job's `implementationThreadId`
- the reviewer delivery uses exactly the Job's independent `reviewerThreadId`
- SQLite/Relay state and fresh EventBus evidence prove the result; thread conversation memory or screenshots are not acceptance evidence
- the immutable-head review, local merge receipt, and Job `COMPLETED` state are reached through Relay ownership with zero manual lifecycle interventions

## FAIL

Any implementation task is delivered to a different thread, reviewer and implementation destinations are equal, a task lacks a distinct execution generation or authoritative terminal event, or completion depends on manually advancing Relay.

<!-- PLANNER-CONTRACT:START -->
## Mandatory Planner contract

Create exactly two independent implementation Tasks for the deterministic workload, with distinct IDs and executable outputs. The second Task may depend on the first for normal source ordering, but both must be separately executable Tasks; do not combine the work into one Task or create replacement Tasks. Do not set `--test-injection`.

The Job is already configured with `implementationThreadId` by the E2E runner. Relay must route both implementation Tasks through ChatGPT and submit each as a separate `new-turn` in that exact thread. The reviewer is independently routed through the distinct durable `reviewerThreadId`. The Planner and workers must not inspect or rely on ChatGPT conversation memory, manufacture lifecycle events, or manually advance review/merge. The E2E controller judges only fresh SQLite/Relay snapshots and EventBus evidence.
<!-- PLANNER-CONTRACT:END -->
