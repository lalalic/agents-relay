# Working on Agents Relay

Agents Relay is a generic, shareable async-agent runtime and skill.

## Principles

- GitHub PR state is durable truth for jobs/tasks. Events are wake-up/observability signals, never durable truth.
- Shared agent registrations are durable GitHub state too: repository/global registries live in trusted registry issues, not inside one job PR.
- One top-level objective maps to one managed PR; child tasks live inside that PR.
- **Agent != Skill != Adapter.** An agent is a registered result-owning identity/role, a skill is a callable capability or behavior contract, and an adapter is an execution runtime.
- Keep agent identity and responsibility separate from execution mechanism. Registered agents may dispatch through configured adapter, command, or HTTP endpoints without becoming those adapters.
- Claimed capabilities are routing declarations, not proof. Keep them separate from observed task/evaluation evidence and capability scores.
- Apply hard eligibility filters before ranking. The orchestrator remains the final chooser; discovery returns candidates and explainable evidence, not an autonomous universal trust verdict.
- Reconcile desired durable state into ephemeral worker executions. Revalidate registered-agent eligibility immediately before dispatch.
- Agents may submit child tasks; task lineage is explicit. Workers are replaceable and recoverable; results/state must survive worker or daemon death.
- Persist real task outcomes and representative suite evaluations through the existing GitHub marker/store model. Deduplicate by execution identity; do not invent a second evidence database.
- Keep reliability, latency, cost, confidence, sample counts, and freshness explainable as separate evidence dimensions. Do not collapse them into one fake universal score.
- Keep provider/model routing separate from roles and capabilities.
- Security boundaries are explicit: command endpoints must be absolute executables; remote HTTP requires HTTPS plus a credential reference; unauthenticated HTTP is loopback-only; secrets/private payloads never belong in public markers.
- Do not add a broad unauthenticated public control plane. Hosted multi-tenant discovery, billing, isolation, private-data routing, and marketplace behavior remain future scope.
- Prefer standard library and small dependencies; do not build a second database when GitHub already holds the durable state.
- TypeScript must use explicit types and avoid `any`.
- UI must remain usable without a frontend framework unless a framework becomes necessary.
- Tests must cover state transitions, parser/serialization, reconciliation, registry/discovery/dispatch/evidence, and recovery-sensitive logic.
