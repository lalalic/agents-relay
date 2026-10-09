# E2E-009 — Daemon restart / orphan recovery

## Objective

Restart the existing production `agents-relayd` once while a real workload execution is active. Run late because this affects shared runtime.

## PASS

- durable executionId/PID/lease evidence survives restart
- current live execution is not duplicated
- expired/orphaned execution is recovered exactly once when appropriate
- already completed work is not falsely failed
- Job eventually continues through the valid lifecycle
