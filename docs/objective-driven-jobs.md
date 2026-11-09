# Objective-driven Jobs

Every Agents Relay Job uses the same durable objective lifecycle. There is no `fixed` versus `autonomous` execution mode, no Job schedule or cron policy, and no Scheduler entity. The opt-in `executionMode: shortcut` selects direct Agent Graph code shortcuts for content-only Jobs.

## Lifecycle

1. A Job starts with an explicit objective and either a direct seed Task batch or an initial Planner round (`job create --initial-plan` or `plan`). A zero-task create-only DRAFT Job waits for an explicit start. Create a shortcut Job with `job create --shortcut-execution` before materializing Tasks; it is content-only, has no auto-merge/review, and does not create Planner rounds. `job run --mode shortcut` only executes a Task of a durably opted-in Job.
2. The Reconciler consumes durable Task outcomes and evaluates `workflow/planner-orchestration.mmd`. After successful work settles, it creates the next `plan-N` round without an owner pressing Continue.
3. The Planner returns `objective_status`, `assessment`, and `next_tasks`. Each materialized child has an immutable `planningDecisionId` and `planningRound`; semantic parentage uses `parentTaskId`.
4. `in_progress` requires executable work or a valid recovery/blocked resolution, so the Job stays ACTIVE. Planner rounds are idempotent across duplicate wakes and daemon restarts.

Shortcut mode is opt-in. It resolves `agents/<agent>.agent.mjs` beside the effective Agent Markdown
(project, shared, or builtin). It falls back only through explicit Agent
inheritance, executes independent graph nodes concurrently,
persists node checkpoints and event waits in the existing SQLite Task result,
and runs nodes without shortcuts using the existing model-backed Worker
adapter. A shortcut failure may have produced effects and stays FAILED for
Troubleshooter recovery; it must not replay the graph. Nonhuman waits resume
only from a validated result receipt atomically stored in the SQLite Task
checkpoint and matched to the active Job, Task, execution, wait ID, revision,
and content hash. A `shortcut.result` EventBus event is only a wake signal; its
payload never supplies trusted output. Record results with
`job shortcut-receipt --id JOB --repo OWNER/REPO --task-id TASK --node-id NODE
--wait-id WAIT --revision REV --execution-id EXECUTION --output-file FILE
--content-sha256 SHA256`. The file contains the completed shortcut result
object, and the hash is over its canonical JSON content. Human approval stays
on the host-invocation path; manual `--event-json` input is rejected.
A wait releases the Job execution slot. Completed checkpoints pin
Task input, Agent Graph, shortcut source, artifact real paths and hashes.
Shortcut-only Job completion requires the durable `contentOnly` policy plus no
PR, merge, review, Planner plan, or outstanding wait.
5. Only the latest successful Plan's `objective_status: satisfied`, together with successful implementation evidence, can open the final Review/completion gate. Reviewer approval, immutable head evidence and verified merge are still required when enabled.

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
