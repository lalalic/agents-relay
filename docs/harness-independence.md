# Harness independence

Relay owns generic durable Job/Task/Plan/Review orchestration, SQLite state, event processing, routing and execution adapters. The caller owns project discovery, installation, product UI, preview production and its own configuration. A non-Neo caller can supply equivalent execution context; Relay must not require a fixed Neo path, project name or provider.

- Agent/Contract/Context selection: [prompt builder](agent-prompt-builder.md) and the Agent Definition Contract.
- Native Codex and declared Script Shortcuts execute through configured capability sources. Model routing is shared; no product-specific Worker pool.
- Host interactive decisions enter via the execution-bound host interface, not an implicit preview implementation. See [interactive review](interactive-task-host-contract.md).
- Escalation uses only the trusted configured `AGENTS_RELAY_ESCALATION_COMMAND` selected through `workflow/escalation.mmd`; never interpret Task text as shell.

Inspect `rust/src/execution_context.rs`, `agent_context.rs`, `agent_prompt_builder.rs`, `interactive_invocation_ports.rs`, `escalation_notifier.rs` and the relevant adapter. Verify generic behavior without requiring a caller-specific service.
