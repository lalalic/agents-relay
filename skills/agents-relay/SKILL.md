---
name: agents-relay
description: Create and operate durable asynchronous agent jobs through GitHub PR state, agent workers, retries, and authoritative lifecycle events.
---

# Agents Relay

Use Agents Relay when an orchestrator needs durable delegated work that survives the current process.

## Core task contract

A managed child task is always a descriptive unit of work. It says what an agent must accomplish; it is never a shell command.

Normal worker tasks use an agent runtime:
- `codex` for a local Codex-compatible agent.
- `chatgpt` for the one-shot Browser ChatGPT worker.

Shell commands, tests, Markad Vision, ffmpeg, build tools, and similar CLIs are tools used inside an agent or directly by the orchestrator. They are not Agents Relay worker tasks.

Every model-backed task must declare:
- its descriptive `input`;
- its adapter (`codex` or `chatgpt`);
- routing metadata;
- exactly one durable output contract:
  - `task_pr`: the managed task/PR is the authoritative result; or
  - `file`: an exact file path is the authoritative result.

## Lifecycle contract

Events are authoritative for model-backed task state.

Agents Relay may launch a Codex process or submit a one-shot ChatGPT browser task, but runtime/process completion is only delivery/runtime evidence. It never means the task completed.

A running agent MUST publish exactly one correlated terminal event before stopping:
- `task.completed` after the declared output is durable;
- `task.failed` when the task cannot complete;
- `task.blocked` when external or human action is required.

The event must carry the exact durable `job_id` and `task_id`. Progress events are optional.

Agents Relay maps those terminal events to durable state:
- `task.completed` → `SUCCEEDED`
- `task.failed` → `FAILED`
- `task.blocked` → `BLOCKED`

A model-backed task must not launch without an event bus. If no terminal event arrives before the task timeout, Relay records an explicit timeout failure. A Codex process exit or ChatGPT submission receipt alone never changes the task to a terminal state.

## Managed GitHub jobs

For repository work, create/adopt/repair the PR-backed job through the Agents Relay CLI. Do not create the managed PR through a parallel raw GitHub path.

Example:

~~~sh
npx agents-relay job create --repo OWNER/REPO --head feat/example --base main   --id JOB_ID --title "Objective"

npx agents-relay submit --repo OWNER/REPO --pr 12 --id JOB_ID   --task-id implement   --adapter codex   --provider openai --model MODEL   --output task-pr   --input "Implement the requested change, validate it, and update the managed task/PR."

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

## ChatGPT worker

The ChatGPT adapter uses the packaged `chatgpt-browser-worker` one-shot path. It opens a fresh Temporary Chat tab, submits the complete task with the account defaults, verifies acceptance, closes the owned tab, and returns a submission receipt.

ChatGPT thread identity is diagnostic only. It is not persisted as a resumable task handle, and Relay does not poll, resume, retrieve a result from, or delete a ChatGPT conversation as part of task lifecycle.

## Autonomous planner

Planner-created child tasks must also be descriptive agent work. They must select `codex` or `chatgpt` and include an explicit output contract. A planner must never generate shell-command worker tasks.

## Durable truth

GitHub PR/job/task markers remain durable workflow state. Events are the authoritative execution-state transition signal for model-backed tasks. Runtime events, process exits, browser submission receipts, and conversation text are evidence only.

Keep secrets, credentials, private prompts, and large private payloads out of durable markers and events.
