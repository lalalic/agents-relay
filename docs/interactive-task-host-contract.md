# Relay host interactive Task contract — implementation and validation

## Scope
New feature, root cause: N/A. Initial prototype method forwarding defect was fixed during this execution.
Relay Graphs own acceptance and Task state policy; SQLite owns durable facts. Markcut is neutral and carries no Relay identities.

## Implementation
- Generic host UI input: eventId, invocationId, immutable revision, approved / changes_requested decision, optional feedback.
- Host adapter binds jobId, taskId and executionId outside any preview tool; it must authenticate the mapping.
- SQLite host_invocation_event and host_invocation_decision tables preserve accepted, duplicate and stale event facts transactionally.
- The canonical interactive-invocation Graph selects approval/change and wake effects. An interactive wait moves the Task from RUNNING to DRAFT; an accepted decision releases the same Task to QUEUED.
- One Task may repeatedly yield while waiting for review, release its worker, then resume with persisted feedback on a new worker execution; no new Task is created for a revision. Interactive waits never use BLOCKED or UNBLOCKED.
- Reconciliation can recover a committed decision after a lost event wake. Unapproved interactive Tasks cannot complete, and pending human review does not create Troubleshooter Tasks.

## Verified in Agents Relay checkout, October 12, 2026
- npm run build: PASS.
- node --test test/interactive-invocation.test.js: PASS 5/5.
- focused Graph/source-size/invocation tests: PASS 16/16.
- npm run test:fast: PASS 127/127 (earlier implementation checkpoint).
- npm run test:full: PASS 845/845, 0 failures.
- Integration fixtures cover v1/v2 Request Changes then v3 Approve, stale/duplicate approvals, feedback persisted in SQLite, Task completion gate, DRAFT-to-QUEUED same Task resume and recovery after lost wake.

## Deviations and pending coordinating Job acceptance
- Real registered Markcut MCP player port 4571 scenarios A and D: NOT RUN here; separate Markcut repository scope.
- Real ChatGPT MCP Apps event delivery for scenario B: BLOCKED for genuine E2E PASS until an actual registered host interactive session is exercised. Mocked/deterministic host tests are not equivalent.
- Markcut standalone and both repositories regression/install verification scenarios C/E: pending coordinating Job; no Markcut changes in this Task.
- Independent review, merge, publish, deployment and installed production check are NOT RUN. Relay/coordinating Job owns them.
- Optional in-process waiter is a synchronous host convenience only; durable suspension/recovery does not depend on its promise.

## Changed files
- src/interactive-invocation.ts, src/interactive-resume.ts, src/host-invocation-store.ts: host adapter, Graph dispatch, SQLite ledger and recovery.
- src/relay-store.ts, src/store.ts, src/projected-store.ts, src/types.ts: persistence types/adapters.
- src/reconciler-runtime.ts, src/reconciler.ts, src/troubleshooter.ts, src/managed-worker-input.ts: event handling, worker resume and lifecycle guard.
- workflow/interactive-invocation.mmd: canonical interactive decision policy.
- test/interactive-invocation.test.js, test/workflow-engine.test.js: deterministic integration and graph registration.
