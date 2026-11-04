# Shortcut Execution / Normal Worker Fallback

## Current Normal Worker No-Start Rule

When a ChatGPT or Z normal Worker fails without an accepted, correlated
`task.started` event, Relay uses the Task Lifecycle Graph to try **one**
automatic retry on a compatible Codex worker's **configured default model**.
It neither creates a replacement Job/Task nor starts a Troubleshooter on this
successful retry path.

The Codex default is read from `$CODEX_HOME/config.toml` (or
`~/.codex/config.toml`). A missing config model, incompatible capability,
hard runtime restriction, disabled provider, exhausted attempts or previous
no-start fallback prevents that retry. An accepted `task.started` prevents it.

The durable Task records the old execution ID, attempt, worker/model identity,
reason and timestamp in `noStartFallback`. The Graph clears the old Task
execution/lease/route and the Reconciler cancels owned work before rerouting.
Rerouting uses the existing Router and provider hard gates.

**Risk:** No `task.started` observation does not prove the remote provider
did nothing. This operator-selected policy can retry work that was submitted
but whose start event was lost. Do not rely on it for non-idempotent external
operations without their own idempotency keys. Human approvals and publication
gates are never inferred.

The older platform-confirmed pre-submission reroute continues to function
independently. It may select another eligible Worker.

## Local Verification

Run from the isolated Agents Relay worktree:

```sh
npm run build
node --import ./test/test-store-env.mjs --test \
  test/no-start-fallback.test.js \
  test/chatgpt-platform-fallback.test.js \
  test/workflow-v2-lifecycle-parity.test.js \
  test/core.test.js
```

The new tests cover both source Adapters, four failure surfaces, expiration,
Codex default identity, failure gates, SQLite restart, late generation events
and the absence of a Troubleshooter on successful recovery.

## Direct Shortcut Runner Release Status

The CLI handoff is implemented: `neo project run` now executes the bound
Relay `job run --mode shortcut` in the foreground, forwards live node events,
appends a private Run log, propagates non-success exit codes, and checks
durable Job/Task completion before returning 0. The mixed
code-shortcut/Worker-fallback DAG remains unverified.

Next, the Shortcut Runner must use existing Relay Worker fallback for uncovered
model-backed nodes and prove the 20-minute elapsed budget and canonical
result validation with a full Run. A separate direct Codex executor is not required.
The real Vlog full-DAG E2E and independent review remain **NOT_RUN**
and block the single unified release.

No live browser/provider test, publishing, external transfer or real Markcut
review approval is implied by these local regression results.

## Original Shortcut Branch Implementation Evidence (not yet merged to main)

The original shortcut development branch includes a foreground Relay direct
`job run --mode shortcut` implementation, changes to `agent-shortcut.ts`,
`cli-shortcut.ts`, Graph dispatch and local `task-actions.ts`. This branch
history is retained in merge parent `c0dbc62` for review and continuation.
Those changes are **not** equivalent to full `neo project run` integration,
existing Worker fallback integration, or a proven real Vlog end-to-end run.

## Watching the same Run (T012)

From a terminal on Neo Master, use the single Shortcut Runner worktree's
Relay build until main is released:

```sh
NEO_RELAY_CLI=/Users/chengli/Workspace/.worktrees/orchestrator/relay-shortcut-direct-20261104/dist/cli.js \
  neo project run --project vlog --path /Users/chengli/Workspace/neo/vlog/runs/DATE-RUN
```

From another terminal (or through Neo MCP), follow the same canonical Run:

```sh
tail -f /Users/chengli/Workspace/neo/vlog/runs/DATE-RUN/neo-project-run.log
```

Do not start a real Vlog Run until the owner and assistant are observing
the same terminal/log. CLI foreground streaming and failure-exit tests pass;
Vlog execution and its mixed Worker fallback remain T004/T015 acceptance gates.
