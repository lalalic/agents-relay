# V2 local-first real production E2E — 2026-10-09

## Configuration

- Development branch: `test/v2-local-first-e2e-20261009` from local main `6060987757183fbb80e426a651ea21204e49d8b2` (not stale origin/main `d9f8c1d`).
- Worktree: `/Users/chengli/Workspace/.worktrees/orchestrator/agents-relay-v2-e2e-20261009`.
- Single PM2 `agents-relayd` switched from old E2E worktree to the V2 worktree, same port 8787, concurrency 4, workspace, intervals and webhook-secret-file. Old fault-injection environment excluded. No duplicate daemon or Chrome.
- No GitHub projection, explicit `--no-github`; local Git delivery and immutable-head independent review required.

## Round 1: `v2-e2e-s1-20261009-r1`

- Creation: `job create --head e2e/v2-local-first-s1-r1 --no-github` succeeded with `pr: 0`, `DRAFT` -> `ACTIVE`.
- CLI usability observation: `job create --pr 0 --no-github` rejected `--pr must be a positive integer`; using `--head` works. This is not yet evidence of core lifecycle failure.
- Planner: `plan-1` `SUCCEEDED`; real `model-planner` emitted `planner.started` and `planner.completed` at 13:42:19–13:42:35 UTC. Generated `sqlite-workflow-docs` (QUEUED, Codex).
- `reconcile --no-github` run from remote shell launched real worker PID 80362, execution ID `2b405dd6-ca4b-4830-839d-720f04d12ad1`, routing to Codex/ZAI glm-5.3-flash/high. It exceeded the 90s synchronous Neo shell timeout and the shell process was terminated with SIGTERM. Afterward PID 80362 no longer existed; Task remained QUEUED with attempt=1 and executionId attached; no worker terminal event was observed in `/api/events` at last check. Because test-driver timeout interfered with the worker, this run is **INCOMPLETE/INVALID as an autonomous recovery test**; do not attribute the SIGTERM to an intrinsic Relay failure without further evidence.
- No review, local merge or durable COMPLETED observed. **NOT PASS**.

## Acceptance

Pending complete production lifecycle: real worker completion, independent immutable-head review, legitimate local Git merge receipt, durable Job `COMPLETED` and event/repository cross-check. Do not push until all pass.

## Round 2: `v2-e2e-s1-20261009-r2`

- Round 1 explicitly CANCELLED first; SQLite confirms Job `CANCELLED`, task `CANCELLED`, attempt 1.
- Round 2 created without GitHub (`pr:0`, `DRAFT`). Initial plan invocation failed before execution because the output redirect directory did not exist; corrected with `mkdir -p e2e/reports`.
- Real Planner `plan-1` started at 2026-10-09T13:46:04.944Z and failed at 13:46:43.565Z: `Planner next_tasks[0].agentGraph is invalid: Agent Graph self-cycle at implementation`. No implementation Task was emitted; Job remains ACTIVE with failed Plan.
- Root cause: model produced a malformed optional Mermaid Agent Graph and the manual Planner defaults to one attempt. Validator correctly prevented a cyclic execution. Production repair: explicitly document optional single-node Agent Graph representation and prohibit self-edges/cycles in `skills/agents-relay/agents/planner.agent.md`, retaining strict parser validation. Regression test in `test/autonomous.test.js` asserts both prompt contract and parse rejection. `npm run build` passed, and autonomous suite passed 31/31.
- Status: FAILED, no review/merge/completion. Retest only with a fresh Job after cancellation.
