# Graph Engine orchestration

See [workflow engine](workflow-engine.md) for the executable syntax and engine boundary. `workflow/` is the only lifecycle policy source; `rust/src/workflow/` supplies registered facts, guards, durable mutations and effects. `rust/src/reconciler.rs` reconciles current SQLite state and dispatches selected effects. No effect independently selects the next workflow step.

For a change, identify the owning graph, relevant guard/action, persisted facts and all entry points. Verify deterministic acceptance/rejection, idempotency, execution fencing, recovery and parity across entry points in `rust/tests/`.
