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
- `agents-relay prompt --repo REPO --id JOB --plan-id PLAN --adapter ...` and
  `--task-id TASK` call those **same entry points**, with no separate mock
  assembly, no alternative business Prompt, and no lifecycle changes.

The worker-facing Task Prompt is exactly four sections:

```text
# Role
You are <agent> with responsibility at <cached merged agent absolute path>.

## Contracts
<independent, ordered, sha256-pinned contract file references>

## Contexts
<independent global/Neo/project context file references and priority>

## Task
Use the agents-relay skill at <absolute skill path> to read Job/Task/Plan.
Job: <job-id>
Task: <task-or-plan-id>
Execution: <execution-id>
```

Only the Agent is inherited/merged by the **existing** Agent resolver and
content-addressed to a private 0600 file. Contracts and Contexts are NOT
merged, copied into the Agent, or expanded into launch Prompt text. Source
references include exact SHA-256 digests. Contexts list global rules, Neo
rules and project rules in increasing specificity. `README.md` is supporting
context and never overrides `AGENTS.md` instructions.

`agents-relay` is the actual existing skill name (not a new `agents-skill`).
It now documents two read-only, execution-bound SQLite commands:

```sh
agents-relay plan context --id JOB --plan-id PLAN --execution-id EXECUTION
agents-relay task context --id JOB --task-id TASK --execution-id EXECUTION
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
| ChatGPT Web | Account Default Instructions initialize Neo/XChat harness automatically; no extra per-Task Neo bootstrap | Exact Action output as a regular User turn, readable through Neo MCP |
| Z Web | Transport issues a short-lived OAuth token and uses the canonical interactive Z bootstrap URL, then Neo MCP. A real `task.started` must be accepted before the Task | Exact Action output appended *unaltered* after runtime bootstrap, via Z WebHelm |

Z's dynamic OAuth credential is a **separate runtime-only secret**, not part
of the reusable Task Prompt. The print-only CLI does not disclose it. Z uses
the existing `https://neoy.qili2.com/files/z-chat/bootstrap.md` entry, rather
than carrying another full copy of global rules or Skill catalogs.

Planner dispatch is currently Codex-only; `prompt --plan-id ... --adapter
chatgpt|z` produces a corresponding **Task Prompt preview**, not a working
non-Codex Planner delivery. Completed historical Plan Prompt bytes were not
persisted: CLI reconstruction uses the recorded execution ID and excludes
Tasks created after the Plan began, but should not be mistaken for the exact
historical bytes or current runnable authority.

## Validation

- Unit/integration: `test/prompt-action-parity.test.js`,
  `test/prompt-cli.test.js`, `test/managed-prompt-assembly.test.js`,
  `test/adapters.test.js`, `test/z-bootstrap.test.js`.
- Graph and lifecycle: `npm run test:verification:l1`, then the relevant L3
  integration tests. Model-only checks do not prove event completion.
- The no-GitHub local Job path and stale execution rejections are verified
  independently. A browser submit receipt is *not* a Task completion receipt.
