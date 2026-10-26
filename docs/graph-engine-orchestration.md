# Graph Engine orchestration core

The Graph Engine is the lifecycle decision core for Agents Relay. Its contract is:

```text
current state + event + canonical facts
  -> transition + deterministic mutations + declarative side effects
```

The graph decides lifecycle policy and which next actions are required. It does not directly call GitHub, NATS, worker processes, PM2, browser automation, or durable storage APIs.

## Canonical vocabulary

`src/workflow/contracts.ts` owns finite registries for workflow events, facts, deterministic mutations, and external effects. Canonical Job and Task Mermaid definitions are validated against those registries when loaded.

Mutations are deterministic changes to the durable subject, such as clearing a stale error when a task becomes healthy. They are applied by `src/workflow/runtime.ts`.

Effects are declarative external intents. The initial effect vocabulary is:

- `effect.launchTask`
- `effect.cancelActiveTasks`
- `effect.mergePullRequest`

Each effect has a typed payload contract plus a documented idempotency strategy, failure event, retry owner, and observability namespace.

## Execution loop

```mermaid
flowchart TD
  A[External event or reconciliation observation] --> B[Collect canonical facts]
  B --> C[Graph Engine]
  C --> D[Transition decision]
  D --> E[Apply deterministic mutations]
  E --> F[Persist durable state]
  F --> G[Effect executor]
  G -->|success| H[Effect receipt / observability]
  G -->|failure| I[Canonical effect.failed event]
  I --> C
```

A transition can declare actions in Mermaid:

```mermaid
stateDiagram-v2
  QUEUED --> QUEUED: dispatch [dispatchable] / effect.launchTask
  FAILED --> QUEUED: retry / mutation.clearError,mutation.clearFailureReason
  ACTIVE --> ACTIVE: review.approved [autoMerge] / effect.mergePullRequest
```

Declarative actions are parsed and validated by the Mermaid engine but are not invoked inside the graph. `WorkflowEffectExecutor` executes external effects outside the decision layer.

## Idempotency and failure semantics

`WorkflowEffectHandler` is the base abstraction for effect implementations. Specialized handlers provide the actual external operation and may override the idempotency key. `WorkflowEffectExecutor` records completed keys and returns `completed`, `failed`, or `deduplicated` outcomes.

Current policies are:

| Effect | Idempotency | Failure event | Retry owner |
| --- | --- | --- | --- |
| `effect.launchTask` | Job + Task + attempt | `effect.launchTask.failed` | workflow |
| `effect.cancelActiveTasks` | Job + transition | `effect.cancelActiveTasks.failed` | workflow |
| `effect.mergePullRequest` | Job + head SHA | `effect.mergePullRequest.failed` | workflow |

The Reconciler never translates an effect exception directly into an arbitrary lifecycle assignment. It feeds the canonical failure event back to the graph, then persists the graph's decision.

Worker launch also retains the existing durable execution claim/lease protections, so process launch remains protected beyond the in-process effect receipt.

## Responsibility boundaries

The refactor uses a class hierarchy to keep the orchestration surface small:

```text
ReconcilerRuntimeBase
  └─ ReconcilerReviewBase
       └─ Reconciler
```

- `ReconcilerRuntimeBase`: worker events, watchdog/recovery runtime, effect outcome feedback.
- `ReconcilerReviewBase`: review lifecycle and review-driven graph events.
- `Reconciler`: top-level observation/reconciliation, planner orchestration, and effect handler bindings.
- `workflow/task-reconcile.ts`: dependency facts and graph reconciliation.
- `task-transitions.ts`: dependency refresh and Graph-backed Task/Job transition facade; no Job scheduler.
- `runtime-status.ts`: pure derived projection; it is not durable lifecycle state.
- Store implementations: persistence only.

Normal lifecycle changes go through graph transitions. The sole exception is
`applyHistoricalJobCompatibilityRepair` in `src/workflow/runtime.ts`, which
repairs legacy records that stored derived runtime status in the Job lifecycle
field and validates the terminal target before persisting it.

`DurableTaskTransitionRuntime` is the shared application seam for runtime-owned
Task lifecycle inputs. It serializes competing inputs for one durable Task,
re-reads the current Task immediately before decision, asks the canonical
Mermaid graph about the original semantic event, and persists only an accepted
decision. Serialization is an application primitive, not lifecycle policy.

Watchdog and worker-delivery conditions have explicit graph events such as
`watchdog.failed`, `worker.delivery_failed`, and `worker.start_ack_failed`. A
late correlated worker event remains the original `task.started`,
`task.completed`, `task.failed`, or `task.blocked` event; recovery legality is a
graph guard (`recoverableExecution`) rather than a Reconciler-created
`reconcile.*` lifecycle event. Consequently, after `task.completed` persists
`SUCCEEDED`, a stale watchdog callback re-reads `SUCCEEDED` and the graph rejects
`watchdog.failed` because no such edge exists. Process lifecycle events remain
evidence and never authorize a semantic transition on their own.

## Review Chair pattern

Review Chair is an optional normal Task/Agent Graph pattern. It discovers
visible agents at runtime, records panel selection rationale, fans out sibling
specialist Tasks against one immutable `{ artifact, version }`, and gathers
structured findings into one attributed revision plan. It does not edit the
artifact or replace final review.

```mermaid
flowchart TD
  target[Exact artifact/version] --> chair[review-chair]
  chair --> director[video-director]
  chair --> market[market]
  chair --> style[style specialist]
  director --> synthesis[Unified revision plan]
  market --> synthesis
  style --> synthesis
  synthesis --> executor[Revision Task]
```

The example is illustrative rather than a fixed reviewer list: a landing page
may select copy and visual design, while architecture may select security and
maintainability. The chair chooses agent roles from the resolved visible-agent
catalog; Relay independently routes each durable Task to an available worker
and model. If synthesis exposes a missing dimension, the chair creates another
specialist Task with the same target/version before handing the unified plan to
the executor. Existing SHA-bound final review still gates completion.

## Stability contract

The Mermaid Graph Engine is the only authoritative Job/Task lifecycle decision path. There is no alternate lifecycle evaluator or runtime mode switch.

Canonical graphs fail closed at load time when they reference an undeclared event, fact/guard, mutation, or effect. Dependency reconciliation persists graph-decided Task transitions before later dispatch/effect work proceeds. External effects remain behind `WorkflowEffectExecutor`; they do not mutate lifecycle policy directly.

This stabilization phase is complete once the repository contract tests pass. Future lifecycle regressions are treated as bugs against this contract rather than as unfinished Graph Engine migration work.
