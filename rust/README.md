# Relay Rust backend — shadow implementation

This is the first **executable** Rust slice of Agents Relay V2, not a second
workflow authority or a replacement for the production scheduler.

## Architecture boundary

- **Graph (`src/graph.rs`, `src/graph/parser.rs`)** parses the same strict Mermaid profile that
  `src/workflow/graph-v2.ts` uses. It returns a deterministic decision, including
  ordered actions and emitted event IDs; it does not execute actions or publish.
- **Dispatcher (`src/dispatch.rs`)** implements Graph-authorized transition
  persistence ordering, action receipts, failure events, and success emission
  via an injected port. The CLI only has a mock trace port; it does not write
  the Relay database or run an external effect.
- **Store (`src/store.rs`)** opens an **explicit** SQLite path read-only and
  inspects the existing `job_snapshot` table. It does not create databases,
  migrate schemas, claim leases, enqueue outbox entries, or change job state.
- **CLI (`src/main.rs`)** gives reproducible JSON interfaces for graph
  inventory/validation/batch decisions, simulated Action dispatch traces,
  and store list/get. It is not the
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

This runs the Rust unit suite, Clippy, and differential tests against the
TypeScript GraphRuntime and TypeScript-created SQLite fixtures. It **never**
uses the default `~/.agents-relay/stores` path. The binary accepts a database
only when the operator passes `--db` explicitly.

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
```

`graph batch --graph <file>` reads one JSON decision request per line on stdin
and emits one JSON decision/error per line. A request supplies `currentState`,
`input` (`transport`, `id`, `payload`) and explicit boolean guard results.
**Guard evaluation in production must remain bound to authoritative SQLite
facts**; the CLI guard map exists solely for deterministic parity testing.

## Migration gates before any production switch

1. Expand Rust Store from snapshot reads to transaction-safe effects, leases,
   outbox and idempotent receipts, always with an isolated SQLite fixture first.
2. Port the Graph dispatcher, receipt validation, durable state transitions and
   event publishing without duplicating Graph decisions in code.
3. Port WorkerAdapter, DAG Coordinator, task/job reconciler, review and JEL,
   CLI/REST/Events Bus, retry/recovery/merge, retaining identical contracts.
4. Pass existing L1/L2/L3 lifecycle and review gates, crash/restart and
   concurrently running job tests with a **single authoritative writer**.
5. Compare memory, CPU, throughput, and latency under identical workloads;
   switch one isolated node only after behavioral parity, with rollback.

**Current status:** Rust shadow Graph parser, decision engine, Action
Dispatcher (mock ports only), and read-only SQLite reader. Tests compare 19
canonical executable workflows (591 guarded decisions), Action receipts and
emission order (35 paths), and real TS-created isolated SQLite snapshots.
No production scheduler, state-changing API, or service startup change is
implemented. Do not label this a complete Rust Relay runtime.

## Known existing TypeScript L3 failures

During this migration experiment, `npm run test:fast` passed (148/148), but
`npm run test:verification:l3` is not green on the **unchanged** TypeScript
main branch. A separate detached baseline worktree reproduced the existing
Planner recovery, Final Review and Review convergence failures without any
Rust changes. Until these failures are repaired and all other L3 scenarios
pass, the Rust backend must stay shadow/read-only. This experimental crate
never changes the production dispatcher or a canonical Relay SQLite store.
