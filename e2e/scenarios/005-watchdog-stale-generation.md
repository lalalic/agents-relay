# E2E-005 — Missing terminal watchdog + stale generation

## Objective

Use process/runtime injection to terminate a real worker execution without its mandatory correlated terminal event. Allow watchdog/recovery to establish a newer execution generation, then inject/deliver a delayed terminal event from the old execution.

## PASS

- transport/process exit alone does not create false success
- watchdog classifies missing terminal evidence and recovery proceeds exactly once
- a newer execution generation becomes authoritative
- delayed old-generation terminal event is ignored
- no duplicate concurrent launch; eventual lifecycle state is correct
