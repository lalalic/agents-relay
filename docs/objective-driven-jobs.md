# Objective-driven Jobs

Every Agents Relay Job uses the same durable objective lifecycle. There is no `fixed` versus `autonomous` execution mode, no Job schedule or cron policy, and no Scheduler entity.

## Lifecycle

1. A Job starts with an explicit objective and either a direct seed Task batch or an initial Planner round (`job create --initial-plan` or `plan`). A zero-task create-only DRAFT Job waits for an explicit start.
2. The Reconciler consumes durable Task outcomes and evaluates `workflow/planner-orchestration.mmd`. After successful work settles, it creates the next `plan-N` round without an owner pressing Continue.
3. The Planner returns `objective_status`, `assessment`, and `next_tasks`. Each materialized child has an immutable `planningDecisionId` and `planningRound`; semantic parentage uses `parentTaskId`.
4. `in_progress` requires executable work or a valid recovery/blocked resolution, so the Job stays ACTIVE. Planner rounds are idempotent across duplicate wakes and daemon restarts.
5. Only the latest successful Plan's `objective_status: satisfied`, together with successful implementation evidence, can open the final Review/completion gate. Reviewer approval, immutable head evidence and verified merge are still required when enabled.

## Failure and recovery

Failed implementation work opens Troubleshooter recovery, and a BLOCKED Troubleshooter requires an authorized owner response. A failed Plan also uses durable recovery. A cancelled or interrupted planner is reconciled from SQLite, not from its host process. The Graph owns decisions, and SQLite owns lifecycle state. Events are wake-up signals, never completion proof.

Legacy PR Job markers and SQLite Job snapshots may carry `executionMode` or `schedule`. Current readers ignore them, and current serializers omit them. No legacy cron is executed. The migration does not change existing Task/Plan history or rewrite production Job records.

## Validation

- L1: executable Graph branches for Planner/review/Force Restate gates.
- L2: deterministic role, review and worker evidence tests.
- L3: isolated SQLite and production ingress replay: Task A → Plan 2 → Task B → Plan 3 satisfied → Review → verified completion. Includes restart/deduplication, blocked recovery, and negative false-completion tests.
- Physical provider, GitHub and real-device tests are not implied by deterministic replay.

See [architecture](architecture.md), [workflow engine](workflow-engine.md), and `test/verification/l3-planner-round.test.mjs`.
