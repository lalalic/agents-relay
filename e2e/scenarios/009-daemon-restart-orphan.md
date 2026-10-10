# E2E-009 — Daemon restart / orphan recovery

## Objective

Restart the existing production `agents-relayd` once while a real workload execution is active. Run late because this affects shared runtime.

## PASS

- durable executionId/PID/lease evidence survives restart
- current live execution is not duplicated
- expired/orphaned execution is recovered exactly once when appropriate
- already completed work is not falsely failed
- Job eventually continues through the valid lifecycle

<!-- PLANNER-CONTRACT:START -->
## Mandatory Planner contract

Create one implementation Task with Codex/local-process runtime. On its first attempt, **run `sleep 90` as the first command after `task.started` and before doing implementation work**, keeping its own Worker process alive while the controller observes `task.process.launched` and restarts the daemon. On a recovered execution, do the requested work normally. Do not specify `--test-injection` until `daemon.restart`/orphan checkpoint is registered. Preserve one original Task ID across recovery.

The Planner must encode this in the **structured `next_tasks` response**. The worker must not create its own replacement Task or manufacture failure events. The E2E controller judges only runtime evidence.
<!-- PLANNER-CONTRACT:END -->
