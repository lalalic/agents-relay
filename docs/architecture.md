# Agents Relay v1 architecture

## Goal

Provide a generic, shareable async agent job system where agents can submit durable child tasks, specialized workers execute them asynchronously, results are persisted, and the parent agent can continue when dependencies become ready.

## Core model

- **GitHub pull request** — durable top-level job container and audit surface.
- **Job marker comment** — durable job metadata and continuation state.
- **Task marker comments** — append-friendly durable child-task records.
- **Agents Relay daemon** — reconciler, scheduler, dispatcher, lease/recovery manager, continuation engine, and dashboard server.
- **Agent adapters** — pluggable execution backends such as Codex and shell commands.
- **Event adapter** — optional low-latency notification/wake channel; events never replace durable PR state.
- **Artifact references** — large/private outputs stay outside GitHub comments; task records store references.

## Reconciliation rule

Every wake-up means only: "the durable state may have changed." The daemon reloads the PR and task records, derives desired actions, and reconciles actual execution state. It never advances a job solely because an event claimed something happened.

## State

Job states:

OPEN -> RUNNING -> WAITING|BLOCKED -> COMPLETED|FAILED|CANCELLED

Task states:

QUEUED -> READY -> RUNNING -> WAITING|BLOCKED -> SUCCEEDED|FAILED|CANCELLED

A task becomes READY when all declared dependencies have succeeded and any approval gate is satisfied.

## Task record

Each task is one GitHub PR comment containing a human-readable summary plus a hidden `agents-relay:task:v1` JSON marker. Minimum durable fields:

- task id and parent task id
- dependencies
- capabilities
- adapter + execution input
- routing decision for model-backed workers
- state + attempt
- lease owner and expiry
- execution id/thread id
- result summary and artifact references
- timestamps

Task submission is append-only at creation time, which avoids a single giant mutable manifest and makes agent-to-agent delegation natural.

## Execution

1. An agent submits a task to the PR.
2. A task comment is created durably.
3. The relay wakes and reloads the PR.
4. Scheduler marks dependency-satisfied tasks ready.
5. Dispatcher validates routing/capabilities and claims a lease.
6. Adapter launches the worker.
7. Worker reports progress over the optional event channel.
8. Relay persists terminal task state/result back into the task comment.
9. Relay reconciles dependents and/or resumes the parent continuation.
10. Periodic watchdog reconciliation only repairs missed wake-ups and expired leases.

## Continuations

Continuations are adapters, separate from worker adapters. v1 supports Codex-thread continuation plus a generic command/webhook contract. Hosted web chat continuations may rely on their host integration; their durable state remains recoverable from the PR.

## v1 acceptance criteria

1. A reusable TypeScript package/CLI named `agents-relay`.
2. GitHub PR/comment durable store with job/task marker parsing and updates.
3. CLI to initialize a PR job, submit child tasks, inspect status, reconcile, retry/cancel tasks, and run the daemon.
4. Dependency scheduling and nested parent/child lineage.
5. Worker lease, expiry detection, recovery, retry, timeout, and cancellation semantics.
6. At least Codex and shell worker adapters behind one adapter interface.
7. Routing metadata is mandatory before a model-backed worker can launch.
8. Optional event integration for wake-ups/progress with durable-state reconciliation.
9. Parent continuation interface with Codex-thread continuation implemented.
10. Dashboard web page showing jobs, task tree/state, worker/model, dependencies, results, leases, and live events/status.
11. SSE or equivalent local live dashboard updates.
12. Tests for marker parsing, state transitions, scheduling, reconciliation/recovery, and API/dashboard data.
13. `SKILL.md` describing how an agent submits async work, propagates lineage, consumes results, and treats events vs durable state.
14. Documentation and a runnable local dogfood example.
15. Browser-level verification of the dashboard before merge.

## Non-goals for v1

- Reimplement GitHub as a database.
- Build a general workflow-language/DAG editor.
- Require Redis, Postgres, Temporal, or Kubernetes.
- Make NATS mandatory.
- Implement a hosted multi-tenant control plane.
- Encode domain-specific agent roles in the core runtime.

## Dogfood

This PR is the first top-level Agents Relay job. Development, review, fixes, and verification remain on this PR until the v1 acceptance criteria are met.
