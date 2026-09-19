# Running the service

`agents-relayd` starts the repository worker pool, event-driven reconciler, periodic recovery watchdog, and dashboard. It listens on `127.0.0.1:8787` by default, performs a full durable PR/job reconciliation sweep every hour, and refreshes GitHub-backed dashboard state every 5 minutes to remain rate-limit safe. NATS and GitHub webhooks remain optional low-latency wakeups; the hourly sweep re-reads durable GitHub state so missed wakeups can still recover.

The dashboard reads a bounded window (one day by default, or `--usage-window-days`) of local Codex JSONL session telemetry at `/api/usage`. Requests recorded with GLM models are shown as Z.ai runtime usage; account quota and remaining balance are marked unavailable unless a supported source is added.

```sh
npx agents-relayd --repo OWNER/REPO
```

Use service overrides as needed:

```sh
npx agents-relayd --repo OWNER/REPO \
  --port 8787 --interval 3600000 --refresh-ms 300000 \
  --events nats --nats-url nats://127.0.0.1:4222
```

For an installed package, launch through the package binary rather than a checkout path:

```sh
npx --package agents-relay agents-relayd --repo OWNER/REPO
```

With PM2:

```sh
npx --package agents-relay --package pm2 pm2 start agents-relayd --name agents-relayd -- \
  --repo OWNER/REPO \
  --events nats --nats-url nats://127.0.0.1:4222
```

PM2 forwards `SIGINT` and `SIGTERM`. The service clears its watchdog, unsubscribes from wake events, closes the local dashboard server, and exits only after cleanup.
