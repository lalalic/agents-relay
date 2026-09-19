---
name: agents-relay
description: Create and operate durable asynchronous agent jobs through GitHub PR state, worker adapters, continuations, retries, and live progress events. Use when an orchestrator needs work to survive the current thread/process or delegate recoverable child tasks.
---

# Agents Relay

Use Agents Relay for asynchronous work that must survive the current agent process. Create one durable top-level job per objective and submit child tasks with unique IDs, explicit parentTaskId, dependencies, capabilities, adapter, timeout, and retry policy. A model-backed task must carry a recorded routing decision (provider, model, optional profile/reasoning/cwd/projectId) before it can launch. Use adapter codex for local Codex-compatible workers and adapter chatgpt for a ChatGPT web worker created through MacBridge.

GitHub PR comments are durable truth in operational mode. Reload the PR after every event or wake-up and reconcile desired durable state into worker executions; events and NATS are only low-latency notifications and must never be treated as completion.

## Managed GitHub bootstrap

For new GitHub-backed work, do not create the PR or job marker with raw gh commands. Use the first-class CLI:

~~~sh
agents-relay job create --repo OWNER/REPO --head feat/example --base main \
  --id JOB_ID --title "Objective" --body "PR description"
~~~

job create resolves an existing open PR with the same head/base before creating one, then persists exactly one trusted agents-relay:job:v1 marker. Re-running the command is idempotent.

To bring an existing unmanaged PR under Agents Relay, even when it has zero comments:

~~~sh
agents-relay job adopt --repo OWNER/REPO --pr 6 --id JOB_ID --title "Objective"
~~~

To repair duplicate markers for that same job:

~~~sh
agents-relay job repair --repo OWNER/REPO --pr 6 --id JOB_ID
~~~

A PR carrying a marker for a different job is rejected rather than silently reassigned. Managed task commands must not run until the durable job marker exists; submit/status/reconcile/retry/cancel/serve fail clearly when it is absent.

The legacy init flow remains supported for compatibility, but orchestrators should prefer job create/adopt/repair for GitHub-backed work.

Typical managed flow:

~~~sh
agents-relay job create --repo OWNER/REPO --head feat/example --id JOB_ID --title "Objective"
agents-relay submit --repo OWNER/REPO --pr 12 --id JOB_ID --task-id child --input "echo work" --adapter shell
agents-relay reconcile --repo OWNER/REPO --pr 12 --id JOB_ID
agents-relay status --repo OWNER/REPO --pr 12 --id JOB_ID
agents-relay serve --repo OWNER/REPO --pr 12 --id JOB_ID
~~~

Use --file PATH only for explicit local demo/test mode. Optional --events nats enables wake/progress events with --subject-prefix; the PR remains authoritative.

Use task-level continuation when the sender needs to resume, otherwise the job continuation. Continuation delivery is deduplicated by the durable delivery timestamp. Treat BLOCKED as an approval/manual-release state until an explicit retry/release changes it. Cancellation, timeout, and lease expiry are durable state transitions; do not claim success from a worker process exit alone.

For a ChatGPT worker, use the chatgpt adapter with capabilities model,chatgpt,macbridge. The runtime calls MacBridge's loopback-only ChatGPT conversation endpoint, stores the returned conversation_id as the durable task threadId, and reuses that ID on retry. Pass --chatgpt-project when the worker must run inside one exact ChatGPT Project. MacBridge URL/token overrides are --macbridge-url and --macbridge-token-file; never place the bearer token in job/task markers.

Managed Codex and ChatGPT worker prompts are enriched at launch with the PR URL and durable job/task/parent/project identity; do not duplicate that context manually in task input. Keep one ChatGPT conversation per logical task. Retries reuse the same task conversation, but sibling tasks use separate conversations even when their adapter is the same.

When a job becomes COMPLETED or its GitHub PR is merged, delete all ChatGPT task conversations. Preserve threadId in durable markers, record threadDeletedAt on success, and record/retry threadCleanupError on deletion failure without reopening the job.

V1 runs with one active runner per job; do not start multiple reconcilers without adding an atomic distributed lease. Keep secrets, credentials, private prompts, and large private payloads out of PR markers—store summaries and artifact references only. Event transport failures are degraded observability, not durable task failures.

Registered agents are result-owning roles with responsibility boundaries; skills are callable capabilities and adapters are execution runtimes. Register agents with `agent-register`, discover them with hard filters using `agent-discover`, and treat claimed capabilities separately from observed evaluations/outcomes. Discovery returns explainable evidence and permits exploration; it does not produce a universal trust score. The future constrained remote surface should authenticate `POST /jobs` and `GET /jobs/:id` only, with public/intention-only jobs separated from private-data or credential work.
