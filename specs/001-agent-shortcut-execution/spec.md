# Neo Project Agent Shortcut Execution

## User Scenarios & Testing

### User Story 1 — Run an Agent Graph with available shortcuts (Priority: P1)

As a project owner, I can opt an existing Relay Job into shortcut execution so
its declared Neo Project Agent Graph runs without a Planner round or a queued
browser/model worker per graph node.

**Why this priority**: This is the core hotfix outcome and must reuse the
existing Job and Agent Graph rather than create a parallel workflow runtime.

**Independent Test**: Run a fixed DAG with two independent nodes and one join;
verify both independent shortcuts run concurrently, the join receives only its
declared predecessors' structured outputs, and the existing durable Job reaches
one valid terminal outcome.

**Acceptance Scenarios**:

1. **Given** an existing active Job, a project graph and explicitly selected
   shortcut mode, **When** the owner starts the Job, **Then** Relay executes the
   parsed DAG waves through discovered shortcuts and persists progress in the
   existing SQLite authority.
2. **Given** independent ready nodes, **When** their shortcuts are asynchronous,
   **Then** Relay awaits them concurrently up to a configured bound and does not
   start a dependent node before all declared predecessors succeed.
3. **Given** no shortcut or a shortcut failure, **When** the node is eligible,
   **Then** Relay delegates to the existing Agent Worker/Troubleshooter lifecycle
   and model router asynchronously.

### User Story 2 — Resume safely after external events and restarts (Priority: P1)

As an operator, I can leave one graph node waiting for a correlated human or
external event while independent branches proceed, and Relay resumes only the
matching node once, including after restart.

**Independent Test**: Exercise a fixed DAG with a waiting branch, matching,
duplicate, stale and restart-replayed events; verify exactly-once state change
and no false Job completion.

**Acceptance Scenarios**:

1. **Given** one ready node returns `WAITING_EVENT`, **When** another independent
   node is ready, **Then** the second branch proceeds while the wait identity,
   revision and content hash are durable.
2. **Given** a matching event, **When** it arrives once or is replayed after
   restart, **Then** only the matching durable wait resumes and duplicates or
   stale revisions have no effect.
3. **Given** an event-waiting human approval, **When** its signature or bound
   revision is invalid, **Then** it cannot approve the stage or complete the Job.

### User Story 3 — Use the Vlog Visioner shortcut safely (Priority: P1)

As a Vlog operator, I can use a code-first Visioner shortcut that follows the
shared Visioner Agent and Vlog stage contract, reuses approved metadata, invokes
existing Markcut CLI tooling and returns inspectable evidence without inventing
observations or approval.

**Independent Test**: Use fixture media, an approved manifest, and mocked CLI
dependencies; verify evidence and index artifacts, provenance, fail-closed
behavior, and no real upload or paid call.

**Acceptance Scenarios**:

1. **Given** approved canonical Vlog inputs, **When** the Visioner shortcut runs,
   **Then** it reuses valid metadata, invokes Markcut Vision and the existing
   Vlog index script as required, and returns `vision-evidence.json` plus
   companion artifacts.
2. **Given** missing authorization, stale hashes, unsupported CLI options,
   missing evidence, or ambiguous output, **When** Visioner runs, **Then** it
   fails closed and preserves existing approved evidence.
3. **Given** any successful Visioner result, **When** Relay records the result,
   **Then** it does not imply human approval, publication authorization, merge,
   or successful downstream stages.

## Requirements

### Functional Requirements

- **FR-001**: The system MUST preserve existing `job create` behavior and add an
  explicitly opt-in shortcut execution mode.
- **FR-002**: The system MUST reuse `parseAgentGraph()` and its dependency/wave
  semantics and MUST NOT add a second Agent Graph parser.
- **FR-003**: The system MUST resolve `.shortcut/<agent>.agent.mjs` with project
  agents taking precedence over Neo shared agents, while leaving `.agent.md`,
  project directories, contracts and evals intact.
- **FR-004**: The system MUST execute ready independent shortcuts concurrently
  within a bound and await asynchronous results before advancing dependents.
- **FR-005**: The system MUST persist run and node state in the existing Relay
  SQLite Job/Task authority and use canonical graph transitions for state
  changes; it MUST NOT create another Job store or mutate serialized state
  outside lifecycle operations.
- **FR-006**: Node outcomes MUST be `COMPLETED`, `WAITING_EVENT`, or `FAILED`;
  non-human result-event resumption MUST be identity-, current-execution-,
  revision-, and content-hash-bound, duplicate-safe, restart-safe and
  idempotently consumed through durable history. Human approval MUST use the
  existing authenticated host-invocation authority and MUST NOT be inferred
  from EventBus publication.
- **FR-007**: The system MUST keep existing leases/claims and terminal semantics;
  subprocess exit alone MUST NOT count as success without valid structured
  output and required contract proof.
- **FR-008**: If a shortcut is absent or fails, Relay MUST fall back
  asynchronously through the existing Agent Worker/Troubleshooter lifecycle
  and model router.
- **FR-009**: Shortcut and Worker execution MUST use the same stage inputs,
  outputs and eval requirements; human approval or publishing MUST never be
  inferred.
- **FR-010**: The Vlog Visioner shortcut MUST invoke existing Markcut Vision CLI
  and `vlog/scripts/index-markcut-vision.mjs`, reuse approved metadata and
  preservation rules, return `vision-evidence.json` and companion artifacts,
  and fail closed when provenance or authorization is invalid.
- **FR-011**: Content-only execution MUST NOT trigger automatic Git merge.
- **FR-012**: The system MUST provide a documented, on-demand shortcut generation
  workflow grounded in the existing `.agent.md` contract and CLI templates;
  other agents MUST continue to use Worker fallback until their shortcuts are
  tested.
- **FR-013**: The CLI MUST provide a smallest-possible opt-in entrypoint that
  runs a fixed Agent Graph end to end and remains backward compatible.

### Key Entities

- **Shortcut Run**: Existing Job/Task execution identity, project graph source
  and hash, selected mode, concurrency bound and durable node outcomes.
- **Shortcut Node**: Graph node identity, resolved agent/shortcut reference,
  predecessor outputs, attempt/execution identity, result and optional wait key.
- **Wait Record**: Durable event correlation, node identity, revision/content
  hash, consumed state and approval provenance where applicable.
- **Node Result**: One of `COMPLETED`, `WAITING_EVENT`, or `FAILED`, with
  structured output and evidence required by the corresponding stage contract.

## Assumptions

- Shortcut execution is opt-in and runs against an existing Relay Job; no Relay
  Job is created for this hotfix work itself.
- Only Visioner receives a concrete shortcut in this change. Other agents use
  existing Worker fallback.
- All hotfix verification uses isolated stores and fixture inputs. No real Vlog
  run, paid inference, external upload, service operation, merge, or publish is
  authorized by this request.
- If current lifecycle primitives cannot support atomic direct execution and
  safe event waits, the implementation may deliver a coherent limited MVP and
  must document any deferred behavior honestly.

## Success Criteria

- **SC-001**: A fixed-DAG test proves independent nodes overlap, dependencies
  wait for predecessor completion, and a join receives only declared outputs.
- **SC-002**: Success, missing-shortcut fallback, shortcut failure fallback,
  wait/resume, duplicate/stale event, restart resume, invalid approval and
  invalid output cases produce deterministic durable outcomes.
- **SC-003**: A matching existing Job is resumed without creating a second Job,
  Planner round, per-node Worker queue, or duplicate lifecycle authority.
- **SC-004**: Existing default `job create` and Planner behavior remains
  unchanged in compatibility tests.
- **SC-005**: Fixture-based Visioner tests validate provenance, required
  artifacts and preservation behavior without real external inference,
  uploads or paid calls.
- **SC-006**: Build and focused tests pass; any unrun provider/browser/UI gate is
  reported as not run.
