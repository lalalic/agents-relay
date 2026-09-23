# Agents Relay Task / Job Contract

This contract is the shared protocol for every component that creates, schedules, reviews, or executes Agents Relay jobs and tasks.

## Task producers

Any task producer — orchestrator, planner, or nested task-producing agent — must follow this contract.
Task producers choose semantic task properties such as objective, dependencies, worker requirements, priority, and `storySize`. They do not normally choose an adapter, provider/model, or raw timeout milliseconds.

## Worker routing order

Every new model-backed executable task follows this order:

1. The planner declares `workerRequirements` (capabilities and optional runtime, task-kind, trust-domain, region, and label constraints).
2. `worker-router` resolves those requirements against available workers and a fresh on-demand usage snapshot from the shared usage registry. It applies capability/availability hard gates before considering resource evidence.
3. `model-router` chooses provider/model/reasoning details for the selected worker.
4. Relay persists the selected worker and model routing on the durable task before launch.

Planner output must not hard-code `codex`/`chatgpt`, provider preference, or usage probes. The worker-router and model-router are separate responsibilities; usage readers remain owned by `src/usage.ts` and are not duplicated in either router. Legacy task records that already contain adapter/routing metadata remain readable, but newly produced planner tasks must carry worker requirements.

## Story size

Every worker task has one of three story sizes:

- `S`: about 5 minutes of normal-reasoning execution.
- `M`: about 15 minutes of normal-reasoning execution. This is the default when size is absent or uncertain.
- `L`: about 45 minutes of normal-reasoning execution.

Relay derives the overall execution timeout from `storySize`. If `routing.reasoning` is `high`, Relay doubles the overall execution timeout. Other reasoning levels do not change it.

Raw `timeoutMs` is a compatibility/debug/hotfix override, not the normal task-production interface.

## Task readiness states

Task readiness is explicit and must use these semantics:

- `DRAFT`: durable Task exists but is not executable now. A DRAFT Task with dependencies is promoted to `QUEUED` when all dependencies succeed. A DRAFT Task with no dependencies remains held until an explicit release to `QUEUED`.
- `QUEUED`: executable now; Relay may launch it immediately subject only to worker capacity/routing.
- `RUNNING`: worker execution has actually started.
- `BLOCKED`: execution cannot continue without an external resolution or intervention. Once a Task has entered `RUNNING`, it must not return to `DRAFT`; waiting discovered during execution is `BLOCKED`.
- `SUCCEEDED`, `FAILED`, and `CANCELLED` are terminal outcomes, except that retry explicitly requeues a failed/blocked Task.

Do not use `WAITING` as a Task state or durable Job lifecycle state. `WAITING` is a derived Job runtime status for an `ACTIVE` Job whose next progress depends on a future trigger, schedule slot, dependency release, or other condition.

## Worker lifecycle

Relay owns process lifecycle. Workers own semantic task lifecycle. A worker must publish canonical `task.started` as its first execution action, then exactly one of `task.completed`, `task.failed`, `task.blocked`, or `task.cancelled`. Process launch/exit events do not substitute for worker semantic events.

## Job lifecycle and runtime status

Durable Job lifecycle is intentionally small: `DRAFT | ACTIVE | COMPLETED | CANCELLED`.

- `DRAFT`: durable objective exists, but the execution engine must not run it.
- `ACTIVE`: the execution engine may reconcile the Job. Scheduler, external triggers, manual actions, dependency release, workers, and review may all advance an ACTIVE Job.
- `COMPLETED`: terminal successful lifecycle. `job merge` merges the backing PR; a merged PR is authoritative and reconciles the Job to COMPLETED.
- `CANCELLED`: terminal cancellation. `job cancel` closes the backing PR; a closed, unmerged managed PR also reconciles the Job to CANCELLED.

Job runtime status is derived, not persisted. Relay computes it from lifecycle plus Task, Review, PR, and schedule facts. Runtime values include `IDLE`, `WAITING`, `QUEUED`, `RUNNING`, `BLOCKED`, `FAILED`, `REVIEWING`, `MERGE_PENDING`, `MERGED`, and `CANCELLED`. A blocked Task does not by itself make the Job runtime BLOCKED when other runnable/running work can still advance the objective. Lifecycle is the execution gate; runtime status is observation.

## Job and review lifecycle

A normal task never merges a PR. After all non-superseded work gates pass, Relay creates a SHA-bound final review task. The reviewer emits exactly one of `review.approved`, `review.changes_required`, or `review.blocked`. When `autoMerge` is enabled (default), Relay merges only after `review.approved`, pinned to the exact reviewed head SHA. A new task or new PR head makes earlier final-review evidence stale and requires a fresh review.

Final-review routing follows the same worker-selection boundary as executable work. Capability, availability, explicit reviewer constraints, and resource health are hard gates. Among eligible workers, Relay prefers a reviewer with a different worker identity from the implementation tasks; when that is unavailable it prefers a different provider/model, then falls back to the first eligible worker. The selected worker, `selectedBy` reason, and `reviewerRouting` event data are durable evidence. No provider is a universal reviewer default.

## Job, Task, and planner ownership

The public CLI resource surface is:

- `job create|update|show|list|merge|cancel`
- `task create|update|show|list|retry|cancel`

`job create` persists only durable Job state. It never creates executable work. `task create` creates a real executable Task directly under the Job; direct orchestrator-created Tasks are not wrapped in synthetic planner Tasks and have no planner-round provenance.

Planner rounds are internal planner output, not a general public CLI resource. Relay invokes the planner agent, validates its structured result, persists that invocation as one planner round, then materializes `next_tasks` under that planner round. The planner agent itself does not call Relay CLI or persist Tasks. Only an actual planner invocation creates a planner round.

A zero-task autonomous Job stays idle. An autonomous Job may begin with one or more direct orchestrator-created Tasks and no Plan. After that direct batch completes, Relay may create the first real planner round. Later planner rounds continue until the objective is satisfied. Fixed Jobs never create autonomous planner rounds.

Planner-produced Tasks obey this same contract, including explicit `storySize`.

A scheduled autonomous job adds cron/timezone/next-run and missed-run/concurrency policy to the trusted job marker, plus the `agents-relay:autonomous` label and one bounded time-of-day `agents-relay:next-run:*` index label. The GitHub heartbeat discovers only indexed due candidates, validates the marker's exact `nextRunAt`, claims the slot idempotently, advances the durable next run, and pulses `agents-relay:schedule-wake`. GitHub webhook delivery then wakes local Relay for planner/worker execution. While the schedule is active, the durable Job remains `ACTIVE`; between runs its derived runtime status is `WAITING`. Scheduled recurring Jobs do not enter one-shot final-review/auto-merge after each satisfied run; older-cycle failures are historical evidence and do not block a later slot.
