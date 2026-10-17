# Relay verification (Job 481 / Task 56)

Use `node test/verification/cli.mjs list` to see registered scenarios. Use `node test/verification/cli.mjs foundation /tmp/relay-verification-output` to validate corpus and produce `report.json` and `report.md`. **Foundation mode reports NOT_RUN for every scenario. It does not execute agent contracts, live models, or workflow events.**

Use `node test/verification/cli.mjs trace-check path/to/trace.json` for trace-only validation. This is NOT an event replay or runtime verification. `replay` refuses to run until the real event ingress runner is implemented. Trace JSON contains `scenarioId`, `trace` (array of ordered event names or `{event, progress}` objects) and `terminal`. A failing replay exits nonzero. Run foundation unit tests with `node --test test/verification/harness.test.mjs`.

Foundation extension points:

- L1: load scenarios with category L1; use production validators/agent skill contracts, record actual events and failures with `newEvidence`.
- L2: opt-in live installed adapter/provider execution; collect genuine emissions, distinguish provider from transport failures. Keep NOT_RUN otherwise.
- L3: connect mock external effects to the real production ingress/reconciler/SQLite, append observed events to traces, then call `classifyTrace`. Never force lifecycle transitions inside the harness.

Create an isolated store with `createIsolatedEnvironment`; pass its returned `env` to spawned Relay processes. Do not use the canonical user store. The included scenarios are starting contracts only, not claims of passing integration coverage.

The `classifyObservedTrace` helper requires a trusted isolated-store reader. Synthetic trace checks alone cannot establish L3 PASS.

## SQLite event ingress smoke path

Run `npm run test:verification-foundation` to execute isolated SQLite event-ingress coverage.
`sqlite-ingress.test.mjs` publishes a stale terminal event, a valid terminal event,
and a duplicate through the production Reconciler, checks durable SQLite state,
closes/reopens the store, and verifies persistence. This is **not** the complete
L3 event-loop simulator; Planner, reviewer, merge, and recovery workflows remain
NOT_RUN until a scheduler-driven scenario runner executes those full paths.

## Review-fix extensions

`node test/verification/cli.mjs replay fixture.json` injects a list of external
worker event objects through the production Reconciler ingress and reads a fresh
isolated SQLite store after reopening. Fixture keys: `scenarioId`, optional
`jobId`, `taskId`, `executionId`, `expectedTaskState`, and `events` (each with
`type`, optional `executionId`, `eventId`, `data`). Replay can prove only this
worker-event ingress path; it is **not** a full graph/scheduler/merge simulator.
An intentionally wrong `expectedTaskState` produces a FAIL.

`node test/verification/cli.mjs l2-live provider-matrix.json` evaluates actual
adapter output. The JSON contains `cases` with `role`, `provider`, `skillPath`,
`command` (executable + arguments), `task`, `source` and `executionId`.
Each configured adapter consumes a JSON request from stdin with the **actual
skill contents** and must emit JSON `{events:[{type,source,data}],transportAccepted:true}`
to stdout. The evaluator reports provider/model contract, adapter/transport
failure separately. This is a generic opt-in external adapter protocol; it
is not itself an installed Relay provider launcher. By default cases are
`NOT_RUN`. Set `BW_L2_LIVE=1` only with an authenticated real adapter, and
review external usage/cost before invocation. A fake adapter result cannot
substitute for genuine model tests.

## Full L3 workflow replay

`node test/verification/cli.mjs l3 /tmp/relay-verification-output` runs the
scenario corpus through the production `Reconciler` ingress, canonical Graph
transitions, scheduler dependency release, and isolated SQLite persistence.
It covers normal completion, reviewer changes/re-review, worker and reviewer
recovery, troubleshooter unblock, merge failure/retry with a reason receipt,
planner multi-batch continuation, stalled review, parallel dependencies, and
duplicate/stale events across restart. External agent/provider/Git effects are
represented by injected effects; lifecycle state is always read back from the
isolated durable store. The `broken-terminal-trace` scenario is intentionally
reported `FAIL` to prove forged caller traces cannot establish completion.

`npm run test:verification:l1` runs contract checks and `npm run
test:verification:l3` runs the complete L3 suite. `npm run test:verification`
runs both and is included by the repository verification workflow.

## Dependency graph regression

`dependency-graph.test.mjs` passes a genuine `task.completed` through the
production `Reconciler.handleEvent`, then verifies the production scheduler's
Graph-owned dependency release; failed prerequisites remain unsatisfied.
This adds dependency eligibility evidence, **not** complete end-to-end
Planner, actual Reviewer, Troubleshooter, Escalation, or merge execution.

## Production-path L3 regression probes (Job 481 / Task 56)

Run `npm run test:verification:l3`. The additional
`production-path.test.mjs` drives the real `Reconciler.handleEvent`
and production Graph-backed scheduler against an isolated SQLite store.
It verifies durable success, rejection of duplicate and stale terminal
events, timestamp-changing duplicates, worker failure persistence
across restart, dependency fan-out eligibility, premature autonomous
completion gating, cycle rejection, and a deliberate forged terminal
that cannot change SQLite authority. External Git/provider effects
are not invoked. The tests clean the temporary database and never
modify a daemon or a user Job.

**Evidence boundary:** These are production-ingress and scheduler
regressions, not a complete scheduler-driven simulator. Specifically,
this runner does not yet execute the full reviewer revision/re-review,
troubleshooter escalation/unblock, merge failure/retry, or planner
multi-batch effects to convergence. No positive claim for those L3
cases is justified solely by these probes. The existing trace-only
check must not be used as proof of successful production execution.

## Strict evidence gate for full-path claims (Task 56)

The mock-only workflow replay can reach plausible durable snapshots without executing
production merge, escalation, reviewer-revision, or restart effects. A SQLite
terminal snapshot alone is insufficient causal proof. Thus these scenarios
report `UNSUPPORTED`, not `PASS`; the `l3` CLI exits nonzero until a genuinely
scheduler-driven fixture replaces each stub. The negative forged-terminal
scenario must remain `FAIL`. Existing production-ingress tests retain their
independent PASS results and must not be promoted to full-workflow evidence.
