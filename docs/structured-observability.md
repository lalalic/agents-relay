# Runtime observability

Reconstruct a decision from the correlated event/wake, graph decision, selected action, committed SQLite state and external receipt. Logs and Dashboard projections are observational; they never substitute for durable state. Correlate Job, Task, Plan and execution identity; distinguish stale/duplicate events, retryable infrastructure failures and real terminal outcomes. Do not log secrets, raw credentials or unbounded provider payloads.

Implementation: `rust/src/observability.rs`, `decision_audit.rs`, `events_bus_runtime.rs`, `runtime_status.rs`, `runtime_status_events.rs`, `publication_store.rs`. Validate negative, duplicate and restart cases through native tests; process exit alone is not completion.
