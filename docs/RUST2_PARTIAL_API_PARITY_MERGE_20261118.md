# Rust2 API parity — verified interim merge, 2026-11-18

## Scope

This is an explicitly user-authorized **interim fast-forward merge** of the tested Node→Rust2 implementation accumulated on branch `hotfix/rust2-all-apis-20261117` into `rust2`. It is **not** a complete Node/Rust API parity claim and is **not** a production cutover. The original `rust2-head-to-head-milestone-20261117` tag at `5ed23b1` remains unchanged. No remote push, publish, service restart, deployment or live Job was performed by this tranche.

- Node source remains authoritative; Graph MMD decides workflow policy; SQLite is durable truth. Transport receipts, statuses and event messages are not Task completions.
- Source implementation through commit `ac5db6e` includes real owned-process adapters, routing, Planner and Coordinator, Git/PR bootstrap, scoped SQLite, GitHub projections, cross-Job blocker registration/retries, and Host Invocation event handling. Direct positive/negative tests and original Node fixture comparisons accompany each tranche in `rust/tests/`.
- **Unmatched static runtime exports: 26 across 8 files**, down from 98 at the prior merged baseline. `docs/RUST2_API_PARITY_MATRIX.json` is the authoritative generated inventory; exact symbols and SHA are intentionally not manually duplicated here.
- The same inventory still flags **13 constructor reviews**, **282 type/shape reviews**, and **51 source files without direct differential imports**. These are additional coverage work, not proven failures. **117 PASS / 107 PORTING / 4 EXCLUDED** in the per-file ledger; do not relabel PORTING on the basis of static name correspondence or the aggregate test count.

## Merge gates

On the final source baseline `ac5db6e`, before integration: `npm run build`, `cargo build --bin relay-rust2-parity`, `cargo test --all-targets`, `npm run test:full`, all `rust/tests/head_to_head*.mjs`, L1/L2/Cross-A, audit `--check` and checklist verification must return exit code zero. Log evidence: `/tmp/rust2-intermediate-merge-{node-build,rust-build,native,node-full,h2h,l1,l2,crossa}.log` on the Neo Master. Any failed full gate prevents this interim merge, even when a subset of targeted fixtures passed. The existing baseline has unrelated rustfmt/clippy warning debt; do not silently claim those gates pass without fresh evidence.

## Not yet closed

Continue implementing the remaining exported behavior in `cli.ts`, `planner-runtime.ts`, `pool.ts`, `reconciler-review.ts`, `reconciler-runtime.ts`, `reconciler.ts`, `relayd-dashboard-actions.ts`, and `worker-failure-recovery.ts`. Production dispatch/owned-runtime wiring, negative and restart recovery, multi-store durable effects, complete constructor and type-shape tests remain mandatory for the final claim. New changes must use another isolated, versioned source checkpoint and real post-merge differential tests.
