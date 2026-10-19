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
