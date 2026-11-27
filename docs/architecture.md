# Agents Relay architecture

[AGENTS.md](../AGENTS.md) owns the Design Principles and Architecture Lens.
This document maps the current runtime to its implementation and reference
surfaces; it does not duplicate engineering policy.

## Implementation map

- `workflow/`: executable policy; `rust/src/workflow/`: parser, registries, guards and effects.
- `rust/src/relay_store.rs`, `local_authority_store.rs`, `relayd.rs`, `reconciler.rs`: durable state, scheduling and reconciliation.
- `rust/src/agent_context.rs`, `agent_prompt_builder.rs`: context and prompt assembly.
- `rust/src/execution_routing.rs`, `model_routing.rs`, `owned_process.rs`: selection and execution.
- `dashboard/`, `rust/src/dashboard.rs`, `dashboard_api.rs`: presentation and API translation.
- `rust/tests/`: native behavioral regression evidence.

See [project knowledge index](README.md) for subsystem references.
