# Agents Relay Agent Definition Contract

This is the canonical contract for optional Agent frontmatter hints and their
effect on execution. It applies to project, shared, and Relay-built-in Agents,
including merged Agents. Agent role instructions, Task content, and Graph-owned
workflow/lifecycle behavior remain unchanged.

## Optional frontmatter

Use simple top-level YAML scalar fields and inline comma-separated lists.
These fields are **advisory**, never requirements:

```yaml
---
name: vlog-editor
extends: shared/vlog-editor
skills: [markcut, shotcraft]
model: openai/gpt-6
reasoning: high
---
```

| Field | Consumer | Semantics |
| --- | --- | --- |
| `skills` | Worker User Assignment (including Planner) | Optional skill suggestions, e.g. `Suggested skills ...: markcut, shotcraft`. Only use relevant, available skills. |
| `model` | Unified Execution Router decision prompt | Preferred provider/model name, e.g. `openai/gpt-6`, for advisory ranking only. |
| `reasoning` | Unified Execution Router decision prompt | Preferred reasoning effort, e.g. `high`, for advisory ranking only. |

A field may be omitted. `reasoning` can be specified without `model`.
These optional hints do not auto-install/discover/select/require skills, do not
make a Task depend on a skill, do not create or enable model candidates, and do
not override the Task's explicit routing constraints, available routes, resource
or runtime gates, user routing instructions, or deterministic fallback.
Unknown/unavailable suggestions are not execution errors.

## Resolution and precedence

The effective Agent inherits frontmatter metadata using the existing Agent
resolution and `extends` merge rules; a more specific override wins.
The selected Agent's `skills` hint appears in the Worker/Planner **user
prompt**, not as an enforced bootstrap/contract requirement. The selected
Agent's `model` and `reasoning` hints go to the Router **decision prompt**,
not to the Worker prompt.

User-authored Router `[routing-instruction]` guidance has priority over Agent
preferences, and authoritative hard constraints still apply before selection.
Only configured/default or explicitly listed `[choices]` routes are eligible;
the Agent hint does not widen that choice set. Existing Router selection,
fallback, review, and lifecycle behavior stays the same.

When a field is missing, Relay does not add the corresponding hint. If no safe,
read-only Agent path can be resolved for routing, Relay skips the optional
Router advice rather than preparing a Task worktree or blocking a valid route.
The frontmatter is not durable Job/Task state and does not change CLI or
SQLite schemas.

## Related contracts

- [Task / Job Contract](task-job-contract.md) remains authoritative for durable
  Task/Job inputs, dependencies, and lifecycle facts.
- [Prompt Builder](../../../docs/agent-prompt-builder.md) documents the actual
  Worker User Assignment and the merged Agent snapshot.
- [Execution Router](../../../docs/worker-model-routers.md) documents choice
  discovery, hard gates, decision priorities, and fallback.
