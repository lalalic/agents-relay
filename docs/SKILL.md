# Agents Relay skill

Use Agents Relay when work should survive the current worker. Submit a task with a unique id, explicit `parentTaskId`, dependencies, capabilities, adapter, input, and—when using a model-backed adapter—a recorded routing decision containing provider, model, decision maker, and timestamp.

Treat GitHub PR/job and task marker comments as durable truth. Events are notifications only: after any event, reload the PR and reconcile. Consume terminal results from task records, pass child lineage to new tasks, and do not claim success from an event or process exit alone. Retry only failed/expired work and preserve attempt and lease data. Large outputs belong in artifact references, not comments.
