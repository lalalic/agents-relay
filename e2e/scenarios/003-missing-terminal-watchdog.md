# E2E-003 — Missing terminal event / watchdog

Trigger a worker process exit/termination without the mandatory correlated terminal event.

Expected: watchdog/recovery classifies actual execution evidence, automatically creates recovery/troubleshooting work, and reaches a valid terminal state without silent stall.
