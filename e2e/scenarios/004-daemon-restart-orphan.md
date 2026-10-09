# E2E-004 — Relay daemon restart / orphan recovery

During a running workload, restart the existing production daemon once.

Expected: recovery correlates executionId/PID, resumes or recovers exactly once, creates no duplicate launch, and does not falsely fail completed work. Run late because it affects shared runtime.
