# Relay Agent-Driven Prompt Builder (native Rust)

This document describes the current native Rust Prompt assembly model.
The authoritative **Agent frontmatter schema** lives only in
[Agent Definition Contract](../skills/agents-relay/contracts/agent-contract.md).
The [Agents Relay Skill](../skills/agents-relay/SKILL.md) is the operator
entry point; Neo Project Skills link to the same schema and do not copy it.

## Source selection and execution layer

1. Resolve the selected Agent's normal `extends` chain, `mode`,
   `sections` and merged metadata. The project Agent retains its own parent.
2. Load the Global shared Contract declared in `agent-contract.md`
   (`global_startup_contracts`).
3. For a **Job Task**, compose only the mandatory Contract declarations
   from `worker.agent.md` as an execution layer. Do **not** implicitly
   inherit the Worker Agent's role text or change its parent chain.
   Explicit `extends: worker` remains ordinary inheritance; deduplicate
   overlapping Contract files.
4. For **Plan execution**, load the effective Planner's declared
   `plan-execution.md` Contract; Plan Apply is not Task completion.
5. Add the matching Agent-declared startup and conditional mandatory
   DAG/Git/Event completion and artifact self-review Contracts. All
   required files must exist and be readable. No SHA content checks.

## Prompt structure

| Surface | Contents | Authority |
| --- | --- | --- |
| Harness Global | Native Codex Global AGENTS or XChat bootstrap | Harness-owned |
| Trusted System/Developer | Effective Agent body; Global shared Contract; mandatory execution, Task/Plan, terminal and applicable self-review Contracts; name-only required Skill instructions | Authoritative for this managed execution |
| User Task/Plan Assignment | Execution Bootstrap (exact binding, configured event source/endpoint and native CLI commands), project, task facts, lower-priority selected project Context | Current execution data |
| On-demand references | Explicit non-mandatory `contracts` and other authorized documents | Read only when needed |
| Harness Skills List | Available Skill names, descriptions and paths | The Agent resolves named Skills using this catalog; Relay does not pre-read SKILL.md |

### Execution Bootstrap

The shared Builder renders routine commands in User assignment from the selected
execution and Completion Contracts, not Agent names. Workers publish their own
start/progress/failure using the configured Events Bus API, retrieve fenced Task
Context and verify accepted state. Source and DAG success uses the pinned native
`task complete` CLI; event completion uses the declared result schema. Planner
loads Plan Context and uses its returned `apply_cli`; it never sends Task events.
The native runtime resolves its version-matched CLI and configured bus endpoint.
Effective Agent metadata may set `execution_bootstrap: false` to omit the
command section (default `true`); the execution binding and all mandatory
Contracts remain, and the Agent uses owning Skills for routine operations.
These commands are Relay `task.*` lifecycle operations only, not a conversation
reply channel. Routine commands need no Skill re-discovery; additional operations remain on
demand. Isolated evaluation prompts cannot use production lifecycle commands.

### Project directory Context

The project `AGENTS.md` is **not** automatically read from every Job Task.
Only the effective Agent's `contexts` declaration selects a
harness-compatible file within the active independent project Git root.
`contexts` uses plain relative paths only, such as `AGENTS.md` or
`src/AGENTS.md`; prefixes (`project:` / `relay:`) are not supported. Built-in `implementation.agent.md` and
`planner.agent.md` declare `contexts: [AGENTS.md]`; project
descendants inherit that declaration through normal `extends`.
A replacement Agent with no inherited parent must declare its own
mandatory dependencies. Generic Worker, Reviewer, Troubleshooter and Neo Project DAG Stage Agents declare no project Context by default. Relay development uses a project Reviewer override to select AGENTS.md; other projects can explicitly select their own context.

The selected project `AGENTS.md` is actually read into a lower-priority
User reference section. A missing or unreadable **declared** file fails
closed; unrelated files and project README are not bulk-loaded.
An absent execution Context may not silently bypass Planner's declared
AGENTS.md requirement.

### Skill names, not files

The effective Agent may declare `required_skills: [markcut, ponytail]`.
Relay conveys the **names only** and does not compute Skill paths, read
SKILL.md, install Skills or infer alternatives. The executing Agent
uses the available native Harness Skills List (for Codex, the
`neo skill list` command) to select the exact name and read its SKILL.md
before performing dependent work. If a mandatory Skill is missing or
unreadable, the Agent must report failure rather than simulate use.

`skills` remains a separate advisory name list; `model` and
`reasoning` are advisory Router hints. No file-content SHA is used for
acceptance. Internal fingerprints are diagnostic/report identifiers only.

## Harness delivery

**Codex:** The native Global AGENTS is Harness-owned. Relay sends trusted
instructions via Codex's supported developer-instruction configuration,
sends current assignment as the CLI User prompt, and disables implicit
directory AGENTS.md discovery with `project_doc_max_bytes=0`.
Explicitly declared Context still loads through the shared Builder.
The Codex Harness documents `neo skill list` as a Skill discovery entry.

**XChat / WebChat:** The Neo XChat Bootstrap provides Global rules,
Harness instructions and a discoverable Skills List. Relay and XChat
reuse canonical Agent/Contract selection, but a WebChat ordinary message
does **not** become a privileged System instruction merely because the
Builder labels it trusted. The delivery layer must report the actual
available authority. Successful bootstrap or a submitted message does
not by itself prove that an Agent followed Skill and Contract rules.

The Native CLI is the version-matched `agents-relay-rust` implementation;
never use legacy Node `dist/cli.js` paths as an execution authority.

## Verification boundaries

- Unit/integration: Agent inheritance, Contract ownership and completion
  selection, Planner/Implementation Context selection, required Skill
  names, missing-file fail-closed behavior and Prompt provenance.
- Native CLI dry-run: verify actual generated Codex Prompt layers, per-Agent
  Contract selection, Planner isolated evaluation policy and Context.
- Provider E2E: validate native Codex JSONL, actual Skill discovery/read,
  final event/Plan Apply receipts and durable Job/Task state.
- WebChat E2E: verify bootstrap catalog and platform-level instruction
  delivery; never infer actual privilege or Task completion from UI submission.
- Dashboard/JEL evidence: read accepted receipts and Task/Plan state,
  not process exit codes or optimistic text summaries.

Do not claim a live deployment, merge, real model execution or approval
unless the corresponding verified evidence exists.
