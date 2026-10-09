# Agents Relay Production E2E Runbook

This file is the canonical operating procedure for Agents Relay production-path E2E validation. Any orchestrator starting, continuing, repairing, or reviewing E2E work must read this file first.

## Goal

E2E validates that the real production Agents Relay workflow can finish work without manual lifecycle intervention.

For the happy path, the intended flow is:

```text
fresh workload branch
  -> job create --initial-plan
  -> Planner
  -> Worker
  -> authoritative terminal event
  -> autonomous continuation
  -> independent immutable-head Review
  -> local Git merge
  -> Job COMPLETED
```

After bootstrap, the orchestrator is an observer/repairer of Relay itself, not an operator of the Job under test.

## Ownership and repository boundaries

Everything that defines or controls E2E belongs in the `agents-relay` repository:

- scenario definitions
- runner/controller code
- watcher and handoff logic
- runbooks
- run evidence and reports

The workload repository is only a disposable job holder. It may be any clean local Git repository. The runner must not depend on a repository named `agents-relay-e2e`, on a GitHub PR, or on GitHub CLI. A dedicated workload repo may be deleted and recreated at any time.

GitHub may be enabled in the production daemon because that reflects normal production configuration, but GitHub is optional audit/projection only. Core Job/Plan/Task/Review/merge lifecycle must remain SQLite/local-authority driven.

## Directory layout

- `e2e/scenarios/` — canonical durable scenario contracts.
- `e2e/runner/prepare-round.mjs` — creates an isolated workload worktree/branch and performs the only bootstrap action: `job create --initial-plan`.
- `e2e/runner/watch.mjs` — read-only monitor over durable Job state and EventBus events.
- `e2e/runner/handoff.mjs` — sends suspected defects and evidence back to the configured ChatGPT repair thread.
- `e2e/runs/YYYY-MM-DD/` — execution receipts, watcher state, handoffs, and run logs.
- `e2e/archive/` — historical experiments only; never treat archived scripts as current procedure.

## Scenario order

Run `001-happy-path` first. Do not proceed to recovery/failure scenarios until it passes.

Recommended order:

```text
001
 -> 002 -> 003 -> 005 -> 007 -> 008 -> 009 -> 010 -> 011
                                                -> 004 -> 006
```

`004` and `006` run last because they intentionally affect shared runtime/process dependencies.

## Round model

One E2E attempt equals one immutable round:

```text
Scenario + round number
  -> fresh workload branch/worktree
  -> fresh Job ID
  -> one bootstrap command
  -> observe to PASS or SUSPECT/FAIL
```

A failed round is evidence. Never repair the same Job into a passing round.

When a real defect is found:

1. Preserve the failed Job and watcher evidence.
2. Cancel the failed Job if it is still non-terminal.
3. Fix Agents Relay production code on the current E2E implementation branch.
4. Run focused regression tests and required build checks.
5. If runtime code changed, bump the visible E2E version and restart the single existing production daemon; do not start a duplicate daemon.
6. Create a fresh workload branch/worktree and a fresh Job for the next round.
7. Start a new watcher for that new Job.
8. Repeat until the scenario passes.

## Bootstrap rule

For a normal executable E2E Job, use exactly one Relay bootstrap operation:

```bash
node dist/cli.js job create \
  --repo OWNER/REPO \
  --head e2e/<scenario>-r<N> \
  --base main \
  --id <unique-job-id> \
  --title "<scenario> round <N>" \
  --objective-file <objective.md> \
  --mode autonomous \
  --initial-plan
```

`--initial-plan` owns the initial durable Planner round. Do not follow it with a manual `plan` command.

Without `--initial-plan`, `job create` remains create-only and is not the normal E2E bootstrap.

## Forbidden actions after bootstrap

Once `job create --initial-plan` succeeds, do not manually advance the Job under test. Specifically, do not use:

- `plan`
- `task retry`
- `reconcile`
- `unblock`
- manual review requests or review state changes
- manual merge
- direct Job/Task state mutation
- GitHub/`gh` actions to create, update, review, retry, or merge the workload

Read-only inspection is allowed.

If the Job cannot progress without one of those actions, that is an E2E defect or a scenario/setup defect that must be recorded and handled by a fresh round.

## GitHub rule

Do not use `gh` or a GitHub connector to drive an E2E workflow.

Allowed GitHub use is read-only verification when a scenario explicitly needs external audit evidence, for example checking whether an optional projection exists. GitHub failures must never be used as a reason to manually bypass Relay.

A production daemon may run with GitHub integration enabled; E2E should normally reflect that configuration. However, Job bootstrap and lifecycle must not synchronously depend on GitHub availability.

## Workload repository rule

The workload repo is replaceable. The runner must receive it as input:

- logical repository name: `--repo OWNER/REPO`
- local checkout: `--checkout /absolute/path`

`prepare-round.mjs` must create an isolated E2E worktree under the workspace `.worktrees/e2e/` area instead of switching the user's current checkout.

The workload objective should be deterministic and small. For Scenario 001, prefer a tiny fixture + test + commit so failures are attributable to Relay workflow, not application complexity.

## Watcher contract

`watch.mjs` is an independent controller, not an Agents Relay Job or Task. It must be read-only with respect to the Job under test.

It monitors:

- SQLite-authoritative Job/Plan/Task/Review state
- EventBus events for the exact Job ID
- execution IDs and timeouts
- local merge receipt

It detects at least:

- failed/blocked Tasks
- failed Planner with no executable continuation
- stalled Planner beyond its configured timeout
- stalled RUNNING/QUEUED Tasks using task timeout-aware thresholds
- local merge failure
- terminal inconsistencies
- no-progress situations

The watcher must not call GitHub to decide local PASS/FAIL.

## Same-thread handoff

When the watcher identifies a real suspect, it writes a handoff payload under the current run directory and sends a new turn to the configured ChatGPT repair thread.

The normal operator entry point is one manually triggered npm command:

```bash
npm run e2e -- \
  --thread <stable-chatgpt-thread-id> \
  --scenario 001 \
  --repo OWNER/REPO \
  --checkout /absolute/path/to/workload-repo \
  --round <N> \
  --objective-file /absolute/path/to/objective.md
```

`--scenario 001` resolves to the canonical `001-*` scenario file; the full name such as `001-happy-path` is also accepted. `--thread-id` is retained only as a compatibility alias for `--thread`. The command prepares exactly one fresh round and then starts the watcher. It is never started automatically or on a schedule.

The handoff message must tell the repair thread to:

- inspect the supplied evidence
- identify root cause
- fix Agents Relay production code, not the workload Job manually
- run focused tests
- deploy the new E2E runtime version when necessary
- cancel the failed round
- create the next fresh round
- restart the watcher for the new Job

## PASS criteria

Scenario 001 passes only when all of the following are true without lifecycle intervention after bootstrap:

- initial Planner round succeeded
- implementation work succeeded
- authoritative worker terminal event was accepted
- required independent review succeeded against the current immutable local source head
- local merge succeeded and has a durable merge receipt
- Job reached durable `COMPLETED`
- no manual retry/reconcile/review/merge/unblock was used

Optional GitHub projection state is not a completion gate.

## Scenario 001 — Happy path

Use `e2e/scenarios/001-happy-path.md` as the canonical contract.

The objective should ask for a deterministic, minimal repository change such as:

1. create one small JSON fixture
2. add one Node test asserting it
3. run the repository test suite
4. commit the change on the managed source branch

Then observe only. Any stop between Planner → Worker → Review → local merge → COMPLETED is the defect under investigation.

## Runner lifecycle

The intended closed loop is:

```text
prepare-round
  -> watch
      -> PASS: record result and move to next scenario
      -> SUSPECT: handoff new turn
           -> repair Relay
           -> cancel failed round
           -> prepare next round
           -> watch new round
```

The runner should eventually be able to execute this loop repeatedly without requiring the user to remember operational details.

## Evidence discipline

For every round, preserve:

- scenario ID and round number
- repo/check-out/worktree/branch
- Job ID
- Relay build/version
- Planner/Task/Review execution IDs
- relevant EventBus sequence
- root cause if failed
- production fix commit(s)
- focused test results
- final Job and local merge state
- count of manual lifecycle interventions; Scenario 001 requires zero after bootstrap

Do not claim a scenario PASS based on tests alone. PASS requires the real production-path Job to reach its acceptance state.
