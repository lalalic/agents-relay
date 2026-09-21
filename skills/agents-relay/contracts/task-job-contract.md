# Agents Relay Task / Job Contract

This contract is the shared protocol for every component that creates, schedules, reviews, or executes Agents Relay jobs and tasks.

## Task producers

Any task producer — orchestrator, planner, or nested task-producing agent — must follow this contract.
Task producers choose semantic task properties such as objective, dependencies, adapter/routing, priority, and `storySize`. They do not normally choose raw timeout milliseconds.

## Story size

Every worker task has one of three story sizes:

- `S`: about 5 minutes of normal-reasoning execution.
- `M`: about 15 minutes of normal-reasoning execution. This is the default when size is absent or uncertain.
- `L`: about 45 minutes of normal-reasoning execution.

Relay derives the overall execution timeout from `storySize`. If `routing.reasoning` is `high`, Relay doubles the overall execution timeout. Other reasoning levels do not change it.

Raw `timeoutMs` is a compatibility/debug/hotfix override, not the normal task-production interface.

## Worker lifecycle

Relay owns process lifecycle. Workers own semantic task lifecycle. A worker must publish canonical `task.started` as its first execution action, then exactly one of `task.completed`, `task.failed`, `task.blocked`, or `task.cancelled`. Process launch/exit events do not substitute for worker semantic events.

## Job and review lifecycle

A normal task never merges a PR. After all non-superseded work gates pass, Relay creates a SHA-bound final review task. The reviewer emits exactly one of `review.approved`, `review.changes_required`, or `review.blocked`. When `autoMerge` is enabled (default), Relay merges only after `review.approved`, pinned to the exact reviewed head SHA. A new task or new PR head makes earlier final-review evidence stale and requires a fresh review.

## Fixed and autonomous jobs

`fixed` jobs execute the orchestrator-provided task set and then proceed to final review. `autonomous` jobs may ask the planner for additional task batches. Planner-produced tasks must obey this same contract, including explicit `storySize`.
