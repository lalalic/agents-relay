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

One repository workflow, `.github/workflows/autonomous-scheduler.yml`, runs:

~~~sh
npx agents-relay tick --repo OWNER/REPO
~~~

The workflow runs every ten minutes and uses a non-cancelling concurrency
group. It does not run planners or model workers and does not need NATS, local
project files, or local model credentials. It only discovers due jobs, claims
their scheduled slot in GitHub, advances `nextRunAt`, and updates one fixed
schedule-wake comment. The resulting GitHub `issue_comment` webhook wakes the local
`agents-relayd`, which owns actual planner/worker execution and authoritative
events.

By default `tick` searches the current and two previous 10-minute buckets.
The 144 run-index labels represent the 10-minute slots of a UTC day, so the
candidate set is much smaller than all autonomous jobs while repository label
cardinality stays bounded. GitHub search results are paginated. The trusted
marker's exact `nextRunAt` is always checked before a candidate is claimed.

## Slot semantics

For each oldest indexed slot, `tick` reloads the job marker and:

1. ignores or repairs a stale label when durable `nextRunAt` no longer matches
   that slot;
2. refuses to rerun a slot already represented by `lastScheduledSlot`;
3. when work is active, either advances past the slot (`skip`) or leaves the
   slot for the next heartbeat (`queue`);
4. otherwise persists `lastScheduledSlot`, advances `nextRunAt`, updates the
   bounded next-run label, marks the job running, and updates the fixed schedule-wake comment;
5. the local Relay webhook creates a fresh autonomous planner for that slot and
   runs normal worker/event reconciliation;
6. when that planner is satisfied, the job records `lastRunAt` and returns to
   `WAITING`.

`lastScheduledSlot` tracks claim/idempotency while `currentRunSlot` identifies the active cycle, so skipping a later slot cannot hide work still running from the prior cycle. Historical failures from older slots do not poison the next scheduled cycle.
An active schedule also does not enter the one-shot final-review/auto-merge
path; the PR remains open as the durable recurring job.

`missedRunPolicy: run` advances from the missed slot, preserving later missed
slots for subsequent ticks. `missedRunPolicy: skip` advances from the current
time so an old slot cannot cause a backlog. The default is `skip`.
