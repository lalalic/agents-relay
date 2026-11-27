# Host interactive review

The host generates Preview and collects a decision. Relay owns the durable execution-bound invocation, revision, feedback and Task lifecycle. The host must authenticate its job/task/execution mapping; preview delivery alone is not approval or completion.

`workflow/interactive-invocation.mmd` and the Task graph select waiting/resume effects. Persist and fence host decisions; duplicate or stale decisions cannot authorize a different execution. Request Changes resumes the same Task with feedback, not a new artifact Task. Pending interactive review is not a Troubleshooter failure. Recover a committed decision after a lost wake through normal reconciliation.

Implementation: `rust/src/interactive_invocation.rs`, `interactive_invocation_ports.rs`, `interactive_resume.rs`, `native_host_review_ingress.rs`, `host_invocation_store.rs`. Tests: `native_host_review_ingress`, `native_interactive_ports_closure`, `native_l3_review_wait`. Real host/provider/device checks are separate from isolated tests.
