# Graph-owned Prompt Action

Relay uses a single effective Agent resolver and a single prompt Action for
Planner, Reviewer, Troubleshooter and Implementation Workers. No additional
Role Skill or second Prompt registry exists.

## Graph → Action → Adapter

- The existing `planner-orchestration.mmd` selects a Planner launch. The
  Planner runtime calls `buildPlannerExecutionPrompt()`, which calls the
  shared `buildRelayWorkPrompt()` Action in `agent-prompt-builder.ts`.
- `task-lifecycle.mmd` selects `effect.launchTask`. Its Reconciler effect calls
  `managedWorkerInput()`, which calls the **same** `buildRelayWorkPrompt()`.
- `node <matching-absolute-dist/cli.js> prompt --id JOB --plan-id PLAN --adapter ...` and
  `--task-id TASK` call those **same entry points**, with no separate mock
  assembly, no alternative business Prompt, and no lifecycle changes.

The worker-facing Prompt has five short sections; Bootstrap differs by adapter:

```text
# Role
You are <agent> with responsibility at <cached merged agent absolute path>.

## Bootstrap
<adapter-specific initialization, no duplicated global instructions>

## Contracts
<independent, ordered contract file paths>

## Contexts
<only additional project-specific AGENTS.md when the adapter cannot auto-load it>

## Task
Use the agents-relay skill to read Job/Task/Plan.
Job: <job-id>
Task: <task-or-plan-id>
Execution: <execution-id>
```

Planner reads the Task/Job/Plan Contract, but not Task lifecycle event contracts: a Plan is not a Task and does not emit `task.started`/`task.progress`/`task.completed`. Planner starts with **no Context files**. Its merged project Agent selects `graph.mmd`, stage contracts, and downstream Agent definitions as needed. For normal Tasks, Codex loads project rules through cwd, while ChatGPT/Z receive only the active project `AGENTS.md` because their Web harness does not automatically load local project instructions. This is deliberate per-adapter/context selection, not a directory dump.

Project and Neo Agent frontmatter may use `extends` with an absolute Markdown path (including a standalone external `SKILL.md`). The selected local Agent keeps its own name; the referenced base can have a different name. Existing `mode`/`sections` merge rules apply, and both canonical source paths contribute to the merged contract. Source paths must be explicitly trusted by the Project author; Relay does not discover or register the external roster. Missing or malformed bases fail before Worker launch. Specialist `review run` uses the same resolver.

Optional Agent frontmatter hints use inline YAML values:
```yaml
skills: [shotcraft, markcut]
model: openai/gpt-6
reasoning: high
```
`skills` is displayed only as **Suggested skills** in the Worker's User
Assignment (including the Planner when its Agent is selected). The names do
not auto-install, select, validate or require a Skill. `model` and
`reasoning` are sent only to the unified Execution Router decision prompt as
a **soft Agent preference**, below user routing instructions and all hard
constraints. They do not add candidates, override explicit Task routing, or
alter Router fallback. Missing fields leave both Prompts unchanged. Agent advice
is resolved through a read-only project locator; it never prepares a Task worktree.
If no safe locator or Agent is available, Relay skips the advice.

Only the Agent is inherited/merged by the **existing** Agent resolver and
content-addressed to a private 0600 file. Contracts and Contexts are NOT
merged, copied into the Agent, or expanded into launch Prompt text. Source
references include exact SHA-256 digests. Global rules belong to Bootstrap.
`README.md` is human documentation and is never included as Agent Context.

`agents-relay` is the actual existing skill name (not a new `agents-skill`).
It now documents two read-only, execution-bound SQLite commands:

```sh
node <matching-absolute-dist/cli.js> plan context --id JOB --plan-id PLAN --execution-id EXECUTION
node <matching-absolute-dist/cli.js> task context --id JOB --task-id TASK --execution-id EXECUTION
```

Both reject stale execution bindings. The Worker does not discover Task
content in GitHub/PRs or trust a bare Task ID as authorization. For Plan work,
`plan apply` and its exact durable receipt remain the completion authority;
for Task work, the existing events-bus protocol and Graph own started and
terminal state. `prompt` inspection never launches a model or alters state.

## Adapter Bootstrap boundary

| Adapter | Runtime bootstrap | Task Prompt transport |
| --- | --- | --- |
| Codex | Execution cwd is resolved project; Codex's local instructions plus explicit Context files | Exact Action output as CLI initial prompt |
| ChatGPT Web | Caller-configured harness initializes instructions; Relay does not prescribe a bootstrap | Exact Action output as a regular User turn, readable through configured file tools |
| Z Web | Transport issues a short-lived OAuth token and uses the canonical interactive Z bootstrap URL, then configured MCP tools. A real `task.started` must be accepted before the Task | Exact Action output appended *unaltered* after runtime bootstrap, via Z WebHelm |

Each worker uses the **same CLI version as the Skill pinned by its Prompt**:
resolve `../../dist/cli.js` from `skills/agents-relay/SKILL.md` and invoke
`node <matching-absolute-dist/cli.js>`. Do not invoke a stale global
`agents-relay` CLI. The `plan context` result's `apply_cli` is also bound to
that exact `dist/cli.js`. Task body and review/evidence attachments remain
in SQLite; ChatGPT `new-thread`/`new-turn` transports the Graph Action Prompt
unaltered and keeps idempotency/attachment metadata outside user-message
prose. This byte-for-byte transport check is part of regression tests.

Z's dynamic OAuth credential is a **separate runtime-only secret**, not part
of the reusable Task Prompt. The print-only CLI does not disclose it. The Z adapter uses a caller-configured OAuth origin and harness bootstrap;
Relay never supplies a fixed service endpoint or master credential path.

Planner dispatch is currently Codex-only; `prompt --plan-id ... --adapter
chatgpt|z` produces a corresponding **Task Prompt preview**, not a working
non-Codex Planner delivery. Completed historical Plan Prompt bytes were not
persisted: CLI reconstruction uses the recorded execution ID and excludes
Tasks created after the Plan began, but should not be mistaken for the exact
historical bytes or current runnable authority.

## L4 Prompt Evals

`npm run test:verification:l4` evaluates **18 role/adapter pairs**: 6 Agent
roles × 3 adapters. It generates 14 real Prompts and verifies four hard
runtime rejections before dispatch (Troubleshooter and interactive Vlog
Producer on unsupported adapters). For each generated Prompt it compares the CLI's bytes against the Graph
Action Builder, reads and SHA-verifies the actual cached
Agent and all Contracts, verifies role identity and domain-specific
instructions, rejects duplicate Bootstrap/README/Neo-root contexts, checks
minimal per-adapter Context counts, validates mandatory event obligations,
and proves Task/Plan Context retrieval from isolated **real SQLite** with stale
execution rejection. It also records runtime feasibility separately: Planner
is currently Codex-only; a Final QA on Codex/Z requires additional real
playback/audio capability evidence before it can be accepted. This is a local code/contract evaluation, not an
external model completion.

`npm run test:verification:l4:live` tests the installed Codex CLI/project cwd,
ChatGPT's WebHelm readiness, and a newly issued temporary Z OAuth credential
against the real remote Neo MCP `tools/list`, **pinned Agent snapshot** `fs`
read, and `shell` `neo bootstrap`. Results are saved as a private JSON
report (`/tmp/relay-prompt-l4-live.json` by default), without secrets. Set
`RELAY_L4_CODEX_MODEL_EVIDENCE_FILE` and
`RELAY_L4_CHATGPT_TOOL_PROBE_FILE` to authenticated, independently observed
model-tool probe evidence when available. A submitted Web turn is never proof
that the model used tools. Provider terminal events and real Job outcome are
not exercised by the L4 bootstrap smoke checks: those remain separate E2E
requirements.

The L4 project suite targets the actual Neo Master `neo/vlog` project, not a
fabricated Vlog Agent; override `RELAY_L4_VLOG_PROJECT` for a valid project.
L4 requires access to that project, so it is a **separate verification gate**
from portable unit tests and does not run on generic GitHub runners without
the configured Relay browser workspace.

## Validation

- Unit/integration: `test/prompt-action-parity.test.js`,
  `test/prompt-cli.test.js`, `test/managed-prompt-assembly.test.js`,
  `test/adapters.test.js`, `test/z-bootstrap.test.js`.
- Graph and lifecycle: `npm run test:verification:l1`, then the relevant L3
  integration tests. Model-only checks do not prove event completion.
- The no-GitHub local Job path and stale execution rejections are verified
  independently. A browser submit receipt is *not* a Task completion receipt.

References remain validated internally; generated worker-facing prompts never display SHA256 digests. Z.ai receives its short-lived OAuth token inside the existing Bootstrap section, without a second role or lifecycle prompt.
