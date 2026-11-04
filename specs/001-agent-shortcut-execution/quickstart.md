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

The earlier content-only shortcut path can be invoked with the existing
`agents-relay job run --mode shortcut` interface, but the full
synchronous Neo CLI and mixed code-shortcut/Worker-fallback DAG remain unverified.

The intended Shortcut Runner must run `neo project run` synchronously, stream
node lifecycle, use the existing Relay Worker fallback for uncovered
model-backed nodes, and preserve the 20-minute elapsed budget and canonical
result validation. A separate direct Codex executor is not required.
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
