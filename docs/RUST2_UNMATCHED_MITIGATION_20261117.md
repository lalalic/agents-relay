# Rust2 PORTING unmatched API mitigation — 2026-11-17

## Milestone provenance and outcome

The read-only tagged baseline is `rust2-head-to-head-milestone-20261117` (`5ed23b1`): 177/177 direct Node/Rust suites, 345/345 Rust tests, 1,220/1,220 Node main tests, L3 90 PASS + 1 SKIP, migration ledger 117 PASS / 107 PORTING / 4 EXCLUDED. There were **122 unmatched runtime export names** at the milestone.

The follow-up tranche mitigates **24 flagged names**, reducing unmatched static candidates **122 → 98** without changing the original milestone:

- **6 cross-module API mapping false negatives**: the audit now follows specific `pub use crate::module::{PublicType}` reexports to the referenced public `impl` methods. This correctly locates `ServiceEventBus.publish/subscribe/subscribeAll/close`, `UsageRegistry.snapshot`, and `UnavailableUsageReader.read`. A method name match is not behavior proof.
- **6 real ContinuationAdapter facade exports**: native `CodexThreadContinuation`, `CommandContinuation`, and `WebhookContinuation` now expose their kind-specific public methods, calling the existing owned-process/HTTP adapter. Rust raw-identifier `r#continue` is recognized by the audit. The underlying direct Node/Rust continuation transport was already exercised in Wave4; new native tests check facade selection, argv, error and webhook payload. No Codex executable is invoked.
- **2 `InMemoryStore` methods**: `closePullRequest` and `updatePullRequestBody` have native no-op equivalents, as in Node, for this test-only Store. Native tests confirm no mutation.
- **10 reader names**: public `BrowserWorkspaceUsageReader`, `CodexSessionUsageReader`, `ZaiUsageReader`, `DeepSeekCreditReader` and `OpenRouterCreditReader` now have native `read` facades over the already ported native quota primitives. Direct Node/Rust fixtures use synthetic local Codex session files, a fake WebHelm executable, missing-command rejection and unconfigured API keys. This tests only offline observations, not live provider auth/network correctness. The missing absolute executable now matches Node's spawn error instead of reporting the Rust supervisor's synthetic 126 status.

Evidence lives in `rust/tests/native_unmatched_mitigation.rs`, `rust/tests/head_to_head_usage_readers_mitigation.mjs`, and the unchanged prior Head-to-Head suite. The generated [API Matrix](RUST2_API_PARITY_MATRIX.json) enumerates each remaining candidate, with its actual source and target.

## Not yet equivalent / not claimed

The remaining 98 unmatched names are not all missing implementations. Higher-risk unresolved groups include real CLI/Daemon service wiring (`cli.ts`, `cli-support.ts`), reconciler and planner lifecycle methods, cross-Job Blocker persistence, external GitHub GraphQL paths, Codex app-server live reader behavior, and Router decision orchestration. Treat class-level mappings as preliminary until their signatures, dispatch, durable effects, cancellation/restart and production calls are independently verified.

**Do not upgrade `PORTING` to `PASS` solely from this reduced static count.** Graph chooses workflow actions, SQLite owns durable truth, and event/HTTP receipts never imply successful Task completion. Production deployment, remote push and cutover were intentionally excluded.

## Regression verification for this tranche

- Direct Node/Rust suites: **178 passed / 0 failed**, exit code 0. Includes new real disposable Reader tests and the previously verified Continuation transport comparisons.
- Rust native `cargo test --all-targets -- --test-threads=1`: **348 passed / 0 failed**, exit code 0, including three new Continuation/InMemoryStore tests.
- Node `npm run test:full`: **1,221 passed / 0 failed**, L3 **90 passed / 1 skipped / 0 failed**, exit code 0.
- Supplemental L1 **58/58**, L2 **11 pass / 1 skip**, Cross-A **10/10**. Audited static export correspondence includes a regression that leaves `cli.ts:startService` explicitly unmatched.

These are test fixtures and deterministic local integration evidence, **not a live deployment or authorized production cutover**.
