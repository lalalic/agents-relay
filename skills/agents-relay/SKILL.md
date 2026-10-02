---
name: agents-relay
description: Create and operate durable asynchronous agent jobs through GitHub PR state, agent workers, retries, and authoritative lifecycle events.
---

# Agents Relay

Use Agents Relay when an orchestrator needs durable delegated work that survives the current process.

## Required shared contract

Before creating, planning, reviewing, or managing a job/task, read and follow `contracts/task-job-contract.md`. This is the canonical producer/runtime protocol for story size, lifecycle events, review, and auto-merge.

## Core task contract

A managed child task is always a descriptive unit of work. It says what an agent must accomplish; it is never a shell command.

Normal worker tasks use an agent runtime:
- `codex` for a local Codex-compatible agent.
- `chatgpt` for the one-shot Browser ChatGPT worker.

Shell commands, tests, Markad Vision, ffmpeg, build tools, and similar CLIs are tools used inside an agent or directly by the orchestrator. They are not Agents Relay worker tasks.

Every model-backed task producer normally declares:
- its descriptive `input`;
- semantic requirements such as capabilities/runtime only when known;
- exactly one durable output contract:
  - `task_pr`: the managed task/PR is the authoritative result; or
  - `file`: an exact file path is the authoritative result.

Relay then runs one Execution Router decision over complete worker+model routes and persists the selected worker/adapter and model routing before launch. Explicit adapter/provider/model values are compatibility/debug constraints, not normal producer requirements.

## Lifecycle contract

Events are authoritative for model-backed task state.

Agents Relay may launch a Codex process or submit a one-shot ChatGPT browser task, but runtime/process completion is only delivery/runtime evidence. It never means the task completed.

A running agent MUST use the canonical Neo `events-bus` protocol and publish exactly one correlated terminal event before stopping:
- `task.completed` after the declared output is durable;
- `task.failed` when the task cannot complete;
- `task.blocked` when external or human action is required.

Event publishing is not an Agents Relay CLI responsibility. Sandboxed Codex and hosted ChatGPT workers use the federated `events__publish` MCP tool from `events-bus`; direct non-sandbox local workers may use the caller-provided `NEO_EVENTS_EMIT`. Agents Relay subscribes to the canonical `neo.events.job.<job_id>.>` stream and maps terminal events into durable task state. Relay resolves its native NATS endpoint and subject prefix from the canonical events-bus runtime configuration (with explicit Relay CLI flags remaining authoritative). The same runtime configuration supplies the events-bus HTTP API used for replay/history. Relay and its dashboard must not read the events-bus private history file or maintain a second event-history backend.

The event must carry the exact durable `job_id` and `task_id`. Progress events are optional.

Agents Relay maps those terminal events to durable state:
- `task.completed` → `SUCCEEDED`
- `task.failed` → `FAILED`
- `task.blocked` → `BLOCKED`

A model-backed task must not launch without an event bus. If no terminal event arrives before the task timeout, Relay records an explicit timeout failure. A Codex process exit or ChatGPT submission receipt alone never changes the task to a terminal state.

Worker process exit is observational only. Relay does not perform an exit-time terminal check or synthesize task failure from process exit; semantic terminal state comes from the worker event contract or the normal task timeout.

## Managed GitHub jobs

For repository work, create/adopt/repair the PR-backed job through the Agents Relay CLI. Do not create the managed PR through a parallel raw GitHub path.

Example:

~~~sh
npx agents-relay job create --repo OWNER/REPO --head feat/example --base main   --id JOB_ID --title "Objective"

npx agents-relay task create --repo OWNER/REPO --pr 12 --id JOB_ID   --task-id implement   --output task-pr   --input "Implement the requested change, validate it, and update the managed task/PR."

npx agents-relayd --repo OWNER/REPO --events nats
~~~

Use `--output file --output-path PATH` when the authoritative result is a file.

## Worker prompt

For Codex and ChatGPT workers, Agents Relay adds only durable execution identity and contracts around the stored descriptive task input:
- PR URL
- job ID
- task ID
- parent task ID
- project name
- declared output
- mandatory terminal-event contract

The job/task descriptions remain the durable source of intent. Adapters do not invent task meaning.

## Shared execution context

Before planner, reviewer, normal worker, or nested-worker execution, resolve one execution context from the bound project path. The shared resolver owns project instructions, skills, visible agents, and runtime capabilities with project-local > Neo shared > global `~/.agents` precedence. Concrete paths are execution-time data and must not be persisted into durable task records.

Leaf workers consume the resolved instruction/skill/agent paths, not the full top-level XChat orchestrator contract. Nested workers may inspect visible agents, but any delegation must be represented as an Agents Relay durable child task preserving `parentTaskId`, output contract, routing, leases/retries, events, and review gates.

## ChatGPT worker

The ChatGPT adapter uses Relay's `chatgpt-worker` agent contract and Browser Workspace ChatGPT platform; it does not depend on a Neo worker skill. It opens a fresh Temporary Chat tab, submits the complete task with the account defaults, verifies acceptance, applies the configured `after-start` (default), `never`, or `after-terminal` owned-tab close policy, and returns a submission receipt.

ChatGPT thread identity is diagnostic only. It is not persisted as a resumable task handle, and Relay does not poll, resume, retrieve a result from, or delete a ChatGPT conversation as part of task lifecycle.

## Autonomous planner

Direct orchestrator-created Tasks do not require a Plan. The orchestrator may create the initial batch with `task create`; those Tasks remain top-level unless the orchestrator explicitly gives them normal task parentage. When planner-driven decomposition is desired instead, use `agents-relay plan --repo OWNER/REPO --pr N --id JOB_ID [--prompt TEXT | --prompt-file PATH|-]`.

For explicit `plan` and autonomous continuation, Relay invokes the same planner agent as a pure decision function. The planner receives durable Job/Task state, previous planner rounds, and resolved execution context, then returns structured `{ objective_status, assessment, next_tasks }` output. The planner does not call Relay CLI and does not persist Tasks itself.

Each successful planner invocation is one real `plan-N` planning round. Relay persists that planner result, then creates returned work Tasks with provenance back to that planning round. `parentTaskId` expresses semantic ownership among work Tasks; it is not inherited from the Plan and must never point to a `plan-N` record. `dependencies` independently express execution prerequisites. Historical `planner-N` records remain readable. Only planner execution creates planner rounds; Relay never manufactures synthetic `plan-*` records for direct Task creation. In the dashboard, planner rounds remain provenance/grouping metadata, not semantic parents.

A zero-task autonomous Job remains idle. After a direct orchestrator-created initial batch completes, Relay may start the first real planner round. Fixed Jobs do not automatically create planner rounds.

Planner-created child Tasks remain descriptive agent work and must include the output contract and `storySize`; worker requirements are optional soft routing facts unless an explicit runtime constraint is known. Execution Router chooses the complete runtime route afterward.

## Durable truth

GitHub PR/job/task markers remain durable workflow state. Events are the authoritative execution-state transition signal for model-backed tasks. Runtime events, process exits, browser submission receipts, and conversation text are evidence only.

Keep secrets, credentials, private prompts, and large private payloads out of durable markers and events.

### Automatic task troubleshooting

When an ACTIVE Job contains a current-run `FAILED` task, reconciliation may create one P0-priority `troubleshooter` recovery task for that exact failed attempt. `BLOCKED` is resolved only through authoritative unblock, which records evidence and transitions the Task to `UNBLOCKED`. The recovery task is routed to a local Codex-capable worker with repository/tool access and runs under the bundled Troubleshooter agent contract. Autonomous `UNBLOCKED` Tasks are historical and feed the next Planner round instead of being retried or sent through Troubleshooter. Each Planner round is durably represented by an `agents-relay:plan:v1` PR comment created before generated Task comments and updated in place with its assessment and generated Task IDs. Troubleshooter diagnosis is event-first: it must inspect the failed task's task-scoped lifecycle event history (including ordering, duplicate/missing/late events, source and phase data) before classifying root cause or retrying.

The Troubleshooter diagnoses before retrying. A task-local or transient blocker is repaired narrowly; a shared worker/runtime/tool defect is repaired through the owning repository's P0/self-job workflow. Only after the blocker is removed does it retry the original task and verify durable progress. Historical failures from older scheduled autonomous runs do not spawn recovery work, and deterministic reconciliation does not duplicate a Troubleshooter task for the same failed attempt.
