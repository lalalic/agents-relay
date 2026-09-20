---
name: chatgpt-browser-worker
description: Submit an isolated one-shot ChatGPT browser worker task through browser-harness with a required durable output destination.
---

# ChatGPT browser worker

Use this skill to hand one self-contained task to ChatGPT through the authenticated
browser session. The caller does not manage ChatGPT threads, model selection,
thinking level, polling, or result retrieval.

## Output contract

Every task handed to this worker MUST declare exactly one durable output mode
before the worker is launched.

### 1. Task / PR output

Use this for repository or managed-task work.

The task prompt must identify the exact managed task/PR that owns the result.
The worker performs the requested work directly against that task/PR and records
its final outcome there.

Output:
task/PR
<exact managed task/PR identity and required final action>

### 2. File output

Use this for research, analysis, reports, or other artifact-producing work.

The task prompt must name the exact file path. That file is the authoritative
result.

Output:
file
<exact file path>

A Browser ChatGPT worker task without one of these output declarations is
invalid and must not be launched. The orchestrator chooses and writes the output
contract when it creates the worker task; the worker must not invent or change
the destination.

Progress and terminal success/failure are always reported through the normal
Neo event contract. Events are execution observability, not a third output mode.

## Runtime behavior

The worker is one-shot. It opens an isolated worker-owned ChatGPT tab, submits
the complete task, verifies that ChatGPT accepted the submission, and applies
the configured tab-close policy. `after-start` waits for the exact
post-submission worker `task.started` acknowledgement, `never` leaves the owned
tab open for debugging, and `after-terminal` waits for a new exact-task
`task.completed`, `task.failed`, `task.blocked`, or `task.cancelled` event.
ChatGPT continues the task independently and publishes the result through the
declared output contract. If the start acknowledgement does not arrive within
60 seconds, close only the owned tab and fail with `worker_start_timeout`.

The worker must never interact through a pre-existing user ChatGPT tab.
Browser details, transient conversation identity, submission verification,
model/default-thinking behavior, and tab cleanup are implementation concerns of
the worker and are not part of the caller-facing contract.

The runtime entry point is the browser-worker agent. Callers launch that agent
with the complete task prompt and declared output; they do not call helper
scripts directly.
