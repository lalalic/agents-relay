---
kind: relay-agent-definition-contract
global_startup_contracts: [relay:skills/agents-relay/contracts/execution-boundary.md]
---

# Agents Relay Agent Definition Contract

The `agents-relay` Skill owns Agent/Contract resolution and prompt assembly; resolve any referenced `required_skills` by exact `skill name` through the Harness catalog.

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
extends: editor
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

## Agent-selected dependencies

The effective merged Agent can also declare required resources, which are
**not** advisory hints and are not automatically added for unnamed workers:

```yaml
---
name: custom-implementation
extends: implementation
contexts: [AGENTS.md]
contracts: [relay:skills/agents-relay/contracts/task-recovery-flows.md]
required_skills: [ponytail]
---
```

| Field | Meaning |
| --- | --- |
| `contexts` | Harness-compatible project instruction candidates; at most one declared matching file is actually read and loaded as lower-priority project Context. Other candidates are not read. |
| `contracts` | Agent-declared on-demand Contract references. Their paths are checked, but their bodies are not injected at startup. Mandatory startup rules use `startup_contracts` and the matching execution fields instead. |
| `required_skills` | Required Skill **names only**, inherited with the Agent. The Builder never resolves their filesystem paths or loads SKILL.md. The Agent finds each name in the native Harness Skills List and reads the matching SKILL.md when needed. Missing Skills must be reported as real execution failures. |

`contexts` may contain a bare filename such as `AGENTS.md` or an explicit
project-relative folder reference such as `editor/AGENTS.md`.
Context values are **always plain project-relative paths**, resolved
automatically beneath the active Job's resolved canonical `project.gitRoot`.
The Builder fails closed when that Git-root binding is missing; it never
falls back to `project.path` or the Task execution cwd for Contexts.
No scope prefixes (`project:` or `relay:`), absolute paths or parent
traversal (`..`) are allowed. This restriction applies only to
`contexts`; Contract references retain their own scoped paths.
Only `AGENTS.md` and `CLAUDE.md` are permitted. The builder selects the
first candidate compatible with the actual Harness; it does **not** fall back
to the other Harness's file. An absent or empty effective value, including
`contexts:` and `contexts: []`, means **no directory Context is needed**.
An incompatible candidate also selects none. If the matching candidate is
declared but its file is missing, the required reference fails validation.

The declaration is resolved **after Agent inheritance**. An omitted child
field inherits its parent's value; an explicitly empty field clears it.
Other reference fields remain independent: empty Context does not remove
inherited Contracts or required Skills. The native Harness's Global
instructions are a separate baseline and remain present even when the Agent
declares no directory Context.

## Named Contract blocks in assembled Prompts

All mandatory loaded Contracts appear in the trusted System Prompt inside
`<contracts>...</contracts>`, introduced with "Contracts are the principal
rules you must follow." Each document is wrapped exactly once as
`<contract name="worker-lifecycle">...</contract>` with a stable name derived
from its Markdown filename (without `.md`). The names are exposed in
provenance and the Task's User Prompt so assignments can refer to a specific
Contract without copying its rules. On-demand references remain unloaded and
are never mislabeled as trusted startup Contracts. The `agents-relay` Skill
owns this assembly; neither a Task nor a child Agent can rename trusted blocks.

## Declared startup and assignment Contracts

**Only global shared Contracts load automatically.** Their list is defined
in this Agent Definition Contract's `global_startup_contracts` frontmatter,
currently pointing to `execution-boundary.md`. Every other Contract
must be explicitly declared by the effective inherited Agent Markdown.

An Agent may `extends: worker` to inherit the shared Worker Agent Markdown,
or explicitly declare its own required Contracts, as Planner does:

```yaml
---
name: planner
startup_contracts: [relay:skills/agents-relay/contracts/plan-execution.md]
---
```

| Field | Loader behavior |
| --- | --- |
| `startup_contracts` | Required trusted System Contract documents |
| `assignment_contracts` | Required trusted System assignment Contract documents |
| `dag_contracts` | Required trusted System Contract documents when Task has a DAG node |
| `source_contracts` | Required trusted System Contract documents for Git/source delivery |
| `event_contracts` | Required trusted System Contract documents for ordinary Task event delivery |
| `artifact_contracts` | Required trusted System documents for artifact-changing tasks including files, media, DAG or Git |
| `eval_contracts` | Explicit read-only Eval safety Contract, not a production instruction |

Each entry uses `relay:` followed by a canonical package-relative
**complete Markdown Contract file**. The Loader rejects `#section` selectors:
each Contract is a cohesive, independently named document. It verifies
root confinement, file type, existence, readability and nonempty content.
No SHA digest validates file content. A declared missing or unreadable file
fails closed; duplicate files are loaded once. The effective child can
explicitly clear inherited declarations with `[]`.

### Job Task execution Contract layer versus Agent inheritance

For a Relay Job **Task**, Runtime automatically applies the Contract
declarations from the bundled `worker.agent.md`. It does **not** implicitly
add `extends: worker` to the selected Agent, override a declared parent,
or inject the Worker Agent's role body. Normal Agent inheritance is
resolved independently.

`extends: worker` remains a valid explicit Agent inheritance choice.
A custom Agent may inherit another parent (e.g. `editor`), Worker, or
have no parent. With explicit Worker inheritance, identical Contracts
from the inheritance chain and Task execution layer are loaded **once**
by canonical file identity, without SHA validation. Agent-specific Contracts
may add to, but never remove or replace, mandatory Task Contracts.
Clearing an inherited list with `[]` affects only Agent metadata.

A Job **Plan** does not receive Worker Task Contracts: the effective
Planner Agent's declared Plan Contract applies. A standalone invocation
has only the shared Global Contract and explicitly declared requirements
for that supported mode.

The generic Prompt Builder does not hardcode Worker/Planner/terminal Contract
filenames. Only a Task's **authoritative** output type selects among sections
already declared in its Agent Markdown. Runtime Graph checks and terminal
receipts remain mechanically enforced.

All mandatory Contracts, including Task assignment and DAG/Git/Event
completion, are delivered in trusted System/Developer instructions.
The User assignment contains execution facts and selected project Context
at lower priority. Required Skill names remain trusted Agent instructions;
the Agent uses the native Harness Skills List to locate and read the
matching SKILL.md when needed, never assuming a pre-resolved path.

Codex disables implicit project instruction discovery with
`project_doc_max_bytes=0`. Only an explicitly selected project AGENTS.md
is read and included as lower-priority Context. Required Skills remain
name-only until the executing Agent loads them using the Harness. Path
scope, existence and readability checks apply to selected Contract and
Context documents; no content SHA is used for validation. A whole-Prompt
fingerprint is diagnostic metadata, not a content-validation gate.

The separate `contracts` field remains an on-demand reference list.
`contexts` is still at most one declared native project instruction file,
never a substitute for shared execution Contracts. Ponytail remains a Skill
referenced by Planner, not an automatically loaded Contract.

## Canonical Agent metadata schema

All Relay and Neo Project Agent frontmatter must follow this **single
authoritative schema**. Neo Project `type`, `inputs`, `outputs` and
`reviewers` describe project-domain handoffs, not Relay execution types.

| Field | Meaning |
| --- | --- |
| `name`, `description` | Agent identity |
| `extends`, `mode`, `sections` | Normal explicit Agent inheritance and section composition |
| `skills`, `model`, `reasoning` | Advisory Skill or Router preferences only |
| `required_skills` | Skill **names** only; Agent resolves them through Harness Skills List and reads SKILL.md when needed |
| `contexts` | At most one explicitly selected native `AGENTS.md` / `CLAUDE.md` file, loaded below trusted Contracts |
| `contracts` | On-demand Contract paths, not startup injection |
| `startup_contracts`, `assignment_contracts` | Required trusted System/Developer Contract documents |
| `dag_contracts`, `source_contracts`, `event_contracts` | Applicable terminal Contract selected by authoritative Task output kind, delivered as trusted instructions |
| `artifact_contracts` | Task-scoped required artifact self-review Contract |
| `eval_contracts`, `eval_assignment_contracts` | Isolated evaluation policy, not production Worker instructions |

Use inline lists (`contexts: [AGENTS.md]`,
`required_skills: [markcut]`) rather than nested YAML arrays. Full
Contract filenames are required; no `#section` selectors or SHA content
validation. Omitted child fields inherit a parent's declarations; `[]`
explicitly clears only Agent-owned inherited dependencies.

**Directory Context is role-owned, not implied by Task execution.**
Built-in Implementation and Planner declare
`contexts: [AGENTS.md]`. Project descendants inherit that
declaration through normal `extends` unless explicitly overridden.
A project replacement Agent without an inherited base must declare
its own requirements. A selected missing AGENTS.md fails closed.

Generic Worker, Reviewer, Troubleshooter and Neo Project DAG Stage
Agents do not implicitly load project AGENTS.md. Job Task execution
automatically composes only Worker **Contract declarations**, never
the Worker Agent body, parent identity or Context.

## Resolution and precedence

The effective Agent inherits frontmatter metadata using the existing Agent
resolution and `extends` merge rules; a more specific override wins.
The selected Agent's `skills` hint appears in the Worker/Planner **user
prompt**, not as an enforced bootstrap/contract requirement. The selected
Agent's `model` and `reasoning` hints go to the Router **decision prompt**,
not to the Worker prompt. All Model Agents (Job Workers, Planner, Final Reviewer,
Troubleshooter, DAG stages, and detached Outcome/Preflight Review) use the same
native Execution Router to select one eligible route. Detached agents use the
shared read-only preference resolver and detached Router entry point; they
must not silently use Codex defaults or implement a separate selector.
The selected Provider/Profile/Model/Reasoning is passed to the common Codex
route argument encoder, including fresh and resumed executions; role-specific
prompt and completion contracts remain independent. Do not copy route
selection or Codex route flag construction into each Agent launcher.

Durable Job `routingPreferences` soft hints have priority over Agent frontmatter hints for still-unrouted normal Tasks.
Explicit Job routing preferences are appended to the Decision Engine's routing instructions
and take precedence over conflicting global Router `[routing-instruction]` guidance and Agent
preferences. Authoritative hard constraints still apply before selection.
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
