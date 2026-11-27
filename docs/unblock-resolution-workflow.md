# Recovery, unblock and resolution

The executable recovery/Task/Planner graphs own policy. Use `workflow/task-resolution.mmd`, `troubleshooter.mmd`, `blocker-recovery.mmd`, `blocker-resolution.mmd`, `authoritative-unblock.mmd`, `escalation.mmd` and `planner-orchestration.mmd`. The [recovery Contract](../skills/agents-relay/contracts/task-recovery-flows.md) specifies agent/operator obligations; the [blocker Contract](../skills/agents-relay/contracts/blocker-job-recovery.md) defines external prerequisite handling.

Diagnose an actual failure from its current execution facts before retrying. Confirmed provider quota failures follow route recovery, not Troubleshooter. A Troubleshooter runs once; unresolved recovery uses the configured durable escalation flow. A verified resolution can release/retry the original Task or establish a valid dependency. Preserve failed history, exact execution fencing and original thread identity where valid. A human decision must be authoritative, correlated and followed by fresh verification; no stale receipt or invented success.

Implementation: `rust/src/task_recovery.rs`, `worker_failure_recovery.rs`, `blocker_recovery.rs`, `troubleshooter.rs`, `unblock.rs`, `planner_recovery.rs`, `reconciler.rs`. Test negative/restart/dedupe paths in isolated SQLite, including invalid and stale resolution receipts.
