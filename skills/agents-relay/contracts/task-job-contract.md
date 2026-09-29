# Agents Relay Task / Job Contract

This contract is the shared protocol for every component that creates, schedules, reviews, or executes Agents Relay jobs and tasks.

## Job and Task authoring format

Job objectives and Task inputs are **Markdown** and are durable execution context, not short labels. Use Mermaid where a diagram materially explains a workflow, state model, architecture, dependency graph, relationship, or other visual structure. **Mermaid-first applies to that explanation/section, not to the entire Job objective or Task input.** Put the diagram before the prose that explains that visual model, but keep normal document structure: start with the goal/context when that is what the reader needs first. Do not force a Mermaid block at the top of every objective/input, and do not add decorative or redundant diagrams when Markdown is clearer.

The trusted machine-readable Job/Task marker stores lifecycle and execution metadata only. Do **not** duplicate the Job objective or Task input inside marker JSON. The Job marker lives in the PR body immediately before the human-readable Job objective; Task markers live in their Task comments immediately before the human-readable Task input/result. Readers reconstruct `objective` / `input` from that visible Markdown while remaining backward-compatible with legacy markers that embedded long-form content or stored the Job marker in a separate comment.

For long-form content, use files instead of shell-quoted arguments:

- Job create/update: `--objective-file PATH` (or `--objective-file -` for stdin) is preferred. `--objective` is for short/simple content only. They are mutually exclusive.
- Task create/update: `--input-file PATH` (or `--input-file -` for stdin) is preferred. `--input` is for short/simple content only. They are mutually exclusive.

When creating a new Job from an active discussion, the orchestrator must consolidate **all context needed to finish the Job without the originating thread** into the Job objective before creation. Include, as applicable: goal, relevant background, decisions already made, requirements, constraints, lifecycle/workflow semantics, non-goals, implementation boundaries, acceptance criteria, delivery/review instructions, and any important known issues. Do not create a Job whose objective is only a one-line summary when the discussion contains material implementation context.

For a newly created PR (`job create --head`), standalone objective Markdown is required. The PR body is the single durable Job surface: one hidden `agents-relay:job:v1` marker followed by the objective Markdown. Updating Job metadata or objective updates that same body. New Jobs must not create a separate Job comment that repeats the objective. Readers must remain backward-compatible with legacy Job-comment markers, and a successful Job save may migrate such a legacy marker into the PR body only after validating the replacement before deleting the redundant legacy Job comment.

## Task producers

Any task producer — orchestrator, planner, or nested task-producing agent — must follow this contract.
Task producers choose semantic task properties such as objective, dependencies, worker requirements, priority, and `storySize`. They do not normally choose an adapter, provider/model, or raw timeout milliseconds.

### Task input vs result

A Task input records **what is known and what has already been decided before execution**. A Task result records **what execution discovered and what was actually done**.

Task input should include, as applicable:

- goal and observed behavior;
- evidence and reproduction details;
- constraints and acceptance criteria;
- **known root cause** only when it is already confirmed by the user, a prior Task, or durable evidence;
- **hypothesis** when a suspected cause is not yet confirmed;
- **proposed solution** when there is a candidate approach that the executor may validate or change;
- **required solution** when the user or orchestrator has already decided the implementation approach. Executors must follow it unless they discover that it is infeasible, unsafe, or conflicts with higher-priority constraints, in which case they must report the deviation explicitly.

Do not require a producer to invent a root cause or solution that is not known yet.

Task results should include, as applicable:

- **root cause** for bug, incident, failure, diagnostic, or recovery work; if an investigation cannot determine it, state that explicitly with the remaining uncertainty;
- **implemented solution**, describing what was actually changed or done;
- **deviations** from any proposed or required solution, with the reason;
- **validation** showing how the result was verified;
- relevant changed files, commits, PR comments, artifacts, or remaining issues.

For feature/refactor work with no failure to diagnose, root cause is not required. For research tasks, use findings/evidence instead of forcing root-cause language.

Keep these concepts distinct: observation is not root cause; hypothesis is not root cause; requested approach is not implemented solution; implementation is not validation.

### Job-defined Task tag

`Task.state` is reserved for Relay lifecycle only: `DRAFT`, `QUEUED`, `RUNNING`, `BLOCKED`, `SUCCEEDED`, `FAILED`, and `CANCELLED`. A Job may additionally define one optional `tag` contract for a Job-specific result or classification that should be visible on each Task without changing its lifecycle state.

The Job owns the meaning of the tag. Its trusted Job marker declares a human-readable `description` explaining what the tag means and when workers should set it, plus the allowed durable values and their dashboard display strings:

```json
{
  "tag": {
    "description": "Deterministic E2E outcome. Set pass when the fixed E2E exits 0; set fail when it still fails after the required retry.",
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

A tag must describe something specific to the Job contract, not Relay lifecycle. Examples include an E2E result (`pass` / `fail`), publication result, validation classification, or another small Job-defined outcome. The Job description must tell the worker when to set the tag and what each allowed value means. Jobs without a `tag` declaration behave exactly as before.

For the ChatGPT Browser Worker guardian, for example, the Job defines `pass -> ✅` and `fail -> ❌`; each hourly E2E child Task reports `data.tag` after running the fixed deterministic E2E, while the Task lifecycle independently records whether Relay execution itself completed, failed, or became blocked.


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

A scheduled autonomous job adds cron/timezone/next-run and missed-run/concurrency policy to the trusted job marker. The always-on `agents-relayd` process is the sole heartbeat for repositories it manages: on startup and every ten minutes it evaluates cached managed Jobs and reconciles due work through the local worker pool. There is no GitHub Actions scheduler fallback. Unscheduled autonomous Jobs and fixed Jobs do not use the scheduler heartbeat.

The scheduler heartbeat filters cached managed Jobs, reloads each due Job to validate the marker's exact `nextRunAt`, claims the slot idempotently, advances the durable next run, and reconciles planner/worker execution locally. While the schedule is active, the durable Job remains `ACTIVE`; between runs its derived runtime status is `WAITING`. Scheduled recurring Jobs do not enter one-shot final-review/auto-merge after each satisfied run; older-cycle failures are historical evidence and do not block a later slot.


## Task evidence and head identity

Task inputs must make evidence freshness and target identity explicit when those facts affect correctness. A Task may bind its own review, audit, or source evidence to an immutable SHA/version. That frozen target belongs to that Task; it must not be propagated mechanically into later dependent work. A downstream release, deploy, publication, or other Task that runs after dependencies complete must resolve the current durable Job/PR head at execution time unless the Job objective explicitly requires the earlier immutable target.

When success depends on the actual current UI, browser state, store listing, runtime state, or another externally observable surface, the Task contract must require fresh evidence from that real current surface. Reusing an existing screenshot, prepared asset, cached observation, or older evidence is valid only when the Job explicitly permits it.

This does not weaken immutable review semantics: final review and specialist review Tasks should continue to declare and inspect one exact immutable target/version.

## Dependency vs block and authoritative unblock

`dependencies` describe normal DAG ordering. Dependency completion does not create an unblock lifecycle event or Planner unblock trigger; Relay simply releases dependent work when its prerequisites succeed. `BLOCKED` is different: it records that execution reached a runtime/external condition that invalidates normal progress.

A BLOCKED Task cannot be resumed through retry, queue, dashboard state editing, PR push, webhook, ordinary task update, or troubleshooter inference. Except for blocker-Job resolution, the authoritative entry points are `task unblock --reason ...` and `job unblock --reason ...`. Authoritative unblock records the blocked baseline and current evidence, then transitions `BLOCKED -> UNBLOCKED` through the durable `task.unblocked` lifecycle event. `BLOCKED` therefore always means the blocker is still effective; `UNBLOCKED` means the old blocked attempt is historical and its blocker was explicitly cleared.

A CANCELLED Task is terminal by default. An explicit `task recover --reason ...` operation may requeue the same Task identity only when its Job remains nonterminal; it clears the stale execution lease, extends the retry budget, and requires the canonical `recover [explicitRecovery]` lifecycle transition. Ordinary retry and dashboard actions continue to reject CANCELLED Tasks.

For autonomous Jobs, an UNBLOCKED Task is never silently retried. Its unblock metadata becomes the trigger/change context for the next Planner round, which decides whether to replace, split, wait, or otherwise re-plan the objective. For fixed Jobs, authoritative unblock records the UNBLOCKED transition first and may then requeue the same Task according to fixed-job retry semantics.

Each Planner round is also a first-class durable Plan entity stored in its own `agents-relay:plan:v1` PR comment. Relay creates the Plan comment before the internal planner execution record and before any generated Task comments, then updates that same Plan comment with the final assessment and generated Task IDs. Unblock/change facts belong to the Plan trigger/context, not to new Job-level Change Cycle state. Historical `kind=planner` Task records and legacy Job `changeCycle` fields remain readable for compatibility only.

A blocker Job owns reverse `unblocks` references. When it resolves, Relay checks the dependent Job. If that autonomous Job has an effective BLOCKED work Task, resolution uses the same authoritative `BLOCKED -> UNBLOCKED -> Planner` path. If it does not have BLOCKED work (for example the registered Task is DRAFT or FAILED), existing release/retry behavior remains unchanged.

Automatic Planner creation treats only a Task whose lifecycle state is exactly `BLOCKED` as a block gate. `UNBLOCKED` and FAILED history do not themselves gate a new Planner round; active DRAFT/QUEUED/RUNNING work still prevents a competing planning round.
