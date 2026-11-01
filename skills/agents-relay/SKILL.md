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

For content-generation objectives, read the active Neo Project `AGENTS.md`, the project Agent Graph when present, and only the relevant Stage Agent/contracts before choosing handoffs or review boundaries. Do not assume a universal stage order or load every project document. The shared Task/Job Contract remains authoritative for durable Tasks.

## Execution-scoped Job and Task loading

The assigned Prompt identifies the current execution, not the Task body. Read the
Task or Plan through the version-matched Relay CLI on Neo Master before doing work. **Do not use an unrelated global `agents-relay`
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

Both context commands reject stale or inactive execution identities. Do not
circumvent them with `job show`, GitHub/PR data, or guessed Task input. Optional
`--repo` constrains the requested Job identity. The Planner uses the returned `apply_cli` (bound to the same installed
Relay package), verifies the Plan apply receipt, and does not invent task contents. Publish required Task events
for actual Tasks according to the separate event contract. A Plan follows its
existing Plan lifecycle rather than inventing task.started or task.completed.

## Core task contract

A managed child task is always a descriptive unit of work. It says what an agent must accomplish; it is never a shell command.

Relay selects a compatible worker runtime for each Task:
- `codex` for local Codex-compatible work;
- `chatgpt` for interactive Browser ChatGPT work;
- `z` for supported Z Web work.
A valid Prompt is not proof the runtime can fulfill every capability requirement.

Shell commands, tests, Markad Vision, ffmpeg, build tools, and similar CLIs are tools used inside an agent or directly by the orchestrator. They are not Agents Relay worker tasks.

Every model-backed task producer normally declares:
- its descriptive `input`;
- semantic requirements such as capabilities/runtime only when known;
- exactly one durable output contract:
  - `task_pr`: the managed task/PR is the authoritative result; or
  - `file`: an exact file path is the authoritative result.

Relay selects the worker and model. Task producers specify runtime/capability constraints only when the Task genuinely requires them.

## Lifecycle contract

Use the Relay CLI to read authoritative Task/Job status and invoke Relay operations. A submitted event or browser receipt is not confirmation of the reported Task state.

Agents Relay may launch a Codex process or submit a one-shot ChatGPT browser task, but runtime/process completion is only delivery/runtime evidence. It never means the task completed.

A running agent MUST use the canonical Neo `events-bus` protocol and publish exactly one correlated terminal event before stopping:
- `task.completed` after the declared output is durable;
- `task.failed` when the task cannot complete;
- Progress is optional; `task.blocked` and `task.unblocked` are Relay-owned lifecycle facts, never agent terminal events.

The only non-CLI lifecycle signal an executing Task agent publishes is its
required `task.started`, optional `task.progress`, and one terminal event
through the separately documented Neo `events-bus` protocol. Use the
federated `events__publish` MCP tool where provided (or the explicit
`NEO_EVENTS_EMIT` capability for authorized local workers). For Relay status,
history, recovery and changes, use the version-matched Relay CLI; never
read internal files, event storage, or service APIs directly.

The event must carry the exact durable `job_id` and `task_id`. Progress events are optional.

Agents Relay maps those terminal events to durable state:
- `task.completed` → `SUCCEEDED`
- `task.failed` → `FAILED`
Relay may authoritatively move a Task to `BLOCKED` for an external condition and may resume it only through an authorized unblock operation. A human response is an append-only Task Comment and resumes the blocked Troubleshooter, not the failed original Task. Task input remains stable; recovery agents receive current authoritative state and relevant comments as execution context.

A model-backed task must not launch without an event bus. If no accepted `task.started` or newer current-execution `task.progress` arrives within `Task.timeoutMs`, Relay records an inactivity timeout failure. A Codex process exit or ChatGPT submission receipt alone never changes the task to a terminal state.

A worker process exit is not a Task result. Verify the actual Task status through Relay CLI.

## Managed GitHub jobs

For repository work, create/adopt/repair the PR-backed job through the Agents Relay CLI. Do not create the managed PR through a parallel raw GitHub path.

Example:

~~~sh
node <matching-absolute-dist/cli.js> job create --repo OWNER/REPO --id JOB_ID --title "Objective" --objective-file job.md --initial-plan

node <matching-absolute-dist/cli.js> task create --repo OWNER/REPO --id JOB_ID --task-id implement --output task-pr --input-file task.md

~~~

Use `--output file --output-path PATH` when the authoritative result is a file.

## Worker prompt

The assigned execution Prompt and the read-only `agents-relay prompt` CLI
share the same five-section format:

- **Role:** selected Agent identity and immutable cached merged Agent path;
- **Bootstrap:** adapter-specific initialization without copying global rules;
- **Contracts:** independently listed shared contract paths, in order;
- **Contexts:** only adapter-required project instructions; global rules belong to Bootstrap;
- **Task:** this skill's path, Job ID, Task/Plan ID and Execution ID.

No Task body, PR URL, copied Agent catalog, merged Contracts or merged Contexts.
The exact work objective, output and acceptance are retrieved with the
execution-bound Relay CLI context command above. Adapters must preserve the
assigned Prompt without rewriting its authoritative references.

## Shared execution context

Follow the selected Role, independent Contracts, and task-specific Contexts
listed in the assigned Prompt. Discover additional Skills only when the Task
requires them; do not load the complete Agent or Skill catalog.

Delegation, if authorized, uses the matching Relay CLI to create a durable child
Task with the declared parent, output, dependencies and acceptance conditions.

## ChatGPT worker

Use the assigned ChatGPT Prompt and Neo MCP tools. A browser submission receipt
is delivery evidence, not proof of Task completion. Read status through Relay CLI
and publish Task events only as required by the Event Contract.

## Objective-driven Planner

Direct orchestrator-created Tasks do not require a Plan. The orchestrator may create the initial batch with `task create`; those Tasks remain top-level unless the orchestrator explicitly gives them normal task parentage. When planner-driven decomposition is desired instead, use `agents-relay plan --repo OWNER/REPO --pr N --id JOB_ID [--prompt TEXT | --prompt-file PATH|-]`.

For explicit `plan` and continuation, the Planner reads its execution-bound
`plan context` from the matching CLI, prepares
`{ objective_status, assessment, next_tasks }`, then invokes the returned
`apply_cli`. Only the exact `PLAN_APPLIED:<plan-id>:<execution-id>` receipt
confirms that the Plan was accepted.

Each successful planner invocation is one real `plan-N` planning round. Relay persists that planner result, then creates returned work Tasks with provenance back to that planning round. `parentTaskId` expresses semantic ownership among work Tasks; it is not inherited from the Plan and must never point to a `plan-N` record. `dependencies` independently express execution prerequisites. Historical `planner-N` records remain readable. Only planner execution creates planner rounds; Relay never manufactures synthetic `plan-*` records for direct Task creation. In the dashboard, planner rounds remain provenance/grouping metadata, not semantic parents.

A zero-task DRAFT Job remains idle until explicit first planning or direct Task creation. After initial work settles, every Job automatically replans until the latest successful Plan is `satisfied`; there is no fixed/autonomous mode or Job scheduler.

Planner-created child Tasks remain descriptive agent work and must include the output contract and `storySize`; worker requirements are optional soft routing facts unless an explicit runtime constraint is known. Execution Router chooses the complete runtime route afterward.

## Durable truth

The version-matched Relay CLI is the authoritative interface for Job, Task,
Plan, Review, recovery and delivery state. Do not read or modify Relay
implementation storage, GitHub markers, or private service endpoints. Events,
process exits, browser submissions and conversation text are not themselves
Task completion proof.

Keep secrets, credentials, private prompts, and large private payloads out of durable markers and events.

### Automatic task troubleshooting

When Relay reports a failed Task with a Troubleshooter assignment, obtain the
execution-bound Task Context and `task events --id JOB --task-id TASK` history through the matching CLI.
Diagnose before retrying. Repair task-local causes narrowly; use the owning
P0/self-job workflow for shared defects. For a genuine human blocker, request
escalation through Relay CLI. Only the blocked Troubleshooter can be resumed
through authorized unblock; it must recheck the condition before requesting
recovery of the original Task. Confirm reported state through Relay CLI.

## Persistent service bootstrap

This Skill owns `agents-relay/daemon`, `agents-relay/dashboard-tunnel`. The `daemon-service-manage` Skill is required. Run `node skills/agents-relay/bin/services.mjs setup` for idempotent registration through `serviceman`; run `status` to inspect or `doctor` to fail if a service is not online. Existing process configuration is preserved. Do not create unqualified legacy PM2 names.
