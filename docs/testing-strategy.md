# Test strategy

## Fast feedback

npm run test:fast builds TypeScript and runs 12 focused test modules with two-file concurrency. This checks Graph lifecycle and effects, SQLite authority and cross-process schedule claims, no-PR routing, local Git merge and lock recovery, webhook audit isolation, and reconciliation signals.

Use after local edits. Passing fast tests does not authorize a merge.

## Full acceptance

npm test (or npm run test:full) builds and runs every test/*.test.js serially, including workers, daemon, planner, reviewer, dashboard, shutdown, and publication. Run before merge or release. Do not delete safety coverage to make it green.

npm run test:publish is the existing publish-specific runner.

## Guidelines

- Prefer behavioral reproductions of failures over source-text snapshots.
- Reuse fixtures instead of duplicating fake GitHub clients in local workflow tests.
- Retain SQLite concurrency, dual-process merge, stale lock recovery, review SHA invalidation, publication isolation, event-driven wake, and startup recovery.
- Measure real wall time before altering test concurrency.
