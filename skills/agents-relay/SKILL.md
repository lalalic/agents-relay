---
name: agents-relay
description: Use when work needs durable, multi-agent orchestration across turns or processes - plan and execute Jobs/Tasks, coordinate dependencies and reviews, recover failures, and track authoritative lifecycle events. Also use for content-generation workflows (research, story, production, human review, publication) that need explicit agent roles and handoff boundaries. Not for simple one-shot tasks with no durable coordination.
requires:
  skills:
    - daemon-service-manage
---

# Agents Relay

Use Agents Relay when an orchestrator needs durable delegated work that survives the current process.

## Required shared contract

For unified agent terminal events and role-specific results, see `contracts/event-contract.md` and `contracts/task-recovery-flows.md`.

Before creating, planning, reviewing, or managing a job/task, read and follow `contracts/task-job-contract.md`. This is the canonical producer/runtime protocol for story size, lifecycle events, review, and auto-merge.

## Content-generation workflow

For content-generation objectives, read `workflows/content-generation.md` before choosing agents, review boundaries, or durable Tasks. This workflow is a planning guide; the shared task/job contract remains authoritative.

## Execution-scoped Job and Task loading

The Graph-selected Prompt Action passes an execution identity, **not** Task
prose or a GitHub/PR URL. Read the Task or Plan through the Relay CLI on Neo
Master before doing work. **Do not use an unrelated global `agents-relay`
executable.** The Prompt identifies this exact installed Skill by absolute
path and hash. Resolve the matching CLI as `../../dist/cli.js` relative to
this Skill's directory and run `node <matching-absolute-dist/cli.js>`.
This preserves version identity for local Codex and hosted Neo MCP workers.
For a normal Worker, Reviewer or Troubleshooter:

```sh
node <matching-absolute-dist/cli.js> task context --id JOB --task-id TASK --execution-id EXECUTION
```

For a Planner (the Prompt names a Plan in its `Task:` field):

```sh
node <matching-absolute-dist/cli.js> plan context --id JOB --plan-id PLAN --execution-id EXECUTION
```

Both operations read the SQLite-authoritative context and reject stale or
inactive execution bindings; do not use `job show`, GitHub, or guessed input as a
fallback to evade this check. Optional `--repo` further fences the immutable SQLite Job identity.
No GitHub fetch or Relay HTTP service is needed for either read-only command. The Planner uses the returned `apply_cli` (bound to the same installed
Relay package), verifies the Plan apply receipt, and does not invent task contents. Publish required Task events
for actual Tasks according to the separate event contract. A Plan follows its
existing Plan lifecycle rather than inventing task.started or task.completed.

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

Accepted, execution-correlated Task events drive Relay transitions; SQLite remains the durable lifecycle authority.

Agents Relay may launch a Codex process or submit a one-shot ChatGPT browser task, but runtime/process completion is only delivery/runtime evidence. It never means the task completed.

A running agent MUST use the canonical Neo `events-bus` protocol and publish exactly one correlated terminal event before stopping:
- `task.completed` after the declared output is durable;
- `task.failed` when the task cannot complete;
- Progress is optional; `task.blocked` and `task.unblocked` are Relay-owned lifecycle facts, never agent terminal events.

Event publishing is not an Agents Relay CLI responsibility. Sandboxed Codex and hosted ChatGPT workers use the federated `events__publish` MCP tool from `events-bus`; direct non-sandbox local workers may use the caller-provided `NEO_EVENTS_EMIT`. Agents Relay subscribes to the canonical `neo.events.job.<job_id>.>` stream and maps terminal events into durable task state. Relay resolves its native NATS endpoint and subject prefix from the canonical events-bus runtime configuration (with explicit Relay CLI flags remaining authoritative). The same runtime configuration supplies the events-bus HTTP API used for replay/history. Relay and its dashboard must not read the events-bus private history file or maintain a second event-history backend.

The event must carry the exact durable `job_id` and `task_id`. Progress events are optional.

Agents Relay maps those terminal events to durable state:
- `task.completed` → `SUCCEEDED`
- `task.failed` → `FAILED`
Relay may authoritatively move a Task to `BLOCKED` for an external condition and may resume it only through an authorized unblock operation. A human response is an append-only Task Comment and resumes the blocked Troubleshooter, not the failed original Task. Task input remains stable; recovery agents receive current authoritative state and relevant comments as execution context.

A model-backed task must not launch without an event bus. If no accepted `task.started` or newer current-execution `task.progress` arrives within `Task.timeoutMs`, Relay records an inactivity timeout failure. A Codex process exit or ChatGPT submission receipt alone never changes the task to a terminal state.

Worker process exit is observational only. Relay does not perform an exit-time terminal check or synthesize task failure from process exit; for synchronous workers it caps the remaining inactivity wait at the shorter post-exit terminal grace.

## Managed GitHub jobs

For repository work, create/adopt/repair the PR-backed job through the Agents Relay CLI. Do not create the managed PR through a parallel raw GitHub path.

Example:

~~~sh
npx agents-relay job create --repo OWNER/REPO --id JOB_ID --title "Objective" --objective-file job.md --initial-plan

npx agents-relay task create --repo OWNER/REPO --pr 12 --id JOB_ID   --task-id implement   --output task-pr   --input "Implement the requested change, validate it, and update the managed task/PR."

npx agents-relayd --repo OWNER/REPO --events nats
~~~

Use `--output file --output-path PATH` when the authoritative result is a file.

## Worker prompt

The canonical Task lifecycle Graph selects `effect.launchTask`; its Action
gets the exact same five-section Prompt from `buildRelayWorkPrompt()` as the
read-only `agents-relay prompt` CLI. A Planner uses the same Prompt Action
through the planner-orchestration Graph. It includes only:

- **Role:** selected Agent identity and immutable cached merged Agent path;
- **Bootstrap:** adapter-specific initialization without copying global rules;
- **Contracts:** independently listed shared contract paths, in order;
- **Contexts:** only adapter-required project instructions; global rules belong to Bootstrap;
- **Task:** this skill's path, Job ID, Task/Plan ID and Execution ID.

No Task body, PR URL, copied Agent catalog, merged Contracts or merged Contexts.
The exact work objective, output and acceptance are retrieved with the
execution-bound SQLite Context Action above. A new Adapter must transport the
Graph Action Prompt unchanged; bootstrap and authentication are platform-owned.

## Shared execution context

Before planner, reviewer, normal worker, or nested-worker execution, resolve one execution context from the bound project path. The shared resolver owns project instructions, skills, visible agents, and runtime capabilities with project-local > Neo shared > global `~/.agents` precedence. Concrete paths are execution-time data and must not be persisted into durable task records.

Leaf workers consume the resolved instruction/skill/agent paths, not the full top-level XChat orchestrator contract. Nested workers may inspect visible agents, but any delegation must be represented as an Agents Relay durable child task preserving `parentTaskId`, output contract, routing, leases/retries, events, and review gates.

## ChatGPT worker

The ChatGPT adapter uses Relay's `chatgpt-worker` agent contract and Browser Workspace ChatGPT platform; it does not depend on a Neo worker skill. It opens a fresh regular ChatGPT thread so the worker can use Neo MCP, submits the task with the account defaults, verifies the durable thread ID and submission receipt, and closes its caller-owned WebHelm Session after submission. File inputs are passed as explicit local paths for Neo MCP reading, not browser uploads.

ChatGPT thread identity is diagnostic only. It is not persisted as a resumable task handle, and Relay does not poll, resume, retrieve a result from, or delete a ChatGPT conversation as part of task lifecycle.

## Objective-driven Planner

Direct orchestrator-created Tasks do not require a Plan. The orchestrator may create the initial batch with `task create`; those Tasks remain top-level unless the orchestrator explicitly gives them normal task parentage. When planner-driven decomposition is desired instead, use `agents-relay plan --repo OWNER/REPO --pr N --id JOB_ID [--prompt TEXT | --prompt-file PATH|-]`.

For explicit `plan` and automatic continuation, Relay invokes the selected Planner Agent. It reads execution-bound Plan Context through the CLI, builds a structured `{ objective_status, assessment, next_tasks }` candidate and commits that candidate only through `agents-relay plan apply`. The exact `PLAN_APPLIED:<plan-id>:<execution-id>` receipt is mandatory. It never mutates SQLite directly.

Each successful planner invocation is one real `plan-N` planning round. Relay persists that planner result, then creates returned work Tasks with provenance back to that planning round. `parentTaskId` expresses semantic ownership among work Tasks; it is not inherited from the Plan and must never point to a `plan-N` record. `dependencies` independently express execution prerequisites. Historical `planner-N` records remain readable. Only planner execution creates planner rounds; Relay never manufactures synthetic `plan-*` records for direct Task creation. In the dashboard, planner rounds remain provenance/grouping metadata, not semantic parents.

A zero-task DRAFT Job remains idle until explicit first planning or direct Task creation. After initial work settles, every Job automatically replans until the latest successful Plan is `satisfied`; there is no fixed/autonomous mode or Job scheduler.

Planner-created child Tasks remain descriptive agent work and must include the output contract and `storySize`; worker requirements are optional soft routing facts unless an explicit runtime constraint is known. Execution Router chooses the complete runtime route afterward.

## Durable truth

SQLite is the sole local durable lifecycle authority. GitHub PR/Job/Task markers are collaboration projections. Correlated model-worker events are inputs to Graph-selected, SQLite-committed transitions; runtime events, process exits, browser receipts, and conversation text are not themselves completion proof.

Keep secrets, credentials, private prompts, and large private payloads out of durable markers and events.

### Automatic task troubleshooting

When an ACTIVE Job contains a current-run `FAILED` task, reconciliation may create one P0-priority `troubleshooter` recovery task for that exact failed attempt. `BLOCKED` is resolved only through authoritative unblock, which records evidence and transitions the Task to `UNBLOCKED`. The recovery task is routed to a local Codex-capable worker with repository/tool access and runs under the bundled Troubleshooter agent contract. Historical ordinary unblock evidence is Planner recovery context; only an effectively blocked Troubleshooter can be authoritatively resumed. Each Planner round is durably represented by an `agents-relay:plan:v1` PR comment created before generated Task comments and updated in place with its assessment and generated Task IDs. Troubleshooter diagnosis is event-first: it must inspect the failed task's task-scoped lifecycle event history (including ordering, duplicate/missing/late events, source and phase data) before classifying root cause or retrying.

The Troubleshooter diagnoses before retrying. A task-local or transient blocker is repaired narrowly; a shared worker/runtime/tool defect is repaired through the owning repository's P0/self-job workflow. Only after the blocker is removed does it retry the original task and verify durable progress. Historical resolved failures do not spawn duplicate recovery work, and deterministic reconciliation does not duplicate a Troubleshooter task for the same failed attempt.

## Persistent service bootstrap

This Skill owns `agents-relay/daemon`, `agents-relay/dashboard-tunnel`. The `daemon-service-manage` Skill is required. Run `node skills/agents-relay/bin/services.mjs setup` for idempotent registration through `serviceman`; run `status` to inspect or `doctor` to fail if a service is not online. Existing process configuration is preserved. Do not create unqualified legacy PM2 names.
