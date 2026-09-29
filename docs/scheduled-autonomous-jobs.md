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

Every repository that wants to host scheduled autonomous Jobs must install one
repository workflow at `.github/workflows/autonomous-scheduler.yml`. Scheduled
Job creation/update checks the target repository's default branch and fails with
`SCHEDULED_AUTONOMOUS_UNAVAILABLE` when this workflow is missing. Unscheduled
autonomous Jobs and fixed Jobs do not require it.

For a normal consumer repository, use the published Agents Relay package
directly; the repository does not need an Agents Relay source checkout:

~~~yaml
name: Autonomous scheduler

on:
  schedule:
    - cron: '*/10 * * * *'
  workflow_dispatch: {}

concurrency:
  group: agents-relay-autonomous-scheduler
  cancel-in-progress: false

permissions:
  contents: read
  issues: write
  pull-requests: write

jobs:
  tick:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Process due autonomous buckets
        env:
          GH_TOKEN: ${{ github.token }}
        run: npx --yes --package agents-relay@<published-version> agents-relay tick --repo "$GITHUB_REPOSITORY"
~~~

Pin `<published-version>` to a version available from the package registry. Do
not use `@latest` for production cadence, because a repository heartbeat should
not silently change behavior between runs.

The Agents Relay **source repository** may instead build and run its checked-out
source in the workflow, for example:

~~~sh
npm ci
npm run build
node dist/cli.js tick --repo "$GITHUB_REPOSITORY"
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
   bounded next-run label and updates the fixed schedule-wake comment; the durable Job lifecycle remains `ACTIVE`;
5. for a job that has already been explicitly seeded by an orchestrator task batch, the local Relay webhook may create the next autonomous planner for that slot and run normal worker/event reconciliation; a never-started zero-task job remains idle;
6. when that planner is satisfied, the job records `lastRunAt`; the durable lifecycle remains `ACTIVE` and its derived runtime status returns to `WAITING` until the next slot.

`lastScheduledSlot` tracks claim/idempotency while `currentRunSlot` identifies the active cycle, so skipping a later slot cannot hide work still running from the prior cycle. Historical failures from older slots do not poison the next scheduled cycle.
An active schedule also does not enter the one-shot final-review/auto-merge
path; the PR remains open as the durable recurring job.

`missedRunPolicy: run` advances from the missed slot, preserving later missed
slots for subsequent ticks. `missedRunPolicy: skip` advances from the current
time so an old slot cannot cause a backlog. The default is `skip`.
