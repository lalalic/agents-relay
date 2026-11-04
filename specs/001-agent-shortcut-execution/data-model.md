# Data Model

## Shortcut run

An existing Relay Job carries the durable `executionMode: "shortcut"` policy
and `contentOnly: true`, selected at Job creation before Task materialization.
The Job and Tasks remain in Relay SQLite. No separate shortcut store or
serialized Job-file mutation is used.

## Shortcut checkpoint

The executing Task result stores the Agent Graph hash, Task input hash, resolved
shortcut source hash, checkpoint schema version, node outputs, waits, validated
result receipts, and artifact SHA256 values. On resume, the runner verifies the
fingerprints and each artifact's real path and bytes before reusing output.

## Shortcut node

A node references its Agent Graph node ID and resolved Agent name, predecessor
node IDs, structured output/evidence, result (`COMPLETED`, `WAITING_EVENT`, or
`FAILED`), and exact Relay execution identity. `COMPLETED` requires a valid
contract result. Process exit alone is not success.

## Wait record

A wait binds node, wait identity, revision, expected content hash, and the
current Task execution ID. An asynchronous producer records a receipt in the
same SQLite Task checkpoint. It binds Job, Task, node, wait, revision,
execution, expected content hash, and a validated completed result object.
Recording is atomic and does not complete the node. The runner rechecks the
current Task fingerprints and receipt before the graph-selected resume effect
consumes it. EventBus results only wake reconciliation; their output is never
trusted. Identical duplicate receipts are idempotent, while stale or conflicting
receipts are rejected.
Human approvals are not shortcut result events; they use the existing
host-invocation decision authority, and a shortcut that requests human approval
cannot automatically select Worker fallback; human decisions require authenticated host invocation.

## Lifecycle

The canonical Task lifecycle graph selects `effect.launchShortcut` for an
opted-in Direct Shortcut Job with a Graph Task. This is distinct from normal
Worker no-start fallback, which records `Task.noStartFallback` and requeues
only a failed, unstarted ChatGPT/Z normal Worker generation.
`shortcut.waiting` releases its lease while preserving the current execution
identity. Such a wait does not occupy the Job execution slot, so independent
branches can proceed. SQLite remains the sole lifecycle and checkpoint
authority.
