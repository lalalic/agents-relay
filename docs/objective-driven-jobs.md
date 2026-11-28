# Objective-driven Jobs

The immutable canonical Git root identifies the Job. SQLite owns Job, Plan, Task, Review and execution state. See the [Task/Job Contract](../skills/agents-relay/contracts/task-job-contract.md) for schemas and lifecycle; the executable authority is `workflow/job-lifecycle.mmd`, `planner-orchestration.mmd`, `task-lifecycle.mmd` and `review-lifecycle.mmd`.

A reviewed objective precedes ordinary Job creation; optional Planner creates the minimal independently owned Tasks. A design Task is conditional on real architectural need; accepted design becomes part of the durable objective. Task dependencies govern execution order, while parentTaskId governs semantic ownership. Declared Neo Project runs alone use the validated Coordinator DAG path. Do not add Plan/Coordinator/review Tasks merely for ceremony.

Independent Final Review is bound to the immutable target. Attributed findings route to targeted revisions; ambiguous ownership uses focused replanning. Local Git completion does not depend on optional origin publication.

Implementation: `rust/src/relay_create.rs`, `job_actions.rs`, `planner.rs`, `planner_runtime.rs`, `task_actions.rs`, `dag_task_runtime.rs`, `reconciler_review.rs`, `local_git_merge.rs`. Validate source and current CLI help before assuming exact fields or behavior.

A targeted revision may advance the Job source HEAD before its execution-fenced Git delivery receipt is committed. The Review Graph defers stale invalidation for an exact, correlated current-round revision-owned tip until Task delivery/settlement; unrelated head changes still invalidate the review and stale children. No old verdict authorizes merge of a changed head.
