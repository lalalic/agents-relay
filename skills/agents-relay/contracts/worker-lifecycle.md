# Managed Worker Lifecycle Contract

- Publish `task.started` immediately when execution begins.
- Publish `task.progress` for meaningful progress.
- Report exactly one terminal outcome through the declared Task Completion Contract: `task.completed` or `task.failed`.
- Use the `events-bus` Skill to publish lifecycle events directly owned by the Worker.
- Use the exact assigned Job, Task and Execution source for every event.
- Report only verified outcomes and evidence; failure includes phase, reason and evidence.
- Verify Relay acceptance of lifecycle events. Process exit and transport acknowledgement alone do not establish success.
- Relay owns durable state and blocked/unblocked transitions; never publish Relay-owned lifecycle events or fabricate approval.
