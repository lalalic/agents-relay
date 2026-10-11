# Scenario catalog

Every attempt uses one fresh workload branch + one fresh durable Job. Never mutate a failed round into a pass. After bootstrap, the controller must not manually retry/reconcile/review/unblock/merge the Job under test.

## Validated baseline

1. `001-happy-path` — ordinary production lifecycle. PASS.
2. `002-worker-blocker-troubleshooter-recovery` — real worker blocker, automatic Troubleshooter, exact original Task recovery. PASS.

## Compressed exception scenarios

3. `003-objective-exception-ladder` — workload-only choreography: worker fails once -> Troubleshooter recovery -> exact original retry -> reviewer rejects twice -> two Graph-created fixes -> third review approves -> merge.
4. `004-objective-recovery-exhaustion-escalation` — workload-only terminal path: recovery cannot safely proceed and Troubleshooter invokes canonical escalation; must not falsely complete.
5. `005-watchdog-stale-generation` — runtime injection: missing terminal/process exit -> watchdog/recovery -> newer execution -> delayed stale old terminal ignored.
6. `006-provider-quota-reroute` (legacy scenario ID) — genuine worker execution rejection (quota, model, provider, or equivalent) -> classified failure -> appropriate automatic recovery of original Task.
7. `007-projection-isolation-retry` — external transport injection: projection failure + duplicate delivery while SQLite lifecycle remains authoritative.
8. `008-async-browser-handoff` — async browser submission transport exits before authoritative terminal event; no duplicate launch.
9. `009-daemon-restart-orphan` — shared-runtime injection: restart daemon during active execution; exactly-once orphan/live recovery.
10. `010-browser-workspace-runtime-failure` — shared-runtime dependency injection; repair/reroute exact original Task.
11. `011-implementation-thread-ownership` — one normal Job configured with an implementation thread; two distinct implementation Task executions are delivered as separate new turns in that same thread, while review uses an independent reviewer thread.

## Why scenarios are compressed this way

Objective-driven failures are safe to combine when the agent can intentionally publish a valid authoritative lifecycle result without modifying Relay or shared runtime. Process death, missing terminal events, stale execution generations, provider transport failures, GitHub transport failures, daemon restart, and Browser Workspace dependency failures require real injection and remain separate.

Recommended order: `001`, `002`, `003`, `004`, `005`, `006`, `007`, `008`, then disruptive shared-runtime `009`, `010`, and finally `011`.

## External injector

`e2e/runner/inject.mjs` is the controller-side fault injector. It never edits Relay SQLite/lifecycle state.

- Scenario 005: `--phase terminate-current`, then after recovery creates a newer execution use `--phase replay-stale-terminal --receipt <terminate receipt>`.
- Scenario 009: `--phase restart-daemon` restarts the existing PM2 `agents-relayd` exactly once.
- Scenarios 006/007/010: `--phase inject --command '<scoped command containing {job}>'`. The controller refuses commands that are not explicitly scoped to the Job and writes an injection receipt. The scenario-specific environment/fault mechanism is supplied when that scenario is run; it is not hard-coded into production Relay.

## Planner instructions are executable E2E documentation

Each `NNN-*.md` scenario must include exactly one section delimited by `<!-- PLANNER-CONTRACT:START -->` and `<!-- PLANNER-CONTRACT:END -->`. `e2e/runner/prepare-round.mjs` reads this section **from the canonical scenario document** and prefixes it to the generated Job Objective for every round. Therefore the actual Planner sees the exact contract; the individual round objective only specifies its workload and expected observations. Missing scenario document/contract fails before Job creation.

For method-level fault injection, the contract must instruct the Planner to set the structured `"--test-injection"` property **on the implementation Task JSON object in `next_tasks`**, not in `input`. It must specify `method`, `action`, `execution`, and a supported `mock` or structured `error`. Only registered injection methods operate, and only when the Job's repository equals `E2E_REPO`. The injection is consumed durably before its execution checkpoint. Watchers never inspect the injected option: they judge normal lifecycle and external-operation evidence.

Scenario contracts without an implemented checkpoint must **not** ask the Planner to emit an injection option. Keep their existing fault/protocol path explicit until a supported method-level checkpoint is available. Any newly added scenario must document its Planner contract and add a coverage test.
