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

## Worker routing order

Every new model-backed executable task follows this order:

1. The planner describes the executable Task precisely. It does not invent a capability matrix for Codex versus ChatGPT. workerRequirements is optional compatibility metadata; an explicit runtime may be used only when the caller already knows the Task must use that runtime.
2. worker-router gathers factual Task context, discovered worker availability, the current shared usage snapshot, built-in routing principles, and optional local free-text rules. Only authoritative legality facts such as an explicitly offline worker or an explicit caller-owned runtime constraint are hard gates. Descriptive capability labels, region/trust labels, and provider quota are decision facts rather than ordinary worker hard gates.
3. When more than one legal model-backed worker exists, worker-router calls the generic typed decide(request, contract) primitive to choose the execution worker. Its default principles prefer ChatGPT when both workers can execute the Task, prefer Codex when native/local execution is necessary, and treat Codex/OpenAI quota pressure as a preference rather than proof that the Codex worker is unusable.
4. model-router runs only after worker selection and independently chooses provider/model/profile for that worker. In particular, an exhausted OpenAI quota must not eliminate the Codex worker before Model Router has a chance to choose another Codex provider/profile.
5. decide() owns no routing facts or legality policy. Its optional Laya implementation is a transient CLI subprocess per decision; unavailable/invalid decisions fall back deterministically. src/usage.ts remains the shared resource-fact source.
6. Relay persists the selected worker and model routing on the durable task before launch.

Planner output must not hard-code codex/chatgpt, provider preference, inferred worker capabilities, or usage probes. Worker Router and Model Router are separate responsibilities. Legacy task records that already contain adapter/routing/worker-requirement metadata remain readable.

## Story size

Every worker task has one of three story sizes:

- `S`: about 5 minutes of normal-reasoning execution.
- `M`: about 15 minutes of normal-reasoning execution. This is the default when size is absent or uncertain.
- `L`: about 45 minutes of normal-reasoning execution.

Relay derives the overall execution timeout from `storySize`. If `routing.reasoning` is `high`, Relay doubles the overall execution timeout. Other reasoning levels do not change it.

Raw `timeoutMs` is a compatibility/debug/hotfix override, not the normal task-production interface.

## Task readiness states

Canonical Job/Task lifecycle legality is defined by the directly renderable runtime sources `workflow/job-lifecycle.mmd` and `workflow/task-lifecycle.mmd`. Producers, runtime code, docs, and agents must treat those files as the transition source of truth; the prose below explains semantics and must not become a second transition table.

Task readiness is explicit and must use these semantics:

- `DRAFT`: durable Task exists but is not executable now. A DRAFT Task with dependencies is promoted to `QUEUED` when all dependencies succeed. A DRAFT Task with no dependencies remains held until an explicit release to `QUEUED`.
- `QUEUED`: executable now; Relay may launch it immediately subject only to worker capacity/routing.
- `RUNNING`: worker execution has actually started.
- `BLOCKED`: execution cannot continue without an external resolution or intervention. Once a Task has entered `RUNNING`, it must not return to `DRAFT`; waiting discovered during execution is `BLOCKED`.
- `SUCCEEDED`, `FAILED`, and `CANCELLED` are terminal outcomes, except that retry explicitly requeues a failed/blocked Task.

Do not use `WAITING` as a Task state or durable Job lifecycle state. `WAITING` is a derived Job runtime status for an `ACTIVE` Job whose next progress depends on a future trigger, schedule slot, dependency release, or other condition.

## Orchestrator self-task ownership

A Task with `adapter: orchestrator` is synchronous self-work owned by the exact orchestrator turn that creates it. It is not a durable handoff to Relay, another worker, a later reconcile cycle, or a future orchestrator thread.

- Creating an `adapter: orchestrator` Task is an execution commitment: the creating orchestrator must execute it in the current turn.
- The creating orchestrator must not end its turn while any orchestrator Task it created remains `QUEUED` or `RUNNING`; it must drive each such Task to a terminal state before returning control to the user.
- Relay must not auto-start, lease, route, or emit synthetic `task.started` / assignment evidence for orchestrator Tasks. A queued orchestrator Task means the creator has not yet terminalized its self-work.
- Successful self-work is terminalized on the same durable Task with `task complete --task-id ... --summary ...`; do not use `record` as a substitute for a Task that was created before execution. `record` remains a backfill mechanism for work that genuinely happened outside Relay.
- If work is intended to survive the current turn or be picked up asynchronously, use a real worker adapter rather than `orchestrator`.

## Cross-Job blocker dependencies

Task `dependencies` remain local to one Job and must contain only Task IDs from that Job. Shared runtime/tool/platform blockers use a separate durable cross-Job relation. The blocker Job owns reverse `unblocks` records identifying dependent repository, PR, Job, Task, and blocked attempt. The dependent Task may carry a lightweight `blockedBy` reference for observability and deduplication.

Blocker resolution is generation-safe and idempotent: Relay retries a dependent only when it is still FAILED/BLOCKED on the recorded attempt and still points at that blocker. Otherwise the relation becomes obsolete. Merge-mode blockers resolve when the blocker PR is observed merged. Blockers requiring package publication, deployment, runtime health, human/external verification, or another post-merge fact use verified mode and resolve only through the explicit verified-resolution path. Existing failure evidence is preserved; retry uses the normal FAILED/BLOCKED -> QUEUED lifecycle transition.

## Worker lifecycle

Relay owns process lifecycle. Workers own semantic task lifecycle. A worker must publish canonical `task.started` as its first execution action, then exactly one of `task.completed`, `task.failed`, `task.blocked`, or `task.cancelled`. Process launch/exit events do not substitute for worker semantic events.

Relay allocates the durable `executionId` before launching model-backed work and gives that worker one exact event source identity: `job/<job-id>/task/<task-id>/execution/<execution-id>`. Every semantic lifecycle event from that execution must copy the identity verbatim in `source.id`. Relay correlates model-worker lifecycle only by this execution identity; `source.agent`, `source.component`, provider/adapter names, and `data.worker_owned` are diagnostic/legacy metadata and MUST NOT authorize or correlate lifecycle state. A retry receives a new execution identity, so events from an older execution are ignored.

A durable execution lease survives Relay process/owner restarts until its `leaseExpiresAt`. A different Relay owner is not evidence that the worker died and MUST NOT by itself reclaim or retry that execution. Recovery may reclaim only after the durable lease expires or another authoritative terminal/liveness fact proves the execution ended.

For a GitHub-backed Job, every mutating model-backed execution runs from an isolated worktree pinned to that PR's current head SHA. It must not run from or switch the user's primary checkout. Relay verifies the remote repository and exact PR head before launch and fails closed when it cannot prepare that checkout. Concurrent PR Jobs for the same repository use separate execution worktrees.

## Job lifecycle and runtime status

The canonical durable lifecycle transition graphs are `workflow/job-lifecycle.mmd` and `workflow/task-lifecycle.mmd`. They use Relay's minimal executable Mermaid `stateDiagram-v2` profile and are the single source of truth for transition legality; do not maintain a parallel JSON/YAML transition table. Runtime status is not part of those lifecycle graphs.

Durable Job lifecycle is intentionally small: `DRAFT | ACTIVE | COMPLETED | CANCELLED`.

- `DRAFT`: durable objective exists, but the execution engine must not run it.
- `ACTIVE`: the execution engine may reconcile the Job. Scheduler, external triggers, manual actions, dependency release, workers, and review may all advance an ACTIVE Job.
- `COMPLETED`: terminal successful lifecycle. `job merge` merges the backing PR; a merged PR is authoritative and reconciles the Job to COMPLETED.
- `CANCELLED`: terminal cancellation. `job cancel` closes the backing PR; a closed, unmerged managed PR also reconciles the Job to CANCELLED.

Job runtime status is derived, not persisted. Relay computes it from lifecycle plus Task, Review, PR, and schedule facts. Runtime values include `IDLE`, `WAITING`, `QUEUED`, `RUNNING`, `BLOCKED`, `FAILED`, `REVIEWING`, `MERGE_PENDING`, `MERGED`, and `CANCELLED`. A blocked Task does not by itself make the Job runtime BLOCKED when other runnable/running work can still advance the objective. Lifecycle is the execution gate; runtime status is observation.

## Job and review lifecycle

A normal task never merges a PR. After all non-superseded work gates pass, Relay creates a SHA-bound final review task. The reviewer emits exactly one of `review.approved`, `review.changes_required`, or `review.blocked`. When `autoMerge` is enabled (default), Relay merges only after `review.approved`, pinned to the exact reviewed head SHA. A new task or new PR head makes earlier final-review evidence stale and requires a fresh review.

Final-review routing follows the same factual worker-selection boundary as executable work. Explicitly offline workers and explicit reviewer runtime constraints are hard gates; provider quota and descriptive capability labels do not by themselves make a worker illegal. Among eligible workers, Relay prefers a reviewer with a different worker identity from the implementation tasks; when that is unavailable it prefers a different provider/model, then falls back to the first eligible worker. The selected worker, selectedBy reason, and reviewerRouting event data are durable evidence. No provider is a universal reviewer default.

## Job, Task, and planner ownership

The public CLI resource surface is:

- `job create|update|show|list|merge|cancel`
- `task create|update|show|list|complete|retry|cancel`
- `plan`

`job create` persists only durable Job state. It never creates executable work. `task create` creates a real executable Task directly under the Job; direct orchestrator-created Tasks are not wrapped in synthetic planner Tasks and have no planner-round provenance. `plan` is the explicit public operation for invoking the Planner against an existing Job; it is not generic CRUD for planner records.

Relay invokes the planner agent, validates its structured result, persists that invocation as one real `plan-N` round, then materializes `next_tasks` under that planning round. `--prompt` / `--prompt-file` add caller guidance to the durable planning input without replacing the Job objective. The planner agent itself does not call Relay CLI or persist Tasks. Only an actual planner invocation creates a planning round. Historical `planner-N` rounds remain readable and participate in round numbering.

A zero-task autonomous Job stays idle under ordinary reconciliation, but an explicit `plan` command can start it immediately. An autonomous Job may also begin with one or more direct orchestrator-created Tasks and no Plan. After that direct batch completes, Relay may create the next real planning round through the same round-construction/execution path used by manual `plan`. Later rounds continue until the objective is satisfied. Fixed Jobs never create autonomous planner rounds automatically.

Planner-produced Tasks obey this same contract, including explicit `storySize`.

A scheduled autonomous job adds cron/timezone/next-run and missed-run/concurrency policy to the trusted job marker, plus the `agents-relay:autonomous` label and one bounded time-of-day `agents-relay:next-run:*` index label. The GitHub heartbeat discovers only indexed due candidates, validates the marker's exact `nextRunAt`, claims the slot idempotently, advances the durable next run, and pulses `agents-relay:schedule-wake`. GitHub webhook delivery then wakes local Relay for planner/worker execution. While the schedule is active, the durable Job remains `ACTIVE`; between runs its derived runtime status is `WAITING`. Scheduled recurring Jobs do not enter one-shot final-review/auto-merge after each satisfied run; older-cycle failures are historical evidence and do not block a later slot.
