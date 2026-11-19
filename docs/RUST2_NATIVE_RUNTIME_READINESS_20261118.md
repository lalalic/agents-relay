# Rust2 native Relay runtime readiness — 2026-11-18

**Verdict: NOT production-ready.** This is a factual gate report after implementing native runtime functionality on the sole `rust2` development branch. It is **not** authorization to switch the live Node Relay daemon, run an unverified provider, or bypass review. No new Relay Job, child ChatGPT thread, or Git worktree was created.

## Verified native runtime scope

| Component | Isolated verification | Production gate |
| --- | --- | --- |
| `agents-relay-rust` native CLI executable | Real binary handles help, version, Job/Task show/list, status and supported daemon HTTP control; disallowed/unbound actions fail closed | Full public CLI and external commands still incomplete |
| `agents-relayd-rust` daemon | Real HTTP PWA/Dashboard route, SQLite read-only inventory, loopback status, SIGTERM/restart without mutating Jobs | Production startup, owner election, service update, package publish and live installation unverified |
| Isolated write daemon (`--isolated-write-store-dir`) | Real unified SQLite CAS, Job update, Task comment, Git receipt fences, reconcile wake; no foreign outbox claim reset; stale concurrent writes rejected | Live store deliberately blocked; full remote provider/EventBus and Graph effect binding missing |
| Script Shortcut Worker | Real `agents/.shortcut/<agent>.agent.mjs`, owned JS runtime subprocess (not Node Relay daemon), PID/PGID/start token SQLite record, timeout/cancel, Graph event identity and atomic SQLite+workflow outbox | Other adapters (Codex, ChatGPT/WebHelm, Z) and production Planner/Review human-delivery remain unbound |
| DAG | Real 2-node dependent Script Job runs in dependency order exactly once per task; output files and 4 durable start/finish events verified | Full Planner + actual model-dependent Review L4 unverified |
| Crash and restart | Real daemon SIGKILL mid Script Worker: owned process stops, late file never appears, restarted Graph marks original execution FAILED, no stale success or over-budget retry | Multi-node Worknode/home98 and cross-process operator/service restart not verified |
| Job lifecycle/local Git delivery | Real native daemon completes a planned Script Job and independently merges a completed source branch into disposable Git `main`; durable merge receipt/event, retry on dirty target, review-approval guard and restart idempotency; 20 original Node/Rust merge-lifecycle differentials | Full model-driven Final Review and production merge on a real user checkout remain unverified |
| Isolated ChatGPT/WebHelm Worker submission | Real native Rust daemon Task claim → disposable WebHelm Unix-socket IPC and owned fake CLI → verified browser delivery receipt, **then independent Graph `task.started`/`task.completed` evidence** → SQLite Task success and browser lease release; temporary thread/terminal barrier failure quarantines Session; native daemon E2E + 3 dedicated IPC scenarios + direct original Node/Rust WebHelm differential pass | This is a test-owned fake WebHelm daemon and an injected test event source, **not** live authenticated ChatGPT/Worknode transport; production WebHelm, interactive Review and Z/Codex worker effects remain NOT_RUN |
| Internal model Worker EventBus ingress | Native owner now accepts exact `job/task/execution`-correlated `task.started`, `task.progress` and `task.completed`/`task.failed` through canonical Graph + atomic SQLite outbox; rejects forged sources, pre-start terminal, stale generations, duplicate event identity and unverified Git Task success; status wake/notifications occur post-commit. Tests: `native_sqlite_write_host.rs` | Actual authenticated provider transport, Codex/ChatGPT/Z launches and production event bus remain **NOT_RUN/UNBOUND**; this internal function is **not** exposed as an HTTP/CLI endpoint |
| Optional remote delivery | Explicit post-COMPLETED projection: no-origin `skipped`, test-owned local bare Git origin nonforce FF push, idempotent retry, exact committed SHA, refuses external or network origins | No live remote push, origin provider or physical production delivery verified |
| Targeted Final Review revisions | Native `task.revise` through exact reviewer execution/Git HEAD and SQLite transaction; numeric child Task ID, feedback comments, duplicate/stale/fraud rejected | Model reviewer, host interactive UI and actual human decision L4 not verified |
| Model adapter boundaries | Disposable executable Codex-shim process proves successful exit does not complete a Task; failure is technical; unverified/temporary browser receipts rejected; Z requires exact execution source | Real Codex CLI explicitly not invoked, ChatGPT/Z/WebHelm physical sessions NOT_RUN, model adapters unbound in daemon |
| Isolation safety | Rejects live SQLite directory, symlinked/hardlinked DB and WAL/SHM/journal; Job project/output and Git push origin must remain inside test-owned fixture; no live production mutation | Production data migration and cutover gate not run |

The same Graph selects actions for the Rust Reconciler. A real integration test identified a previously silent mismatch: the Task Lifecycle wrapper emits string action IDs, whereas older Reconciler code assumed every action was an `{id}` object. `Reconciler::graph_action` now supports both Graph decision forms; real native Script worker launch, multi-task DAG, and original Node/Rust Reconciler differential have passed after the fix. Other raw Graph consumers already receive structured actions; do not blanket-rewrite them.

## Passing isolated regression evidence

- Rust: `cargo test --all-targets -- --test-threads=1`, using only an isolated `AGENTS_RELAY_STORE_DIR` and absolute test-owned `AGENTS_RELAY_SCRIPT_NODE`, **PASS**.
- Rust native daemon executable integration (`native_daemon_binary_readonly.rs`), including forced SIGKILL and restart, **PASS**.
- Rust CLI binary and write host SQLite CAS/outbox tests (`native_cli_binary.rs`, `native_sqlite_write_host.rs`), **PASS**.
- Rust owned Script process and Graph+SQLite tests (`native_script_worker_process.rs`, `native_script_graph_sqlite.rs`), **PASS**.
- Original Node/Rust **focused** Reconciler differential (`head_to_head_reconciler_reconcile_public.mjs`, `head_to_head_reconciler_active_public.mjs`, `head_to_head_reconciler_apply_event.mjs`, `head_to_head_reconciler_git_head.mjs`): **5/5**.
- Original Node/Rust **focused** Task/Job Lifecycle and Planner/Task Resolution Graph differential (`head_to_head_lifecycle_batch.mjs`, `head_to_head_wave4_graph.mjs`): **13/13**.
- Original Node/Rust `reconcileLocalGitCompletion` direct (20 scenarios, all gates, successful/failed/denied merge) and original Node/Rust real isolated Git merge (40 scenarios), **PASS**; see `rust/tests/head_to_head_local_merge_completion.mjs`, `rust/tests/head_to_head_wave4_delivery_git.mjs`.
- Additional Rust native isolated Graph/SQLite and local bare-origin delivery tests, nonforce push/idempotency/approval and remote-escape denial (`native_sqlite_write_host.rs`, `native_daemon_binary_readonly.rs`), **PASS**.
- Ledger integrity: 230 source modules, **152 PASS / 74 PORTING / 4 EXCLUDED / 0 PENDING**. Static unmatched Runtime API names are zero **within the PORTING audit scope**, not blanket behavior equivalence.

After source edits that did not change Node/TypeScript production code, **no standalone Node full-test suite was run**. Direct Node/Rust behavioral differentials use Node only as the original reference implementation.

- Original Node/Rust remote projection with isolated Git/bare origin, retry/lease/terminal and divergence outcomes: **17/17**; `head_to_head_remote_projection.mjs`, production-bound to the native daemon.
- Runtime model event behavior: original Node/Rust Reconciler direct differential **PASS**, Rust all targets **PASS**, isolated model-start/progress/terminal plus replay/collision/Git-fencing tests **PASS**. No real external model/provider was called.
- Isolated ChatGPT native daemon and owned fake WebHelm Unix IPC: `native_chatgpt_webhelm_submission.rs` **3/3**, `native_daemon_binary_readonly.rs` E2E with exact committed model events, native all-target suite and original Node/Rust WebHelm/Browser Worker differential **PASS**. Production model HTTP and authenticated EventBus L4 remain unrun.

## Required gates before a production switch

1. **Worker adapters** — source-verified production launch of Codex, ChatGPT/WebHelm, and Z, exact execution-bound start/terminal events, browser lease release and restart recovery, owned process cancellation and no unverified success.
2. **Planning and Review** — concrete Planner model launch/apply, user review gate/preview and human approval, re-review after Git HEAD changes, Troubleshooter routing/fallback, all enforced by the canonical Graph.
3. **Job terminal & delivery** — native isolated Planned Job completion and verified source merge are done; remaining gate is complete Final Review/Job completion with real model Worker, server Dashboard action receipts, origin delivery under real deployment and multi-node restart.
4. **Production runtime** — service binding and install/publish/version synchronization, single-owner daemon startup, event transport, process group/provenance recovery, Dashboard/PWA and all CLI actions.
5. **Certification** — independently resolve or explicitly exclude the **74 remaining `PORTING`** modules with source-specific original Node/Rust differentials and actual production callers; run L1/L2/L3 plus separate real L4 provider E2E and cross-node acceptance. Avoid repeating the standalone Node full suite if only Rust changed.
6. **Cutover** — backup and restore proof on disposable but structurally equivalent SQLite data, reversible single-owner migration, offline/isolated rollout, live E2E evidence and explicit production approval before pushing/publishing/switching.

## Native isolated launch contract

Build the binaries with `cargo build --manifest-path rust/Cargo.toml --bin agents-relay-rust --bin agents-relayd-rust`.

The native daemon only accepts an explicit *isolated* directory: `--isolated-store-dir /absolute/temp/stores` for read-only, or `--isolated-write-store-dir /absolute/temp/stores` for isolated Graph/SQLite writes. For Script Workers, `AGENTS_RELAY_SCRIPT_NODE` must point to an existing absolute executable JS runtime. The CLI uses `--port <isolated-port>` to reach this daemon; never point an untested native runtime at the production store. The daemon status intentionally advertises `productionReady:false` until the above gates pass.

All test Git roots, SQLite files, Script Agent modules, and listening ports were created under disposable local fixtures. No remote push, package publication, service restart or live production cutover was performed.
