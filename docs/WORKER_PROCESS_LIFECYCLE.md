# Worker execution identity: process / thread

Relay does not use time leases for Task ownership or deadline-based Worker eviction.

## Identity and lifecycle

- SQLite owns the Task Graph. The executionId (plus attempt) fences an execution
  generation and is atomically claimed before delivery. Late events are rejected.
- Local Script/Codex and model Planner invocations register job/task/execution,
  host, PID, PGID, and process start token in the execution_process table.
  The process start token prevents mistaking PID reuse for a live Worker.
- Verified Task terminal events alone authorize completion or failure.
- If a registered local process is gone or reused while the same execution
  remains QUEUED/RUNNING, the Task Graph handles process.exited and marks
  unknown outcome / FAILED. Troubleshooter/retry uses the regular Graph.
- A live process is never terminated or replayed on elapsed time or daemon
  restart. A missing process record is unknown, not proof of process death.
- Remote ChatGPT/WebHelm uses its durable thread/session binding and verified
  provider events; local PID checks do not apply to a remote thread.
- Capacity and atomic claim still matter. Browser pool occupancy is a Session
  resource reservation, not a timed Task execution lease.

## Implementation

- rust/src/reconciler.rs: exact generation process reconciliation.
- rust/src/execution_process_tracker.rs and process_identity.rs: process proof.
- rust/src/native_codex_execution.rs, native_script_worker.rs,
  native_browser_execution.rs: Worker execution without runtime deadlines.
- workflow/task-lifecycle.mmd: process.exited transition.
- rust/src/workflow/contracts.rs: authoritative Graph event names.

## SQLite deployment

Migration is one-way with explicit backup. Remove leaseOwner and leaseExpiresAt
from every JSON Job snapshot and the execution_process.lease_owner column.
Keep executionId, attempt, execution history, process PID and start token.
Run the one-way rust/scripts/migrate_process_only_sqlite.py migration against a
stopped daemon after an online SQLite backup. No old-format compatibility shim
is retained. Verify process-exit recovery after installing the new binary.
