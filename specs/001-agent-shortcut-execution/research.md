# Authoritative Reuse Inventory

Date: 2026-11-03

This inventory was completed before runtime changes. It records existing owners
and intended reuse; implementation must not introduce parallel authorities.

## Agents Relay

| Capability | Existing authority | Reuse boundary |
| --- | --- | --- |
| Agent DAG parsing and scheduling semantics | `src/agent-graph.ts`: `parseAgentGraph()` validates supported Mermaid, detects cycles, returns `nodes`, `edges`, and topological `waves` | Consume this parser and its dependency semantics; do not add another parser. |
| Job/Task operational truth | Relay V2 SQLite Store and persisted Job/Task entities | Keep the shortcut run on an existing Job and durable Task state. Events are wakeups/observability. |
| Lifecycle transitions and effects | `workflow/task-lifecycle.mmd`, `workflow/job-lifecycle.mmd`, `src/workflow/lifecycle.ts`, dispatcher facade | Add graph-owned transitions if new lifecycle decisions are needed; do not mutate snapshot JSON around the graph. |
| Task construction | `src/workflow/entity-creation.ts` `createTaskEntity()` | Use canonical Task construction and dependency checks. Existing CLI task producers use `storySize`, not raw timeout. |
| Existing Job creation and Planner behavior | `job create` in `src/cli.ts`, `src/relayd-control.ts`; `--initial-plan` creates the normal Planner round | Preserve current behavior and defaults. Shortcut is opt-in. |
| Normal worker routing/fallback | Reconciler, execution context and model/worker routing | Normal Worker safe pre-submission rerouting is separate from Direct Shortcut mode. Missing/failed Direct Shortcut nodes must fail closed; they may not automatically enqueue an ordinary Worker. A normal ChatGPT/Z failure with no accepted start may retry once on a configured Codex default. |
| Prompt and agent context | shared execution-context resolver and `buildRelayWorkPrompt` | Resolve project-specific agents ahead of shared Neo agents at execution time; do not persist resolved absolute paths in Task records. |

## Neo Project and Vlog

| Capability | Existing authority | Reuse boundary |
| --- | --- | --- |
| Project policy and agent discovery | Neo root `AGENTS.md`, project `AGENTS.md`, and shared `agents/*.agent.md` | Keep existing Markdown agents and project directories intact. Shortcut source is additive under `agents/.shortcut/<agent>.agent.mjs`; project agents take precedence over Neo shared agents. |
| Vlog normal-stage topology | `vlog/graph.mmd` and `vlog/AGENTS.md` | Existing DAG: Visioner → Director → Editor → Producer → Final QA. Watcher/ingress and publishing are outside it. |
| Visioner behavior | `agents/visioner.agent.md` | Treat this contract as authoritative; shortcut may only execute supported existing tools and return its required evidence. |
| Stage inputs, artifacts and acceptance | `vlog/docs/episode-stage-contract.md` | Visioner requires owner-approved source manifest/local readable media; `vision-evidence.json` cites source IDs, hashes, original times, and uncertainty. |
| Media understanding and metadata | Markcut Vision CLI; approved `input/media/metadata.json` and `perception.desc` | Reuse valid metadata and Markcut's CLI; no custom media pipeline, provider switch, fabricated observations, or overwrite of approved evidence. |
| Vlog index creation | `vlog/scripts/index-markcut-vision.mjs` | Invoke the existing script from Vlog root for a dated canonical run; its index is intermediate, not accepted Visioner evidence. |
| Human approval/publication gates | Vlog stage contract and producer/final-QA agents | Shortcut completion cannot infer human approval or publication authorization. Content-only runs must not trigger Git merge. |

## Existing gaps / constraints

- Relay's `TaskState` has DRAFT, QUEUED, RUNNING, BLOCKED, SUCCEEDED, FAILED,
  CANCELLED; there is no `WAITING_EVENT` state. Current BLOCKED/unblock semantics
  are Troubleshooter-specific. A safe wait/resume design therefore needs a
  graph-owned state/transition and durable correlation, or a narrower MVP that
  leaves event-waiting to existing async Workers.
- The current task graph applies one Task lease/execution to worker runs. A
  direct DAG run must claim that same Task atomically and must not allocate a
  per-node browser/model worker.
- The provided Spec Kit checkout is untracked in this worktree. It is retained;
  generated/copied `.github/skills/` content is also pre-existing untracked
  worktree data and will not be deleted as part of this hotfix.
- No real episode inputs or execution authorization are part of this request;
  only fixture-based tests may exercise Visioner behavior.

## Architecture Lens

The workflow decisions are whether Direct Shortcut mode executes its declared
Graph through code/model-backed nodes and whether an unstarted normal
ChatGPT/Z failure qualifies for one Codex-default retry.
The owning policy belongs in a stable workflow graph. Concrete shortcut
discovery, execution, artifact validation and persistence are actions/mechanics.
SQLite remains the sole durable authority; no second Job store, event bus,
parser, or lifecycle state machine is acceptable. The existing `job create`
path remains unchanged unless the user opts into the new execution mode.
