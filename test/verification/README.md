# Relay verification foundation (Job 480 / Task 45)

Use `node test/verification/cli.mjs list` to see registered scenarios. Use `node test/verification/cli.mjs foundation /tmp/relay-verification-output` to validate corpus and produce `report.json` and `report.md`. **Foundation mode reports NOT_RUN for every scenario. It does not execute agent contracts, live models, or workflow events.**

Use `node test/verification/cli.mjs replay path/to/trace.json` for deterministic trace validation. Trace JSON contains `scenarioId`, `trace` (array of ordered event names or `{event, progress}` objects) and `terminal`. A failing replay exits nonzero. Run foundation unit tests with `node --test test/verification/harness.test.mjs`.

Foundation extension points:

- L1: load scenarios with category L1; use production validators/agent skill contracts, record actual events and failures with `newEvidence`.
- L2: opt-in live installed adapter/provider execution; collect genuine emissions, distinguish provider from transport failures. Keep NOT_RUN otherwise.
- L3: connect mock external effects to the real production ingress/reconciler/SQLite, append observed events to traces, then call `classifyTrace`. Never force lifecycle transitions inside the harness.

Create an isolated store with `createIsolatedEnvironment`; pass its returned `env` to spawned Relay processes. Do not use the canonical user store. The included scenarios are starting contracts only, not claims of passing integration coverage.

## Isolated Graph/SQLite regressions (Task 56, partial L3)

`npm run test:verification:l3` runs foundation checks plus two production Graph/scheduler/SQLite regression tests. They validate persisted dependency release across a database restart and rejection of duplicate terminal transitions. Each test uses a temporary `AGENTS_RELAY_STORE_DIR`-style directory; no production Job or daemon is changed.

**Coverage limit:** These are component integration regressions, **not** the required full-path L3 simulator. They do not exercise production events-bus ingress, active Reconciler dispatch/worker lifecycle, human escalation, merge effects, replay JSON/Markdown generation, or the required broader fault matrix. Do not report the L3 objective as PASS from these tests alone.

## Production ingress regression (Job 481, Task 56)

`npm run test:verification:l3` also runs `l3-ingress.test.mjs`: an isolated unified SQLite authority under a temporary `AGENTS_RELAY_STORE_DIR`, with real `MemoryEventBus.subscribe`, `Reconciler.watch`/`handleEvent`, production Graph transitions and scheduler-driven dependency release. It asserts persisted state, tests duplicate/stale event rejection, and confirms that a deliberately wrong-generation event fails the expected-success assertion. No external Git or provider calls are made.

**Remaining gap:** This coverage is not a full L3 scenario simulator/CLI replay. Multi-phase recovery, escalation, reviews and merges still need production-path simulator fixtures, actual SQLite causal history, and evidence exports. The older `cli.mjs replay` is only a trace validator, not a production-path replay. Do not label those cases PASS.

### Bounded production ingress replay

Run `node test/verification/l3-replay.mjs test/verification/l3-scenarios/dependency-release.json /tmp/l3-evidence`. This runs a fresh MemoryEventBus → Reconciler.watch → production Graph/scheduler → isolated SQLite, and generates `report.json` and `report.md`. The deliberately invalid `broken-premature-completion.json` exits nonzero; terminal assertions read the saved SQLite state, not input trace terminal markers. `npm run test:verification:l3` runs its positive and negative replay regression tests. This is a bounded two-task replay, **not** all required Job 481 L3 workflows; escalation/re-review/merge/restart and full worker dispatch remain unverified.

## Independent B verification (2026-10-19)

`npm run test:verification:l1` includes production reviewer terminal normalization, event-source identity, agent contract assertions, graph-link resolution, Dashboard safe SVG/navigation controls and the strict evidence gate. `npm run test:verification:l3` runs the existing 17 isolated SQLite/Graph/ingress regressions. This is **not** proof that the complete Job 481 L3 objective has passed.

`node test/verification/evidence-matrix.mjs /tmp/agents-relay-verification-b` emits JSON and Markdown status for the original scenario corpus, conservatively `NOT_RUN` until a trusted production runner supplies causal evidence. It does not accept an arbitrary JSON file as PASS authority. L2 may be PASS only when real installed role skills, actual providers/adapters, Relay acceptance, and the emitted events have been verified. Simulated adapter outputs do not count.

Dashboard graph `workflow/main.mmd` is presentation-only. Canonical nested Mermaid graphs remain the only workflow-policy authority. Browser tests and screenshots are **NOT_RUN** in this independent B slice; static UI tests alone do not satisfy real-browser E2E.

## Independent B review corrections (2026-10-19)

The evidence-matrix gate no longer accepts user-defined `productionPath`, `graphTransitions`, `sqlitePredicates`, `actualTerminal`, or provider booleans. An L3 scenario must execute `runReplay` in a newly isolated SQLite store, with observed ingress transitions. The matrix CLI accepts only its report destination; all corpus cases without complete scenario-specific evidence remain `NOT_RUN`. The replay runner's injected merge outcomes are SQLite fixtures, **not real Graph-selected merge effects**, so they are never independently certified as full-path success by this gate.

Two new L3 negative/safety regressions cover sequential blocked Planner/Worker/Reviewer/Merge attempts, restart, and stale or duplicate generations. These establish no false completion and fencing, **not recovery to an actually achieved Objective**. A production-driven action/effect-reconcile simulator covering successful recovery, unknown-effects reconciliation and human escalation remains incomplete. Real-provider L2 and browser screenshot evidence remain `NOT_RUN`.

## Second-review result (2026-10-19)

`objective-authority.test.mjs` adds an isolated production-ingress negative regression. It injects a planner failure, old-generation worker/reviewer events, a restart and even a fake successful merge receipt, then verifies that SQLite still reports the unfinished autonomous Job as ACTIVE. This is a safety check, not the requested Planner→recovery→Worker→recovery→Reviewer→Merge→Objective COMPLETED positive closed loop. The existing replay harness cannot provide that evidence by calling `sqlite.saveJob` for synthetic merge receipts or by hand-writing a terminal. Such shortcuts are not accepted. Human escalation notification/delivery/unblock, effect-unknown reconciliation and full staged recovery still require Thread A's graph-authorized actions and authoritative postcondition predicates.

## Third review / A integration boundary

A's `f0e1462` introduces `WorkflowActionLedger`, a tri-state condition registry and a dispatcher verification option. B independently ran A's two focused ledger integration test files (3/3 PASS) without editing A's worktree. They establish isolated reserve/deduplicate/Unknown behavior, **not** production Reconciler/Scheduler invocation, authoritative execution-generation fencing, crash-consistent publish, or successful objective verification. B must not simulate successful completion by direct SQLite writes. The full multi-stage positive objective path remains NOT_RUN pending the production dispatch integration and verified postconditions. Browser-specific focused E2E evidence is under `docs/evidence/dashboard-b-third-review/`.

## Fourth review: A action-ledger cross-branch gates

Run `RELAY_A_DIST=/absolute/path/to/A/dist node --test test/verification/action-ledger-cross-branch.test.mjs` against A's *already compiled* artifact, without modifying its dirty worktree. The suite checks authoritative generation/lease/owner/attempt rejection, attempt-key collisions, and reopened SQLite Unknown replay. Without `RELAY_A_DIST`, all 3 tests are explicitly SKIP; they are never counted as verified. During 2026-10-19 testing against A's then-current compiled `dist`, 2/3 passed; the stale authoritative generation test FAILED because compiled code compared `task.attempt` to identity.generation rather than an authoritative generation field. A's dirty source already has an uncommitted different implementation; this report does not imply that source was rebuilt or tested. This gate is intentionally red until A provides the corrected committed build. Crash windows for external publish and full Graph-authorized objective verification are still NOT_RUN.

## Fifth review: A cross-branch integration

B's opt-in A cross-branch suite now covers (1) stale attempt-generation, owner, lease and invalid clock fencing; (2) attempt-key collision; (3) crash/reopen with durable `Unknown`; (4) verified action with deferred state persistence and duplicate replay rejection; and (5) unknown postcondition preventing transition/event publication. These tests directly load A's current compiled `dist` using `RELAY_A_DIST` and cannot be counted if skipped. The local A worktree advanced while tests ran: the final passing run (5/5) used A's compiled implementation including paused-job fencing at commit `311cafd`, not merely historical `96d9e42`. No A source edits were made.

These tests exercise the dispatcher and isolated SQLite, **not** the full production Reconciler-to-Objective multi-stage positive lifecycle. A genuine planner/worker/reviewer/merge failure/recovery chain ending in verified SQLite `COMPLETED` remains NOT_RUN; L2 live provider remains NOT_RUN.

## Sixth review: execution history and pause/resume

Cross-branch tests now explicitly reject missing, mismatched execution IDs and attempts in `executionHistory`, stale generation/owner/lease, and active job pause. They verify an unpaused running lease can reserve a fresh action, and Unknown replay still does not duplicate the effect. A advanced during testing from `311cafd` to `9b11efa`, which requires executionHistory rather than silently permitting legacy absence. The production Reconciler full positive objective recovery and publish crash/replay remain NOT_RUN; these ledger/dispatcher tests do not prove them.

## Seventh review: pending full recovery acceptance

`full-recovery-gates.mjs` enumerates 11 mandatory scenario paths: Planner recovery, Worker recovery, Reviewer changes-required and failure, Merge retry, combined positive objective, human escalation notification/delivery/confirmation/unblock, Unknown effect postcondition reconciliation, crash after persist/before publish, stale replay and impossible objective. These are **acceptance inventory**, not evidence of execution. All are explicitly `NOT_RUN` until production Reconciler/Graph/Scheduler postcondition instrumentation produces trusted SQLite-based proof. Caller-provided traces or `COMPLETED` fields cannot promote them to PASS. A commit `9b11efa` does not yet wire the Ledger and durable outbox to production Reconciler/Scheduler; B does not edit A-owned graph or registry code. Run the B unit tests for gate integrity, not to claim the 11 runtime paths succeeded.

## Eighth review: outbox crash windows and trusted evidence

The dead WeakSet proof gate has been replaced by an explicit `NOT_RUN` acceptance inventory. There is no caller-provided proof promotion path. `outbox-cross-a.test.mjs` is an **opt-in** cross-branch test against A's compiled `DurableWorkflowPublication`, with SQLite crash/restart tests for atomic transition+enqueue rollback, persisted transition+pending event after reopen, and publish-before-ack redelivery. The last test proves duplicates are **observable** and a simulated consumer can dedupe by stable key; it does **not** prove the real event consumer enforces dedup. The local A checkout has additional uncommitted outbox code and is not modified by B. Full positive Objective `COMPLETED`, escalation delivery/confirmation/unblock, and the complete Reconciler publication crash chain remain `NOT_RUN` until authoritative production integration is available.

A later build at `4fa6893` changed the verified dispatcher contract to require `publication.commitTransitionAndEvents` plus a synchronous SQLite `persistSqliteTransition` callback. B's cross-branch tests now provide those interfaces and pass 10/10 against that A build. This remains focused transaction/dispatcher testing, not proof of the production Reconciler's complete multi-stage objective closure or real consumer deduplication.

## A `4fa6893` production wiring coordination

Run `RELAY_A_ROOT=/absolute/path/to/A npm run test:verification:l3` to include `production-wiring.test.mjs`, which reads A's Reconciler/Scheduler source without changing it. A `4fa6893` lacks `actionVerification` invocation in either production module, an outbox restart drain, and an authoritative postcondition binding there. The probe yields `NOT_RUN`; even a future syntactic match only yields `INTEGRATION_PRESENT_UNVERIFIED`, **never** Objective PASS. Complete real L3 requires production path plus persistent, causal SQLite objective predicates, notification/unblock flow, event consumer dedup, and restart/crash recovery to be executed and observed.

## Integration branch acceptance evidence — 2026-10-19

- `npm run test:verification` runs L1, isolated L2 MCP transport contract, L3 and cross-A against **this branch's compiled dist**, plus production-outbox recovery.
- `full-recovery-gates.mjs` has a trusted, in-process production replay evidence provider, with no caller-controlled proof flags. Currently **9/11 PASS**: human escalation with isolated notifier receipt/unblock and unknown launch effect with correlated started event/restart. Both use isolated SQLite → production event ingress → Reconciler/Graph → authoritative objective, with external model, notifier, and Git simulated. The other **2/11 are NOT_RUN**, not asserted to pass.
- `test/verification/l2/event-server.mjs` is an isolated MCP capture sink with strict execution identity. Its test proves transport capture and error rejection only; **L2 real installed adapter/role/model compliance is NOT_RUN**. Do not mistake this MCP server test for a real provider run.
- Production notification delivery to a user-visible channel, positive Planner **Plan round** recovery, complete combined multi-stage chain, and browser E2E remain unverified. A successful regression suite does not supersede these gates.
- This branch is integration work only; no merge, publish or production Job 481 mutations occur through tests.


### Real installed Codex CLI probe (explicit opt-in)

The four positive-role Codex CLI checks were executed in a private temporary working directory on 2026-10-19. Each loaded the installed role instruction file, connected only to the dedicated MCP `relay_l2.publish` sink, captured the emitted event without repairing payloads, and replayed accepted events into production Relay ingress with independent isolated SQLite. All four positive cases were accepted. The initial read-only sandbox attempt failed when MCP demanded unavailable approval; a second invocation used incompatible CLI flags and failed before execution; a third isolated implementation invocation with `--approve-for-me` passed. These failure records remain as diagnostic evidence.

Use `RELAY_L2_LIVE=1 RELAY_L2_ROLE=implementation npm run test:verification:l2:live` to run again with actual model usage and a bounded timeout. Valid role values: `implementation`, `reviewer`, `troubleshooter`, `planner`. The default without `RELAY_L2_LIVE=1` is `NOT_RUN`, not a PASS. The smoke probe executes the installed Codex CLI and role Markdown but does **not** instantiate the Relay CodexAdapter end-to-end. Success/failure/changes-required/escalation/missing-input negative role cases are still NOT_RUN. This isolation never uses the real Job 481, NATS, production Relay Job store, or user Thread.

`npm run test:verification:l2` validates the isolated MCP capture protocol, normal production Relay ingress, and immutable reviewer SHA rejection without incurring a real-model cost.

`npm run test:verification:matrix` recomputes the 11-scenario L3 acceptance inventory via internally fixed production replays and writes `/tmp/agents-relay-job481-evidence/report.json` and `report.md`. Nine paths have internally rerun proof. Planner Plan-round failure/recovery and its combined end-to-end Objective convergence remain NOT_RUN. The Outbox path uses production Reconciler restart plus focused atomicity/publish-before-ack tests, with zero skipped tests; its report names those separate test sources rather than presenting them as one monolithic scenario.

### Additional verified real Plan-round convergence (integration follow-up)

`l3-planner-round.test.mjs` now exercises a real `Plan` record, **not** a synthetic Planner Task. Production Reconciler launches the Planner, receives the injected provider failure, emits `planner.retry`, launches attempt two, commits the resulting Plan children into isolated SQLite, and leaves the unfinished objective ACTIVE. The second test follows those committed children through Worker failure → Troubleshooter recovery → changed Reviewer head → fix task → Reviewer failure → Troubleshooter recovery → approval → simulated Git merge failure/retry → SQLite Job COMPLETED. Run with `npm run test:verification:l3`; both positive tests pass. `l3-planner-combined.mjs` supplies the fixed scenario; no caller-supplied PASS flags are possible.

**Critical remaining distinction:** A retryable Planner failure produces `planner.retry`, not terminal `planner.failed`. The two strict Job 481 matrix paths `planner-failure-recovery` and `sequential-complete-objective` explicitly require terminal Planner failure, a separate Troubleshooter-owned recovery and an eventual successful Plan. That specific sequence is still **NOT_RUN** and is not inferred from this positive automatic retry test.

The isolated escalation notification receipt is injected through a test notifier. A connected production user-visible notifier, complete native CodexAdapter launch compliance, and standalone real-browser Dashboard E2E are not established by these tests.
