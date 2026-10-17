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
