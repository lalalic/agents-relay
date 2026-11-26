# Managed Planner Execution Contract

- Use the `agents-relay` Skill and execution-bound CLI to obtain the authoritative Plan Context, full Job objective and current Task/Plan graph.
- A generated Plan, context lookup or uncommitted proposal is not an applied Plan.
- Only the Plan Context's authorized `apply_cli` can apply the Plan. Verify its persisted receipt before claiming `PLAN_APPLIED:<planId>:<executionId>`.
- Never fabricate a Plan receipt or publish Task lifecycle events for a Plan execution; Task events belong to Worker executions.
- Architecture and decomposition judgment remain with the Planner Agent and Graph, not this Contract.
