---
name: agents-relay
description: Create and operate durable asynchronous agent jobs through GitHub PR state, worker adapters, continuations, retries, and live progress events. Use when an orchestrator needs work to survive the current thread/process or delegate recoverable child tasks.
---

# Agents Relay

Use Agents Relay for asynchronous work that must survive the current agent process. Create one durable top-level job per objective and submit child tasks with unique IDs, explicit `parentTaskId`, dependencies, capabilities, adapter, timeout, and retry policy. A model-backed task must carry a recorded routing decision (provider, model, optional profile/reasoning/cwd/projectId) before it can launch. Use adapter `codex` for local Codex-compatible workers and adapter `chatgpt` for a ChatGPT web worker created through MacBridge.

GitHub PR comments are durable truth in operational mode. Reload the PR after every event or wake-up and reconcile desired state; events and NATS are only low-latency notifications and must never be treated as completion. Read task results from their marker comments, propagate lineage when delegating, and use artifact references for large outputs.

Use task-level continuation when the sender needs to resume, otherwise the job continuation. Continuation delivery is deduplicated by the durable delivery timestamp. Treat `BLOCKED` as an approval/manual-release state until an explicit retry/release changes it. Cancellation, timeout, and lease expiry are durable state transitions; do not claim success from a worker process exit alone.

Typical CLI flow:

```sh
agents-relay init --repo OWNER/REPO --pr 1 --id JOB_ID --title "Objective"
agents-relay submit --repo OWNER/REPO --pr 1 --id JOB_ID --task-id child --input "echo work" --adapter shell
agents-relay reconcile --repo OWNER/REPO --pr 1 --id JOB_ID
agents-relay status --repo OWNER/REPO --pr 1 --id JOB_ID
agents-relay serve --repo OWNER/REPO --pr 1 --id JOB_ID
```

Use `--file PATH` only for explicit local demo/test mode. Optional `--events nats` enables wake/progress events with `--subject-prefix`; the PR remains authoritative.

For a ChatGPT worker, use the `chatgpt` adapter with capabilities `model,chatgpt,macbridge`. The runtime calls MacBridge's loopback-only ChatGPT conversation endpoint, stores the returned `conversation_id` as the durable task `threadId`, and reuses that ID on retry. Pass `--chatgpt-project` when the worker must run inside one exact ChatGPT Project. MacBridge URL/token overrides are `--macbridge-url` and `--macbridge-token-file`; never place the bearer token in job/task markers.

```sh
agents-relay submit --repo OWNER/REPO --pr 5 --id JOB_ID --task-id chatgpt-research \
  --adapter chatgpt --capabilities model,chatgpt,macbridge \
  --provider openai --model gpt-5-6-pro --reasoning high \
  --chatgpt-project g-p-EXACT_PROJECT_ID --input "Research this task and return the result."
```

V1 runs with one active runner per job; do not start multiple reconcilers without adding an atomic distributed lease. Keep secrets, credentials, private prompts, and large private payloads out of PR markers—store summaries and artifact references only. Event transport failures are degraded observability, not durable task failures.
