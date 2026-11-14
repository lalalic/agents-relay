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
- **Agent Graph DAG (`src/agent_graph.rs`)** implements the existing `agentGraph`
  parser, preserves insertion-ordered node/agent IDs, rejects cycles and
  computes parallel execution waves. It does **not** materialize Task rows.
- **Dependency scheduler (`src/reconcile.rs`)** computes **read-only** Graph
  proposals from SQLite Job snapshots. It detects dependency cycles but never
  dispatches work. Review-revision eligibility is explicitly unsupported and
  fails closed, rather than skipping those gates.
- **CLI (`src/main.rs`)** gives reproducible JSON interfaces for graph
  inventory/validation/batch decisions, simulated Action dispatch traces,
  and store list/get, plus read-only `scheduler inspect` and `dag parse`.
  It is not the
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
The public CLI has only **read-only** `--db` commands. Its native writer is
currently exported as a Rust library for integration testing; production
Relay does not load it or switch any provider.

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
- AgentGraph Mermaid DAG topology and execution wave ordering against the
  TypeScript parser (valid, invalid, branching and cycle cases).
- Worker helper's real parent SIGKILL: Rust detects parent loss and reaps
  the child process group, plus standalone normal completion and logs.
- Graph parsing, action receipts, invalid input, dependency proposals and
  SQLite snapshot behavior against TypeScript; malformed graph rejections.

## Migration gates still outstanding

1. Port full Task/Plan/Job field normalization, event payload validators,
   condition/guard facts, and atomic job / action outcome bookkeeping.
2. Port durable Graph dispatch for **all** mutation/effect IDs, worker routing,
   model and browser adapters, Scheduler/Coordinator, DAG Node creation,
   review and JEL without making second procedural lifecycle decisions.
3. Port full projection operations (conflict classification and repair),
   persistent retry/recovery and independent daemon/REST/CLI/Events Bus.
4. Pass existing L1/L2/L3, review changes/approve, crash/restart, multi-node
   concurrency, and **real** end-to-end notification/UI gates with the Rust
   backend as the **sole writer** on a disposable store. Fix any existing
   broken baseline tests before production cutover.
5. Compare memory/CPU/throughput under identical workloads and switch nodes
   deliberately with rollback, never dual-writing a production SQLite store.

**Current status:** native SQLite authoritative primitives, Script Worker,
conditional Task lifecycle, DAG topology parser, and read-only Graph dependency proposals are real,
but **production Relay remains TypeScript**. A complete Rust Relay switch is
not authorized by this experimental stage.

## Known existing TypeScript L3 failures

During this migration experiment, `npm run test:fast` passed (148/148), but
`npm run test:verification:l3` is not green on the **unchanged** TypeScript
main branch. A separate detached baseline worktree reproduced the existing
Planner recovery, Final Review and Review convergence failures without any
Rust changes. Until these failures are repaired and all other L3 scenarios
pass, the Rust backend must stay shadow/read-only. This experimental crate
never changes the production dispatcher or a canonical Relay SQLite store.
