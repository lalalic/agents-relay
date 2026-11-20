# Rust2 transfer to next agent — 2026-11-19

## Verified starting state

- Project: `/Users/chengli/Workspace/agents-relay`; authoritative branch: **`rust2`**.
- Prior implementation commit: **`1d67815`** (durable dependency revision/Graph/SQLite certification). This document is an additional docs-only handoff commit.
- Clean Git tree immediately before this handoff; `git worktree list` showed **one worktree** (the canonical checkout).
- Ledger: **230** tracked source files = **177 PASS / 49 PORTING / 4 EXCLUDED / 0 PENDING**; JSON certification subset: **58 PASS / 49 HOLD** of 107 originally uncertified.
- **Not merged into `main`**; at baseline `git rev-list --left-right --count main...rust2` returned `4 197` (main-only vs rust2-only). `rust2` had no upstream and no remote `origin/rust2` ref. No push, no deployment, no production Rust Relay cutover.
- Existing local `main` tracks `origin/main`. Do **not** interpret this as permission to merge or push.

## Scope and completion condition

Autonomously continue **real Rust2 port/certification until `PORTING=0`**, not by editing the ledger alone. Original source lives in `src/`, native port in `rust/src/`, Graph definitions in `workflow/`. Follow the repository's actual AGENTS.md and Neo bootstrap. Keep this work on canonical `rust2`, sequentially, and avoid unrelated repositories/behavior changes.

For each candidate: (1) read original public Node APIs and existing Rust implementation; (2) directly compare Node source against native Rust with positive/negative original-runtime cases (not duplicate expected results); (3) wire the **actual** production native CLI/daemon/Graph/SQLite path, fail closed for unavailable providers; (4) run focused native E2E, real isolated daemon/process/Git/restart/side-effect barriers when applicable; (5) update all certification and checklist records with exact evidence; (6) run audits and tests; (7) commit the verified change to `rust2`, leaving tree clean. Never silently waive a test or manufacture PASS evidence.

User workflow: **hotfix / no Relay job** — execute directly, self-review, verify E2E, provide evidence, commit and clean. Do **not** run the separate standalone Node test suite; do run necessary original Node/Rust differential tests and native Rust tests. Do not start child threads. **No push, merge to main, live/prod cutover, real provider/external OAuth call or production SQLite writes** without explicit later authorization.

## Last verified work

- `eac9ac5`: certified execution context, Reconciler context, CLI prompt read-only parity and ScriptTaskAdapter. Important: native Script Task pre-start failures map to canonical Graph `worker.delivery_failed` with exact execution ID; do not fabricate a started event.
- `1d67815`: certified `src/dependency-revision-execution.ts`: **540 original Node/Rust public differential cases**, SQLite-backed real global numeric child ID allocation, actual owned JS Shortcut task, terminal Graph/SQLite and daemon restart no duplicate. Removed Reconciler's empty-reserved-ID lost-task path. Focused tests: `native_all_api_sqlite_entrypoints.rs` 6/6, `native_daemon_binary_readonly.rs` 19/19, `cargo test --lib` 87/87.
- 19-test daemon E2E has intermittently failed its isolated fake WebHelm **startup/submission timing**; single-test isolated runs and the full 19-test suite have passed. Keep a reproducible, genuine fail explanation; do not paper over if it recurs. Fake WebHelm uses test-owned AF_UNIX socket only.
- All-target Rust test run at `/tmp/r2-eac9ac5-alltargets.log` showed no recorded failed tests; the remote background job status was not conclusively acknowledged as finished when preparing handoff. **Rerun and verify exit code** before final cross-module promotion/merge.

## Certifier files and commands

- `docs/RUST2_HEAD_TO_HEAD_CHECKLIST.md` (all 230), `docs/RUST2_PORTING_CERTIFICATION_20261118.json` and `.md` (107 originally pending), `docs/RUST2_NATIVE_RUNTIME_READINESS_20261118.md`, `docs/RUST2_API_PARITY_MATRIX.json`, `docs/RUST2_API_PARITY_AUDIT.md`.
- `node scripts/rust2-checklist-verify.mjs` (currently PASS=177, PORTING=49, EXCLUDED=4)
- `node scripts/rust2-api-parity-audit.mjs --write` then `node scripts/rust2-api-parity-audit.mjs --check --json`
- `AGENTS_RELAY_SCRIPT_NODE=$(command -v node) cargo test --manifest-path rust/Cargo.toml --all-targets -- --test-threads=1` using **isolated `AGENTS_RELAY_STORE_DIR=$(mktemp -d ...)`**. Be mindful this is long and macOS scheduling/transport tests may fluctuate.
- `git diff --check && git status --short --branch && git log -4 --oneline`.
- Check pre-existing fixture leftovers `relay.sqlite*` before deleting anything; quarantine unknown untracked local database instead of deleting it.

## Remaining 49 HOLD modules, exact ledger order

- `src/adapters.ts` → `rust/src/adapters.rs`
- `src/blocker-recovery.ts` → `rust/src/blocker_recovery.rs`
- `src/browser-worker-routing.ts` → `rust/src/browser_worker_routing.rs`
- `src/browser-worker-runtime.ts` → `rust/src/browser_worker_runtime.rs`
- `src/chatgpt-platform-fallback.ts` → `rust/src/chatgpt_platform_fallback.rs`
- `src/cli-artifact.ts` → `rust/src/cli_artifact.rs`
- `src/cli-coordinator.ts` → `rust/src/cli_coordinator.rs`
- `src/cli-foreground.ts` → `rust/src/cli_foreground.rs`
- `src/cli-job-create.ts` → `rust/src/cli_job_create.rs`
- `src/cli-support.ts` → `rust/src/cli_support.rs`
- `src/cli.ts` → `rust/src/cli.rs`
- `src/dag-task-runtime.ts` → `rust/src/dag_task_runtime.rs`
- `src/dashboard-actions.ts` → `rust/src/dashboard_actions.rs`
- `src/dashboard.ts` → `rust/src/dashboard.rs`
- `src/decision-audit.ts` → `rust/src/decision_audit.rs`
- `src/escalation-notifier.ts` → `rust/src/escalation_notifier.rs`
- `src/events.ts` → `rust/src/events.rs`
- `src/feedback.ts` → `rust/src/feedback.rs`
- `src/github-auth.ts` → `rust/src/github_auth.rs`
- `src/github-client.ts` → `rust/src/github_client.rs`
- `src/interactive-invocation.ts` → `rust/src/interactive_invocation.rs`
- `src/interactive-resume.ts` → `rust/src/interactive_resume.rs`
- `src/job-worktree-cleanup.ts` → `rust/src/job_worktree_cleanup.rs`
- `src/legacy-orchestrator-repair.ts` → `rust/src/legacy_orchestrator_repair.rs`
- `src/local-job-registry.ts` → `rust/src/local_job_registry.rs`
- `src/local-managed-store.ts` → `rust/src/local_managed_store.rs`
- `src/model-redecision.ts` → `rust/src/model_redecision.rs`
- `src/outcome-review.ts` → `rust/src/outcome_review.rs`
- `src/planner-child-recovery.ts` → `rust/src/planner_child_recovery.rs`
- `src/planner-runtime.ts` → `rust/src/planner_runtime.rs`
- `src/planner.ts` → `rust/src/planner.rs`
- `src/projected-store.ts` → `rust/src/projected_store.rs`
- `src/reconciler-runtime.ts` → `rust/src/reconciler_runtime.rs`
- `src/relay-store.ts` → `rust/src/relay_store.rs`
- `src/relayd-dashboard-actions.ts` → `rust/src/relayd_dashboard_actions.rs`
- `src/relayd.ts` → `rust/src/relayd.rs`
- `src/router-evals.ts` → `rust/src/router_evals.rs`
- `src/service-external-actions.ts` → `rust/src/service_external_actions.rs`
- `src/single-job-task-control.ts` → `rust/src/single_job_task_control.rs`
- `src/store-github.ts` → `rust/src/store_github.rs`
- `src/store.ts` → `rust/src/store.rs`
- `src/task-actions.ts` → `rust/src/task_actions.rs`
- `src/troubleshooter-fallback.ts` → `rust/src/troubleshooter_fallback.rs`
- `src/types.ts` → `rust/src/types.rs`
- `src/usage.ts` → `rust/src/usage.rs`
- `src/workflow/durable-transition.ts` → `rust/src/workflow/durable_transition.rs`
- `src/workspace.ts` → `rust/src/workspace.rs`
- `src/z-adapter.ts` → `rust/src/z_adapter.rs`
- `src/z-oauth.ts` → `rust/src/z_oauth.rs`

## Suggested next picks

`src/browser-worker-routing.ts` and `src/chatgpt-platform-fallback.ts` are still HOLD. They involve routing and provider health: their existing Rust interfaces do **not** necessarily match the original Node adapters/registered/usage inputs and their Graph-run-time binding is not proven. Do not simply mark them PASS. Another opportunity is `src/escalation-notifier.ts`: native HTTP/SQLite functions exist but provider delivery with verified receipts and in-daemon calling must be proven without network production use. Larger integration gaps: `src/relayd.ts`, `src/reconciler-runtime.ts`, `src/adapters.ts`, `src/cli.ts`, `src/planner.ts`.

## Handoff acceptance

New agent should begin by running `git status --short --branch`, inspecting `git log -3 --oneline`, `node scripts/rust2-checklist-verify.mjs`, and verifying no other checkout currently edits this branch. It should end each tranche with an updated ledger, trustworthy exact test evidence, one local commit, and clean tree. Progress to 0 requires real certification and integration, not reclassification.


## 2026-11-19 hotfix continuation: isolated native Blocker and Dashboard Task writes

- Branch `rust2`, unchanged production authority; no Relay job, no Codex CLI, no deployment or GitHub side effects. Only one registered Git worktree (`~/Workspace/agents-relay`). Preserve all preexisting dirty work.
- Blocker Recovery: `rust/src/relayd_sqlite_write.rs::blocker_ensure` now does real canonical Graph planning and binds `SQLiteRelayStore::commit_blocker_recovery_pair` (single `BEGIN IMMEDIATE`, per-Job exact CAS, both-direction durable registration, rollback). `rust/tests/native_blocker_recovery_host.rs`: 3 real isolated Git/SQLite tests; `rust/tests/head_to_head_blocker_recovery_host.mjs`: 2 direct ORIGINAL Node vs Rust isolated SQLite tests. Node does not persist dependent `blockedBy` on this fixture; native stores it atomically with the blocker inverse relation.
- Dashboard Task API: `DaemonServices::task_command`, `task_action`, `task_set_state` route Task create/update/retry/cancel/forced-cancel through existing canonical Graph reducers and SQLite; check projectRoot against disposable Git fixture. Task-create has global numeric ID and idempotency receipt; Task-update has `updatedAt` optimistic CAS. `rust/tests/native_dashboard_task_actions_sqlite.rs`: 5 real isolated SQLite tests; `rust/tests/head_to_head_dashboard_task_commands_sqlite.mjs`: 2 original Node vs Rust SQLite differentials covering positive, idempotency, conflicts, stale version, self dependency. `job_action` remains denied, so entire Dashboard/relayd modules stay PORTING/HOLD.
- Batch A original Node `flushServiceExternalActions` positive path now directly tested with `LocalAuthorityDurableStore` prototype (injected projection and reconciler ports) against Rust. `scripts/rust2-checklist-verify.mjs` now correctly resolves true public `pub use` Rust exports, validating target declarations. `native_coordinator_cli.rs` call signature fixed.
- Required final verification after this patch: `npm run build`, `cargo build --manifest-path rust/Cargo.toml --bin relay-rust2-parity`, isolated `cargo test --all-targets`, direct Node/Rust suites listed above and `node scripts/rust2-checklist-verify.mjs`, `git diff --check`. At the time this handoff section was written, source checklist remains `201 PASS / 25 PORTING / 4 EXCLUDED` and original 107-module certification `79 PASS / 28 HOLD`; these remain true blockers, NOT completed `PORTING=0`.
- Next priority: bind native daemon `job_action` (currently explicit deny), live Reconciler/CLI --foreground provider start/ack timeout paths, browser-worker reroute consumer, GitHub token provider, full dashboard/worker/browser external contract and negative/restart head-to-head. Never promote to PASS merely to reduce the count.


## 2026-11-19 continuation: final regression and scoped Dashboard Job actions

- Polled existing Neo shell job `02143c0f0927bc9f` before bootstrap, then ran `neo bootstrap`. The job terminated successfully (exit 0): Node build and Rust parity binary build, isolated Rust all-targets 116 target results / 524 passed / 0 failed, direct Node/Rust differential 7 passed / 0 failed, checklist and diff-check all passed. This run started **before** the scoped Job-action extension below and is not its full regression.
- Native isolated daemon `job_action` now supports **start/cancel** via canonical Job Graph mutations, SQLite CAS/transaction and a post-commit wake; the `reconcile` route remains explicitly denied until the real daemon Reconciler and provider effects are bound. This is partial integration only: `src/relayd.ts` and `src/relayd-dashboard-actions.ts` remain PORTING.
- `rust/tests/native_dashboard_task_actions_sqlite.rs` now has 7/7 focused tests including real isolated Git/SQLite Job cancel/start, rejection, restart, and durable state checks. Do not promote daemon or Dashboard module status without Node/Rust entrypoint differential and full Reconciler tests.
- Completion still **201 PASS / 25 PORTING / 4 EXCLUDED**; no main merge, push, live changes, or Relay job. Preserve accumulated dirty work until separately reviewed and committed.


## Certification correction: foreground must remain HOLD

- Review found an unjustified PASS for `src/cli-foreground.ts`: only `foregroundEventLine` was compared, while `runForegroundCoordinator` (the important public runtime) lacked original Node/Rust loop, watcher, interrupt and cleanup verification. Its source ledger and 107-module certification were corrected to PORTING/HOLD, not counted as completed.
- Revised tally after correction: **200 PASS / 26 PORTING / 4 EXCLUDED**, original 107 subset **78 PASS / 29 HOLD**. Static API matrix must be regenerated. This supersedes earlier 201/25 counters above.

- Also corrected premature `src/cli-job-create.ts` PASS: only validation-first direct differential was available, not the full persisted public Job creation API. Revised count **199 PASS / 27 PORTING / 4 EXCLUDED** (original 107 subset **77 PASS / 30 HOLD**). Supersedes the previous interim counts.

- Additional correction: `service-external-actions.ts` remains HOLD because only `flushServiceExternalActions` was directly compared; `startServiceExternalActionFlusher` tick, timer, stop and observability behaviors lack parity. Revised count **198 PASS / 28 PORTING / 4 EXCLUDED**, original subset **76 PASS / 31 HOLD**. Supersedes earlier interim counts.

## Post-change full verification and corrected ledger

- Neo shell regression job `1e6f5ba3d967c252` exited **0** after the Dashboard Job action change. With caller-owned temporary `AGENTS_RELAY_STORE_DIR` and Node Script interpreter: Rust all-targets **116 test-result groups, 526 passed, 0 failed**; direct original Node/Rust CLI/Dashboard suites **6 passed, 0 failed**. Includes native 7/7 Dashboard Task/Job SQLite tests. Node/Rust service differential and baseline suites were separately proven by prior `02143c0f0927bc9f` run (524 Rust cases + 7 direct Node/Rust tests, both green).
- API parity audit `--write` and `--check --json`, checklist verify and `git diff --check` passed after certification corrections. The final authoritative source tally is **198 PASS / 28 PORTING / 4 EXCLUDED**; the original 107-module certification is **76 PASS / 31 HOLD**. Prior higher counts in this handoff are historical and superseded.
- Preserve the HOLD gates for `cli-foreground`, `cli-job-create`, `service-external-actions`. They were initially promoted on subset tests only, then corrected after examining the full original public exports.
