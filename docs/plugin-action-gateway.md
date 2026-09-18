# Plugin action gateway

Phase 1 design. No gateway source or tests exist yet; this document is the contract that phase 2 implements.

## Goals

- Let a hosted ChatGPT plugin/connector action surface start and inspect Agents Relay work, without HTTP-fetch access and without the caller choosing execution details.
- Expose exactly two actions: `create_job` (`POST /v1/jobs`) and `get_job` (`GET /v1/jobs/{job_id}`).
- Keep GitHub PR state as durable truth. The gateway is a stateless-ish front door; nothing durable lives in the gateway process.
- Reuse the existing runtime unchanged: `GitHubStore`, marker v1, `Reconciler`, worker adapters, event bus, watchdog.
- Fail safe and predictably: allowlisted projects, authenticated loopback binding, strict input validation, retry-safe job creation.

## Non-goals

- No `send_message`, `cancel_job`, retry, or task-submission actions. A caller may only create a job and read it.
- No hosted multi-tenant control plane, no user accounts, no per-caller quotas or RBAC.
- No second database, queue, registry, or lease store. GitHub remains durable truth; the supervisor cache is disposable.
- No caller-selected repository, cwd, shell command, credentials, adapter, provider, model, capabilities, or routing.
- No changes to `Reconciler`'s single-store/single-job contract, to the job/task state machine, or to marker v1.
- No web UI, no deployment automation, no job/PR garbage collection policy (see open concerns).
- No cross-PR dependency edges. Parent lineage is recorded metadata only.

## Request and response schemas

Gateway surface (OpenAPI 3.1 document served, authenticated, at `GET /v1/openapi.json`).

`POST /v1/jobs`, `operationId: create_job`, `content-type: application/json`, body <= `max_body_bytes` (default 65536). All objects are `additionalProperties: false`; any unrecognized field is rejected.

```json
{
  "intent": "string, required, 1..4000",
  "project": "string, required, must match a configured project name",
  "idempotency_key": "string, required, 1..128, [A-Za-z0-9._:-]+",
  "context": "string, optional, <=16000",
  "requirements": ["string, optional, <=32 items, each <=512"],
  "parent": { "job_id": "string, optional", "task_id": "string, optional" },
  "agent": { "name": "string, optional, <=64" }
}
```

`201 Created` on a newly anchored job, `200 OK` when an existing job is resolved from the same `idempotency_key`:

```json
{
  "job_id": "agents-relay-3f9c1a7d2e4b6c08",
  "state": "OPEN",
  "project": "agents-relay",
  "created": true,
  "reconciled": false,
  "task_id": "b1e2...",
  "title": "Add a retry budget to the watchdog",
  "pr": {
    "repository": "lalalic/agents-relay",
    "number": 12,
    "branch": "agents-relay/agents-relay-3f9c1a7d2e4b6c08",
    "url": "https://github.com/lalalic/agents-relay/pull/12"
  },
  "links": {
    "self": "https://relay.example/v1/jobs/agents-relay-3f9c1a7d2e4b6c08",
    "pr": "https://github.com/lalalic/agents-relay/pull/12"
  },
  "poll_after_ms": 5000
}
```

- `state` is read from the durable job marker after the anchor write, so for a fresh job it is normally `OPEN`. `reconciled: true` means the first reconciliation completed inside `create_timeout_ms`; `false` means the watchdog/event path will pick it up.
- `links.self` and `links.pr` are always present. `links.status` is an alias for `links.self`. `links.dashboard` is present only when the project config sets a reachable `dashboard_url`; the only real dashboard routes in this repo are `serveDashboard`'s `/`, `/api/job`, `/api/usage`, `/events`, all bound to `127.0.0.1`, so a loopback URL is deliberately never emitted.
- `links.self` uses `public_base_url` when configured; otherwise it is the relative path `/v1/jobs/{job_id}`.
- No credentials, routing, or provider/model data appear in any response.

`GET /v1/jobs/{job_id}`, `operationId: get_job`, `200 OK`:

```json
{
  "job_id": "agents-relay-3f9c1a7d2e4b6c08",
  "project": "agents-relay",
  "state": "RUNNING",
  "terminal": false,
  "updated_at": "2026-09-18T23:31:02.114Z",
  "closed": false,
  "title": "Add a retry budget to the watchdog",
  "pr": { "repository": "lalalic/agents-relay", "number": 12, "branch": "agents-relay/...", "url": "https://github.com/lalalic/agents-relay/pull/12" },
  "tasks": [
    {
      "task_id": "b1e2...",
      "state": "RUNNING",
      "attempt": 1,
      "adapter": "codex",
      "result_summary": null,
      "error": null,
      "thread_id": null,
      "updated_at": "2026-09-18T23:31:02.114Z"
    }
  ],
  "links": { "self": "/v1/jobs/agents-relay-3f9c1a7d2e4b6c08", "pr": "https://github.com/lalalic/agents-relay/pull/12" }
}
```

- `terminal` is `state in {COMPLETED, FAILED, CANCELLED}`.
- `closed` reflects the PR's own `state`/`merged` flags; a manually closed PR does not mutate the durable job.
- Task entries intentionally omit `input`, `context`, `continuation`, and routing. Full text stays in the PR comment where the host controls visibility.
- `get_job` never mutates durable state and never registers a runtime; it is a bounded read through `GitHubStore`.
- `GET /healthz` returns `204` unauthenticated with an empty body. Every other route requires the bearer token.

## Project configuration schema

The gateway has no default project. Configuration comes from `AGENTS_RELAY_GATEWAY_CONFIG` (absolute path to JSON). Each entry is an explicit allowlist grant; a request naming an unconfigured project is rejected.

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
      "local_path": "/Users/chengli/Workspace/agents-relay",
      "base_branch": "main",
      "adapter": "codex",
      "capabilities": ["model", "codex"],
      "routing": { "provider": "openai", "model": "gpt-5.3-codex", "reasoning": "high" },
      "max_attempts": 3,
      "timeout_ms": 900000,
      "max_in_flight": 2,
      "trusted_authors": ["lalalic"],
      "label": "agents-relay",
      "branch_prefix": "agents-relay/",
      "dashboard_url": null
    }
  ]
}
```

Rules:

- `name` matches `^[a-z0-9][a-z0-9-]{0,31}$` and is unique; the gateway resolves projects by exact match.
- `adapter` is limited to `codex` in phase 1. Gateway-created jobs never use the `shell` adapter, so caller text is never executed as a command.
- `capabilities` must be a subset of the adapter's declared capabilities, otherwise config validation fails at startup.
- `routing` is mandatory and becomes the initial task's `RoutingDecision` (`decidedBy: "gateway-config"`, `decidedAt` at anchor time) with `cwd` taken from `local_path`.
- `trusted_authors` is passed to `GitHubStore` so only host-authored marker comments are honored.
- Environment: `AGENTS_RELAY_GATEWAY_TOKEN` (required, >=32 chars), `AGENTS_RELAY_GATEWAY_BIND` (default `127.0.0.1`), `AGENTS_RELAY_GATEWAY_PORT` (default `8790`), `AGENTS_RELAY_GATEWAY_MAX_BODY_BYTES` (default `65536`), plus the existing `--events nats`/`--nats-url`/`--subject-prefix` options for the shared bus.
- Config validation is fail-closed: any invalid project aborts startup. No project is ever auto-created.

## Trust boundary

Caller-controlled: `intent`, `context`, `requirements`, `project` name, `parent`, `agent.name`, `idempotency_key`.

Server-controlled: repository, base branch, local path, adapter, capabilities, provider/model/routing, `cwd`, concurrency, lease, timeout, retry policy, continuation policy.

- Authentication is a single bearer token from the environment, compared in constant time. There is no caller identity, so there is no per-caller attribution or quota; the token is the whole trust boundary. The token is never logged or echoed.
- Binding is loopback by default. A non-loopback bind is an explicit opt-in and then the bearer token plus host firewall/tunnel is the only protection; TLS termination is out of scope but required in practice.
- The gateway holds no GitHub credentials of its own: `GhApiClient` shells out to the host's authenticated `gh` CLI, exactly like the CLI does today.
- The caller cannot influence which repository, which directory, which model, or whether a shell runs. Unknown or extra fields are rejected rather than ignored.
- Prompt-injection surface: `intent`/`context` become Codex task input in an allowlisted repository. They are passed as task input text and are never interpolated into a shell command or a git argument. A malicious caller with a valid token can still consume agent budget and cause code changes in an allowlisted repo; that is accepted for a single-operator loopback gateway and is the reason the surface is limited to two actions.
- `get_job` exposes only bounded, non-secret fields; the full task input remains in the host-controlled PR comment.
- Phase 1 has no `continuation` on gateway jobs, so a completed task never auto-resumes an external thread.

## PR anchor lifecycle

One `create_job` call maps to exactly one open pull request in the configured project. The anchor carries no code change.

1. Validate the body against the schema; reject unknown fields, unknown project, oversized input.
2. Derive `job_id = <project>-<first 16 hex of sha256(project + "\0" + idempotency_key)>`, so the same key always names the same job.
3. Resolve an existing job: supervisor cache first, then `GET /repos/{repo}/branches/agents-relay/<job_id>`. If the branch exists, load the PR for that branch and finish any missing durable writes (steps 6-8), then return `created: false`.
4. Read the base ref, then the base commit's tree SHA.
5. Create an empty commit and ref via the GitHub git-data API: `POST /repos/{repo}/git/commits` with `tree` = base tree SHA and `parents: [base commit sha]` (no blob/tree changes, therefore an empty diff), then `POST /repos/{repo}/git/refs` for `refs/heads/agents-relay/<job_id>`. This avoids mutating any local checkout. A local `git commit --allow-empty` + push is the documented fallback if the API path is unavailable.
6. Open a draft PR from that branch onto `base_branch`, then add the project label (`agents-relay` by default). The label is the rediscovery index; the branch prefix encodes `job_id`.
7. `new GitHubStore(new GhApiClient(), repository, prNumber, new Set(trusted_authors))` and `saveJob(job)` writes the `agents-relay:job:v1` marker comment. The job record is the existing `Job` shape plus the optional lineage extension below.
8. `appendTask(initialTask)` writes one `agents-relay:task:v1` comment: `state: QUEUED`, empty `dependencies`, config capabilities, config adapter, config routing, config `maxAttempts`/`timeoutMs`, `parentTaskId: null`.
9. Register the runtime with the supervisor and trigger reconciliation (bounded wait, see failure rules).
10. Publish `job.created` (orchestrator) and return the response.

Durability rule: `create_job` reports success only after step 8. Steps 4-6 partial failures leave a branch/PR without markers; a retry with the same `idempotency_key` re-resolves the branch and completes the remaining writes on the same PR. The gateway never creates a second PR for the same key.

Lifecycle after creation: the job only ever moves through the existing `OPEN -> RUNNING -> WAITING|BLOCKED -> COMPLETED|FAILED|CANCELLED` transitions driven by `Reconciler` and `schedule`. The gateway never writes task state directly, never transitions a job, and never merges or closes the anchor PR. The anchor PR is a container and audit surface; merging it is a human/host decision outside this design.

### Marker-v1 extension

`Job` gains optional fields; existing readers ignore unknown keys because `renderJobComment` spreads the job object and `parseJob` returns parsed JSON. No marker version bump, no new marker label.

```ts
parentJobId?: string;
parentTaskId?: string | null;
project?: string;
requirements?: string[];
createdBy?: { kind: 'gateway'; agentName?: string; keyFingerprint: string };
```

`job_id`, `title`, `state`, `prNumber`, `repository`, `continuation`, timestamps, and `tasks` are unchanged. `requirements` are recorded prose for human/agent readers only; they never feed capabilities, routing, or adapter selection.

## Supervisor and recovery

`JobSupervisor` owns one `GitHubStore` + one `Reconciler` + one watchdog interval + one event subscription per active job. This matches the existing single-store/single-job `Reconciler`; `Reconciler` itself is not modified.

- Runtimes are created lazily by `create_job` and by boot recovery, and are keyed by `job_id` so repeated calls cannot double-register a watchdog.
- `get_job` does not create a runtime; it reads through a short-lived `GitHubStore`.
- Process-wide `max_active_jobs` (default 8) and per-project `max_in_flight` bound concurrent work; exceeding them returns `429 capacity_exceeded` with `retry_after_ms`, never a queued-but-invisible job.
- Idle eviction: a runtime with no non-terminal task and no activity for `idle_ttl_ms` is stopped (unsubscribe, clear watchdog) and dropped. Residency is a cache, never truth.
- Every runtime uses the existing watchdog pattern from `createService`: `setInterval(reconcile, watchdogMs)` (default 60000 from `SERVICE_DEFAULTS`), unref'd, cleared on eviction/shutdown. SIGINT/SIGTERM stop all runtimes and close the HTTP server, mirroring `Service.stop`.

Boot recovery (`recover()`), no local state involved:

1. For each configured project, `GET /search/issues?q=repo:{repository}+is:pr+is:open+label:{label}`.
2. For each result, extract `job_id` from `pull_request.head.ref` after `branch_prefix`; if that fails, scan the PR body/comments for an `agents-relay:job:v1` marker.
3. `GitHubStore.load(job_id)`; skip jobs whose state is terminal (they stay readable via `get_job`).
4. Register a runtime, reconcile once, subscribe to the shared event bus when configured, and start the watchdog.
5. Event subscriptions use the existing subject prefix `agents-relay.events.job`, so gateway runtimes and CLI runtimes observe the same wakes. Without NATS the watchdog still converges; that degradation already exists today.

If two gateway instances run against the same repository they will each rebuild runtimes for the same jobs, which violates the existing "one active runner per job" v1 assumption. Single-instance operation is required until a distributed lease exists.

## Existing primitive reuse

| Primitive | Reused as |
| --- | --- |
| `GitHubStore`, `GhApiClient`, `DurableStore` | Anchor PR creation, marker read/write, trusted-author filtering. No store changes. |
| `JOB_MARKER` / `TASK_MARKER` + `renderJobComment` / `renderTaskComment` / `parseJob` / `parseTask` | Durable job and initial task records. Marker v1 unchanged. |
| `Job` / `Task` / `RoutingDecision` types, `assertJobTransition` / `assertTaskTransition` | Same durable shapes and state rules; only optional `Job` fields are added. |
| `Reconciler` | One instance per job; reconciliation, lease recovery, continuation, event emission unchanged. |
| `schedule` / `dependencyReady` | Dependency and job-state derivation for the initial task (which has no dependencies). |
| `ShellAdapter` / `CodexAdapter` | Execution; gateway config selects `codex` only. |
| `EventBus`, `NatsEventBus`, `eventFor` | `job.created` / `job.reused` / `job.create.failed` plus the existing task events. |
| `createService`'s watchdog + SIGTERM stop pattern (`SERVICE_DEFAULTS`) | Supervisor runtime lifecycle. |
| `serveDashboard` | Untouched. Its routes justify emitting a dashboard link only when `dashboard_url` is configured. |
| `InMemoryStore` and the existing test style (`node --test` against `dist/`) | Phase-2 gateway tests. |

No new HTTP framework, no schema library, no database, no queue: `node:http` plus hand-written validation, matching the repo's no-dependency posture.

## Event behavior

- Gateway-authored events: `job.created` (`visibility: orchestrator`) after the marker is durable, `job.reused` (`orchestrator`) when an idempotent retry resolves an existing job, `job.idempotency.mismatch` (`orchestrator`) when the same key arrives with different intent, and `job.create.failed` (`user`, level `error`) for anchor failures.
- `get_job` publishes nothing. Reads have no side effects beyond supervisor cache population in the create path.
- Existing `Reconciler` events are unchanged and remain authoritative for execution: `task.started` (`user`), `task.completed` (`orchestrator`), `task.failed` (`user`), `task.retry`, `thread.started`, `continuation.failed`.
- Event publishing is best-effort and never gates HTTP outcomes: failures are caught and reported as `event.transport.failed`, exactly like `Reconciler.emit`. A 201 response means the durable marker exists; it never means an event was delivered.
- Events are not durable and are never used to answer `get_job`. Every read reloads GitHub.

## Failure and idempotency rules

Error envelope: `{ "error": { "code": "...", "message": "...", "retryable": true|false } }`.

| Condition | Status | `error.code` | Retryable |
| --- | --- | --- | --- |
| Missing/invalid bearer | 401 | `unauthorized` | no |
| Malformed JSON, missing/short field, bad `idempotency_key` | 400 | `invalid_request` | no |
| Unrecognized field | 400 | `unknown_field` | no |
| Project not in config | 400 | `unknown_project` | no |
| Body over limit / wrong content type | 413 / 415 | `payload_too_large` / `unsupported_media_type` | no |
| Unknown `job_id`, non-numeric PR, missing branch | 404 | `not_found` | no |
| `max_active_jobs` or `max_in_flight` reached | 429 | `capacity_exceeded` | yes |
| GitHub API/`gh` failure | 502 | `github_unavailable` | yes |
| First reconcile exceeded `create_timeout_ms` | 201 with `reconciled: false` | - | yes (poll `get_job`) |
| Unexpected internal error | 500 | `internal` | yes |

Idempotency rules:

- `idempotency_key` is required, which makes every create retry safe. `job_id` is a deterministic function of `(project, idempotency_key)`, so no extra mapping table is needed.
- Resolution order: supervisor cache, then branch lookup. A resolved job returns `200` with `created: false` and never mutates the existing job's intent, task, or state.
- Same key with different `intent`/`context` returns the existing job and publishes `job.idempotency.mismatch`. The key is the contract; the caller must send identical payloads on retry.
- Same intent with a different key creates a new job and PR. Deduplication by content is the caller's responsibility, not the gateway's.
- Concurrent same-key requests may both attempt anchor creation. The loser observes GitHub's `422` on ref/PR creation, re-resolves the existing branch, and returns `created: false`. Both responses agree on `job_id` and PR.
- Partial anchor: if the PR exists but markers are missing, the retry completes steps 7-8 on the same PR before returning. A `201` is only ever returned after the job and initial task markers are durable.
- Reconciliation is never awaited for correctness. `create_job` waits at most `create_timeout_ms` for the first `reconcile`; on timeout it returns the last durable state with `reconciled: false` and lets the watchdog converge.
- No process state is required to recover: after a crash, branch + label + markers are enough to rebuild every runtime.

## Acceptance tests

Phase 2 tests run with `node --test test/gateway-*.test.js` against built `dist/` output, matching the existing suite, using a fake `GitHubClient` and `InMemoryStore`.

1. Schema: missing `intent`, empty `project`, bad `idempotency_key`, and 33 requirements each return `400 invalid_request`; an extra `repository` or `adapter` field returns `400 unknown_field`; a 70 KB body returns `413`; `text/plain` returns `415`.
2. Auth: no bearer and wrong bearer return `401`; `/healthz` returns `204` without a token; other routes return `401` before any GitHub call.
3. Project allowlist: an unconfigured project returns `400 unknown_project` and performs zero GitHub writes.
4. Happy path: one `create_job` produces exactly one empty commit (same tree SHA as base), one `refs/heads/agents-relay/<job_id>`, one draft PR, the `agents-relay` label, one job marker comment, and one task marker comment whose `adapter`, `capabilities`, `routing`, `maxAttempts`, and `timeoutMs` come from config.
5. Caller cannot choose execution: attempts to pass `adapter`, `provider`, `model`, `cwd`, `command`, or `capabilities` are rejected as `unknown_field`, and the durable task still carries the config values.
6. Idempotent retry: two identical calls yield one PR, `created: true` then `created: false`, identical `job_id`/PR/branch, and no duplicate comments.
7. Concurrent same-key: the second ref/PR creation receives `422`; the response is `created: false`, and only one PR and one marker pair exist.
8. Same key, different intent: returns the existing job, publishes `job.idempotency.mismatch`, and leaves the durable job and task untouched.
9. Partial anchor: with marker writes failing once, the first call errors, and the retry with the same key completes markers on the same PR without creating a second PR.
10. `get_job`: unknown id returns `404 not_found`; a terminal job returns `terminal: true` and registers no runtime; the payload omits task `input`, `context`, `routing`, and any dashboard link when `dashboard_url` is unset.
11. Lineage: `parent` and `agent.name` are persisted as `parentJobId`/`parentTaskId`/`createdBy` and echoed by `get_job`, while the initial task keeps `parentTaskId: null` and no cross-PR dependency.
12. Supervisor: repeated create/get calls for one job keep exactly one runtime and one watchdog; `max_active_jobs` and `max_in_flight` produce `429 capacity_exceeded`; idle eviction removes the runtime while `get_job` still reads correct state.
13. Recovery: a supervisor boot with two open labeled PRs (one terminal, one running) builds exactly one runtime, reconciles once, and skips the terminal job; an unparseable branch name falls back to the marker scan.
14. Events: `create_job` publishes `job.created` with `visibility=orchestrator`; a throwing event bus still yields `201` and publishes `event.transport.failed`; `get_job` publishes nothing.
15. Marker compatibility: job comments written without the new optional fields parse and round-trip, keeping the existing marker/store tests green.
16. Reconciliation is not blocking: with a slow reconciler, `create_job` returns within `create_timeout_ms` with `reconciled: false` and a durable `OPEN` job.

## Phase 2 file plan

| File | Responsibility |
| --- | --- |
| `src/gateway/config.ts` | Load and validate `AGENTS_RELAY_GATEWAY_CONFIG`, env (`token`, `bind`, `port`, `max_body_bytes`), fail-closed project allowlist. |
| `src/gateway/schema.ts` | Request/response types, hand-written validators, `idempotency_key` -> `job_id` derivation, error-code mapping. |
| `src/gateway/openapi.ts` | Static OpenAPI 3.1 document for `create_job` / `get_job` / `/healthz`, served authenticated. |
| `src/gateway/anchor.ts` | Project resolution, base ref/commit/tree lookup, empty commit, branch, draft PR, label, marker writes, existing-anchor resolution. |
| `src/gateway/supervisor.ts` | `JobSupervisor`: lazy runtime registry, watchdog, event subscribe/unsubscribe, idle eviction, capacity limits, `recover()`. |
| `src/gateway/actions.ts` | `create_job` and `get_job` handlers: request -> durable job/task -> response mapping. |
| `src/gateway/server.ts` | `node:http` server, routing, bearer auth, body-size enforcement, JSON parsing, error envelope, SIGINT/SIGTERM shutdown. |
| `src/gateway/main.ts` | Entrypoint wiring config -> supervisor -> server; `recover()` before listen. |
| `src/types.ts` | Add the optional `Job` lineage fields. |
| `package.json` | Add the `agents-relay-gateway` bin entry and a `--gateway` test glob. |
| `ops/agents-relay-gateway.md` (or PM2/systemd snippet) | Ops runbook extending `docs/service.md`: env, config path, bind, logs, restart/recovery expectations. |
| `test/gateway-config.test.js`, `test/gateway-actions.test.js`, `test/gateway-supervisor.test.js`, `test/gateway-server.test.js` | Acceptance tests 1-16 above, fake `GitHubClient` + `InMemoryStore`. |
| `README.md`, `docs/service.md` | Short pointers to this document and the new bin. |

Explicitly not in phase 2: changes to `src/reconciler.ts`, `src/store.ts`, `src/markers.ts`, `src/events.ts`, `src/scheduler.ts`, `src/dashboard.ts`.

## Open design concerns

1. Transport for hosted ChatGPT: a hosted connector cannot reach a loopback HTTP server. Phase 2 assumes a thin local connector/MCP shim that holds the bearer token and calls the loopback gateway; direct hosted-to-loopback access, and the tunnel plus second auth layer it would need, remain undecided.
2. `links.dashboard` is effectively unavailable: `serveDashboard` is loopback-bound and single-job, so no honest dashboard URL exists for a gateway job until an external route is configured.
3. Anchor PRs are durable noise: empty commits, draft status, and no merge/close/GC policy. Whether anchors are closed automatically on completion, and whether they may ever merge into the base branch, is unresolved.
4. Label creation may need repo admin; rediscovery depends on `label:agents-relay` search, with a marker-scan fallback when the label or branch name is unusable.
5. One shared bearer token means no caller attribution and no per-caller budget. A leaked token can spend agent budget in allowlisted repositories.
6. Capacity limits are process-local, so two gateway instances break the "one active runner per job" invariant; the existing v1 distributed-lease gap applies.
7. Idempotency stores only a key fingerprint in the marker, so a caller that loses its key cannot recover its job by intent.
8. `requirements` are recorded prose only. Any future mapping to capabilities or routing must go through project config, or callers regain execution influence by another name.
9. `get_job` state can lag reality if a human closes or merges the anchor PR; the design reports PR `closed` but deliberately never mutates the durable job in response.
