# Working on Agents Relay

Agents Relay is a generic, shareable async-agent runtime and skill.

## Architecture contract

Read DESIGN-PRINCIPLES.md before planning, implementation, or final review of
architecture-sensitive work.

## Principles

- GitHub PR state is durable collaborative truth. V2 Relay Store owns operational execution state; events remain wake-up/observability signals, never durable truth by themselves.
- Reconcile desired durable state into ephemeral worker executions.
- One top-level objective maps to one PR; child tasks live inside that PR.
- `job create` creates durable job state only. The top-level orchestrator decides whether to start work and, if so, submits the initial task batch separately. A zero-task autonomous job must remain idle; Relay must not invent its first planner/task batch.
- Agents may submit child tasks; task lineage is explicit.
- Any component that creates or manages jobs/tasks must follow `skills/agents-relay/contracts/task-job-contract.md`; task producers choose `storySize`, not raw timeout milliseconds.
- Workers are replaceable and recoverable. Results and state must survive worker or daemon death.
- Keep provider/model routing separate from roles and capabilities.
- Prefer standard library and small dependencies. Do not duplicate GitHub collaborative records in a competing database; V2 may use the built-in SQLite Relay Store for operational state, leases, event idempotency, materialized runtime views, and projection outbox.
- TypeScript must use explicit types and avoid `any`.
- UI must remain usable without a frontend framework unless a framework becomes necessary.
- Tests must cover state transitions, parser/serialization, reconciliation, and recovery-sensitive logic.

## Workflow authority classification

Before implementing any feature or bug fix, apply the task-relevant
Architecture Lens from DESIGN-PRINCIPLES.md. Do not start with a procedural
code change and classify it afterward.

- **Graph** owns workflow policy: legal transitions, branching, eligibility, ordering, and decisions about **when**, **whether**, or **what happens next**. If existing workflow behavior changes, inspect the canonical `workflow/*.mmd` graphs first and change the owning graph when that policy belongs there.
- **Action / effect** performs a concrete mutation or external side effect already selected by a graph. It may validate inputs and report success/failure, but it must not make a second workflow decision.
- **TypeScript code** owns non-policy mechanics: facts, pure calculations, parsing/serialization, persistence primitives, leases/claims, I/O adapters, runtime projections, and concrete guard/action implementations.
- Do not duplicate graph-owned policy in CLI, dashboard, reconciler, scheduler, webhook, daemon, API, helper, or runtime code.
- For the same intent, every entry point must converge on the same graph/action semantics.
- Final Review must verify the applicable Design Principles, not only code correctness.
- Canonical workflow graph filenames and identities do not use `v1`/`v2`/etc suffixes. Git history is the version history; keep one stable current graph name.

## Execution context ownership

- The shared execution-context resolver owns discovery of project instructions, skills, visible agents, and runtime capabilities.
- Precedence is project-local > Neo shared > global `~/.agents`; concrete paths are resolved at execution time, not persisted in task records.
- Agents Relay owns durable orchestration, lineage, leases/retries, lifecycle events, and review gates.
- Workers consume the resolved context. Nested workers delegate only by creating durable Relay child tasks; they must not directly spawn arbitrary child agents.

## Operational workflows

P0/self-job behavior is defined by `skills/agents-relay/contracts/orchestrator-workflows.md`. Task/job semantics are defined by `skills/agents-relay/contracts/task-job-contract.md`. These are Agents Relay orchestration contracts, not global agent policy.
