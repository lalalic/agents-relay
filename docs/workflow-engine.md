# Executable Mermaid workflow profile

Agents Relay uses a deliberately small subset of Mermaid `stateDiagram-v2` as the source of truth for durable lifecycle graphs. The same `.mmd` file is intended to be rendered by Mermaid, reviewed and edited by humans/agents, and parsed directly by Relay. There is no generated JSON/YAML workflow definition.

Canonical graphs:

- `workflow/job-lifecycle.mmd`
- `workflow/task-lifecycle.mmd`

## Supported profile

A file must start with `stateDiagram-v2`. Blank lines and Mermaid `%%` comments are allowed. The executable profile supports only transitions:

```text
[*] --> STATE
STATE --> STATE: event
STATE --> STATE: event [guard]
STATE --> STATE: event / action
STATE --> STATE: event [guard] / action1, action2
STATE --> [*]
```

State, event, guard, and action identifiers use letters/numbers plus `_`, `.`, and `-` (identifiers start with a letter or `_`). Exactly one initial `[*] --> STATE` transition is required. Initial/final pseudo-state transitions have no event label. Unsupported Mermaid constructs fail validation rather than being silently ignored.

The label grammar is intentionally small:

```text
event [guard] / action1, action2
```

Guards and actions are **names**, not embedded JavaScript. Runtime code registers implementations for those names. The graph defines policy/structure; TypeScript implements primitive capabilities and side effects.

## Engine boundary

The generic engine parses and validates the Mermaid graph, checks whether a state-to-state transition is legal, resolves transitions by event, evaluates named guards, and invokes named actions. Callers remain responsible for durable persistence, locking/claims, event delivery, and external side effects.

The first migration uses the graph to replace the hard-coded Job/Task transition tables. Runtime status remains a derived projection from Job/Task/Review/PR/schedule facts and is intentionally outside this state-machine engine.

## Non-goals

- no JSON/YAML mirror or generated workflow source;
- no arbitrary Mermaid syntax or Mermaid renderer implementation;
- no JavaScript expressions embedded in labels;
- no BPMN/general-purpose scripting language;
- no distributed workflow/locking implementation;
- no worker-internal step graph;
- no runtime-status projection engine in this first version.
