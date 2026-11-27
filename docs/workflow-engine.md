# Executable workflow engine

`workflow/*.mmd` owns lifecycle transitions, guards, branching and ordered effects. The Rust engine validates registry-bound identifiers and rejects unsupported syntax, ambiguous or illegal transitions. No parallel JSON/YAML workflow or procedural policy engine.

- `rust/src/workflow/graph_v2_parser.rs`, `graph_v2.rs`: syntax and evaluation.
- `rust/src/workflow/contracts.rs`, `conditions.rs`, `effects.rs`, `dispatcher.rs`, `durable_transition.rs`: registered facts, guards, actions and durable application.
- `workflow/job-lifecycle.mmd`, `task-lifecycle.mmd`, `review-lifecycle.mmd`, `planner-orchestration.mmd`, `revision-lifecycle.mmd`: inspect the relevant actual graph for policy; use `workflow/` for the full current inventory.
- SQLite is the state authority; event ingress wakes reconciliation and carries correlated evidence. Launch/process exit/preview is not completion. Local merge and optional remote publication are separate.
- Task dependency flow and semantic parent ownership are independent. Declared Project DAG runs use a Coordinator and ordinary durable Agent children; no separate retry engine. Ordinary Jobs do not require a Coordinator.

Use graph/registry tests and isolated SQLite integration tests for legal, negative, duplicate, restart and recovery paths.

## Executable Mermaid profile

The current parser is `rust/src/workflow/graph_v2_parser.rs`; evaluator is `graph_v2.rs`. Inspect the actual registries in `contracts.rs` for allowed semantic identifiers. Graphs support optional YAML frontmatter for display metadata, one `flowchart LR|RL|TD|TB` header, and exactly one `%% relay: initial NODE_ID` declaration naming a state node. Comments and display labels are not executable.

```text
node["state: STATE_ID"]
node["guard: GUARD_ID"]
node["action: ACTION_ID"]
node["emit: EVENT_ID"]
```

Node IDs are unique topology identifiers; semantic state IDs must be unique. Guard/action identifiers may recur in distinct nodes. A `|` separator inside a quoted node label introduces non-executable display text. Unsupported shapes or semantic labels fail validation.

- State edges use `on: EVENT_ID` or `request: ACTION_ID` and may target a state, guard or action.
- Multiple paths for the same input are allowed only through distinct guard nodes. Evaluation rejects zero enabled transitions as `no_transition` and multiple enabled paths as `ambiguous`.
- A guard has one or two unique `true`/`false` branches, targeting state, guard or action. A missing branch disables that candidate. Guards evaluate supplied facts, not I/O.
- An action has one continuation: an unlabeled edge to another action/state, or `to: STATE_ID` to the matching state. Additional `emit: EVENT_ID` edges point to matching emit nodes, which have no exits.
- All states must be reachable from the initial node. No arbitrary Mermaid styling, expressions or scripting language is executed.

The engine returns the accepted transition and ordered mutation/effect intents; the durable runtime applies them with fencing, receipts and idempotency. External effects do not independently choose transitions. Use actual production graphs for working examples and tests for validation behavior. Do not copy an old grammar or duplicate Graph policy in Rust.
