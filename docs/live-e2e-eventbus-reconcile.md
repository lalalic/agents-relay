# Live EventBus/ReconcileCoordinator E2E probe

This PR is the post-PR154 live end-to-end validation of the managed worker
lifecycle. It exercises the path from canonical `task.started` and terminal
`task.completed` events through the EventBus and per-job
`ReconcileCoordinator`, GitHub task/PR mutations, and webhook-driven refresh.

The probe is documentation-only: runtime behavior is unchanged. Its final
review and automatic merge are intentionally handled by the normal Relay
workflow so the complete lifecycle remains observable and auditable.
