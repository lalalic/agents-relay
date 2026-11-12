# Objective-driven Jobs

Every Agents Relay Job uses one durable Job/Task Scheduler, whether an
explicit Planner is requested or an already-defined Agent Graph is started.
There is no `executionMode` on newly-created Jobs. Starting a Job is distinct
from choosing its independent Final Review/Merge policy.

## Lifecycle

1. `job create` records an objective as a DRAFT Job. Use `--initial-plan` when a
   Planner is wanted. For a plan-free workflow, create a queued Task with an
   `agentGraph`, then call `job run --id JOB --task-id TASK` to activate the Job.
2. The ordinary Reconciler creates one Coordinator and durable Agent-named Tasks
   as dependencies become ready. Script and Model Agents share the same Task
   lifecycle, retries, failure recovery, and human `review.preview` boundary.
   A Coordinator is not a Worker and holds no execution lease while children run.
3. Completed Tasks release dependent Tasks and eventually complete the
   Coordinator. The canonical Job Graph owns completion, Final Review, and local
   Git merge according to the Job's policy. A plan-free Job can keep the
   standard review/merge gates; use the independent `--no-review` and
   `--no-auto-merge` flags only when each specific policy is unwanted.
   Initial execution needs no Planner. An explicit Final Review CHANGES_REQUIRED
   can still invoke the established finding-driven repair Plan, not a startup Plan.
4. An optional Planner-based Job follows the normal `plan-N` recovery and
   objective-satisfaction rules. Planner retries and Final Reviews remain
   independent of whether a Graph Job was activated through `job run`.

Historical completed or cancelled direct Shortcut records retain archived
`executionMode` metadata for read compatibility, but new Jobs never set this
field. Neither `--shortcut-execution` nor `--content-only` is accepted for new Jobs.
Both are legacy metadata only; the Coordinator is a normal Job Task. The old direct
Shortcut runtime only serves historical checkpoints and is not used for new
Job runs.

## Failure and recovery

Failed implementation work opens Troubleshooter recovery, and a BLOCKED Troubleshooter requires an authorized owner response. A failed Plan also uses durable recovery. A cancelled or interrupted planner is reconciled from SQLite, not from its host process. The Graph owns decisions, and SQLite owns lifecycle state. Events are wake-up signals, never completion proof.

SQLite Job snapshots preserve the explicit `executionMode: shortcut` policy.
Unsupported legacy scheduling fields remain ignored; no cron is executed. The
change does not rewrite production Job records.

## Validation

- L1: executable Graph branches for Planner/review/Force Restate gates.
- L2: deterministic role, review and worker evidence tests.
- L3: isolated SQLite and production ingress replay: Task A → Plan 2 → Task B → Plan 3 satisfied → Review → verified completion. Includes restart/deduplication, blocked recovery, and negative false-completion tests.
- Physical provider, GitHub and real-device tests are not implied by deterministic replay.

See [architecture](architecture.md), [workflow engine](workflow-engine.md), and `test/verification/l3-planner-round.test.mjs`.
