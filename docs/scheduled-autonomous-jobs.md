# Scheduled autonomous jobs

Scheduled autonomous jobs reuse the existing GitHub PR, trusted job/task
markers, local Relay daemon, planner, and event contracts. They do not add a
Relay database or per-job daemon.

## Durable state

The trusted `agents-relay:job:v1` marker contains the schedule:

```json
{
  "cron": "*/10 * * * *",
  "timezone": "America/Toronto",
  "nextRunAt": "2026-09-21T13:20:00.000Z",
  "missedRunPolicy": "run",
  "concurrencyPolicy": "skip",
  "lastScheduledSlot": null,
  "currentRunSlot": null,
  "lastRunAt": null
}
```

The trusted marker is the complete durable scheduling truth. No scheduler labels, GitHub Search index, wake comments, or repository-local scheduler workflow are required.

## Creation

~~~sh
npx agents-relay job create --repo OWNER/REPO \
  --base main --id scheduled-job --mode autonomous \
  --title "Operate the objective" --objective "Keep the objective current" \
  --schedule "*/10 * * * *" --schedule-timezone America/Toronto \
  --missed-run-policy run --schedule-concurrency skip
~~~

Cron supports the five standard fields, including ranges and steps. The
scheduler resolution is 10 minutes, so every selected minute must be divisible
by ten. `nextRunAt` can be supplied for recovery or tests and must match the
cron expression and timezone.

## Heartbeat

The always-on `agents-relayd` process is the only scheduler heartbeat. On daemon
startup and every ten minutes it filters its disposable in-process managed Job view, restored from SQLite, for
open autonomous Jobs whose exact durable `nextRunAt` is due, reloads the Job to
revalidate the slot, claims it idempotently, advances durable schedule state,
and reconciles the Job directly through the local worker pool.

There is no GitHub Actions scheduler fallback and no `agents-relay tick` cloud
heartbeat. Scheduled execution therefore requires a running `agents-relayd`
instance that manages the repository.

## Slot semantics

For each due locally known Job, `agents-relayd` reloads the SQLite-backed Job state and:

1. ignores or repairs a stale label when durable `nextRunAt` no longer matches
   that slot;
2. refuses to rerun a slot already represented by `lastScheduledSlot`;
3. when work is active, either advances past the slot (`skip`) or leaves the
   slot for the next heartbeat (`queue`);
4. otherwise persists `lastScheduledSlot`, advances `nextRunAt`, updates the
   durable schedule state; the durable Job lifecycle remains `ACTIVE`;
5. for a job that has already been explicitly seeded by an orchestrator task batch, local reconciliation may create the next autonomous planner for that slot and run normal worker/event reconciliation; a never-started zero-task job remains idle;
6. when that planner is satisfied, the job records `lastRunAt`; the durable lifecycle remains `ACTIVE` and its derived runtime status returns to `WAITING` until the next slot.

`lastScheduledSlot` tracks claim/idempotency while `currentRunSlot` identifies the active cycle, so skipping a later slot cannot hide work still running from the prior cycle. Historical failures from older slots do not poison the next scheduled cycle.
An active schedule also does not enter the one-shot final-review/auto-merge
path; the PR remains open as the durable recurring job.

`missedRunPolicy: run` advances from the missed slot, preserving later missed
slots for subsequent ticks. `missedRunPolicy: skip` advances from the current
time so an old slot cannot cause a backlog. The default is `skip`.
