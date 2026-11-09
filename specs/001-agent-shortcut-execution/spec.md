# Neo Project Agent Shortcut Execution

## User Scenarios & Testing

### User Story 1 — Execute a project Agent Graph directly (P1)

As a project owner, I invoke `neo project run` against a bound project Run and see
real-time node status until the Relay Job has a proven terminal outcome. Relay
uses its existing Agent Graph, lifecycle, SQLite authority and receipts.
Code-shortcut nodes execute directly; uncovered model-backed nodes run using
the existing Relay Worker fallback, rather than a new direct Codex executor.

**Independent test**: A fork/join DAG proves bounded concurrency, dependency
ordering, predecessor-only outputs, live started/progress/terminal events, and
one durable terminal result rather than treating process exit as success.

### User Story 2 — Use code shortcuts and model-backed nodes (P1)

Nodes with an explicit, verified `<agent>.agent.mjs` execute that
module. Nodes requiring a model but lacking a code shortcut use the existing
Relay Worker fallback, including its normal Adapter/model routing and durable
Task lifecycle. No separate direct Codex executor is required.

**Independent test**: Exercise one code-shortcut node and one model-backed
Worker fallback node; assert graph dependencies, canonical Task ownership,
contract-valid outputs, correct routing and no duplicate execution.

### User Story 3 — Resume correlated events safely (P1)

A non-human `WAITING_EVENT` retains execution identity, node, revision,
content hash and receipt across restarts. Independent branches may advance.
Duplicates or stale receipts never advance the graph. Human approvals remain
under authenticated host-invocation authority.

### User Story 4 — Recover ChatGPT/Z failure without a start event (P1)

In **normal Worker mode**, if ChatGPT or Z fails and Relay has **not accepted
the correlated `task.started` event** for that exact execution, automatically
retry the same Task **once** with an eligible Codex worker running its actual
configured default model, **without Troubleshooter**. Preserve the failed
attempt and original execution identity. Apply routing hard gates and never
reroute a Task already started or a Direct Shortcut Job.

**Independent test**: A failed launch, start-ack timeout, explicit failed
worker event, and failed runtime exit without `task.started` each select a
Codex default retry when eligible. A started Task, wrong/stale execution,
missing Codex default, unmet capability/runtime requirement, exhausted
attempts, or a second fallback failure does not. Only one retry is allowed.

**Operational risk**: A missing `task.started` event does not prove the
platform did not execute a request. The retry must retain evidence and be
fenced to an exact failed generation; the operator accepts this residual
duplicate-execution risk for normal Worker mode.

### User Story 5 — Vlog Visioner shortcut (P1)

The Vlog Visioner code shortcut consumes authorized canonical metadata,
uses existing Markcut Vision CLI and `vlog/scripts/index-markcut-vision.mjs`,
and returns `vision-evidence.json` plus companion artifacts without
fabricating observations, approval, uploads or publication authority.

## Requirements

- **FR-001**: Preserve existing normal `job create`, Planner and Worker
  behavior; Direct Shortcut execution is explicitly opt-in and bound to one
  existing Relay Job/Run, without duplicate Job or lifecycle authority.
- **FR-002**: Reuse `parseAgentGraph()`, existing DAG dependencies, bounded
  concurrency and structured predecessor outputs. No second graph parser.
- **FR-003**: Resolve code shortcuts from project agents before Neo shared
  agents, without changing `.agent.md`, project contracts or eval requirements.
- **FR-004**: A model-backed node without an available code shortcut MUST use
  the existing Relay Worker fallback and its configured Worker/Adapter routing.
  Do not create a new direct Codex model executor.
- **FR-005**: Direct Shortcut CLI runs synchronously, emits actual per-node
  started/progress/completed/failed/wait events in real time, and distinguishes
  completed, failed, blocked, timed out and interrupted exit statuses.
- **FR-006**: The Shortcut Graph Executor owns DAG readiness, code-shortcut
  execution and predecessor outputs. Model-backed fallback nodes use the
  existing Relay Worker dispatch without creating another scheduler or
  duplicate Job/Task authority. Preserve Relay SQLite lifecycle, leases and receipts.
- **FR-007**: Missing *code shortcuts* for model-backed nodes MAY select the
  existing Worker fallback according to the Graph contract. Invalid code
  shortcut results, unauthorized effects and failed execution MUST NOT be
  silently treated as successful; recovery follows canonical Relay policy.
- **FR-008**: Non-human `WAITING_EVENT` receipts are node-, execution-,
  revision- and content-hash-bound, duplicate-safe, restart-safe and
  idempotently consumed; human approvals require the existing authenticated
  host-invocation gate, not EventBus publication.
- **FR-009**: Direct mode has one durable 20-minute elapsed budget measured
  from the **first execution**, which resumption cannot reset. Timeout
  cancels only owned work and persists non-success evidence.
- **FR-010**: A real canonical Vlog Run must prove every required node,
  provenance, outputs, adapter/model, elapsed time and terminal result within
  20 minutes before Direct Runner release. Partial Visioner proof or process
  exit is not full-DAG success.
- **FR-011**: A `--dry-run` does not write or dispatch; a repeated invocation
  validates and reuses its bound Job without repeating completed nodes.
- **FR-012**: Shortcut and ordinary Worker outputs follow the same
  stage-specific contracts and evals. No terminal result implies approval,
  publication authorization, automatic merge or paid third-party transfer.
- **FR-013**: Vlog Visioner reuses approved metadata, invokes existing Markcut
  Vision and index tooling, and fails closed on stale hashes, unauthorized
  input, missing evidence or ambiguous observations.
- **FR-014**: For ChatGPT and Z **normal Worker** executions, a
  confirmed failure with **no accepted `task.started` for the exact current
  execution** MUST trigger at most one automatic Codex configured-default
  retry without creating a Troubleshooter, provided remaining attempts,
  compatible hard Worker requirements, provider policy and actual configured
  default model. Never infer success from a process exit.
- **FR-015**: The retry is graph-authorized, generation-fenced, persisted
  atomically with the original route, failure reason and retry marker. The
  previous execution must be cancelled/cleared before dispatch; delayed
  events from its generation cannot finish or start the new execution.
  A second failed generation MUST NOT automatically fall back again.
- **FR-016**: A Task with accepted `task.started`, no confirmed failure,
  a mismatched execution identity, incompatible Codex requirements,
  or an unavailable default model MUST use existing failure/recovery.
  The existing explicit pre-submission safe-rejection route remains
  supported; shortcut-mode model nodes may use the existing Worker fallback
  while retaining Graph/SQLite authority.

- **FR-017**: No code from this feature may auto-merge, push or publish
  content. All release gates require independent review and real evidence.

## Key Entities

- **Direct Shortcut Run**: Existing Job identity, immutable Run binding,
  DAG/hash, elapsed budget, nodes and durable receipt history.
- **Node Outcome**: `COMPLETED`, `WAITING_EVENT` or `FAILED`, with
  contract-validated evidence and immutable execution provenance.
- **Normal Worker No-Start Fallback**: Exact failed execution, original route,
  no accepted start event, durable once-only Codex-default recovery marker,
  failure evidence and route exclusions.
- **Wait Receipt**: Exact node, execution, revision and content hash.

## Success Criteria

- **SC-001**: Fork/join scheduling, code-shortcut execution and ordinary
  Worker fallback node tests verify live events, real structured outputs,
  dependency order and durable transitions.
- **SC-002**: Restart, replay, stale receipts, human-approval denial, timeout,
  interruption and idempotent run binding tests pass.
- **SC-003**: ChatGPT/Z failed executions without `task.started` retry
  once on the actual Codex default model without Troubleshooter; accepted
  starts, stale/mismatched events, incompatible routes, second failures and
  exhausted attempts never auto-retry. Exercise restart and late-event cases.
- **SC-004**: Default Worker and Planner modes retain prior behavior.
- **SC-005**: Visioner fixture tests validate evidence preservation and
  provenance without upload, external inference or authorization bypass.
- **SC-006**: Direct Runner release requires a real Vlog full-DAG E2E,
  project evals, independent review and an observed terminal outcome.
  Anything not actually exercised is reported `NOT_RUN`, not PASS.

## Scope & Safety

This spec defines one Shortcut Graph execution path with two supported node
mechanisms: direct code shortcut and existing Relay Worker fallback for
model-backed nodes. Normal ChatGPT/Z Workers retain their once-only no-start
recovery to the configured Codex default. All paths share Relay Graph and
SQLite authority; no new direct Codex executor or second scheduler is required.

No real third-party upload, purchase, publication, human approval or
automatic Git merge is authorized by implementing this contract. Prior
incomplete Direct Runner changes remain unmerged until SC-006 is satisfied.
