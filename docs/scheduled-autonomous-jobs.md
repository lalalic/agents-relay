# Scheduled autonomous jobs

Scheduled autonomous jobs reuse the existing GitHub PR, trusted job/task
markers, local Relay daemon, planner, and event contracts. They do not add a
Relay database or per-job daemon.

## Durable and indexed state

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

The same PR also carries:

- `agents-relay:autonomous`
- one bounded `agents-relay:next-run:0` through `agents-relay:next-run:143`
- one fixed `agents-relay:schedule-wake:v1` comment, updated only to wake the local Relay webhook

The marker remains durable truth; labels are an index so the heartbeat does not
enumerate every managed PR. Relay repairs stale or legacy scheduling labels from
the marker.

## Creation

~~~sh
npx agents-relay job create --repo OWNER/REPO --head feat/scheduled \
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

The always-on `agents-relayd` process is the authoritative scheduler heartbeat
for repositories it manages. On daemon startup and every ten minutes it runs the
same indexed due-slot logic used by `agents-relay tick`, claims due slots
idempotently, advances durable schedule state, and reconciles the claimed Job
directly through the local worker pool. This avoids depending on GitHub Actions
`on.schedule`, whose delivery is best-effort and may be delayed or skipped.

A repository may still install `.github/workflows/autonomous-scheduler.yml` as
an optional cloud fallback. That workflow should run `agents-relay tick --repo
OWNER/REPO`; duplicate local/cloud heartbeats are safe because slot claiming is
idempotent. The workflow is not a prerequisite for creating scheduled Jobs.

By default the CLI `tick` path searches the current and two previous 10-minute
buckets. The local daemon uses a wider recovery lookback so a daemon restart or
short outage can recover stale indexed slots while `missedRunPolicy` still
controls whether old work is replayed or skipped. The 144 run-index labels
represent the 10-minute slots of a UTC day, so the candidate set remains much
smaller than all autonomous jobs while repository label cardinality stays
bounded. The trusted marker's exact `nextRunAt` is always checked before a
candidate is claimed.

## Slot semantics

For each oldest indexed slot, `tick` reloads the job marker and:

1. ignores or repairs a stale label when durable `nextRunAt` no longer matches
   that slot;
2. refuses to rerun a slot already represented by `lastScheduledSlot`;
3. when work is active, either advances past the slot (`skip`) or leaves the
   slot for the next heartbeat (`queue`);
4. otherwise persists `lastScheduledSlot`, advances `nextRunAt`, updates the
   bounded next-run label and updates the fixed schedule-wake comment; the durable Job lifecycle remains `ACTIVE`;
5. for a job that has already been explicitly seeded by an orchestrator task batch, the local Relay webhook may create the next autonomous planner for that slot and run normal worker/event reconciliation; a never-started zero-task job remains idle;
6. when that planner is satisfied, the job records `lastRunAt`; the durable lifecycle remains `ACTIVE` and its derived runtime status returns to `WAITING` until the next slot.

`lastScheduledSlot` tracks claim/idempotency while `currentRunSlot` identifies the active cycle, so skipping a later slot cannot hide work still running from the prior cycle. Historical failures from older slots do not poison the next scheduled cycle.
An active schedule also does not enter the one-shot final-review/auto-merge
path; the PR remains open as the durable recurring job.

`missedRunPolicy: run` advances from the missed slot, preserving later missed
slots for subsequent ticks. `missedRunPolicy: skip` advances from the current
time so an old slot cannot cause a backlog. The default is `skip`.
