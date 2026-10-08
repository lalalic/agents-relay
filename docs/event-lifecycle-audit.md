# Event-first lifecycle: action-path and graph coverage audit

Scope: Agents Relay PR #260. This is a source-level audit, not evidence that the reported incidents are repaired.

## Observations vs hypotheses

- **Observed:** neo PR #123 `execution-queue-v1` had a Codex exit with code 0 around 2026-10-08 01:01 UTC, while its durable Task later remained `QUEUED` with an execution lease. `src/reconciler-runtime.ts:343-360` publishes `task.process.exited` as an *observational* event; it does not itself finalize the Task. `src/pool.ts:238-250` subscribes to terminal worker events but excludes `task.process.exited` from accepted lifecycle inputs. These combined facts explain how successful process exit can fail to drive immediate durable recovery; they do not establish why the worker omitted the mandatory terminal event.
- **Observed:** plan-4 of neo PR #123 emitted `planner.completed` and wrote GitHub planning output, but its standalone `plan` CLI process survived for >32 minutes. `src/cli.ts:459-466` already wraps Plan execution in `withEventBus`; `src/cli-support.ts:106-116` closes that bus in `finally`. Hence the simple claim 'the CLI forgot to close its NATS connection' is **not proven**. Other active handles or an interrupted `finally` remain possibilities; a handle-level reproduction is required.
- **Observed:** `process.exited` with exit code 0 can be followed by `process.signal` cleanup logs. A cleanup signal is not by itself an execution failure. The exit result must be authoritative; post-exit cleanup deserves a separate classification.
- **Observed:** a managed review Task may transition `QUEUED -> RUNNING` after dispatch; successful dispatch is not proof of a terminal reviewer result.

## Source-backed action-path matrix

| Ingress / owner | Scope / source | State decisions | Durable mutation / effects | Gap or duplication risk |
| --- | --- | --- | --- | --- |
| CLI `plan` | `src/cli.ts:457-467` | Planner entry | `planJob`, wake publish, `withEventBus` closes transport | Process/resource finalization after `planner.completed` not guaranteed by terminal event alone |
| CLI task commands | `src/cli.ts:126-201`, `src/task-actions.ts` | Task graph transition helpers | Managed task command + wake | Must use same graph and correlation as daemon |
| Daemon event ingress | `src/pool.ts:229-254` | Filters known lifecycle/wake events | ReconcileCoordinator | Ignores process-exit observation for immediate repair, unlike terminal events |
| Per-job runtime event ingress | `src/reconciler-runtime.ts:152-171` | `applyEvent` routes started, terminal, review, wake | `applyTerminalEvent` and coordinator | `task.process.exited` is emitted but not consumed as authoritative liveness context |
| Worker process settlement | `src/reconciler-runtime.ts:343-360` | Observational only | Emits `task.process.exited` or `task.process.async_exited` | A live/lease mismatch can persist until timeout |
| Worker timeout | `src/reconciler-runtime.ts:361-389` | `watchdog.failed` graph transition | Aborts owned execution and emits failure | Needs bounded process-group cleanup plus PID identity verification |
| Orphan recovery | `src/execution-recovery.ts` | `lease.expired` and `execution.orphaned` | Retry/fail via canonical graph | Startup recovery only selects `RUNNING`, not `QUEUED` with executionId |
| Pool startup / reconcile | `src/pool.ts:196-227` | Startup recovery and discovery | Reconcile job snapshots | Startup and periodic reconcile are fallback, not lifecycle event transport |
| GitHub webhook | `src/pool.ts:281-314`, `src/relayd.ts:334-348` | Correlated target wake | Publishes wake / target reconcile | Possible duplicate wake paths require delivery-id dedup verification |
| Scheduler and watchdog | `src/relayd.ts:446-479` | Timer signal/heartbeat | Periodic reconcile | Watchdog cadence cannot replace terminal event-triggered reconciliation |
| Review events | `src/reconciler-review.ts`, `src/reconciler-runtime.ts:155-159` | Review SHA gate | Approve, changes-required/re-plan | Must ensure one SHA-bound fix action and idempotent receipt |
| Graph effects | `src/workflow/contracts.ts`, `src/workflow/effects.ts` | Canonical graph decision | `effect.launchTask`, `effect.cancelActiveTasks`, `effect.mergePullRequest` | Timer, process ownership and projection plumbing belong to effect mechanics, not duplicated lifecycle policy |
| Job / task reconcile | `src/workflow/job-reconcile-v2.ts`, `src/workflow/task-reconcile.ts` | Graph-owned policy | Durable transitions and effects | Verify no competing imperative state transitions in call sites |

## Canonical workflow graph coverage

Graph sources: `workflow/*.mmd`; declared events/effects: `src/workflow/contracts.ts`.

| Area | Present | Missing or ambiguous |
| --- | --- | --- |
| Task lifecycle | `task.started`, `task.completed`, `task.failed`, `watchdog.failed`, `lease.expired`, `execution.orphaned` | Process settlement `task.process.exited` not an explicit input; must not silently equate exit 0 to success |
| Planner orchestration | `planner.reconcile`, pending recovery and new-round effect | Process-close / terminal grace after published `planner.completed` is a side-effect supervision gap, not a separate outcome state |
| Review lifecycle | Approval, changes-required, blocked, SHA binding | Verify replay races, stale head and idempotency |
| Job lifecycle | PR merge/close, implementation completion | Ensure post-merge deployment evidence never holds completion open |
| Scheduler | Scheduled-run and schedule-cycle graphs | Real-time schedule.tick ingestion vs ten-minute insurance must have one action owner |
| Blockers and escalation | Authoritative-unblock, blocker-resolution, troubleshooter, escalation graphs | Transport and process exit telemetry do not have a dedicated reconciliation path |
| Projection conflict | Projection conflict graph | GitHub comments/PR are collaboration projections; SQLite is operational authority |

## Required implementation gates

1. Correlate each executionId with host, PID, PGID, process start identity, owner and lease **in the operational store**, without turning GitHub projection into a PID database.
2. At `task.process.exited`, trigger a bounded liveness/terminal-evidence probe. Do **not** promote exit code 0 to `SUCCEEDED` without a valid mandatory terminal event. If absent after grace, graph-owned retry/failure must happen instead of an indefinitely QUEUED lease.
3. Reconcile startup orphans for both `RUNNING` and claimed `QUEUED`; verify process identity before reaping or superseding an execution. Ensure a live process on another instance is not killed.
4. After terminal publication, close transport and other handles via finally; separately enforce process-group TERM -> KILL on exact owned identity after grace. Distinguish normal exit and post-exit cleanup signals.
5. Route correlated webhook, task and review events to the same coordinator immediately; use periodic reconcile only to repair lost events or stale leases. Avoid duplicate effect execution with idempotency keys.
6. Regression tests: exit-before-terminal; terminal-before-exit; duplicate/late event; PID reuse; stale QUEUED startup; planner terminal followed by live socket; signal escalation; concurrently delivered webhook+terminal; daemon restart and lease ownership.

Review status: **audit only**. No runtime behavior is claimed fixed by this document.

