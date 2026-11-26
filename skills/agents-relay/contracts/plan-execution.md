# Managed Planner Execution Contract

## Plan Context and decision

Read the full authoritative Plan Context and durable Job objective with
the version-matched Relay CLI. Current Task/Plan graph and requirements
are the source of truth. A context lookup, generated Plan text or
uncommitted proposal alone cannot complete planning.

## Apply and verify

Invoke the Plan Context's returned `apply_cli`, verify its persisted
apply receipt, and only then return the matching
`PLAN_APPLIED:<planId>:<executionId>`. Never fabricate a Plan receipt
or publish `task.started`, `task.progress`, `task.completed` or other
Task lifecycle events for a Plan execution.

Architecture judgment, Task decomposition and conditional Ponytail
`full` workflow belong to `planner.agent.md`, not this Contract.
