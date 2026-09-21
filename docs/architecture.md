# Agents Relay v1 architecture

## Goal

Provide a generic, shareable async agent job system where agents can submit durable child tasks, specialized workers execute them asynchronously, results are persisted, and the parent agent can continue when dependencies become ready.

## Core model

- **GitHub pull request** — durable top-level job container and audit surface.
- **Job marker comment** — durable job metadata and continuation state.
- **Task marker comments** — append-friendly durable child-task records.
- **Agents Relay daemon** — reconciler, scheduler, dispatcher, lease/recovery manager, continuation engine, and dashboard server.
- **Agent adapters** — agent execution backends such as Codex and ChatGPT browser workers.
- **Event adapter** — required lifecycle channel for model-backed workers. Correlated terminal events drive task-state transitions, while GitHub PR/task markers persist the resulting durable state.
- **Periodic watchdog** — low-frequency recovery sweep that re-reads durable PR/job state to repair missed wakeups and recover stale execution state (30 minutes with webhook mode by default; 5 minutes without webhooks for compatibility).
- **Artifact references** — large/private outputs stay outside GitHub comments; task records store references.

## Agent network slice

An agent is a registered, result-owning worker/social role with a responsibility boundary. It is not the same thing as a skill (a callable capability) or an execution adapter (Codex or ChatGPT). Registration is machine-driven through the CLI/core API and is stored as a trusted `agents-relay:agent:v1` marker comment on the same PR.

Registration records identity/name, role and responsibility, claimed capabilities, explicit boundaries/non-goals, endpoint/runtime, availability, and routing metadata. `agent-register` and `agent-discover` provide the smallest useful registry surface. Discovery applies hard filters first and returns observed evidence and reasons rather than a universal score. Evidence can include representative evaluations, outcomes, reliability, latency, and cost. `--explore` allows new/unobserved agents to be considered first; the orchestrator still owns the final choice.

The registry does not yet execute remote agents or expose a public marketplace. A constrained ChatGPT/voice/mobile runtime should eventually use a small authenticated service surface with only `POST /jobs` (intention-only/public jobs) and `GET /jobs/:id`; credentials and private payloads must stay out of PR markers and events. Private-data/credential jobs, multi-owner trust, isolation, billing, and public discovery are future security-gated work.

## Execution modes

Jobs persist `executionMode` as `fixed` or `autonomous`; missing mode in legacy
markers is read as `fixed`. Fixed is the default and keeps the v1 submit flow
unchanged. Autonomous jobs use the existing task records and parent hierarchy:
when all currently runnable work is settled and no planner task is active,
reconciliation appends one durable `kind: "planner"` task. The planner returns
typed `objective_status`, `assessment`, and `next_tasks` values. Each
`next_tasks` item becomes a normal child task of that planner task.

Stable task IDs and append-if-same-definition behavior make planner retries
idempotent. Leases, owner recovery, and completion decisions remain in the
reconciler; planner output never directly marks a job complete.

## Reconciliation rule

Every wake-up means only: "the durable state may have changed." The daemon reloads the PR and task records, derives desired actions, and reconciles actual execution state. It never advances a job solely because an event claimed something happened. Event-driven and periodic reconciles are single-flight within one process; a periodic sweep may create the next autonomous planner task only from durable settled state.

## State

Job states:

OPEN -> RUNNING -> WAITING|BLOCKED -> COMPLETED|FAILED|CANCELLED

Task states:

QUEUED -> READY -> RUNNING -> WAITING|BLOCKED -> SUCCEEDED|FAILED|CANCELLED

A task becomes READY when all declared dependencies have succeeded and any approval gate is satisfied. Autonomous completion additionally requires a durable planner result of `satisfied`, every planner/work task to be `SUCCEEDED`, and no unresolved failure or blocked task.

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
6. Adapter launches/submits the worker; Relay emits `task.process.launched` only after that succeeds.
7. The worker emits its own correlated `task.started` after real work begins. Relay never synthesizes this event.
8. Codex emits `task.process.exited` on synchronous runtime exit; ChatGPT emits `task.process.async_exited` after its submit runtime exits while the remote worker may continue.
9. Worker reports progress and exactly one terminal task event over the canonical event channel.
10. Relay persists terminal task state/result back into the task comment.

Managed Codex and ChatGPT bootstrap prompts carry only the durable PR URL and
task-comment URL, plus the Job/Task IDs and project name. The worker retrieves
the job and task from GitHub using the access available in its environment, so
the stored task input is not duplicated into the launch prompt. GitHub comment
URLs are hydrated onto tasks when the durable graph is reloaded.

The ownership boundary is strict: workers own `task.started` and the exact
terminal task event; Relay owns `task.process.launched` and
`task.process.exited`/`task.process.async_exited`. If a Codex process exits
after `task.started` without a terminal event, Relay waits only a short bounded
grace window and then records an explicit `task.failed` lifecycle-contract
failure (`worker_exit_without_terminal_event`). That safeguard is not a
process event promoted to completion, and it is suppressed when a valid
correlated terminal event has already arrived.
11. Relay reconciles dependents and/or resumes the parent continuation.
12. Periodic watchdog reconciliation only repairs missed wake-ups and expired leases; webhook mode uses targeted reconciliation for the normal path and cached dashboard reads do not trigger broad discovery.

The ChatGPT adapter establishes its event cursor/barrier before submission and accepts only a post-barrier, worker-owned `task.started` for the exact job/task. Its owned Temporary Chat tab uses the configurable `after-start` policy by default; `never` keeps it open for tests/debugging, and `after-terminal` waits for a new, correlated `task.completed`, `task.failed`, `task.blocked`, or `task.cancelled` event before closing it. Stale or wrong-task events never satisfy either barrier. If no start acknowledgement arrives within 60 seconds, Relay closes only the owned tab under `after-start` and records an explicit `worker_start_timeout` start-ack failure; process-exit events remain distinct from task terminal events.

Configure the daemon or CLI service with `--chatgpt-tab-close-policy after-start|never|after-terminal`, or set `AGENTS_RELAY_CHATGPT_TAB_CLOSE_POLICY`. The default is `after-start`.

## Continuations

Continuations are adapters, separate from worker adapters. v1 supports Codex-thread continuation plus a generic command/webhook contract. Hosted web chat continuations may rely on their host integration; their durable state remains recoverable from the PR.

## v1 acceptance criteria

1. A reusable TypeScript package/CLI named `agents-relay`.
2. GitHub PR/comment durable store with job/task marker parsing and updates.
3. CLI to initialize a PR job, submit child tasks, inspect status, reconcile, retry/cancel tasks, and run the daemon.
4. Dependency scheduling and nested parent/child lineage.
5. Worker lease, expiry detection, recovery, retry, timeout, and cancellation semantics.
6. Codex and ChatGPT agent adapters behind one adapter interface; shell commands remain tools used by orchestrators/agents, not managed worker tasks.
7. Routing metadata is mandatory before a model-backed worker can launch.
8. Optional event integration for wake-ups/progress with durable-state reconciliation.
9. Parent continuation interface with Codex-thread continuation implemented.
10. Dashboard web page showing jobs, task tree/state, worker/model, dependencies, results, leases, and live events/status.
11. SSE or equivalent local live dashboard updates.
12. Tests for marker parsing, state transitions, scheduling, reconciliation/recovery, and API/dashboard data.
13. `skills/agents-relay/SKILL.md` plus supporting agent files describing how an agent submits async work, propagates lineage, consumes results, and treats events vs durable state.
14. Documentation and a runnable local dogfood example.
15. Browser-level verification of the dashboard before merge.

## Non-goals for v1

- Reimplement GitHub as a database.
- Build a general workflow-language/DAG editor.
- Require Redis, Postgres, Temporal, or Kubernetes.
- Make NATS mandatory.
- Implement a hosted multi-tenant control plane.
- Encode domain-specific agent roles in the core runtime.
- Build a broad public agent marketplace or unauthenticated remote HTTP API.

## Dogfood

This PR is the first top-level Agents Relay job. Development, review, fixes, and verification remain on this PR until the v1 acceptance criteria are met.


## Shared execution context

`resolveExecutionContext(projectPath, role, options)` is the common discovery boundary for XChat-compatible orchestrators and Relay runtimes. It resolves project instructions, skills, visible agents, and adapter/runtime capabilities from three layers with project-local > Neo shared > global `~/.agents` precedence. The resolver returns concrete paths only for the current execution; GitHub-backed durable task records keep semantic names and routing intent rather than filesystem paths.

Planner, reviewer, normal worker, and nested worker launches consume the same resolved structure. The planner may select its visible `planner` agent definition from that context; the ChatGPT adapter consumes the resolved `chatgpt-browser-worker` skill instead of a Relay-owned duplicate. Leaf workers receive the generic resolved context and do not inherit the full top-level `xchat-orchestrator` responsibilities.

Relay remains the only durable delegation boundary. A nested worker may inspect visible agents and propose sub-work, but execution of that sub-work must be a durable child task with `parentTaskId`; direct arbitrary child-agent spawning is outside the contract. This preserves output contracts, leases/retries, model routing, events-bus lifecycle, and review gates. XChat bootstrap code can consume the same resolver through `agents-relay context resolve --project-path <path> --role orchestrator` (or reuse the underlying module inside the package) rather than maintaining a second discovery algorithm.
