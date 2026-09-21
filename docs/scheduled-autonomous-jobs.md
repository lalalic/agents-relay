# Scheduled autonomous jobs

Scheduled autonomous jobs reuse the existing GitHub PR, trusted job/task
markers, reconciler, planner, review gate, and event contracts. They do not add
a Relay database or per-job daemon.

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
  "lastRunAt": null
}
```

The same PR also carries:

- `agents-relay:autonomous`
- `agents-relay:next-run:0` through `agents-relay:next-run:5`

The marker remains durable truth; labels are an index so the heartbeat does not
enumerate every managed PR. Relay repairs the index from the marker when it
observes a stale or duplicate scheduling label.

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
npx agents-relay tick --repo OWNER/REPO --events nats --nats-url "$NATS_URL"
~~~

The workflow runs every ten minutes, uses a non-cancelling concurrency group,
and requires a repository `NATS_URL` secret because model-backed workers need
authoritative lifecycle events. The checkout's CLI runs the tick, so a workflow
does not depend on the package having been published yet.

By default `tick` searches the current and two previous 10-minute buckets with
the autonomous and bounded run-index labels per bucket. It never performs a
repository-wide job scan. Use `--lookback-buckets` (maximum 36) to widen
recovery for short outages.

The six run-index labels map slots by modulo position within an hour. This
keeps repository label definitions bounded while GitHub search narrows
discovery to current/recent slots. The trusted marker's exact `nextRunAt` is
the authority: a candidate is run only when its marker matches the target slot,
and stale labels are repaired during processing.

## Slot semantics

For each oldest indexed slot, `tick` reloads the job marker and:

1. ignores or repairs a stale label when the durable `nextRunAt` no longer
   matches that slot;
2. refuses to rerun a slot already represented by `lastScheduledSlot`;
3. when work is active, either advances past the slot (`skip`) or leaves the
   label for the next tick (`queue`);
4. otherwise persists `lastScheduledSlot`, advances `nextRunAt`, replaces the
   next-run label, reopens the job if needed, and invokes reconciliation;
5. records `lastRunAt` only after reconciliation is idle.

`missedRunPolicy: run` advances from the missed slot, preserving later missed
slots for subsequent ticks. `missedRunPolicy: skip` advances from the current
time so an old slot cannot cause a backlog. The default is `skip`.

The normal final-review and auto-merge gates still apply. A merged PR is no
longer open and therefore no longer eligible for scheduled execution.
