## 2026-11-20 final scope freeze: 213 PASS / 10 PORTING / 7 EXCLUDED

- Latest Dashboard static HTTP parity fixes: new rust/tests/head_to_head_dashboard_static_http.mjs verifies 55/55 real original Node HTTP responses against Rust compiled static PWA response status, headers and body SHA256. Fixed exact /dashboard-config.js, method-insensitive exact /api/version, and WHATWG URL path normalization. This does not certify full Dashboard backend or production SSE.
- STOP expanding parity matrices without a concrete production blocker. Focus only on remaining runtime-critical provider/daemon/foreground, authenticated EventBus/Host delivery, real WebHelm and HTTP/SSE integration. Ten modules remain PORTING; all other counts unchanged. Do not claim live Node-to-Rust cutover, remote push or full all-target verification for this change.
- Repository /Users/chengli/Workspace/agents-relay, branch rust2; prior commits e1bd6ca interactive Host, 3a8107f Host receipt, 05ecc59 Store fixes, c87f80b Planner. This tranche uses isolated fixture HTTP, no external provider.

## 2026-11-20 newest: Interactive Host one-shot approval certified, 213 / 10 / 7

- Existing rust2 checkout. src/interactive-invocation.ts certified PASS. The native HostInteractiveInvocationCoordinator.bind_with_waiter provides a one-shot accepted-decision receiver equivalent to Node bind(...).decision Promise, with original 60-second deadline from bind and exact generation cleanup. An older timed-out receiver cannot evict a rebound waiter; close/timeout never fabricate approval. Accepted record includes immutable Job/Task/Execution/Invocation/Revision, decision, feedback/comments and original event, delivered ONLY AFTER Graph-authorized HostInvocationPorts SQLite fingerprint/receipt commit. ReconcilerRuntimeBase exposes bind_interactive_invocation_with_waiter after durable Task generation binding.
- Evidence: direct original Node/Rust 72 Host public event/normalizer/fingerprint/Graph/bind cases, 10 real SQLite Host Coordinator, 190 interactive resume, 17 RuntimeBase. Native 8 real SQLite/EventBus tests prove approved/changes_requested, forged/stale denial, accepted only once after commit, Task release, timeout, original event+comments, restart/no duplicate; three HostInvocationPorts tests include old-timeout/rebound generation race. Full focused Neo shell job b33adf9379308225 exited 0: 36 Rust tests across 5 targets and 4 Node test declarations, 0 failures. All user data/provider/logical authority is isolated.
- Certified only interactive-invocation.ts. Authenticated production Model/EventBus transport, actual model Worker continuation and daemon concurrency are still HOLD under reconciler-runtime.ts and relayd.ts; do not use injected test Host as proof of live delivery. Ledger **213 PASS / 10 PORTING / 7 EXCLUDED**. Full all-target post-tranche Rust regression NOT_RUN. No remote push, live deployment, real Codex or provider use.

## 2026-11-20 latest: Host interactive decision requires SQLite approval (remain 212 / 11 / 7)

- In rust/src/reconciler_runtime_base.rs, fixed a critical event-ingress issue: task.interactive_decision previously flowed through ReconcilerRuntime.apply_event which evaluated Graph but had NO durable HostInvocation SQLite decision receipt, and could falsely report accepted. New RuntimeBaseStore.apply_host_invocation_event port is mandatory for that event and defaults to explicit denial for unbound hosts. The isolated, injected SQLite Host implementation calls HostInteractiveInvocationCoordinator.apply_event to record immutable decision fingerprint/receipt atomically; only after commit does it emit task.interactive_decision.accepted and, when Graph selects wakeWorker, run interactive_resume::recover_interactive_decisions, committing actual Task release. No external authenticated transport is exposed or used.
- Tests: NEW rust/tests/head_to_head_interactive_invocation_public.mjs direct original Node/Rust 72 public Host events/normalizers/fingerprint/Graph recovery/bind candidate cases. Existing head_to_head_host_invocation_ports.mjs 10 real SQLite cases and head_to_head_reconciler_runtime_base.mjs 17 Node/Rust RuntimeBase cases pass. native_reconciler_runtime_base.rs 4 real SQLite+EventBus tests now cover approved and changes_requested, wrong source refusal, exactly one accepted event, duplicate and daemon-restart replay, real Graph QUEUED release. native_interactive_ports_closure.rs two cases independently pass.
- BOTH src/interactive-invocation.ts AND src/reconciler-runtime.ts intentionally remain PORTING because native bound Host still lacks Node-style 60s waiter/promise/callback semantics and authenticated production daemon EventBus/provider routing. The injected native fixture's SQLite receipt is real but is NOT proof of live approval transport. Current ledger remains **212 PASS / 11 PORTING / 7 EXCLUDED**.
- Prior Store fixes commit 05ecc59, Planner PASS c87f80b. No production push/cutover, no real model/provider invocations. Full Rust all-target final regression NOT_RUN after these changes. The latest focused regression output is /tmp/rust2-interactive-regression-rust.log and /tmp/rust2-interactive-regression-node.log.

## 2026-11-20 latest: SQLite Agent Registry and PR Head parity repairs (Store remains HOLD)

- Continuing in existing rust2 with no Codex CLI, Relay jobs, external provider, live SQLite, push or cutover. Store source of truth remains SQLite. Fixed rust/src/relay_store.rs parity bugs: save_agents([]) now persists agent_registry_observed_at even for zero rows, so confirmed empty != not queried; save_agents now uses normal INSERT in the same BEGIN IMMEDIATE transaction so duplicate Agent IDs abort/rollback (not upsert-silently-overwrite); load_pull_request_facts returns head:null when ref or SHA missing/empty, never a fake partial HEAD object.
- Evidence: NEW head_to_head_relay_store_agent_registry.mjs 11 direct original Node/Rust scoped and legacy SQLite fixtures / 89 API operations, including negative absent source registry, duplicate rollback, UNKNOWN/stale PR facts and repeated event dedupe. NEW native_relay_store_agent_registry.rs 2 real disk SQLite + daemon reopen cases. Prior facade closure 24 real SQLite scenarios / 528 operations, native_sqlite_write_host 16/16 and native_dashboard_task_actions_sqlite 16/16 all pass (Neo shell regression 31283a77f5d5cfe4; this ran before final PR Head patch, followed by a fresh direct Node/Rust PR Facts test and two native disk tests). Full final all-target regression NOT_RUN.
- src/relay-store.ts is still PORTING (remaining outbox/whole Store facade and reexport reviews not closed). No false PASS promotion: **212 PASS / 11 PORTING / 7 EXCLUDED**. Previous Planner runtime PASS and commit c87f80b remain unchanged.

## 2026-11-20 newest: Planner-runtime certified, Rust2 212 PASS / 11 PORTING / 7 EXCLUDED

- In existing rust2 worktree, bound automatic Graph-selected planner.launch and planner.recoverPending effects in rust/src/relayd_sqlite_write.rs to the SAME native_script_planner PlannerLaunchPorts/finishPlanner as manual job.plan. The owned local Script and exact Planner execution ID settle through Graph/SQLite; there is no second scheduler or Node/Codex subprocess. Native daemon restart recovers a pending Plan, never creates a second Plan after a satisfied objective, and fails closed for a missing trusted Script.
- Connected Planner Runtime cross-Job unblock registration in rust/src/native_script_planner.rs through existing Graph blocker dependency action and SQLite commit_blocker_recovery_pair (both independent local Git roots verified before write), with explicit requested repository/Job/Task identity. Reconciler's prepare_dependency_revisions now retries ONLY previously committed Plan pendingUnblocks; missing related Jobs retain pending, later registration triggers one atomic two-Job commit and ack; restart/duplicate retries cannot create a second relation. No external Model Provider or user live jobs touched.
- Planner-runtime certified as PASS based on direct original Node/Rust API (310 activation/error, 112 cross-Job unblock, 19 finishPlanner, 20 launchPlanExecution cases), plus 29 Rust native tests (16 daemon/SQLite, five real Script Planner including cross-Job, three unblock, three finish, two launch). The final focused batch exited 0 (Neo shell job b12c92e0036537c6: 29 Rust, 14 Node test declarations, 0 failures). Production real Model Planner and other daemon gates remain HOLD in planner.ts and relayd.ts.
- Separately, cli-artifact Rust draft-07 nested boolean schemas and items:false now match original Ajv; added 16 boolean/7 recursive local ref and JSON Pointer direct filesystem comparisons atop the existing 277. Do NOT mark cli-artifact PASS: nonstandard JS RegExp/invalid compiler error and full Ajv edge parity still remain.
- Current ledger 212 PASS / 11 PORTING / 7 EXCLUDED. All-target full regression after these latest changes and live Node-to-Rust cutover are NOT_RUN. Preserve test-only relay.sqlite triplet; no remote push or live deployment.

## 2026-11-20 latest: Troubleshooter fallback and real SQLite human notification

- After Rust2 adapter commit 761ae5c, bound both src/troubleshooter-fallback.ts public actions to native rust/src/reconciler.rs and rust/src/relayd.rs / rust/src/relayd_sqlite_write.rs. The Reconciler queues the Graph-authorized alternate-model retry before requesting the canonical task.escalate human gate. ReconcileHost and DaemonServices implement fail-closed escalation and notification ports. A browser submission or HTTP acknowledgment without verified ID cannot mark human delivery.
- Isolated native daemon test coverage now includes durable Graph/SQLite human escalation, original Node order suppressing false recovery.exhausted for human-escalated recovery, unique escalation ID under two concurrent daemon callers, restart idempotency, pending/no-channel durable observation and explicitly injected loopback trusted HTTP receipt + invalid-receipt backoff. The isolated host rejects non-loopback notifier URLs and NEVER reads user real environment credentials. Production external notifier configuration still belongs to HOLD src/relayd.ts.
- Evidence: head_to_head_wave2_review_effects.mjs six fallback cases; NEW head_to_head_troubleshooter_escalate_public.mjs twelve entire original Node/Rust escalation + mutated Job cases; original task-recovery 116 and notifier 56; native_dashboard_task_actions_sqlite.rs 12 Graph/SQLite/notification/concurrency tests, native_wave4_review_escalation.rs atomic outbox 3, native_reconciler_reconcile_public.rs seven. No real provider, Codex, Relay job or live SQLite. Ledger **211 PASS / 12 PORTING / 7 EXCLUDED**. Earlier historical sections below superseded.
- An all-target Rust regression was launched before final notifier changes (Neo job fcc4ff9ec70ffc22); rerun after the last modifications, do not claim full regression green unless final run exits 0.

## 2026-11-20 takeover from follow-up agent (newest update)

- Previous follow-up committed 11455e6 (daemon WorkerFailurePorts/start-ack and three modules) and 004f509 (Z adapter/OAuth), leaving 209 PASS / 14 PORTING / 7 EXCLUDED. Its uncommitted adapters.ts work was preserved and completed here, with no new worktrees or Relay jobs.
- Adapters: 57 direct Node/Rust public cases, 49 WebHelm owned-process preflight probes, 8 NEW original Node/Rust CodexAdapter.launch tests using only a fake owned executable, plus the existing 700+ Stage2 pool/adapter comparisons; native ChatGPT fake AF_UNIX pool/barrier tests (3), helper tests (6) and native facade tests (12). Fixed processExit terminationReason from null to leader-exit per original Node. No real Codex CLI or live ChatGPT invoked.
- Ledger **210 PASS / 13 PORTING / 7 EXCLUDED** after the adapter tranche. The remaining active runtime/daemon/foreground/planner modules are still HOLD; no artificial PASS promotion. Another agent's concurrent Rust all-targets run recorded a daemon startup-port timeout once under contention; rerunning that single native coordinator daemon E2E in isolation passed. Run a new full all-target regression before claiming all tests green.
- Earlier dated handoff sections below are history and carry superseded counts.

# Rust2 handoff — CURRENT authoritative status (2026-11-20)

**READ THIS FIRST:** Everything after the divider below is historical and its older PASS, PORTING, branch and merge remarks are superseded. The authoritative data is the current checklist and certification JSON.

## Pickup and exact state

- Checkout: /Users/chengli/Workspace/agents-relay. Active branch: rust2; latest completed implementation commit 153375e. Following the user-requested merge, local main should fast-forward to the *handoff commit* as well. Check both branch pointers. No push, deployment, live daemon restart or production Rust cutover is authorized.
- **NOT COMPLETE**: current 230-source migration ledger: **204 PASS, 19 PORTING, 7 EXCLUDED, 0 PENDING**. Separate original 107-file certifier: **82 PASS, 22 HOLD, 3 EXCLUDED**. No 0-PORTING claim.
- Latest full isolated regression: Neo job e6a6f6cf50b3f484 exited 0; npm build and prior Rust parity binaries built; **118 Rust target results, 532 tests passed, 0 failed**; selected direct original Node/Rust CLI, Dashboard and local-Git suites **143 passed, 0 failed**; checklist verification and diff check passed. Standalone full Node tests were not run. All tests used disposable local Git / SQLite fixtures and isolated AGENTS_RELAY_STORE_DIR, no real providers.
- Original main Dashboard PWA changes merged into rust2 at 99a3ce4 (main before merge b2481f9). Both Node and Rust serve *one* frontend directory dashboard/ with matching versioned asset URLs. Two stale Rust raw-template assertions were corrected in native_dashboard_api.rs and native_stage2_daemon_smoke.rs; focused and full tests passed.
- User explicitly instructed **skip all retired compatibility**. Original Node daemon hardcodes noGitHub=true and DisabledGitHubClient. Public CLI and Rust CLI reject --pr / --github-* / remote PR switches, including help; do not port these. Three in-source historical shims github-auth.ts, github-client.ts, projected-store.ts are **EXCLUDED**, not PASS, guarded by source invariants and original runtime test rust/tests/local_git_runtime_excludes_remote_github.mjs (2 passing). SQLite, canonical Graph, local Git, event bus, active adapters are still fully in-scope.
- Static API audit was regenerated/verified in this handoff after stale hash detection. It checks names only, not behavior. The old git stash named rust2-wip-cli-support-before-main-20261120 holds a safety copy already reapplied and committed: do not blindly apply it. The disposable untracked relay.sqlite* triplet was preserved under .git/rust2-quarantine/20261120-handoff/ (not committed); do not confuse it with the production SQLite store.

## Exactly 19 outstanding PORTING modules

1. src/adapters.ts — real native adapter execution, ack/terminal/cancel, production provider/Graph binding.
2. src/browser-worker-routing.ts — 3,192 Node/Rust candidates pass; bind pool-health reroute in actual WorkerFailurePorts daemon.
3. src/browser-worker-runtime.ts — complete WebHelm lease, probe, monitor, cancel, recovery, session quarantine and reconnect parity.
4. src/chatgpt-platform-fallback.ts — 4,661 Node/Rust cases pass; bind no-start fallback and quarantine to daemon and SQLite.
5. src/cli-artifact.ts — complete Ajv schema/reference/format and CLI negative Unicode/error parity.
6. src/cli-coordinator.ts — native job.run Graph/SQLite works; foreground/interrupt/provider lifecycle parity pending.
7. src/cli-foreground.ts — formatting tested only; full watch/poll/reconcile/SIGINT/SIGTERM/AbortSignal/cleanup unverified.
8. src/cli.ts — finish public CLI routing, error/exit behavior, active foreground and real daemon binding.
9. src/dashboard.ts — PWA and basic HTTP pass; remaining SSE/auth/versioned transport/error/lifecycle integration.
10. src/interactive-invocation.ts — real daemon host callback, Graph/SQLite acceptance, stale/dedupe/restart/resume.
11. src/planner-runtime.ts — native Planner runtime/children, Graph/outbox/restart orchestration.
12. src/planner.ts — complete native Planner effect protocols with owned script/provider-fake E2E.
13. src/reconciler-runtime.ts — production event ingress, worker start-ack, failure/terminal/cancel and restart.
14. src/relay-store.ts — complete active public SQLite durable-store facade, concurrency/rollback/outbox parity.
15. src/relayd.ts — end-to-end native daemon orchestration of all active modules, not just smoke tests.
16. src/troubleshooter-fallback.ts — original fallback state and human escalation delivery, concurrent/retry/rollback.
17. src/types.ts — 1,237 Node/Rust runtime cases pass; bind chatGptStartAckTimeoutMs in daemon for ChatGPT and Z.
18. src/z-adapter.ts — native Z credential/WebHelm transport/start-ack/cancel/quarantine E2E.
19. src/z-oauth.ts — production HTTPS/TLS/identity integration and safe failure handling; local fake HTTP flow passes.

## Concrete next-agent workflow

- Run neo bootstrap once, then AGENTS.md/DESIGN-PRINCIPLES.md. Inspect git status, git log, git branch -vv and git worktree list; develop on rust2, not on main. User will assign a replacement agent. Never use Codex CLI, Relay Jobs, live services or production SQLite during isolated certification.
- Prioritize the real daemon path: rust/src/relayd.rs, reconciler_runtime.rs, native_browser_execution.rs, worker_failure_orchestration.rs and WorkerFailurePorts. Native WebHelm submission and Graph terminal barrier exist, but Node start-ack policy is not yet fully production-bound. Task state must never be inferred from browser submission. Cover launch failure, duplicate/stale generation, timeouts, cancel, quarantine, restart and post-commit event/SQLite receipts.
- For each source, compare original Node public APIs with native Rust against identical independent fixtures; prove production native CLI/daemon bindings, Graph/SQLite side effects, negative + duplicate + restart. Only then change PORTING to PASS; do not reclassify missing live behavior as compatible or excluded.
- Repro checks: npm run build; node scripts/rust2-checklist-verify.mjs; node scripts/rust2-api-parity-audit.mjs --write; node scripts/rust2-api-parity-audit.mjs --check --json; with isolated AGENTS_RELAY_STORE_DIR and AGENTS_RELAY_SCRIPT_NODE set, cargo test --manifest-path rust/Cargo.toml --all-targets -- --test-threads=1; selected original Node/Rust H2H tests; git diff --check. Commit each verified tranche.
- User's acceptance remains **PORTING=0 AND real tests pass**, not just a count adjustment. Do not push/deploy without explicit authorization.

---

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

## Continuation: real daemon reconcile and public Job creation

- Daemon `job_action(reconcile)` now runs the **same Graph/SQLite Reconciler pass** as periodic Pool reconciliation using the shared `reconcile_one_daemon_job` in `rust/src/relayd.rs`. Explicit wake-only false receipts removed. 8 native Dashboard tests include actual Git HEAD durable CAS, post-restart no-duplicate pass and invalid action guards; daemon full Rust all-targets job `af809ee0b913f7e4` exited 0 (**527 passed, 0 failed**, 116 groups; Node/Rust CLI/Dashboard 6/6).
- `src/cli-job-create.ts` promoted to PASS **only after** a public original Node/Rust 25-scenario real Git/SQLite differential (`head_to_head_cli_job_create_sqlite.mjs`) plus production `workspace_control(job.create)` isolated native test. Fixed Rust description, raw persisted plans shape versus API response, malformed PR number and empty idempotency key. Actual isolated daemon now forbids out-of-fixture roots on Job creation. No live/remote effects.

- `service-external-actions.ts` promoted to PASS after previously missing public startServiceExternalActionFlusher timer/stop/error behavior was directly compared to original Node (7 timed cases), and a real local SQLite outbox was flushed exactly once through a fake GitHub effect by the native timer. No live provider. This helper has no active original Node caller, so there is no production caller contract to bind. Revised **200 PASS / 26 PORTING / 4 EXCLUDED**.

- `src/local-job-registry.ts` original two public functions verified on **live writable WAL + closed checkpointed offline SQLite without SHM/WAL**, and read-only DB/directory. Native production CLI `storeFor` now uses immutable-ID registry resolver factory and transfers its exact owned Store; 39 + offline direct Node/Rust cases and native 4/4 CLI tests passed. Ledger **201 PASS / 25 PORTING / 4 EXCLUDED**.

- `workflow/durable-transition.ts` public `apply/updateFact` direct original Node/Rust 20-case tests + native real SQLite 2/2 Graph/version/rollback/restart. The native production ingress already folds Graph/SQLite CAS into `ReconcilerRuntime.apply_event`/`apply_verified_worker_event`, rather than calling a second transition runtime. Certified PASS on equivalent owned production semantics. Ledger **202 PASS / 24 PORTING / 4 EXCLUDED**.

- `relayd-dashboard-actions.ts` full exported six-method factory passed original Node/Rust 49+8 cases; true native daemon `job_action` now start/reconcile/cancel with CAS/Graph, Task actions canonical, dashboard factory standalone SQLite included. Server helper certified PASS; authenticated transport and provider adapters remain HOLD in dashboard.ts/relayd.ts. Ledger **203 PASS / 23 PORTING / 4 EXCLUDED**.

## 2026-11-20 main merge and active-only CLI support

- Merged new main Dashboard PWA via merge commit 99a3ce4 (main b2481f9) preserving single dashboard/ frontend. Reconciled CSS/JS reader conflicts and corrected the stale sharedRoot test to assert the canonical removal. Node Dashboard 117/117 and native Dashboard PWA/API 8/8.
- Pre-existing CLI support dirty files were safely stashed and reapplied, no data lost.
- CLI support: caller explicitly instructed all compatibility code may be skipped. Retired --pr, --github, remote lifecycle, pullRequest, optionalLegacyPr and historical PR ID fences are not required porting parity. Native CLI now rejects those switches even with --help, tested by native_cli_binary.rs. Certified active-only public API across original Node/Rust local Git/ID, scoped SQLite, EventBus and real loopback HTTP, with failure paths. 204 PASS / 22 PORTING / 4 EXCLUDED. No deployment, main push or Relay jobs.

- All retired compatibility is explicitly skippable per user request. Three unused GitHub remote auth/provider/projection source modules moved from PORTING to **EXCLUDED**, NOT PASS: github-auth.ts, github-client.ts, projected-store.ts. Original Node daemon is hardcoded noGitHub=true, uses only DisabledGitHubClient; no active flusher. Original runtime negative tests and CLI rejection prove this. Canonical SQLite outbox, local Git merge and Graph remain IN-SCOPE. New ledger **204 PASS / 19 PORTING / 7 EXCLUDED**.
