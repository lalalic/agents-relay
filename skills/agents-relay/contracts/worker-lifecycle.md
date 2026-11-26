# Managed Worker Lifecycle Contract

Every managed Worker Task has an exact Relay Job, Task and Execution
identity. Relay Graph owns durable state; a provider process exit or transport
acknowledgement alone does not mean the Task succeeded.

## Preflight and progress

Perform minimal required preflight before task.started. Publish meaningful
task.progress when work advances; preserve the exact current execution source.
Verify accepted event receipts and continue checking Task acceptance.

## Failure, review, terminal boundary

Publish task.failed with phase, reason and evidence on failure. Repair
feasible validation problems in this same execution. Only use an authorized
interactive-review action; never fabricate approval or publish task.blocked
or task.unblocked, which Relay owns. A process exit is not completion.
Follow the selected declared DAG/Git/Event Task Completion Contract.
