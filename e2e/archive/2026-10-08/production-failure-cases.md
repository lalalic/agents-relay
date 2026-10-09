# Production-path E2E regression scenarios (2026-10-08)

Run against the existing production Agents Relay daemon, existing NeoY/Event Bus/Router/workers, and only `lalalic/agents-relay-e2e` for workload PRs. No parallel test daemon or synthetic lifecycle entry point. For each run capture PR, Job/Task marker, event history, execution ID, process exit, Graph transition, final GitHub state, actual changed files, recovery time and count of human interventions. **PASS requires no manual retry/reconcile/review/merge**, except explicit planned fault-injection by the tester.

## E2E-001 Happy path / bootstrap
Evidence: E2E repo PR #2, plan-1 failed because the repository had not been cloned; plan-2 generated a plan but failed while writing via `gh exited null`. This is a **current failed real run**.
Trigger: Create standard autonomous Job in the existing E2E repo; issue one standard `plan` invocation.
Expected: Planner persists plan/tasks without manual repair, worker runs fixture change, immutable review succeeds, auto-merge completes, Job COMPLETED.
Fail evidence: PR #2 Job ACTIVE, both plans FAILED, zero Tasks. Identify underlying GitHub command cause before any retry.

## E2E-002 Worker completion followed by process exit
Evidence: Agents Relay PR #264 (`task.completed` followed by `task.process.exited`, `authoritative:false`).
Trigger: Worker publishes matching task.completed then exits with nonzero error / benign stderr, with same execution identity.
Expected: Task SUCCEEDED remains authoritative, process diagnostic preserved separately, automatically advance review, no retry of succeeded work.

## E2E-003 Missing terminal event / watchdog
Evidence: PRs #260 and #263, repeated terminal-event timeout; #265 also had the same failure.
Trigger: Worker process exits/terminates without mandatory correlated terminal event.
Expected: Watchdog classifies by actual exit and structured worker output, troubleshooter/recovery runs automatically, eventual valid terminal or explicit BLOCKED with evidence; never silently stall.

## E2E-004 Relay daemon restart / orphan
Evidence: PR #264 `Orphaned after relayd restart after maximum attempts`.
Trigger: Start running E2E worker then perform planned restart of existing `agents-relayd`; observe all active production jobs.
Expected: Reconcile based on executionId and PID, recover or resume exactly once, no duplicate worker launch or false failure. This test intentionally affects shared runtime and must be run serially after inspecting active jobs.

## E2E-005 Review runtime fails
Evidence: PR #264 final review `Reading additional input from stdin...` (exitCode 1), PR #258 planner similarly failed.
Trigger: Review runtime produces genuine provider failure or EOF/exit instead of terminal event.
Expected: Classify provider error using stdout/stderr and exit status, troubleshoot and reroute/retry without requesting manual review; immutable SHA is honored.

## E2E-006 Browser Workspace missing runtime dependency
Evidence: PR #264 Troubleshooter ChatGPT worker failed twice with `ModuleNotFoundError: No module named 'yaml'`.
Trigger: Controlled missing Python dependency at browser-workspace invocation (only test execution; never remove shared packages for all production jobs).
Expected: Preflight identifies missing dependency, canonical troubleshooter fixes tool runtime or routes to usable worker, retries original task automatically.

## E2E-007 Provider quota exhausted
Evidence: PR #264 troubleshooter determined ZAI quota errors were hidden in Codex stdout; related routing incidents.
Trigger: Select exhausted provider or inject quota-rejected response at test worker boundary.
Expected: Parse structured stdout accurately as rate_limit_exceeded, read fresh usage, reevaluate router, resume original Task with viable provider, review and merge automatically.

## E2E-008 Planner GitHub persistence failure
Evidence: E2E PR #2 plan-2 `gh exited null` after planner generated valid next_tasks.
Trigger: GitHub CLI process abnormal exit during task/plan projection.
Expected: Preserve plan evidence, retry idempotently, no duplicate plan/task comments or permanent Planner FAILED.

## E2E-009 Async browser-worker handoff
Evidence: PR #257 `task.process.async_exited` on ChatGPT worker, some repeated executions.
Trigger: Async submit returns before terminal user event.
Expected: Keep Task running until matching terminal, avoid treating transport exit as business success/failure, avoid duplicate worker launches.

## E2E-010 Repeated webhook and stale execution event
Evidence: PR #264 multiple synchronize/job.wake, repeated execution attempts.
Trigger: Duplicate synchronize, wake and delayed terminal from previous execution.
Expected: One authoritative task transition per attempt, outdated execution ignored, no duplicate concurrent start, same final durable result.

## E2E-011 Merged PR with failed mandatory work
Evidence: PR #263 Job COMPLETED while implementation Task FAILED; PR #265 had cancelled work after merge.
Trigger: External merge arrives despite failed mandatory implementation.
Expected: Graph-owned merge semantics and job completion agree with approved contract; failed work cannot be silently represented as successful implementation, preserve evidence and create corrective recovery as needed.

## Execution order
001 first (current blocker), then 002,003,005,007,008,009,010,011; 004 and 006 last because shared runtime fault injection can disturb normal production tasks.
For each: baseline -> run/fault -> event capture -> automatic recovery observation -> failure root cause -> durable code-fix Job -> review/merge/deploy -> rerun same E2E. Never relabel an untested case PASS.
