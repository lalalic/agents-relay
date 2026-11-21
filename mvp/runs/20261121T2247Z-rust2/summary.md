# Rust-only Foreground CLI transport resilience — 2026-11-21

- Real Model-only Rust E2E **Job 692** Model A **2135 SUCCEEDED** with actual `task.started` / `task.progress` / `task.completed` Events Bus records and Git-tracked `493e01c` artifact. Model B **2136 RUNNING** when this evidence was recorded. Job not yet COMPLETED; Final Review not yet run.
- During this genuine Job, `neo project run --foreground` detached with `io: Broken pipe (os error 32)`, even while the daemon-owned Model B continued. This is a foreground observation/transport bug, not Model Task failure.
- Rust-only fix: bounded retries for transient Broken pipe/connection reset/EOF on read-only daemon Job/Events requests and the execution-fenced idempotent reconcile/Plan Apply operations; all non-idempotent writes retain fail-closed handling. Foreground reattachment does NOT create a second Worker or Task. New tests prove transient read/history/reconcile errors cannot fabricate terminal success and permanent auth/Graph errors still fail.
- Native `native_cli_foreground` **15/15 PASS**, Rust CLI binary rebuilt, minimum CLI MVP **3/3 PASS** (real create, Script A→B→C, durable Job COMPLETED readback). See `cli-brokenpipe-regression.log`.
- Native Rust production daemon remains exclusive live owner; it was not restarted while real Model B was in-flight. Neo Mobile postponed.
