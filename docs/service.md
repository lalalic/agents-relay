# Running the service

`agents-relayd` starts the repository worker pool, event-driven reconciler, periodic recovery watchdog, and dashboard. With no `--pr`/`--id`, it discovers Git repositories under `~/Workspace` (or `--workspace PATH`), maps GitHub `origin` remotes to repositories, and watches all discovered repositories together. It listens on `127.0.0.1:8787` by default. With a GitHub webhook configured, targeted webhook reconciliation is primary and the broad recovery watchdog runs every 30 minutes by default; without a webhook, the compatibility watchdog remains 5 minutes. Dashboard auto-refresh and periodic SSE snapshots use cached workspace state instead of broad GitHub reads. Explicit Jobs refresh performs broad discovery, while selected-job refresh is targeted to one pull request.

The dashboard reads a bounded window (one day by default, or `--usage-window-days`) of local Codex JSONL session telemetry at `/api/usage`. Requests recorded with GLM models are shown as Z.ai runtime usage; account quota and remaining balance are marked unavailable unless a supported source is added.

The Event Bus is the shared transport for worker lifecycle facts and orchestration signals. Runtime events such as `task.started` and terminal task/review events are applied as durable lifecycle facts; they do not imply a GitHub PR refresh. GitHub webhooks first enter the Event Bus as repository/PR signals, then the repository pool refreshes that PR once, fans the refreshed snapshot out to affected Jobs, and submits reconcile work through per-Job `ReconcileCoordinator` mailboxes. The coordinator serializes one Job, consumes every lifecycle fact, coalesces reconcile work, and is the only event-consumer path that decides to run orchestration reconciliation. Narrow observers such as worker start acknowledgement may still subscribe directly but do not own reconciliation.


```sh
npx agents-relayd --repo OWNER/REPO
```

Workspace mode (the default):

```sh
npx agents-relayd --workspace ~/Workspace
```

Use `--repo OWNER/REPO` to retain the single-repository worker pool. Legacy single-job daemon mode remains available with `--repo OWNER/REPO --pr NUMBER --id JOB_ID`.

Use service overrides as needed:

```sh
npx agents-relayd --repo OWNER/REPO \
  --port 8787 --interval 1800000 --refresh-ms 300000 \
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

GitHub App installation authentication and the webhook/cache consumption model are documented in [github-app-rate-limit.md](github-app-rate-limit.md).
