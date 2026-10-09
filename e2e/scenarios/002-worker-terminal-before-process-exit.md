# E2E-002 — Worker completion followed by process exit

Trigger a worker that publishes matching `task.completed` and then exits nonzero or emits benign stderr.

Expected: authoritative Task success remains `SUCCEEDED`; process diagnostics are recorded separately; review continues automatically; no duplicate retry.
