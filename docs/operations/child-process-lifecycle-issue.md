# Relay child-process lifecycle and orphan cleanup

## Problem and observed evidence (2026-10-07)

On the Neo self node, five `npm exec agents-relay plan` invocations and their Node children remained alive for over five days after their launcher had disappeared (PPID=1). They were not PM2-managed services. Examples: `browser-workspace` PR #20/#21, `agents-relay` PR #246/#247, `family-tutor` PR #31. Sending SIGTERM killed child processes, but some npm wrappers persisted in uninterruptible state.

Separately, two Markcut preview servers spawned concurrent `mflux-generate-flux2` Python jobs against the same media output; children were restarted after terminating Python directly and became orphaned after terminating their parent servers. Swap usage fell from about 19 GB to about 4 GB after terminating orphaned generation jobs. Markcut-specific ownership belongs in Markcut, but Relay must enforce the same robust managed-child lifecycle for planner/worker/shell subprocesses.

## Objective

Implement a reusable, platform-aware lifecycle mechanism for processes spawned by Agents Relay (especially planner commands), ensuring that timeouts, cancellation, parent shutdown/crash, retry, and reconciliation do not leave detached `npm exec`, `node`, `gh`, or nested grandchildren running. Ensure CLI `plan` terminates after its intended work; identify and fix why actual historical plan invocations stayed alive for days rather than blindly imposing a universal short timeout.

## Scope and acceptance criteria

- Trace all process launch paths (`spawn`, `exec`, shell wrappers, planner runner, adapters) and identify the ownership layer. Preserve legitimate PM2 daemons and unrelated processes.
- Establish bounded process-group ownership and shutdown semantics (SIGTERM, grace period, SIGKILL) with platform-aware behavior. Do not kill arbitrary matching process names or unowned process groups.
- Cancellation/timeout/abort/parent-exit must propagate to children and grandchildren, including detached or npm-wrapped workers; prevent re-spawn during cancellation.
- Ensure planner CLI does not hang on active handles, event-bus clients, pollers or child command descendants after finishing; close resources correctly.
- Reconciliation/recovery handles lost owners and abandoned work without killing live legitimate jobs; add diagnostics/audit for PID, process group, invocation, reason, signal, exit status and elapsed duration without logging secrets.
- Add regression tests for successful completion, timeout, cancellation, parent exit, nested children, retry, and competing jobs; inspect tests run and verify no surviving child processes after termination.
- Run focused tests and review the completed change. Keep code changes inside Agents Relay; separately flag Markcut player cleanup as a follow-on concern.

## Safety constraints

Do not restart NeoY, PM2 or Chrome as part of regression tests. Do not kill unrelated active services. Use test-owned disposable child trees only.

## Confirmed cause and resolution

Planner, adapter, GitHub, continuation, usage-probe, escalation, decision, and workspace helpers launched child processes independently. Planner abort and timeout signalled only the immediate PID. When an npm/shell/Codex descendant inherited stdout or stderr, Node's child `close` event waited for that descendant even after the direct child exited; the planner promise therefore never settled, the CLI never reached event-bus/reconciler cleanup, and the abandoned wrapper tree survived its launcher. The overall planner timeout did fire, but its direct-PID SIGTERM did not own or terminate the descendant group.

All Relay subprocess launches now converge on `src/owned-process.ts`. On POSIX each disposable launch receives its own process group; Windows uses direct graceful termination followed by targeted `taskkill /t /f`. Abort, timeout, cancellation, retry cleanup, direct leader exit, and orderly shutdown use SIGTERM plus a bounded grace period and SIGKILL. A detached, stdio-free supervisor watches the parent relationship and terminates only its assigned process group if the Relay parent is killed, covering owner crashes without process-name matching. Existing startup/lease reconciliation remains the durable-state authority while the supervisor handles the abandoned OS process tree.

Structured observations record the secret-safe invocation identity, executable basename, PID, process group, termination reason, signal, exit status, and elapsed duration. CLI `plan` and local `reconcile` explicitly close their reconciler and event-bus resources before returning. Regression tests create only disposable process trees and verify normal wrapper completion, cancellation, timeout, competing-group isolation, CLI planner completion, and parent SIGKILL cleanup with fresh PIDs.

Markcut preview/player process ownership remains a separate follow-on in Markcut; Relay does not inspect or terminate those unowned services.
