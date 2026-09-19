# Running the service

`agents-relayd` starts the event-driven reconciler and periodic full-reconciliation watchdog for one durable job. It listens on `127.0.0.1:8787` by default, performs a full durable PR/job sweep every hour, and refreshes the dashboard every 15 seconds. Events remain optional wakeups; each sweep re-reads GitHub PR markers/state and applies the same lease, retry, dependency, parent-continuation, terminal-PR, and ChatGPT-cleanup semantics as an event-driven reconcile. NATS remains optional; enable it with `--events nats` and configure it with `--nats-url` and `--subject-prefix`.

The dashboard reads a bounded window (one day by default, or `--usage-window-days`) of local Codex JSONL session telemetry at `/api/usage`. Requests recorded with GLM models are shown as Z.ai runtime usage; account quota and remaining balance are marked unavailable unless a supported source is added.

```sh
npx agents-relayd --repo OWNER/REPO --pr 1 --id JOB_ID
```

Use service overrides as needed:

```sh
npx agents-relayd --repo OWNER/REPO --pr 1 --id JOB_ID \
  --owner runner-a --port 8787 --interval 3600000 --refresh-ms 15000 \
  --events nats --nats-url nats://127.0.0.1:4222
```

For an installed package, launch through the package binary rather than a checkout path:

```sh
npx --package agents-relay agents-relayd --repo OWNER/REPO --pr 1 --id JOB_ID
```

With PM2:

```sh
npx --package agents-relay --package pm2 pm2 start agents-relayd --name agents-relay-job-1 -- \
  --repo OWNER/REPO --pr 1 --id JOB_ID \
  --events nats --nats-url nats://127.0.0.1:4222
```

PM2 forwards `SIGINT` and `SIGTERM`. The service clears its watchdog, unsubscribes from wake events, closes the local dashboard server, and exits only after cleanup.
