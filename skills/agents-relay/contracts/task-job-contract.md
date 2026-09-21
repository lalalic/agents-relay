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

## Worker lifecycle

Relay owns process lifecycle. Workers own semantic task lifecycle. A worker must publish canonical `task.started` as its first execution action, then exactly one of `task.completed`, `task.failed`, `task.blocked`, or `task.cancelled`. Process launch/exit events do not substitute for worker semantic events.

## Job and review lifecycle

A normal task never merges a PR. After all non-superseded work gates pass, Relay creates a SHA-bound final review task. The reviewer emits exactly one of `review.approved`, `review.changes_required`, or `review.blocked`. When `autoMerge` is enabled (default), Relay merges only after `review.approved`, pinned to the exact reviewed head SHA. A new task or new PR head makes earlier final-review evidence stale and requires a fresh review.

Final-review routing follows the same worker-selection boundary as executable work. Capability, availability, explicit reviewer constraints, and resource health are hard gates. Among eligible workers, Relay prefers a reviewer with a different worker identity from the implementation tasks; when that is unavailable it prefers a different provider/model, then falls back to the first eligible worker. The selected worker, `selectedBy` reason, and `reviewerRouting` event data are durable evidence. No provider is a universal reviewer default.

## Fixed and autonomous jobs

`fixed` jobs execute the orchestrator-provided task set and then proceed to final review. `autonomous` jobs may ask the planner for additional task batches. Planner-produced tasks must obey this same contract, including explicit `storySize`.
