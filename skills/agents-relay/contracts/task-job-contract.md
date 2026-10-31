# Agents Relay Task / Job Contract

This contract is the shared protocol for every component that creates, schedules, reviews, or executes Agents Relay jobs and tasks.

## Job and Task authoring format

Job objectives and Task inputs are **Markdown** and are durable execution context, not short labels. Use Mermaid where a diagram materially explains a workflow, state model, architecture, dependency graph, relationship, or other visual structure. **Mermaid-first applies to that explanation/section, not to the entire Job objective or Task input.** Put the diagram before the prose that explains that visual model, but keep normal document structure: start with the goal/context when that is what the reader needs first. Do not force a Mermaid block at the top of every objective/input, and do not add decorative or redundant diagrams when Markdown is clearer.

The trusted machine-readable Job/Task marker stores lifecycle and execution metadata only. Do **not** duplicate the Job objective or Task input inside marker JSON. The Job marker lives in the PR body immediately before the human-readable Job objective; Task markers live in their Task comments immediately before the human-readable Task input/result. Readers reconstruct `objective` / `input` from that visible Markdown while remaining backward-compatible with legacy markers that embedded long-form content or stored the Job marker in a separate comment.

For long-form content, use files instead of shell-quoted arguments:

- Job create/update: `--objective-file PATH` (or `--objective-file -` for stdin) is preferred. `--objective` is for short/simple content only. They are mutually exclusive.
- Task create/update: `--input-file PATH` (or `--input-file -` for stdin) is preferred. `--input` is for short/simple content only. They are mutually exclusive.

When creating a new Job from an active discussion, the orchestrator must consolidate **all context needed to finish the Job without the originating thread** into the Job objective before creation. Include, as applicable: goal, relevant background, decisions already made, requirements, constraints, lifecycle/workflow semantics, non-goals, implementation boundaries, acceptance criteria, delivery/review instructions, and any important known issues. Do not create a Job whose objective is only a one-line summary when the discussion contains material implementation context.

Ordinary `job create` requires standalone objective Markdown. An external display PR is projected after the first meaningful code commit; existing PRs are adopted with `job adopt`. The PR body is the single durable Job surface: one hidden `agents-relay:job:v1` marker followed by the objective Markdown. Updating Job metadata or objective updates that same body. New Jobs must not create a separate Job comment that repeats the objective. Readers must remain backward-compatible with legacy Job-comment markers, and a successful Job save may migrate such a legacy marker into the PR body only after validating the replacement before deleting the redundant legacy Job comment.

## Task producers

Any task producer — orchestrator, planner, or nested task-producing agent — must follow this contract.
Task producers choose semantic task properties such as objective, dependencies, worker requirements, priority, and `storySize`. They do not normally choose an adapter, provider/model, or raw timeout milliseconds.

`Task.timeoutMs` is the inactivity window. Only an accepted `task.started` or newer `task.progress` event for the exact current execution resets it; duplicate, stale, and out-of-order progress does not.

### Planning graph and semantic Task tree

The planning graph expresses execution flow. The Task tree expresses semantic ownership. `dependencies` answer which durable outcomes must succeed before a Task can run; `parentTaskId` answers which durable artifact or milestone owns the Task. These are independent relationships.

A later Planner round must inspect the existing semantic tree and attach review, revision, re-review, validation rerun, release correction, or recovery work to the existing artifact subtree. Independent milestones remain roots. `plan-N` records are provenance/history and must never be semantic parents. Existing terminal Tasks remain immutable historical evidence and may continue to own later work.

### Task input vs result

A Task input records **what is known and what has already been decided before execution**. A Task result records **what execution discovered and what was actually done**.

After creation, keep `Task.input` stable as the objective and initial evidence.
Responses, resolution changes, and escalation history belong in append-only
Task Comments. SQLite atomically records typed comments with authoritative
resolution/escalation mutations; PR-bound Jobs project those comments through
the durable idempotent projection outbox. Comments supplement current state and
never replace `Task.resolution` or `Task.escalation`.

Task input should include, as applicable:

- goal and observed behavior;
- evidence and reproduction details;
- constraints and acceptance criteria;
- **known root cause** only when it is already confirmed by the user, a prior Task, or durable evidence;
- **hypothesis** when a suspected cause is not yet confirmed;
- **proposed solution** when there is a candidate approach that the executor may validate or change;
- **required solution** when the user or orchestrator has already decided the implementation approach. Executors must follow it unless they discover that it is infeasible, unsafe, or conflicts with higher-priority constraints, in which case they must report the deviation explicitly.

Do not require a producer to invent a root cause or solution that is not known yet.

Every executing Task worker must make both of these explicit in its durable Task result:

- **root cause** — for bug, incident, failure, diagnostic, or recovery work, state the confirmed cause; if it cannot be determined, say so and preserve the remaining uncertainty. For feature, refactor, research, review, or other work with no failure cause to diagnose, explicitly state that root cause is not applicable and why rather than omitting it.
- **implemented solution** — describe what was actually changed or done. For read-only research or review work, state the concrete findings, recommendation, or resolution produced by the Task rather than omitting the solution.

Task results should also include, as applicable:

- **deviations** from any proposed or required solution, with the reason;
- **validation** showing how the result was verified;
- relevant changed files, commits, PR comments, artifacts, or remaining issues.

This is a worker result-content contract, not a requirement for dedicated `rootCause` / `solution` schema fields. Workers may satisfy it in normal durable result prose unless a Job defines a stricter structured output contract.

Keep these concepts distinct: observation is not root cause; hypothesis is not root cause; requested approach is not implemented solution; implementation is not validation.

### Worker self-review before success

Every artifact-changing implementation worker follows the shared [worker self-review loop](worker-self-review.md), regardless of its selected agent name or runtime adapter. Complete the implement → self-review → fix → re-review cycle until the latest full review has no actionable findings. Include review rounds, fixes, validation evidence, and the clean-review result in the durable Task result. The worker's self-review never substitutes for an independent final Reviewer, human approval, or Relay's Graph-owned lifecycle gates.

### Job-defined Task tag

`Task.state` is reserved for Relay lifecycle only: `DRAFT`, `QUEUED`, `RUNNING`, `BLOCKED`, `SUCCEEDED`, `FAILED`, and `CANCELLED`. `BLOCKED` is exclusive to Tasks whose `agentName` is exactly `troubleshooter`; ordinary Tasks never enter `BLOCKED` or an `UNBLOCKED` lifecycle state. A Job may additionally define one optional `tag` contract for a Job-specific result or classification that should be visible on each Task without changing its lifecycle state.

The Job owns the meaning of the tag. Its trusted Job marker declares a human-readable `description` explaining what the tag means and when workers should set it, plus the allowed durable values and their dashboard display strings:

```json
{
  "tag": {
    "description": "L3 verification outcome. Set pass only after authoritative SQLite replay checks pass; set fail when a required check fails.",
    "values": {
      "pass": "✅",
      "fail": "❌"
    }
  }
}
```

A worker does **not** edit the Task marker directly. When the Job defines a tag and the tag applies to the work just performed, the worker reports one allowed durable value in the canonical terminal event as `data.tag`:

```json
{
  "type": "task.completed",
  "data": {
    "tag": "pass",
    "exit_code": 0
  }
}
```

Relay validates `data.tag` against `Job.tag.values`. If the value is allowed, Relay persists it into the trusted Task marker as the Task's `tag`; undeclared or invalid values are ignored. The transport `data.tag` is not duplicated into `result.data`. The resulting Task metadata may therefore contain both independent concepts at once:

```json
{
  "state": "SUCCEEDED",
  "tag": "pass"
}
```

The dashboard always keeps the normal lifecycle badge. When a valid Task tag is present, it additionally renders the display string from `Job.tag.values` after the lifecycle status. For the example above this appears as `SUCCEEDED ✅`.

A tag must describe something specific to the Job contract, not Relay lifecycle. Examples include a verified L3 result (`pass` / `fail`), publication result, validation classification, or another small Job-defined outcome. The Job description must tell the worker when to set the tag and what each allowed value means. Jobs without a `tag` declaration behave exactly as before.

For a validation Job, for example, the Job defines `pass -> ✅` and `fail -> ❌`; each L3 verification Task reports `data.tag` after the isolated replay and evidence checks, while Task lifecycle independently records the worker outcome.


### Task resolution classifications

`Task.resolutionClassification` is durable diagnostic metadata, separate from
`Task.state` and the recovery `Task.resolution` path. The canonical Task
Resolution Graph and `task classify` CLI action may classify a known FAILED
work Task as `superseded` or `invalid`; each record requires a different
durable target Task, evidence, and reason. Classification never changes the
FAILED lifecycle state, execution history, or result and never proves success.
Unknown outcomes, active executions, and Tasks with active recovery ownership
cannot be classified. Planners must preserve these fields in their assessment
and may treat classified history as covered when validating a fresh Plan.

### Optional Review Chair Tasks

Projects may use the shared `review-chair` agent as a normal Task or Agent
Graph node. The chair discovers specialist agent roles from the resolved
visible-agent catalog, records selection reasons, and creates sibling durable
specialist Tasks carrying the same immutable review target/version. Their
structured findings are synthesized into one attributed revision plan. A chair
may add a specialist when synthesis exposes a missing dimension. It never
chooses worker/model/provider, edits the artifact, or replaces the existing
SHA-bound final reviewer. For example, `video-director + market + style ->
review-chair -> unified revision plan` is a project pattern, not a hard-coded
Relay reviewer list.

Every Job is objective-driven. After a direct initial Task batch or a Planner-produced batch settles, reconciliation evaluates the canonical Planner Graph and creates the next durable `plan-N` round until the latest successful Plan returns `objective_status: satisfied`. There is no fixed/autonomous mode, no Job schedule, no cron slot, and no Scheduler entity. The daemon performs startup recovery and wake-driven reconciliation from SQLite. A satisfied Plan alone does not complete a Job: successful implementation evidence, SHA-bound review when enabled, and verified local merge/delivery remain mandatory.

A newly created zero-task DRAFT Job waits for explicit initial planning (`plan` or `--initial-plan`) or direct work creation; this is only a start gate, not a distinct execution mode. Failed or blocked Tasks require durable Troubleshooter/owner recovery and never allow a fabricated completion. Duplicate events and daemon restarts must not create duplicate Plan rounds.


## Task evidence and head identity

### Canonical Neo Project runs boundary

`runs/` is durable runtime evidence, not source code and not temporary checkout state. When a Task's declared file output is under `runs/`, that Task and every semantic descendant execute directly in the canonical resolved project directory. Agents Relay MUST NOT create or switch those Tasks into per-execution Git worktrees.

This is a strong execution boundary:

- tracked source/code work may use a managed PR worktree;
- Neo Project runtime work under `runs/` uses the canonical project directory;
- continuations, reviews, QA, render, and publication Tasks beneath a `runs/` owner reuse that same canonical runtime directory;
- `runs/` remains ignored/private and must not be committed merely to move evidence between Tasks;
- a new Task/worktree must never make prior run evidence disappear.

For example, a `neo-build-log` episode whose output is `runs/2026-10-02/package.md` executes in the canonical `neo/neo-build-log` project directory, and its review/render/publish descendants see the same `runs/2026-10-02/` tree.

Task inputs must make evidence freshness and target identity explicit when those facts affect correctness. A Task may bind its own review, audit, or source evidence to an immutable SHA/version. That frozen target belongs to that Task; it must not be propagated mechanically into later dependent work. A downstream release, deploy, publication, or other Task that runs after dependencies complete must resolve the current durable Job/PR head at execution time unless the Job objective explicitly requires the earlier immutable target.

When success depends on the actual current UI, browser state, store listing, runtime state, or another externally observable surface, the Task contract must require fresh evidence from that real current surface. Reusing an existing screenshot, prepared asset, cached observation, or older evidence is valid only when the Job explicitly permits it.

This does not weaken immutable review semantics: final review and specialist review Tasks should continue to declare and inspect one exact immutable target/version.

When project context exposes a canonical design-principles or architecture
contract, Final Review must also verify the reviewed immutable target against
the principles that materially apply to the Job objective and changed area.
The reviewer should consume that project context rather than duplicating the
full architecture contract in the review Task. A second authority path or
stateful action is a blocking architecture finding when the project contract
forbids it.

## Dependency vs block and authoritative unblock

`dependencies` describe normal DAG ordering. An unmet dependency keeps ordinary work in `DRAFT`; dispatchable work is `QUEUED`. Dependency completion does not create an unblock lifecycle event or Planner unblock trigger; Relay releases dependent work when its prerequisites succeed. Worker, platform, semantic, and unknown-outcome failures are `FAILED`. Unknown worker outcome fails closed and never justifies rerouting. Only a Troubleshooter waiting for an authoritative human response may become `BLOCKED`.

A BLOCKED Troubleshooter cannot be resumed through retry, queue, dashboard state editing, PR push, webhook, ordinary task update, or Troubleshooter inference. The authoritative entry point records the response and transitions that same Troubleshooter `BLOCKED -> QUEUED` through `task.unblocked`. The queued Troubleshooter must execute again, verify the condition from fresh evidence, and issue a fresh resolution before Relay may retry or replan the original FAILED Task. Prior `resolved` metadata never authorizes another attempt. Historical ordinary BLOCKED snapshots migrate to FAILED while their append-only event history remains unchanged; they are never silently converted to success.

The old `UNBLOCKED` state is compatibility-only input. It normalizes to QUEUED only for Troubleshooter Tasks and to FAILED for ordinary Tasks, pending diagnosis.

Each Planner round is also a first-class durable Plan entity stored in its own `agents-relay:plan:v1` PR comment. Relay creates the Plan comment before the internal planner execution record and before any generated Task comments, then updates that same Plan comment with the final assessment and generated Task IDs. Unblock/change facts belong to the Plan trigger/context, not to new Job-level Change Cycle state. Historical `kind=planner` Task records and legacy Job `changeCycle` fields remain readable for compatibility only.

A blocker Job owns reverse `unblocks` references. When it resolves, Relay releases matching dependency-waiting Tasks through their ordinary DRAFT/QUEUED path. It cannot unblock ordinary work or resume a Troubleshooter without the authoritative response flow.

Automatic Planner creation treats a currently BLOCKED Troubleshooter as a recovery gate. FAILED history alone does not authorize resolution or success; active DRAFT/QUEUED/RUNNING work still prevents a competing planning round.
