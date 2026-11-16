# Relay Rust backend — staged native rewrite

The Rust rewrite includes real transactional SQLite Job and Task semantics,
physical Workers, Graph-backed Coordinator scheduling and a protected
single-node native foreground path. Its **canonical database compatibility**
with the existing Relay store now has a separate test. It is **not yet a full
production replacement**: full L3 recovery, Review, Router and canonical
runtime cutover must still pass without discarding existing Jobs or leases.

## Canonical SQLite / Neo Project foreground parity (2026-11-16)

The original, authoritative SQLite database is **not copied into a new Rust
store**. The opt-in canonical mode opens exactly
`$HOME/.agents-relay/relay.sqlite` with the existing Node schema and global
Job/Task ID sequence. Its `source_registry` insert and Job+Coordinator Task
creation are one SQLite IMMEDIATE transaction. The Rust daemon skips all
preexisting Node-owned Jobs without an explicit native intake fingerprint; it
must never claim another reconciler's Task lease.

The per-user runtime side directory
`$HOME/.local/state/agents-relay/canonical-rust` is **not another DB**; it is
for a private lock, control socket, trusted Worker manifest, and execution
requests. Before enabling canonical mode, that directory must be owned by the
current user, mode `0700`, contain the explicitly approved marker file
`.canonical-relay-owner-v1` with exact text
`canonical-rust-operator-approved-v1\n`, and the environment must set
`RELAY_RUST_LIVE_MODE=canonical-live`. There is no automatic migration,
implicit production access or silent fallback to a second database.

Verified on a disposable, real-schema SQLite online backup (original source
unchanged), including four physical Script Workers:

```sh
cargo build --locked --manifest-path rust/Cargo.toml --all-targets
RELAY_CANONICAL_SOURCE_DB="$HOME/.agents-relay/relay.sqlite" \
  node --test rust/tests/native-canonical-sqlite-l3-e2e.mjs
node --test rust/tests/native-neo-project-foreground-e2e.mjs
node --test rust/tests/review-parity.mjs
node --test rust/tests/parity-matrix.test.mjs
```

The Neo E2E calls the real `neo/.bin/neo-project-run.mjs` implementation with
an isolated `NEO_RELAY_EXECUTABLE`-compatible wrapper, not mocked Relay
responses. It proves the `source → designer → face → motion` Coordinator
scheduling, *not* actual Rodin/Blender/Face content execution. Do not use
Dashboard port `8787` as a write endpoint.

The Rust-only CLI, DAG, worker, storage and review regression suite now
passes **179/179 tests** (`node --test --test-concurrency=1 rust/tests/*.mjs`).
The original full TypeScript L3 suite still fails **12 of 78 cases**, covering
Planner/recovery/Review convergence. Passing the Rust-only suite does not
validate or excuse those failed acceptance scenarios.

The authoritative open L3 capabilities and exact cutover blockers are in
[`rust/docs/parity-matrix.json`](docs/parity-matrix.json). A passing Rust
**subtest** does not grant permission to replace the production scheduler or
claim prior Node-owned Jobs. Retain the current PM2 installation while
remaining L3, managed Review, recovery, and provider gates are not verified.

## Rust live service, read-only Dashboard (2026-11-14)

The Rust service may run persistently in a dedicated operator-marked Job
namespace under the user's private state directory. It does NOT claim the
TypeScript production store, Scheduler, Review or JEL ownership. This is
intentional while the Vlog production Job is pending human Review.

- Exact location: $HOME/.local/state/agents-relay/rust-live/relay.sqlite
- Required marker file: .relay-rust-live-namespace-v1 with the single line
  rust-relay-owned-standalone-namespace-v1 (newline terminated)
- Directory must be user-owned and mode 0700.
- Required environment: RELAY_RUST_LIVE_MODE=pilot-live.
- Rust CLI can initialize its own store, create/activate/inspect Jobs.
- Native loop Daemon schedules and completes only Graph-authorized no-review
  Jobs. No approval, merge, publishing or revision is inferred.
- The native Rust Dashboard is served by Rust at `127.0.0.1:8787` and
  public `https://agents.qili2.com/`, with unchanged original Node browser
  client. `/` projects historical Node Jobs and `/rust/` projects the
  isolated Rust Jobs. The historical Events Bus is queried read-only.
- Only the Rust-owned DB receives native Worker claims. A production
  TypeScript SQLite path cannot pass the Rust namespace fence.
- Rust dashboard GET /api/jobs lists at most 20 sanitized Job/task state
  summaries. It deliberately omits worker inputs, outputs and private media.

The native read-only HTTP slice serves `GET /api/jobs` with case-insensitive
title/ID search (`q`), repeated or comma-separated durable lifecycle filters
(`status`/`statuses`), exact repository filters (`repo`/`repositories`), and
`page`/`pageSize` pagination (page size is capped at 20). It returns the
filtered Jobs, the unfiltered repository list, and normalized pagination
metadata. `GET /api/jobs/{id}` returns one sanitized Job and Task summary.
`GET /api/jobs/{id}/tasks` returns the ordered sanitized Task hierarchy,
and `GET /api/jobs/{id}/tasks/{taskId}` returns one sanitized Task.
Public reads exclude private Task inputs, outputs, results and local project
paths, including the original Node Dashboard's potentially sensitive fields.
Missing Jobs or Tasks and malformed numeric path IDs return 404. All routes use the read-only SQLite
reader; a successful HTTP response does not imply Task success or change
lifecycle state.
`GET /api/events?job=ID[&task=ID][&limit=N]` returns an array of matching events
already stored in the isolated Rust authority's inbox/outbox. It returns the
newest 60 by default, ordered by local recorded timestamp then event ID, and
clamps a finite integer `limit` to 1–60. Valid
unknown Job IDs and unknown Task filters return empty arrays, matching the Node
history API. The route keeps newest-first ordering and ignores order/cursor
query parameters just like the Node Dashboard wrapper; it does not expose
cursor pagination. The production Node Dashboard reads the Events Bus history
service (`src/dashboard-data.ts` -> `src/events-bus-runtime.ts`), whose global
cursor is not present in the Rust SQLite inbox/outbox. It does not read the
production Events Bus history or change lifecycle state. The Rust server serves the **exact original Node Dashboard HTML, CSS, and
JavaScript bytes** generated from `src/dashboard-html.ts`. It does not
rewrite the browser client, monkey-patch `fetch`, change its controls, or
replace Mermaid. The original Mermaid 11 CDN URL is preserved and the Rust
Content-Security-Policy permits that same URL. The client has a byte-for-byte
parity test: `node rust/scripts/verify-original-dashboard-ui.mjs`.

Rust implements the original `/api/jobs`, `/api/job`, `/api/usage`,
`/api/graphs`, `/api/graph-symbol`, `/api/decision-audit`,
`/api/execution-router-rules`, and `/api/troubleshooter-qa` routes,
keeping their original response shapes. The Usage backend reads real
OpenAI/Codex and Z.ai quota windows plus DeepSeek/OpenRouter credits
read-only. Unavailable provider values remain unavailable, never replaced
by inferred Job counts. Expensive probes are cached for 30 seconds.

Some backend functionality remains incomplete: the old Events Bus history
is read via its authoritative local Events Bus API, not reconstructed from SQLite;
the true new Router Test action is not connected; and Job/Task lifecycle mutations are not
available through the Dashboard. Such gaps must be fixed in the Rust
backend, **not** through alternative frontend implementations. Configuration
writes are restricted to local same-origin requests; the public tunnel
cannot change Router Rules or Troubleshooter Q&A. Native Graph/CLI commands
remain the authority for lifecycle transitions. Client reuse is not evidence
of full backend API parity.

### Historical Node Relay inventory (Rust read-only bridge)

Optionally pass `--history-db "$HOME/.agents-relay/relay.sqlite"`.
This is a read-only view of former Node Relay Jobs; it does not migrate,
schedule, or combine Jobs with the Rust namespace. `/` reads historical
Jobs and `/rust/` reads Rust-native Jobs. Both pages serve the **same exact**
client bytes; the Rust server selects the proper read-only SQLite authority
using the referring page or an explicit `source=history` query parameter.
Native mutations remain fenced to the `--db` Rust authority. The public
Job/Task read projection omits private worker inputs/outputs, results,
interactive invocation payloads, and local project paths.

Historical Event Bus history is not available from those snapshots.
A historical read-only view is not a cutover of its Jobs to Rust scheduling.

### Authenticated host Preview binding

The isolated native Dashboard can bind a host-owned Review Preview to the
current Task execution through `POST /api/review/preview/begin`. It requires
`RELAY_RUST_REVIEW_HOST_TOKEN` with at least 32 bytes and a matching
`Authorization: Bearer …` header. The JSON body contains only `jobId`,
`taskId`, and `executionId`, with optional exact revision fields (`revision`,
`contentHash`, `revisionId`, `requestId`, `idempotencyKey`, and `previewId`).
When those fields are supplied, the endpoint requires a complete consistent
content identity and persists it with the execution binding. It rechecks that
the Job is active and the Task is running in that exact execution. Replaying
the same request returns the binding without a
new snapshot write, including after a Dashboard restart. The authenticated
`POST /api/review/preview/decision` route accepts the host decision envelope
and delegates identity, revision, graph, and deduplication checks to the
durable Review authority. Accepted decisions enter the host decision ledger;
the daemon performs the Graph-selected resume. A delivery receipt alone does
not resume or complete a Task. These routes are isolated-pilot evidence, not
the production control API or a physical host/mobile Review test.

The isolated daemon also creates one Graph-selected Troubleshooter Task for
each eligible failed ordinary Task. Creation atomically checks the existing
recovery barrier, allocates a global Task ID, persists the trusted Model route
and failure context, and records one outbox event. A correlated native Model
claim is allowed only while the exact parent is still failed or blocked at the
same attempt. The original failed Task is left unchanged. The daemon requires a
configured Model Troubleshooter; if none is available, it keeps the failed
work unresolved and reports the missing route. Plan-failure recovery and the
broader production Troubleshooter retry/escalation scheduler remain incomplete.

Build and start the native service with an explicitly selected, already
initialized Rust live-namespace database:

```sh
cargo build --locked --manifest-path rust/Cargo.toml --bin relay-native-dashboard
RELAY_RUST_LIVE_MODE=pilot-live rust/target/debug/relay-native-dashboard \
  --db "$HOME/.local/state/agents-relay/rust-live/relay.sqlite" --port 8788
```

The entrypoint binds only to loopback and rejects paths outside the marked Rust
namespace. Do not point it at the Node production database.

This live namespace is a verified Rust scheduler in a running native service,
but is NOT a full Node.js Relay production cutover. In particular, existing
Node.js Jobs still need their own Reconciler and Review/JEL guarantees.

## Read-only Job and Task CLI inspection

The shadow CLI has a small inspection surface matching the Node CLI record
shapes. Every command requires an explicit database path and Job ID; Task show
also requires a Task ID:

```sh
agents-relay-rust job show --db /path/to/relay.sqlite --job-id 101
agents-relay-rust task list --db /path/to/relay.sqlite --job-id 101
agents-relay-rust task show --db /path/to/relay.sqlite --job-id 101 --task-id 42
```

These inspection commands use `RelayReader` and return the Job, its Task array,
or one Task as JSON. They do not discover a default store, mutate SQLite,
launch workers, or provide production CLI/API parity. The separate
`escalation run` effect below does not access a Relay store. The existing
`store list/get` commands remain available.

## Configured escalation executor

`agents-relay-rust escalation run` follows the canonical
`workflow/escalation.mmd` graph and invokes only the absolute executable named
by trusted deployment configuration `AGENTS_RELAY_ESCALATION_COMMAND`. The
value may be an absolute executable or a JSON argv array beginning with one;
Task text is written to a private handoff file and never interpreted by a
shell. The executor receives `--handoff-file`, optional
`--on-needs-user-file`, and optional `--cwd`. It must return exactly one JSON
object with `status` equal to `resolved`, `failed`, or `needs_user` and a
non-empty `summary`. Missing executors, nonzero exit, timeouts, malformed or
oversized output map to technical failure, never successful recovery or proof
of a human blocker. This command does not mutate durable Task recovery state;
daemon Troubleshooter reconciliation remains incomplete. The native
`RelayAuthority` also exposes Graph-selected transactional effects to assign
`escalation_gate` ownership to the original failed Task, block the same
Troubleshooter Task, and queue that Task after a response. Those effects are
covered against SQLite restart and replay; the production authenticated
control API and daemon scheduler do not call them yet.

```sh
AGENTS_RELAY_ESCALATION_COMMAND='["/opt/relay/escalation-adapter","fixed-arg"]' \\
  agents-relay-rust escalation run --intent-file ./intent.md \\
    --blocked-on-file ./blocked-on.md --cwd /path/to/project
```

## 2026-11-14 native Job intake, completion and outbox increment

The isolated native Rust pilot can now perform **Job creation, global Job/Task ID
allocation, idempotent replay, Graph-owned Job activation and no-review local
completion**, without invoking the Node.js CLI to seed a Job. Its
relay-native-job CLI uses the same V2 SQLite job_snapshot authority,
with init/create/activate/show/complete operations. The init command is
restricted to marked temporary roots; production stores remain blocked.
A Coordinator DAG may be created from a project-local Mermaid file and
execution-bound input file. Graph decisions are made from the canonical
workflow/job-lifecycle.mmd, not a second Rust-only state machine.

The `relay-native-job task create` action adds a guarded ordinary Task to an
existing Job in that same isolated SQLite authority. It accepts inline or
root-local file input, task-pr/file output, priority, story size, parent and
dependency metadata. The Task Lifecycle Graph selects its initial state from
dependency facts; the Job Lifecycle Graph activates a DRAFT Job. IDs and the
snapshot commit in one SQLite transaction. The command requires an explicit
`--db` and `RELAY_RUST_EXPERIMENTAL_TEST_ONLY=isolated-test`; it rejects the
Rust live namespace and does not schedule workers. This bounded mutation does
not provide production CLI/API or service parity.

Example:

```sh
relay-native-job task create --db /tmp/relay-rust-authority-demo/relay.sqlite \\
  --job-id 101 --input-file /tmp/relay-rust-authority-demo/task.md \\
  --output task-pr --story-size M --priority P1
```

The native daemon closes a Job only when all tasks succeeded, the
Job explicitly disabled both Final Review and auto-merge, there are no active
interactive Review/Plan/resolution states, and the canonical Job Graph permits
local.completed. Review-enabled, merge-enabled, failed, paused and incomplete
Jobs remain ACTIVE. Job completion never fabricates human approval or merge.

An optional relay-native-daemon --nats-port PORT publishes its durable
SQLite task-event outbox to the explicit local Core NATS port, with bounded
transport envelope, stable deduplication event IDs and PING/PONG confirmation
before marking the outbox published. A disconnect or missing PONG leaves the
record pending; a PONG is not a delivery guarantee to an individual observer.
The daemon does not publish any events by default. The actual Neo Events
Bus/Chat Gateway production service has not been cut over.

For isolated native runtime work, `relay-native-daemon --loop ...
--nats-ingress-port PORT` also subscribes to `relay.events.job.*.task.*` on
loopback Core NATS. Both ingress and outbox can use deployment-provided
`AGENTS_RELAY_NATS_TOKEN` or the paired `AGENTS_RELAY_NATS_USERNAME` and
`AGENTS_RELAY_NATS_PASSWORD`; token and user/password modes cannot be mixed.
Secrets are not accepted on argv or written to diagnostics. TLS-required
servers fail closed because this pilot transport is plaintext-only. Ingress
validates correlated worker lifecycle, interactive-wait, and Review-decision
events against the current SQLite Job/Task/execution and the canonical Task
Graph. Review decisions additionally require the durable invocation/content
identity ledger. This bounded pilot ingress does not establish production
Events Bus, production host Preview, or service parity.

A real Codex calculator and a Vlog pilot using three original private MOV/VTT
files were separately tested through native Rust Job creation and Daemon
execution: calculator generated a standalone HTML/JS page with passing
Node tests; Vlog created a private six-second MP4 with all five DAG agents
plus Coordinator succeeding and publisher skipping unauthorized posting.
Both isolated test Jobs reached COMPLETED and resisted duplicate execution
across subsequent daemon ticks. This is not proof of Neo Mobile
Request Changes/Approve Review, full Markcut editing/render, JEL
review/merge/revision or production crash recovery parity. The production
TypeScript daemon remains the sole live writer for ordinary user Jobs.

Test commands:
    cargo build --manifest-path rust/Cargo.toml --bins
    node --test rust/tests/native-job-lifecycle-e2e.mjs

relay-native-job requires RELAY_RUST_EXPERIMENTAL_TEST_ONLY=isolated-test
and explicit, already marked private temporary directories. It deliberately
does not support a production database override.

## 2026-11-14 isolated native DAG / Review increment

The **isolated test daemon only** now drives Coordinator activation, atomic
Script/Model DAG child materialization, predecessor output handoff and
Coordinator completion using the canonical Graph and SQLite authority. It
passes immutable task input to Script as well as Model processes, distinguishes
logical Coordinator state from physical Worker claims, and refuses DAG output
paths outside its disposable root. An `approved` interactive Review can resume
the **same Task** only with a matching durable host decision; a forged
`approved` field also fails the Worker claim. An accepted `changes_requested`
decision requeues that same Task as a Model revision. A pre-existing trusted
Model route is preserved; a Script-origin Task has its Script route cleared
and remains unclaimable until a trusted Model route is supplied. The revision
retains the human feedback and instructions. A later accepted Approve restores
the original execution configuration and Task input, then queues the same
Task without treating the decision as completion. The isolated daemon does
not create or deliver the host Preview itself; real host Preview, notification,
mobile and production event integration remain unverified.

The added `native-dag-daemon-e2e.mjs` and
`native-review-resume-daemon-e2e.mjs` run real isolated Rust processes; their
synthetic approval receipts are test fixtures, not Neo Mobile approvals. The
production Node.js daemon remains the sole writer for actual Vlog Jobs.

## Graph-selected downstream dependency revisions

The isolated Rust dependency reconciler now reads `workflow/dependency-revision.mmd`
through the shared Graph dispatcher. For a succeeded downstream Task with an
explicit `revalidate` or `rerun` edge, it waits until every revised upstream
Task settles, forms a stable evidence vector from the latest successful
upstream Task ID and attempt, and creates one same-lineage child for that
vector. The child keeps `parentTaskId` pointed at its original semantic owner;
its `dependencies` separately include the owner and the selected upstream
evidence Tasks. `rerun` is selected if any changed edge requests rerun;
otherwise the Graph selects revalidation. Duplicate vectors are idempotent
across daemon ticks and SQLite reopen.

If upstream evidence changes while a revision child is still queued, the
dependency Graph selects stale marking and the Task Lifecycle Graph cancels
that child before creating any replacement. Native Script claims and terminal
completion also reject a stale revision vector. This is isolated parity only:
it does not prove full DAG, provider, scheduler, or production parity, which
remains `FAIL` in `docs/rust-parity-matrix.json`.

Focused checks (all stores isolated with `AGENTS_RELAY_STORE_DIR`):

```sh
AGENTS_RELAY_STORE_DIR=$(mktemp -d) cargo test --locked --manifest-path rust/Cargo.toml authority::dependencies::tests
AGENTS_RELAY_STORE_DIR=$(mktemp -d) cargo test --locked --manifest-path rust/Cargo.toml stale_dependency_revision_cannot_commit_worker_completion
```

## Architecture boundary

- **Graph (`src/graph.rs`, `src/graph/parser.rs`)** parses the same strict Mermaid profile that
  `src/workflow/graph-v2.ts` uses. It returns a deterministic decision, including
  ordered actions and emitted event IDs; it does not execute actions or publish.
- **Dispatcher (`src/dispatch.rs`)** implements Graph-authorized transition
  persistence ordering, action receipts, failure events, and success emission
  via an injected port. The CLI only has a mock trace port; it does not write
  the Relay database or run an external effect.
- **Read-only store (`src/store.rs`)** opens an **explicit** SQLite path and
  inspects the existing `job_snapshot` table. It cannot write or migrate.
- **Transactional authority (`src/authority.rs`, `src/authority/*`)** opens
  only existing SQLite files and atomically mutates `job_snapshot`,
  `workflow_event_outbox` and `workflow_event_inbox`, with immutable Job
  identity, terminal-state protection, WAL atomic rollback, event-key
  collisions and monotonic timestamps. It also implements global Job/Task
  IDs, idempotency, Action Attempt Ledger, lease fencing, PID/PGID identity
  rows, and unified/legacy Projection Outbox claiming and receipts. **These
  APIs are library-only and are not connected to production Relay.**
- **Task lifecycle (`src/lifecycle.rs`)** applies the canonical
  `workflow/task-lifecycle.mmd` transition in an SQLite transaction,
  checking execution identity. Only pure, implemented mutations are allowed;
  unsupported effects fail closed. The Script Worker fixture explicitly
  launches an external process as a separate, verified effect.
- **Native Worker (`src/worker.rs`, `src/bin/relay-worker-helper.rs`)** runs
  an executable with `Command` (no shell injection or inherited environment),
  isolated OS process group, output streams to log files, exact PID callback,
  timeout, cancellation, and process-group cleanup. The helper uses private
  newline-delimited JSON, requires an `ack` after launch identity persistence,
  and stops a Worker on parent death, stdin disconnect or SIGTERM.
- **Agent Graph DAG (`src/agent_graph.rs`, `src/authority/coordinator.rs`)**
  parses canonical `agentGraph` nodes/edges/waves and now materializes ordinary
  child Tasks. Graph checkpoint, ready predecessor facts, scoped idempotency,
  **global Task ID allocation and Job snapshot update** share one IMMEDIATE
  SQLite transaction. Multiple concurrent Coordinator ticks cannot create a
  second child Task. Full production DAG scheduling and agent discovery are
  not connected to Rust yet.
- **Review (`src/authority/review.rs`, `src/authority/review/resume.rs`)**
  validates current execution, invocation and revision against canonical
  `interactive-invocation.mmd`, persists decision/event ledgers atomically and
  calculates the TypeScript-compatible fingerprint. An accepted decision can
  resume the **same** Task via `task-lifecycle.mmd`, clear old lease, reset
  attempts, append human feedback and reroute a scripted DAG Task to its
  Model revision worker. These are explicit library calls, not a host/mobile
  notification or production Review endpoint.
- **Native Worker Scheduler (`src/authority/scheduler.rs`,
  `src/native_script.rs`, `src/native_model.rs`)** has atomic Script and
  explicitly routed Codex/Model Task claims: canonical
  `effect.launchTask`, Task Lease, Attempt, Execution History and Action Ledger
  are written in **one SQLite transaction**. A second CAS on the same Action
  Ledger prevents a copied claim from launching the same generation twice.
  The isolated native Worker adapter records real PID/PGID/start-token,
  requires correlated, bounded structured `COMPLETED` output rather than
  exit code alone, and commits result, terminal event, and verified launch
  Action Ledger receipt in **one** SQLite transaction. A Model Task must
  preserve both durable Worker Router and Model Router decisions, and provide
  an exact `task.completed` execution-bound receipt. Worker exit code zero
  cannot stand in for an event. It verifies Lease, Owner, Attempt,
  Execution History and pause
  fences; no Task success implies Job completion. The **production daemon
  and worker routing still belong to TypeScript**; the native adapter is not
  currently a supervised, crash-recovering production service.
- The isolated daemon claims each ready Task through that same Graph-selected
  transaction, then runs distinct claims concurrently up to `max_tasks`, with
  one SQLite connection per supervised Worker. Dependency and stale-revision
  guards stay in the claim action; the logical DAG Coordinator has no lease or
  physical slot. This bounded pilot behavior is not production scheduler parity.
  `rust/tests/native-daemon-e2e.mjs` exercises a mixed Script/Model batch,
  configured capacity, a Model dependent released by a completed Script, and
  restart dedupe; scheduler launch actions run through the shared Graph
  dispatcher and reserve their ledger receipt in the same SQLite transaction.
- **Single-node isolated daemon (`src/single_node.rs`,
  `src/native_daemon.rs`, `src/native_daemon/adapter.rs`,
  `src/bin/relay-native-daemon.rs`, `src/supervised_script.rs`)** executes
  multi-Job Script and explicitly configured Model-port Task loops, with canonical dependency reconciliation
  inside the Job snapshot transaction, SQLite launch CAS, parent-death-safe
  `relay-worker-helper` startup ACK, exact PID/PGID/start-token registration,
  bounded correlated Worker output, and transactional terminal Task state.
  A nonblocking OS file lock permits **one daemon process per SQLite store**;
  that lock is held across idle `--loop` ticks and released automatically on
  exit/SIGKILL (CLOEXEC; not held by the Worker helper). There is deliberately
  **no multi-node design**. It runs `--once` or `--loop`, handles SIGTERM/SIGINT
  by cancelling the helper, and never creates a second scheduler database. Native recovery requires the
  original OS process identity to be demonstrably gone or reused; a missing
  or unknown PID **blocks** mutation, and proven expiration becomes FAILED,
  not a speculative successful completion or automatic retry. Its binary
  **refuses all production stores**: only a marked, explicitly supplied
  temporary SQLite path and `RELAY_RUST_EXPERIMENTAL_TEST_ONLY=isolated-test`
  are accepted. Script and Model-port executables come solely from a small,
  explicitly supplied trusted role manifest; no embedded shell, environment
  inheritance, implicit model provider or Neo integration is added to Relay.
  The test Model E2E uses a real child process with a **fixture provider**, not
  a verified live Codex service; real provider integration is still pending.
- **Final Review readiness (`src/final_review.rs`)** derives conservative
  durable facts for the canonical `review-lifecycle.mmd` and emits a **read-only**
  `review.create` proposal against a caller-verified local Git head. It gates
  active work, Plans, Troubleshooter recovery, current reviewer and stale
  SHA. It neither creates the Reviewer Task nor generates approval/merge.
- **Dependency scheduler (`src/reconcile.rs`)** computes read-only Graph
  proposals from SQLite. It detects cycles but never dispatches workers.
  Review-revision eligibility is explicitly unsupported and fails closed.
- **Recovery inspector (`src/recovery.rs`, `src/authority/process.rs`)**
  checks lease expiry and exact host/PID/PGID/start-token identity, then asks
  canonical Task Graph for failure actions. Unknown process identity or
  another active owner blocks recovery. The inspector is read-only; an
  explicit, transactionally re-probed native recovery Action may mark a
  demonstrably expired and terminated execution FAILED. Full production
  restart ownership/cleanup remains unported.
- **CLI (`src/main.rs`)** gives reproducible JSON interfaces for graph
  inventory/validation/batch decisions, simulated Action dispatch traces,
  and store list/get, plus read-only `scheduler inspect`,
  `scheduler recovery`, `review inspect`, and `dag parse`. It is not the
  production Relay CLI and cannot launch an agent.
- **Local Git (`src/local_git.rs`)** lets `review inspect` resolve the durable
  Job's actual worktree HEAD without spawning a process or accepting a caller-
  supplied SHA. It handles detached, loose, packed, linked-worktree, SHA-1 and
  SHA-256 metadata and rejects malformed or symlinked metadata. The daemon does
  not yet use this resolver to schedule reviewers.
- Neither Rust nor TypeScript may duplicate canonical Graph policy, and neither
  may create separate job/event stores. `workflow/*.mmd` remains authoritative.
- No Neo-specific binaries, MCP tools, permissions, worker providers, or
  platform names are needed for this Rust implementation.

## Build and test

From the repository root:

```sh
npm run build
cargo test --locked --manifest-path rust/Cargo.toml
cargo clippy --locked --manifest-path rust/Cargo.toml --all-targets -- -D warnings
cargo build --locked --manifest-path rust/Cargo.toml --all-targets
node --test rust/tests/*.mjs
cargo build --locked --release --manifest-path rust/Cargo.toml
```

This runs Rust unit tests, Clippy, all-target test binary builds and
TypeScript/Rust differential tests. Tests use marked temporary directories
and isolated SQLite fixtures, never the default `~/.agents-relay/stores` path.
The main `agents-relay-rust` CLI uses read-only `--db` commands and the
configured, store-independent escalation executor above.
The separate, marked-fixture-only `relay-native-daemon` binary exercises
native SQLite writes and real Script Workers. Production Relay does not
load this binary or switch providers.

## Experimental native daemon (temporary test stores only)

The **separate** `relay-native-daemon` executable refuses the production
`~/.agents-relay/stores` directory. Use a new, privately owned directory under
`$TMPDIR` with a name prefixed `relay-rust-authority-`, an existing V2 SQLite
`job_snapshot` database, and a sibling
`.relay-rust-authority-isolated-test` marker. Provide a trusted manifest in
that same directory (example):

```json
{
  "agents": {
    "build-agent": {
      "executable": "/bin/sh",
      "args": [
        "-c",
        "printf '{\"jobId\":\"%s\",\"taskId\":\"%s\",\"executionId\":\"%s\",\"status\":\"COMPLETED\",\"output\":{}}' \"$RELAY_JOB_ID\" \"$RELAY_TASK_ID\" \"$RELAY_EXECUTION_ID\" > \"$RELAY_RESULT_PATH\""
      ]
    }
  }
}
```

Then run in an explicitly isolated environment:

```sh
RELAY_RUST_EXPERIMENTAL_TEST_ONLY=isolated-test \
  rust/target/debug/relay-native-daemon --once \
  --db "$TEST_ROOT/relay.sqlite" --manifest "$TEST_ROOT/manifest.json" \
  --helper "$(pwd)/rust/target/debug/relay-worker-helper"
# Substitute --loop --interval-ms 1000 to poll until SIGTERM/SIGINT.
```

`--once`/`--loop` use the **same** Graph/SQLite path and an exclusive
single-node OS lock. Ordinary Script Tasks and an explicitly configured,
**already routed Codex/Model Worker port** are implemented in this fixture.
The model command must be supplied by the caller's trusted manifest: a
`kind: "model"` entry with absolute `executable` and `args`. It reads a private,
0600-permission `RELAY_TASK_REQUEST_PATH` JSON file (Job/Task/Execution/Owner,
Task input, Attempt, `workerSelection`, `routing`) and writes a JSON event to
`RELAY_RESULT_PATH` with **exactly** these correlated fields plus:

```json
{
  "type": "task.completed",
  "status": "COMPLETED",
  "adapter": "codex",
  "summary": "Worker reported completion with correlated evidence",
  "output": {"artifact": "example"}
}
```

The listed fields augment the required identity/routing copies from the
request. The Rust bridge rejects missing, stale, mismatched, symlinked or
oversized receipts. It uses the **existing** Graph to commit terminal Task
state, result, outbox event and launch receipt together. The manifest is a
provider **port**, not a built-in Codex worker or execution router. A real
Codex provider bridge and prompt/agent discovery have not yet passed E2E.
Browser, Planner, Reviewer, Troubleshooter and full Coordinator/JEL execution
remain unported. Worker exit code 0 alone is never Task success; Job stays
ACTIVE for independent Final Review.

The test suite executes real `SIGKILL`/`SIGTERM` on the daemon and verifies
that the helper reaps the worker process group. Recovery tests advance only
the disposable SQLite clock to simulate a lease expiration and verify a
single `task.failed` event, no repeat launch, and no false completion.

## CLI examples

```sh
rust/target/release/agents-relay-rust graph inventory --dir workflow
rust/target/release/agents-relay-rust graph validate --graph workflow/task-lifecycle.mmd
rust/target/release/agents-relay-rust graph decide \
  --graph workflow/task-lifecycle.mmd \
  --request '{"currentState":"DRAFT","input":{"transport":"event","id":"release","payload":{}},"guards":{}}'
# Substitute "simulate" for "decide" and provide "receipts" in the request
# to inspect action/emit ordering through an entirely in-memory mock adapter.
rust/target/release/agents-relay-rust store list --db /path/to/explicit/test.sqlite --limit 20 --offset 0
rust/target/release/agents-relay-rust store get --db /path/to/explicit/test.sqlite --job-id 123
rust/target/release/agents-relay-rust scheduler inspect --graph workflow/task-lifecycle.mmd \
  --db /path/to/explicit/test.sqlite --job-id 123
rust/target/release/agents-relay-rust dag parse --file /path/to/agentGraph.mmd
rust/target/release/agents-relay-rust review inspect \
  --db /path/to/explicit/test.sqlite --job-id 123
rust/target/release/agents-relay-rust scheduler recovery \
  --db /path/to/explicit/test.sqlite --job-id 123 --task-id 456 \
  --now 2026-11-13T21:00:00Z --owner-activity inactive
```

`graph batch --graph <file>` reads one JSON decision request per line on stdin
and emits one JSON decision/error per line. A request supplies `currentState`,
`input` (`transport`, `id`, `payload`) and explicit boolean guard results.
**Guard evaluation in production must remain bound to authoritative SQLite
facts**; the CLI guard map exists solely for deterministic parity testing.

## Review hardening and parity boundaries

The Rust shadow engine preserves the TypeScript Graph parser's accepted
Mermaid syntax (including whitespace in initial directives and ignored
non-executable Action edges). Input Events/Actions absent from the derived
registry are errors, not ordinary no-transition results. Action Receipt
payloads are preflight-checked **before** any per-action event publication;
a malformed/null receipt cannot be silently considered successful. These
rules have targeted adversarial and topology differential tests.

Rust deliberately enforces the *typed* `ActionReceipt` object contract
more strictly than permissive JavaScript primitives. Actual production
Graph input and emitted-event payload validators are still TypeScript-owned;
the current mock ports do not implement them. The shadow CLI must not be
wired into the production reconciler until validator parity and L3 recovery
are implemented and verified. SQLite stays explicit-path/read-only, including
when a TypeScript writer uses WAL mode.

## Physical and cross-language verification

The Rust integration fixture binaries in `rust/examples/` require:

- `RELAY_RUST_EXPERIMENTAL_TEST_ONLY=isolated-test`;
- an **existing** SQLite database in a temporary directory whose leaf name
  begins `relay-rust-authority-`;
- a sibling `.relay-rust-authority-isolated-test` marker file.

No production SQLite connection, state-changing command or worker execution
is exposed from `agents-relay-rust` main CLI. The Rust test commands above verify:

- TypeScript Job write → Rust transactional update/event/inbox → TypeScript
  read, plus cross-language global Task ID and idempotency compatibility.
- Unified Projection Outbox: TypeScript enqueue → Rust claim/complete →
  TypeScript receipt, including stale-claim and retry/backoff protection.
- Real native `/bin/sh` Script Worker through DRAFT → QUEUED → RUNNING →
  SUCCEEDED, with canonical Graph, persisted launch ledger/lease, real PID,
  process output, durable completion event and TypeScript readback.
- AgentGraph Mermaid DAG topology and wave ordering against TypeScript,
  then Rust Coordinator start → parallel root materialization → dependent
  child materialization → completion → TypeScript Job readback, including
  ID reuse across twelve concurrent Rust writers and failed-write rollback.
- Current invocation/revision Review acceptance, fingerprint parity with
  nested comments, TypeScript duplicate/stale recognition and same-Task
  `changes_requested` resume with Model routing and feedback comments.
- Recovery inspection parity against TypeScript `lease.expired` Graph actions;
  real OS process probes distinguish live/terminated/reused/unknown PID.
- Twelve concurrent native Scheduler contenders create exactly one durable
  Script claim **and** Action Ledger entry; twelve copied launch claims have
  exactly one successful CAS. Paused/unready tasks cannot claim.
- Real native Worker completes only with `status=COMPLETED` and matching
  Job/Task/Execution identity. Exit code 0 with absent or stale output is a
  Graph-authorized FAILED Task, never a false SUCCEEDED Job.
- Verified completion and output are one SQLite transaction; stale Lease,
  pause and wrong generation cannot produce Task success.
- Final Review read-only Graph decision parity across 12 TypeScript scenarios
  including current/old head, active Reviewer, pending Planner and unresolved
  Troubleshooter; no automatic Review approval or Merge.
- Worker helper's real parent SIGKILL: Rust detects parent loss and reaps
  the child process group, plus standalone normal completion and logs.
- Graph parsing, action receipts, invalid input, dependency proposals and
  SQLite snapshot behavior against TypeScript; malformed graph rejections.

## Migration gates still outstanding

1. Port full Task/Plan/Job field normalization, event payload validators,
   condition/guard facts, and atomic job / action outcome bookkeeping.
2. Extend the **single-node** isolated daemon toward an authorized local
   Scheduler/Coordinator, with safe production store ownership and backpressure.
   Port the actual Codex/provider adapter (the current Model port is a fixture
   interface), Browser Worker, agent discovery/prompt assembly, event wakeups,
   Planner and Reviewer Task materialization, Review verdicts, JEL revision
   rounds and merge gates.
   Do not introduce a parallel lifecycle policy.
3. Port remaining projection conflicts/repairs, crash/restart reconciliation,
   verified orphan cleanup, retry action execution, and daemon/REST/CLI/
   Events Bus integration. Recovery *inspection* is read-only; a separate
   Graph-selected test-only executor can persist proven expired failures.
4. Pass existing L1/L2/L3, review changes/approve, crash/restart, single-node
   daemon exclusion, and **real** end-to-end notification/UI gates with the Rust
   backend as the **sole writer** on a disposable store. Fix any existing
   broken baseline tests before production cutover.
5. Compare memory/CPU/throughput under identical single-host workloads and
   perform one deliberate daemon cutover with rollback; never dual-write the
   production SQLite store.

**Current status:** SQLite atomic primitives, Script and explicit Model-port
claims, one-time launch CAS, OS-locked **single-node** daemon (test-only),
helper-supervised workers, Coordinator DAG child creation, interactive Review
resume, read-only Final Review gating and safe expired-process failure handling
are implemented. **Production Relay remains TypeScript**. Real provider
integration, Model/Browser Router ownership, Planner, Reviewer, JEL convergence,
full production recovery and Events/REST ingress are missing. No cutover is
authorized, and no multi-node support is planned.

## Full TypeScript L3 migration gate — not green

This stage ran `npm run test:verification:l3` on a disposable, isolated
TypeScript store while Rust remained disconnected from the production daemon:
**78 total, 65 passed, 12 failed, 1 skipped**. Failing scenarios cover Job
481 replay proof, Planner/worker/Reviewer fault recovery, Troubleshooter,
human escalation, Final Review and a review-to-merge convergence path.
The untouched TypeScript baseline had independently shown failures in these
areas before the Rust migration. Rust changes in this stage do not alter the
TypeScript scheduler, tests, or graphs, and cannot establish a full L3 pass.

The focused `npm run test:l3:dag` **does** pass all 22 Coordinator/Review
scenarios, including changes-requested and re-approval. Do not confuse those
gates. The Rust public CLI stays read-only and Rust writer library operations
remain isolated from production SQLite until full convergence/recovery gates
are independently green.
