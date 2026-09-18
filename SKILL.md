# Agents Relay

Use Agents Relay for asynchronous work that must survive the current agent process. Create one durable top-level job per objective and submit child tasks with unique IDs, explicit `parentTaskId`, dependencies, capabilities, adapter, timeout, and retry policy. A model-backed task must carry a recorded routing decision (provider, model, optional profile/reasoning/cwd) before it can launch.

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
