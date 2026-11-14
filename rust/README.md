# Relay Rust backend — staged native rewrite

The Rust rewrite now includes a **real transactional SQLite backend** and a
**physical native Script Worker** in addition to the Graph shadow engine. It
is **not** a production Relay replacement yet: the installed TypeScript
Reconciler remains the single production writer/scheduler until L1/L2/L3,
Review/JEL/DAG and recovery equivalence gates are met.

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
- **Native Script Scheduler (`src/authority/scheduler.rs`,
  `src/native_script.rs`)** now has an atomic Script Task claim: canonical
  `effect.launchTask`, Task Lease, Attempt, Execution History and Action Ledger
  are written in **one SQLite transaction**. A second CAS on the same Action
  Ledger prevents a copied claim from launching the same generation twice.
  The isolated native Worker adapter records real PID/PGID/start-token,
  requires correlated, bounded structured `COMPLETED` output rather than
  exit code alone, and commits result + Task Graph state in one transaction.
  It verifies current Lease, Owner, Attempt, Execution History and pause
  fences; no Task success implies Job completion. The **production daemon
  and worker routing still belong to TypeScript**; the native adapter is not
  currently a supervised, crash-recovering production service.
- **Isolated native daemon (`src/native_daemon.rs`,
  `src/bin/relay-native-daemon.rs`, `src/supervised_script.rs`)** now executes
  actual multi-Job Script Task loops, with canonical dependency reconciliation
  inside the Job snapshot transaction, SQLite launch CAS, parent-death-safe
  `relay-worker-helper` startup ACK, exact PID/PGID/start-token registration,
  bounded correlated Worker output, and transactional terminal Task state.
  It runs `--once` or `--loop`, handles SIGTERM/SIGINT by cancelling the helper,
  and never creates a second scheduler database. Native recovery requires the
  original OS process identity to be demonstrably gone or reused; a missing
  or unknown PID **blocks** mutation, and proven expiration becomes FAILED,
  not a speculative successful completion or automatic retry. Its binary
  **refuses all production stores**: only a marked, explicitly supplied
  temporary SQLite path and `RELAY_RUST_EXPERIMENTAL_TEST_ONLY=isolated-test`
  are accepted. Script executables come solely from a small, explicitly
  supplied trusted role manifest; no embedded shell, environment inheritance,
  or Neo integration is added to Relay.
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
- Neither Rust nor TypeScript may duplicate canonical Graph policy, and neither
  may create separate job/event stores. `workflow/*.mmd` remains authoritative.
- No Neo-specific binaries, MCP tools, permissions, worker providers, or
  platform names are needed for this Rust implementation.

## Build and test

From the repository root:

```sh
npm run test:rust
npm run build:rust
```

This runs Rust unit tests, Clippy, all-target test binary builds and
TypeScript/Rust differential tests. Tests use marked temporary directories
and isolated SQLite fixtures, never the default `~/.agents-relay/stores` path.
The main `agents-relay-rust` CLI retains only **read-only** `--db` commands.
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

`--once`/`--loop` use the **same** Graph/SQLite path. Only ordinary Script
Tasks have an execution adapter; Model, Browser, Planner, Reviewer,
Troubleshooter and full Coordinator/JEL execution are **not** implemented
by this test daemon. Worker exit code 0 alone is never Task success. The
completed native Script Task leaves the Job ACTIVE for Final Review.

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
  --db /path/to/explicit/test.sqlite --job-id 123 \
  --verified-local-head <local-git-commit-sha>
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
is exposed from `agents-relay-rust` main CLI. `npm run test:rust` verifies:

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
2. Extend the isolated Script-only daemon to a fully supervised, production-
   authorized multi-Job Scheduler/Coordinator (cross-node owner leases,
   production recovery and backpressure); port agent discovery, Model/browser
   adapters, event wakeups, actual Reviewer
   Task materialization, verdict/Review-driven JEL rounds and merge gates.
   Do not introduce a parallel lifecycle policy.
3. Port remaining projection conflicts/repairs, crash/restart reconciliation,
   verified orphan cleanup, retry action execution, and daemon/REST/CLI/
   Events Bus integration. Recovery *inspection* is read-only; a separate
   Graph-selected test-only executor can persist proven expired failures.
4. Pass existing L1/L2/L3, review changes/approve, crash/restart, multi-node
   concurrency, and **real** end-to-end notification/UI gates with the Rust
   backend as the **sole writer** on a disposable store. Fix any existing
   broken baseline tests before production cutover.
5. Compare memory/CPU/throughput under identical workloads and switch nodes
   deliberately with rollback, never dual-writing a production SQLite store.

**Current status:** SQLite atomic primitives, Script claim and launch CAS,
helper-supervised multi-Job Script daemon (test-only), Coordinator DAG child
creation, interactive Review resume, read-only Final Review gating, and safe
expired-process failure handling are implemented. **Production Relay remains
TypeScript**. Full production ownership, Model/Browser/Planner routing,
Final Reviewer execution, JEL convergence and notification/REST ingress are
not implemented. No cutover is authorized.

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
