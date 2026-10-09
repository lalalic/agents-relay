# Working on Agents Relay

Agents Relay is a generic, shareable async-agent runtime and skill.

## Architecture contract

Read DESIGN-PRINCIPLES.md before planning, implementation, or final review of
architecture-sensitive work.

## Principles

- V2 SQLite Relay Store is the sole authoritative Job/Plan/Task/Review/Execution/Lease/Recovery state. GitHub only executes external PR/commit/review/merge effects; events are wake-ups/observability, never standalone durable truth.
- Reconcile desired durable state into ephemeral worker executions.
- One top-level objective maps to one local Job (which may reference one external PR); child Tasks/Plans/Review state remain in local SQLite.
- `job create` without `--initial-plan` is create-only. For a normal executable Job, prefer `job create --initial-plan`; this creates the first durable Planner round and hands subsequent execution to Relay. A zero-task Job created without `--initial-plan` remains idle.
- Agents may submit child tasks; task lineage is explicit.
- Any component that creates or manages jobs/tasks must follow `skills/agents-relay/contracts/task-job-contract.md`; task producers choose `storySize`, not raw timeout milliseconds.
- Workers are replaceable and recoverable. Results and state must survive worker or daemon death.
- Keep provider/model routing separate from roles and capabilities.
- Prefer standard library and small dependencies. SQLite is canonical lifecycle state, not a cache of GitHub comments. Do not hydrate/recover lifecycle from PR body/comments, or enqueue lifecycle projection writes. The outbox may hold only idempotent external PR actions.
- TypeScript must use explicit types and avoid `any`.
- UI must remain usable without a frontend framework unless a framework becomes necessary.
- Tests must cover state transitions, parser/serialization, reconciliation, and recovery-sensitive logic.
- Every disposable subprocess launched by Relay must use the shared owned-process lifecycle so direct exit, cancellation, timeout, retry, and parent death clean the exact process group without process-name matching.

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

## Production E2E

Before starting, continuing, repairing, or reviewing any Agents Relay E2E run, read `e2e/README.md` and follow it as the canonical E2E operating procedure. Scenario definitions live under `e2e/scenarios/`. The E2E control plane belongs to this repository; workload repositories are disposable inputs and must not be hard-coded into runner behavior.

## Operational workflows

P0/self-job behavior is defined by `skills/agents-relay/contracts/orchestrator-workflows.md`. Task/job semantics are defined by `skills/agents-relay/contracts/task-job-contract.md`. These are Agents Relay orchestration contracts, not global agent policy.
