# Running the service

`agents-relayd` starts the repository worker pool, event-driven reconciler, periodic recovery watchdog, and dashboard. With no `--pr`/`--id`, it discovers Git repositories under `~/Workspace` (or `--workspace PATH`) by unique Git-root directory name and watches their SQLite Jobs. GitHub origin is optional metadata and never defines local repository identity. It listens on `127.0.0.1:8787` by default. Dashboard reads and recovery use the local SQLite inventory.

The dashboard reads a bounded window (one day by default, or `--usage-window-days`) of local Codex JSONL session telemetry at `/api/usage`. Requests recorded with GLM models are shown as Z.ai runtime usage; account quota and remaining balance are marked unavailable unless a supported source is added.

### Jobs search API

`GET /api/jobs` performs a read-only query against the authoritative Relay SQLite inventory. It never mutates Job, Plan, Task, Review, lease, or recovery lifecycle state.

Dashboard consumers use these request parameters:

| Parameter | Contract |
| --- | --- |
| `q` | Case-insensitive substring match on durable Job title or ID. |
| `status` | Repeat the parameter for an inclusive OR across lifecycle states: `DRAFT`, `ACTIVE`, `COMPLETED`, and `CANCELLED`. Comma-separated `statuses` remains a compatibility alias. When every status selection is empty, the API defaults to `DRAFT`, `ACTIVE`, and `COMPLETED`; `CANCELLED` is returned only when explicitly selected. A `DRAFT` selection matches durable `DRAFT` Jobs and Jobs whose GitHub PR is a draft. |
| `repo` | Repeat the parameter for an inclusive OR across exact local repository identities. An empty selection matches every repository. |
| `page` | One-based page number; invalid or missing values resolve to `1`, and values beyond the last page resolve to the last page. |
| `pageSize` | Positive integer capped at `20`; invalid or missing values use `20`. |
| `refresh` | Set to `1` for an explicit Refresh query. The backend re-reads the current SQLite-backed inventory before applying filters and pagination. |

Status and repository selections are OR operations within each filter; combining them ANDs the two predicates together. The response contains the selected `jobs`, every known `repositories` value (unfiltered so the selector remains stable), `total` matching count, the normalized `page`, effective `pageSize`, and `totalPages`. Calls without any search-contract parameter retain the previous array response for unrelated callers.

Runtime decisions are additionally recorded as one structured observability stream (`src/observability.ts`): wake, graph decision, transition/effect, store commit, and projection outcome share a repository/PR/job/task/execution correlation envelope. The stream is diagnostic only and never a second durable store; failures are classified as deterministic `conflict` vs `transient` retry vs `terminal`, and secrets/prompts/large payloads are redacted. Set `AGENTS_RELAY_OBSERVABILITY` (`silent`|`debug`|`info`|`warn`|`error`, default `info`) to control it. See [structured-observability.md](structured-observability.md).

The Event Bus is the shared transport for worker lifecycle facts and orchestration signals. Runtime events enter the local Reconciler and update durable SQLite state; the event transport is not lifecycle truth. Optional GitHub webhooks can record external facts but never own local Job transitions.


```sh
npx agents-relayd --repo LOCAL_ROOT_NAME
```

Workspace mode (the default):

```sh
npx agents-relayd --workspace ~/Workspace
```

Use `--repo LOCAL_ROOT_NAME` to retain the single local Git repository worker pool. Legacy single-job daemon mode remains available with `--repo LOCAL_ROOT_NAME --pr NUMBER --id JOB_ID`.

By default, Relay probes the configured NATS endpoint (`--nats-url`, then `EVENTS_BUS_NATS_URL`, then `nats://127.0.0.1:4222`). When the broker is reachable, the CLI and daemon automatically use NATS even when `--events` is omitted. Pass `--events nats` to require NATS explicitly; pass an explicit non-NATS value such as `--events none` to disable auto-detection. If NATS is unavailable, commands that require authoritative model-task lifecycle events fail clearly instead of pretending the transport exists.

Use service overrides as needed:

```sh
npx agents-relayd --repo LOCAL_ROOT_NAME \
  --port 8787 --interval 1800000 --refresh-ms 300000 \
  --events nats --nats-url nats://127.0.0.1:4222
```

For an installed package, launch through the package binary rather than a checkout path:

```sh
npx --package agents-relay agents-relayd --repo LOCAL_ROOT_NAME
```

With PM2:

```sh
npx --package agents-relay --package pm2 pm2 start agents-relayd --name agents-relayd -- \
  --repo LOCAL_ROOT_NAME \
  --events nats --nats-url nats://127.0.0.1:4222
```

PM2 forwards `SIGINT` and `SIGTERM`. The service clears its watchdog, unsubscribes from wake events, closes the local dashboard server, and exits only after cleanup.

GitHub App installation authentication and the webhook/cache consumption model are documented in [github-app-rate-limit.md](github-app-rate-limit.md).

## Fact-only GitHub webhooks

GitHub webhooks are external fact inputs, not cache-invalidation signals. Relay consumes a webhook only when the payload is sufficient to apply a deterministic local fact without a follow-up GitHub API read. Currently this includes package publication markers, pull-request close/merge state, and pull-request synchronize head changes. Ordinary PR edits, normal comments, reviews, checks, suites, and workflow notifications are ignored unless a future explicit consumer can handle them entirely from the payload. A webhook must never trigger a PR snapshot refresh.
