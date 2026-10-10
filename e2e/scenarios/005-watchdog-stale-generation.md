# E2E-005 — Missing terminal watchdog + stale generation

## Objective

Use process/runtime injection to terminate a real worker execution without its mandatory correlated terminal event. Allow watchdog/recovery to establish a newer execution generation, then inject/deliver a delayed terminal event from the old execution.

## PASS

- transport/process exit alone does not create false success
- watchdog classifies missing terminal evidence and recovery proceeds exactly once
- a newer execution generation becomes authoritative
- delayed old-generation terminal event is ignored
- no duplicate concurrent launch; eventual lifecycle state is correct

<!-- PLANNER-CONTRACT:START -->
## Mandatory Planner contract

Create the original implementation Task with `"workerRequirements":{"runtime":"codex","capabilities":["model","local_repo"]}`. Do not set `--test-injection` until a matching worker-process termination method checkpoint is implemented; the existing controller tests actual worker termination.

The Planner must encode this in the **structured `next_tasks` response**. The worker must not create its own replacement Task or manufacture failure events. The E2E controller judges only runtime evidence.
<!-- PLANNER-CONTRACT:END -->
