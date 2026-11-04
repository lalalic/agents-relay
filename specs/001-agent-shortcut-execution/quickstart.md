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

`neo project run` executes the bound Relay Job in the foreground, emits real
node events, persists a private Run log, and verifies durable exit status.
The canonical Graph executor now dispatches code shortcuts and only missing
model nodes through existing Relay Worker Adapters as owned durable child Tasks,
including Troubleshooter recovery. No separate Codex executor or global
Relay Queue is used. The **five permanent DAGs D01–D05** (D06 removed) plus
F01–F10 cases run with `npm run test:shortcut:dags`; D01–D05 are also part of
`test:fast` and `test:full`.

2026-11-04 evidence: shortcut DAG 47/47, fast 134/134, full 1106/1106,
L3 70 PASS / 1 SKIP / 0 FAIL. A real **private** Vlog Run
`neo/vlog/runs/2026-11-04-shortcut-mixed-dag-vlog-e2e-v2/` passed Visioner,
Director and Editor, then Producer failed from overly restrictive canonical
Run input interpretation. The input contract was corrected and verified by
F09/F10, but the **real Producer after the fix, the final render, human
preview approval and Final QA remain NOT_RUN**. The 20-minute deadline and
owned-process restart gate T014 and independent review remain open. Do not
release, merge, deploy, publish, voice-clone or assume owner approval from
synthetic checks or a partial Run.

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

Only run private Vlog media with the owner-authorized canonical Run and the same
observable terminal/log. Do not substitute a completed process or a partial
Visioner/Worker result for full T015 video, owner review, or Final QA.
