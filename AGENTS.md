# Working on Agents Relay

Agents Relay is a generic, shareable async-agent runtime and skill.

## Principles

- GitHub PR state is durable truth. Events are wake-up/observability signals, never durable truth.
- Reconcile desired durable state into ephemeral worker executions.
- One top-level objective maps to one PR; child tasks live inside that PR.
- Agents may submit child tasks; task lineage is explicit.
- Workers are replaceable and recoverable. Results and state must survive worker or daemon death.
- Keep provider/model routing separate from roles and capabilities.
- Prefer standard library and small dependencies; do not build a second database when GitHub already holds the durable state.
- TypeScript must use explicit types and avoid `any`.
- UI must remain usable without a frontend framework unless a framework becomes necessary.
- Tests must cover state transitions, parser/serialization, reconciliation, and recovery-sensitive logic.

## Shared execution context

Use `resolveExecutionContext` for project instructions, skill visibility, visible agents, and runtime capabilities. Keep the precedence project-local > Neo shared > global `~/.agents`; do not add Relay-owned copies of shared skills or hardcode a Neo checkout path. Relay owns durable orchestration and review state, while workers receive the resolved context and delegate nested work only by creating durable Relay child tasks with `parentTaskId`.
