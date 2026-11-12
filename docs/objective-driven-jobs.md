# Objective-driven Jobs

Every Agents Relay Job uses one durable Job/Task Scheduler, whether an
explicit Planner is requested or an already-defined Agent Graph is started.
There is no `executionMode` on newly-created Jobs. Starting a Job is distinct
from choosing its independent Final Review/Merge policy.

## Lifecycle

1. `job create --initial-plan` is the normal objective-first, Planner-led path.
   When a project supplies an existing Agent DAG, use **one**
   `job create --coordinator-graph-file ... --coordinator-input-file ...
   --coordinator-output-path ... --coordinator-project-root ...
   --coordinator-workspace-root ...` instead. This atomically creates a DRAFT
   Job and its queued Coordinator Task in SQLite. No initial Planner is required.
2. `job run --id JOB --task-id NUMERIC_TASK_ID` using the Task ID returned by
   creation activates that same ordinary Job
   and publishes a wake signal. It returns `ACTIVE`, not task completion.
   Neo `neo project run` persists an idempotent Run binding around these calls.
3. The Reconciler materializes one durable Agent Task per ready DAG node.
   Each node can be Script or Model; both use the same execution events,
   retries, recovery and `review.preview` boundary. The Coordinator is not
   a Worker/lease and has no second runtime lifecycle.
4. An accepted terminal `task.completed` wakes the **same Job's Reconciler**
   to release dependencies and immediately dispatch successor nodes while
   capacity permits. Independent branches can run concurrently; joins wait
   for all dependencies. At capacity, QUEUED stays durable and the ordinary
   global pool eventually admits the work.
5. The regular Job Final Review and Git Merge remain independent policy
   gates (`--review`/`--no-review`, `--auto-merge`/`--no-auto-merge`).
   CHANGES_REQUIRED may create a later Planner repair round; it does not
   imply that an initial Planner was required.

There is no supported Shortcut Job mode, direct foreground Shortcut runner,
receipt command, or content-only completion path. Legacy Shortcut metadata
is removed from normalized Job snapshots and is never emitted for new Jobs.
Neither `--shortcut-execution` nor `--content-only` may be used to create new
Jobs. Existing persisted records are not rewritten just to retire these fields.

## Failure and recovery

Failed implementation work opens Troubleshooter recovery, and a BLOCKED Troubleshooter requires an authorized owner response. A failed Plan also uses durable recovery. A cancelled or interrupted planner is reconciled from SQLite, not from its host process. The Graph owns decisions, and SQLite owns lifecycle state. Events are wake-up signals, never completion proof.

SQLite remains authoritative for both Planner-led and Coordinator-led Jobs. Legacy execution-mode and schedule fields are ignored on normalized reads; no old direct Shortcut executor or cron is started. Production snapshots are not mass-rewritten.

## Validation

- L1: executable Graph branches for Planner/review/Force Restate gates.
- L2: deterministic role, review and worker evidence tests.
- L3: isolated SQLite and production ingress replay: Task A → Plan 2 → Task B → Plan 3 satisfied → Review → verified completion. Includes restart/deduplication, blocked recovery, and negative false-completion tests.
- Physical provider, GitHub and real-device tests are not implied by deterministic replay.

See [architecture](architecture.md), [workflow engine](workflow-engine.md), and `test/verification/l3-planner-round.test.mjs`.
