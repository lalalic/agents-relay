# Running the plugin action gateway

The plugin action gateway (`agents-relay-gateway`) is a small HTTP front door that lets a hosted ChatGPT plugin/connector start and read Agents Relay work without HTTP-fetch access. It exposes exactly two actions — `create_job` and `get_job` — plus an unauthenticated `GET /healthz`. GitHub PR comments stay the durable truth; the gateway keeps no state of its own. The design contract is [docs/plugin-action-gateway.md](../docs/plugin-action-gateway.md).

## Prerequisites

- Node.js 22+ and an installed, authenticated `gh` CLI. The gateway shells out to `gh api`, exactly like `agents-relay` does, so it holds no GitHub credentials of its own.
- One local checkout per allowlisted project (used as the task `cwd`) and permission to push a branch plus open a draft PR and apply the configured label in that repository.

## Configuration

`AGENTS_RELAY_GATEWAY_CONFIG` (or `--config PATH`) points at a JSON file. There is no default project: each entry is an explicit allowlist grant, and any invalid entry aborts startup.

```json
{
  "public_base_url": "https://relay.example",
  "max_active_jobs": 8,
  "create_timeout_ms": 5000,
  "idle_ttl_ms": 1800000,
  "projects": [
    {
      "name": "agents-relay",
      "repository": "lalalic/agents-relay",
      "local_path": "/srv/agents-relay",
      "base_branch": "main",
      "adapter": "codex",
      "capabilities": ["model", "codex"],
      "routing": { "provider": "openai", "model": "gpt-5.3-codex", "reasoning": "high" },
      "max_attempts": 3,
      "timeout_ms": 900000,
      "max_concurrent": 2,
      "trusted_authors": ["lalalic"],
      "label": "agents-relay",
      "branch_prefix": "agents-relay/",
      "dashboard_url": null
    }
  ]
}
```

| Variable | Default | Notes |
| --- | --- | --- |
| `AGENTS_RELAY_GATEWAY_CONFIG` | required | Absolute path to the JSON config. `--config PATH` is equivalent. |
| `AGENTS_RELAY_GATEWAY_TOKEN` | required | Bearer token, at least 32 characters. The whole trust boundary; never logged or echoed. |
| `AGENTS_RELAY_GATEWAY_BIND` | `127.0.0.1` | Safe local default. Non-loopback binds require equivalent network controls. |
| `AGENTS_RELAY_GATEWAY_PORT` | `8790` | |
| `AGENTS_RELAY_GATEWAY_MAX_BODY_BYTES` | `65536` | Larger bodies get `413 payload_too_large`. |
| `AGENTS_RELAY_GATEWAY_PUBLIC_BASE_URL` | unset | Overrides `public_base_url`; must be `https://`. |

Optional shared-bus flags match the rest of the repo: `--events nats --nats-url URL --subject-prefix PREFIX`.

## Start

```sh
node dist/gateway/main.js --config /etc/agents-relay/gateway.json
# or, for an installed package:
npx --package agents-relay agents-relay-gateway --config /etc/agents-relay/gateway.json
```

Startup is fail-closed and ordered: validate config, rebuild runtimes for open relay PRs (`recover()`), then listen. A config error, an unusable `gh`, or a failed recovery search prevents the process from listening at all — fix the cause and restart rather than running with partial state.

With PM2:

```sh
npx --package agents-relay --package pm2 pm2 start agents-relay-gateway --name agents-relay-gateway \
  -- --config /etc/agents-relay/gateway.json --events nats --nats-url nats://127.0.0.1:4222
```

`SIGINT`/`SIGTERM` close the HTTP server, then stop every job runtime (clearing watchdogs and event subscriptions) before exit.

## Hosted transport

The gateway binds loopback by default and does not terminate TLS. A hosted plugin/connector needs a reachable **HTTPS** base URL, so the supported hosted path is an operator-provided TLS reverse proxy or tunnel that terminates HTTPS and forwards to the loopback gateway — nginx/Caddy in front of `127.0.0.1:8790`, or an equivalent tunnel. An explicit non-loopback bind behind equivalent network controls is also allowed. `public_base_url` is that connector-facing HTTPS origin and is used to build the action/status links returned to the caller. Provisioning DNS, certificates, tunnels, and network ACLs is out of scope for this service.

The gateway's bearer token remains the only authentication in every topology.

## Operating it

```sh
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8790/healthz   # 204, unauthenticated

curl -sS -X POST http://127.0.0.1:8790/v1/jobs \
  -H "authorization: Bearer $AGENTS_RELAY_GATEWAY_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"intent":"Add a retry budget to the watchdog","project":"agents-relay","idempotency_key":"thread-42"}'

curl -sS http://127.0.0.1:8790/v1/jobs/agents-relay-3f9c1a7d2e4b6c08 \
  -H "authorization: Bearer $AGENTS_RELAY_GATEWAY_TOKEN"

curl -sS http://127.0.0.1:8790/v1/openapi.json \
  -H "authorization: Bearer $AGENTS_RELAY_GATEWAY_TOKEN"
```

`POST /v1/jobs` returns `201` for a new job, `200` when an identical request reuses the existing job, and `409 idempotency_conflict` when the same `(project, idempotency_key)` arrives with a different request body. Always send the same `idempotency_key` when retrying.

**Data handling.** `intent`, `context`, and `requirements` become durable GitHub PR content (the job marker and the initial task comment's input). The gateway cannot detect pasted secrets. Do not send secrets, credentials, tokens, or private data; put large or private payloads in artifact references owned by the caller. This service adds no encryption, redaction, or alternate storage.

## Observability

- Events are mirrored to stderr as one JSON object per line, and published on the shared `agents-relay.events.job.*` bus when `--events nats` is set. Event delivery is best-effort and never gates an HTTP outcome; a dead bus is reported as `event.transport.failed` and the durable marker still exists.
- Gateway events: `job.created`, `job.reused`, `job.idempotency.conflict`, `job.create.failed`. Execution events (`task.started`, `task.completed`, …) still come from the reconciler.
- Durable truth is always the anchor PR: its `agents-relay:job:v1` and `agents-relay:task:v1` comments. Inspect the PR when the API and your expectations disagree.

## Restart, recovery, and capacity

- After a restart the gateway rediscovers open relay PRs per project: issue search supplies PR numbers, each PR is fetched to read `head.ref`, the branch prefix encodes the job id, and trusted marker comments are the fallback when the branch name cannot be parsed. Terminal jobs stay readable but get no runtime.
- Runtime residency is a cache, bounded by `max_active_jobs` (default 8). Exceeding it returns `429 capacity_exceeded` with `retry_after_ms`. Per-job task concurrency is the existing reconciler limit from the project's `max_concurrent`; there is no global or distributed scheduler.
- Idle runtimes with no non-terminal task are evicted after `idle_ttl_ms`; `get_job` keeps working because it reads GitHub.
- Run **one** gateway instance per repository. Two instances each rebuild the same runtimes, which breaks the existing "one active runner per job" v1 assumption until a distributed lease exists.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Process exits with a config error | `AGENTS_RELAY_GATEWAY_TOKEN` missing/short, unknown keys, a non-`codex` adapter, or a capability the adapter does not declare. |
| `401 unauthorized` | Missing or wrong bearer token. Nothing is sent to GitHub. |
| `400 unknown_project` | The `project` name is not in the allowlist. No GitHub write happens. |
| `400 unknown_field` | The caller tried to pass execution details (`repository`, `cwd`, `command`, `adapter`, `provider`, `model`, `capabilities`, `routing`). Those are server-controlled. |
| `409 idempotency_conflict` | The key was already used for a different request. Use a new key for a new job. |
| `413` / `415` | Body over `max_body_bytes`, or a content type other than `application/json`. |
| `429 capacity_exceeded` | `max_active_jobs` reached; retry after `retry_after_ms`. |
| `502 github_unavailable` | `gh` is unauthenticated or GitHub rejected the call. Nothing was lost: retry with the same idempotency key. |

## Verifying a change

```sh
npm test              # full suite, including the gateway acceptance tests
npm run test:gateway  # gateway tests only
```

Gateway tests use an in-memory GitHub fake and never perform real GitHub writes.
