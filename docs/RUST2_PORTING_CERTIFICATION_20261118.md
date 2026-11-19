# Rust2 原 107 个 PORTING 模块逐项认证（2026-11-18）

> 本表是逐文件的真实审计清单，不是所有模块均通过。**PASS** 需公开 API 原始 Node/Rust 直接差分、Rust 原生负面测试和实际生产调用绑定；只通过静态 API 名称匹配，不能晋级。**HOLD** 指存在尚未关闭的证据缺口，不等同于未实现。

- 原始检查范围：107 个源模块。已认证 **35 PASS**，保留 **72 HOLD/PORTING**。
- 本轮仅跑 Rust 原生测试与必要的 Node/Rust 差分；未重跑独立 Node 全量测试。
- 这份报告对应上次全量 Node/Rust 230/230 PASS 后的逐项认证。全量 230/230 不等于 107 个模块逐一通过。
- `directDiffTests` 与 `otherRustModuleReferences` 基于静态文本检索；测试文件出现导入或 Rust 源文件出现引用，仅说明有线索，不表示覆盖了每个公开 API 或进入生产。
- `typeOrShapeReviews` 是待审计结构标记，不代表发现了实际类型错误。

## 已认证为 PASS

### `src/review-replan.ts`
- All 3 public pure APIs directly matched original Node with negative durable Job/re-review cases in head_to_head_wave4_review_pure.mjs
- Rust native review_replan unit tests and canonical reconciler_review/pool/planner callers verified
- Redundant planner review-needs-replan implementation replaced by one shared source
- 直接差分：`rust/tests/head_to_head_wave2_review.mjs`, `rust/tests/head_to_head_wave3_review_model.mjs`, `rust/tests/head_to_head_wave4_review_pure.mjs`

### `src/workflow/planner-orchestration-v2.ts`
- Full public Graph registry and 500 job fact / 360 Graph decisions / 210 effect callbacks with original Node parity
- Native Graph runtime/action tests and production reconciler/pool uses the Rust facts and decision API
- 直接差分：`rust/tests/head_to_head_wave2_graph.mjs`, `rust/tests/head_to_head_wave3_graph.mjs`, `rust/tests/head_to_head_wave4_graph.mjs`

### `src/workflow/task-resolution.ts`
- 7 exported helper APIs across 160 randomized original Node/Rust fixture sets and 350 sync/async Graph effect traces
- Native Graph tests and production Task recovery, action, Planner and Troubleshooter callers verified
- 直接差分：`rust/tests/head_to_head_wave2_graph.mjs`, `rust/tests/head_to_head_wave3_graph.mjs`, `rust/tests/head_to_head_wave4_graph.mjs`

### `src/local-merge-delivery.ts`
- 20 组原始 Node/Rust 直接 Graph merge/COMPLETED 成功与拒绝差分，通过 `rust/tests/head_to_head_local_merge_completion.mjs`。
- 真实隔离 Git source → main merge、SQLite CAS、结果事件、重启幂等、无 Origin 跳过和本地 bare origin 非强制推送、拒绝外部远端，Rust 原生 E2E 通过。
- 正式服务调用绑定：`rust/src/relayd.rs` → `DaemonServices::reconcile_local_completion` → `rust/src/relayd_sqlite_write.rs`。真实模型、完整人工审核和跨节点 L4 仍未验收。

### `src/local-merge-projection.ts`
- 原 Node/Rust 远端投影的 17 个直接差分场景通过：普通成功、无 origin、失败重试门禁、过期 lease、已完成、远端冲突及有效隔离 bare origin。
- Rust 原生测试证明 SQLite Graph 幂等性、实际非强制推送、错误 SHA 和外部远端拒绝；正式 daemon 已接通 `effect.remoteDelivery`。真实生产远端与模型 L4 尚未验收。

## 2026-11-18 认证批次（严格逐模块）

本批只认证经过 Node 原始导出直接对照、Rust 原生负面/SQLite/Graph 测试和实际运行调用复核的模块。组合门禁是 71 个差分文件，115 PASS / 0 FAIL；Rust `cargo test --all-targets` PASS。未执行独立 Node 全量测试；真实多节点/模型 L4 未验收。

| 源模块 | 直接 Node/Rust 差分 | Rust 原生验证 | 生产调用 |
|---|---|---|---|
| `src/dag-result-contract.ts` | `head_to_head_wave4_delivery.mjs` | `native_wave4_delivery.rs` | `rust/src/reconciler_runtime.rs` |
| `src/review-revision-settlement.ts` | `head_to_head_wave2_review_effects.mjs` | `native_wave3_review_store.rs` | `rust/src/reconciler_review.rs` |
| `src/review-revision-stale.ts` | `head_to_head_wave2_review_effects.mjs` | `native_wave3_review_store.rs` | `rust/src/reconciler_review.rs` |
| `src/worker-failure-recovery.ts` | `head_to_head_worker_failure_orchestration.mjs` | `native_worker_failure_orchestration.rs` | `rust/src/worker_failure_orchestration.rs` |
| `src/reconcile-coordinator.ts` | `head_to_head_wave2_coordinator.mjs` | `native_wave2_reconcile_coordinator.rs` | `rust/src/reconciler_runtime_base.rs` |
| `src/task-inactivity-watchdog.ts` | `head_to_head_wave4_watchdog.mjs` | `native_worker_ack_watchdog_cancel.rs` | `rust/src/reconciler_runtime.rs` |
| `src/task-transitions.ts` | `head_to_head_wave2_graph.mjs` | `native_wave2_graph.rs` | `rust/src/task_actions.rs` |
| `src/owned-process.ts` | `head_to_head_process_browser_worker.mjs` | `native_owned_process_lifecycle.rs` | `rust/src/adapters.rs` |
| `src/local-git-merge.ts` | `head_to_head_wave4_delivery_git.mjs` | `native_sqlite_write_host.rs` | `rust/src/local_merge_delivery.rs` |
| `src/reconciler-review.ts` | `head_to_head_reconciler_review_base.mjs` | `native_reconciler_review_base.rs` | `rust/src/reconciler.rs` |
| `src/relayd-control.ts` | `head_to_head_workspace_control_factory.mjs` | `native_sqlite_write_host.rs` | `rust/src/relayd_sqlite_write.rs` |

## 2026-11-18 认证第二批（严格逐模块）

本批只认证经过 Node 原始导出直接对照、Rust 原生负面/SQLite/Graph 测试和实际运行调用复核的模块。组合门禁是 71 个差分文件，115 PASS / 0 FAIL；Rust `cargo test --all-targets` PASS。未执行独立 Node 全量测试；真实多节点/模型 L4 未验收。

| 源模块 | 直接 Node/Rust 差分 | Rust 原生验证 | 生产调用 |
|---|---|---|---|
| `src/browser-worker-pool.ts` | `head_to_head_process_browser_worker.mjs` | `native_browser_worker_pool.rs` | `rust/src/browser_worker_runtime.rs` |
| `src/continuation.ts` | `head_to_head_wave4_delivery.mjs` | `native_wave4_delivery.rs` | `rust/src/browser_worker_runtime.rs` |
| `src/decision.ts` | `head_to_head_wave2_decision.mjs` | `native_stage2_daemon_smoke.rs` | `rust/src/cli_runtime_public.rs` |
| `src/pool.ts` | `head_to_head_pool_public_lifecycle.mjs` | `native_pool_public_lifecycle.rs` | `rust/src/relayd.rs` |
| `src/reconciler.ts` | `head_to_head_reconciler_reconcile_public.mjs` | `native_reconciler_reconcile_public.rs` | `rust/src/relayd.rs` |
| `src/review-revision-execution.ts` | `head_to_head_wave4_review_revision.mjs` | `native_wave3_review_store.rs` | `rust/src/reconciler.rs` |
| `src/review-revision-model.ts` | `head_to_head_wave3_review_model.mjs` | `native_wave3_review_store.rs` | `rust/src/reconciler_review.rs` |
| `src/reviewer-thread.ts` | `head_to_head_wave4_review_pure.mjs` | `native_wave3_review_store.rs` | `rust/src/reconciler_review.rs` |
| `src/local-authority-store.ts` | `head_to_head_store_facade_closure.mjs` | `native_cross_job_blocker_store.rs` | `rust/src/cli_support.rs` |

## 2026-11-18 认证第三批（严格逐模块）

本批只认证经过 Node 原始导出直接对照、Rust 原生负面/SQLite/Graph 测试和实际运行调用复核的模块。组合门禁是 71 个差分文件，115 PASS / 0 FAIL；Rust `cargo test --all-targets` PASS。未执行独立 Node 全量测试；真实多节点/模型 L4 未验收。

| 源模块 | 直接 Node/Rust 差分 | Rust 原生验证 | 生产调用 |
|---|---|---|---|
| `src/dashboard-data.ts` | `head_to_head_worker_c.mjs` | `native_stage2_dashboard.rs` | `rust/src/dashboard_api.rs` |
| `src/projection-outbox.ts` | `head_to_head_projection_outbox_strict.mjs` | `native_graph_outbox_batch.rs` | `rust/src/relay_store.rs` |

## 2026-11-18 认证第四批（严格逐模块）

本批只认证经过 Node 原始导出直接对照、Rust 原生负面/SQLite/Graph 测试和实际运行调用复核的模块。组合门禁是 71 个差分文件，115 PASS / 0 FAIL；Rust `cargo test --all-targets` PASS。未执行独立 Node 全量测试；真实多节点/模型 L4 未验收。

| 源模块 | 直接 Node/Rust 差分 | Rust 原生验证 | 生产调用 |
|---|---|---|---|
| `src/force-restate-validation.ts` | `head_to_head_force_restate_validation_public.mjs` | `native_planner_finish_public.rs` | `rust/src/planner_runtime_public.rs` |

## 2026-11-18 逐项证据补充

- `src/worker-routing.ts` — 原始 Node 差分 `rust/tests/head_to_head_worker_routing_public.mjs`；Rust 原生 `rust/tests/native_model_redecision.rs`；生产调用 `rust/src/model_routing.rs`；148 direct original Node/Rust worker defaults/quota/discovery/capability/eligibility/selection fixtures, plus 105 public Worker/Model/Execution routing hard-gate cases; Rust native model and Browser Pool integration。

- `src/cli-worker-task.ts` — 原始 Node 差分 `rust/tests/head_to_head_cli_worker_task_public.mjs`；Rust 原生 `rust/tests/native_cli_binary.rs`；生产调用 `rust/src/cli.rs`；44 exact original Node/Rust public recovery diagnosis, dependency validity and Task creation test fixtures; fixed Rust omission of undefined routing/requirements; native CLI and SQLite Graph tests pass。

- `src/model-routing.ts` — 原始 Node 差分 `rust/tests/head_to_head_model_routing_public.mjs`；Rust 原生 `rust/tests/native_model_redecision.rs`；生产调用 `rust/src/model_redecision.rs`；4 public API exports: 36 exact Node/Rust choice/default/profile/catalog discovery and 30 routeModel hard-gate fixtures; Rust native reroute, exclusions, failure/restart; routes called by production model_redecision and execution_routing。

- `src/unblock.ts` — 原始 Node 差分 `rust/tests/head_to_head_unblock_facts.mjs`；Rust 原生 `rust/tests/native_cli_unblock.rs`；生产调用 `rust/src/relayd_control.rs`；3 pure helpers across 120 original Node/Rust cases plus actual durable unblockTask through head_to_head_atomic_public_apis.mjs; native SQLite Graph no false human unblock and no duplicate retries。

- `src/troubleshooter.ts` — 原始 Node 差分 `rust/tests/head_to_head_troubleshooter_public.mjs`；Rust 原生 `rust/tests/native_reconciler_reconcile_public.rs`；生产调用 `rust/src/reconciler.rs`；35 original Node/Rust cases exercise all 6 public APIs, global numeric SQLite Task allocation, Graph-generated recovery, retries/reopens/exhausted and immutable recovery metadata; native Reconciler and Graph regression。

- `src/relay-store-discovery.ts` — 原始 Node 差分 `rust/tests/head_to_head_relay_store_discovery_public.mjs`；Rust 原生 `rust/tests/native_unified_job_registry.rs`；生产调用 `rust/src/local_job_registry.rs`；19 exact original Node/Rust read-only SQLite inventory, immutable Job scope, legacy-DB refusal and ambiguous binding cases; native unified registry/restart verification。

- `src/job-actions.ts` — 原始 Node 差分 `rust/tests/head_to_head_job_actions_public.mjs`；Rust 原生 `rust/tests/native_reconciler_plan_job.rs`；生产调用 `rust/src/dashboard_actions.rs`；144 original Node/Rust Graph activate/cancel Task/Plan mutation/failure cases, with two durable public action IDs。

## 已有局部验证、但不能升级的关键模块

- **`src/cli-coordinator.ts`**：11 个真实 Git/SQLite Head-to-Head 场景及 4 个 Rust 原生测试已通过，但 run_coordinator_job_command 只发现 parity harness 引用，正式 CLI 生产分发尚未直接绑定本端口
- **`src/cli-unblock.ts`**：直接 Task/Job Graph+SQLite 负面/重放测试已通过，但 run_task_unblock_command/run_job_unblock_command 目前仅由 parity harness 和测试调用，正式 CLI 生产调用链待闭合
- **`src/route-outcome-recording.ts`**：JSONL、审计分类与追加失败的原生测试通过，但正式 Runtime 目前仅直接使用 classify_routing_failure，terminal/launch/watchdog 审计写入没有生产调用证据
- **`src/model-redecision.ts`**：redecide_failed_task 目前只发现 parity harness 引用，缺实际 Worker 恢复执行入口与提交/回滚的原生证据
- **`src/relayd-main.ts`**：此模块没有可枚举 Runtime API：零静态未匹配名称不是守护进程启动和恢复等价证据，必须做真实进程启动/退出/重启门禁
- **`src/relayd.ts`**：公开 daemon 运行入口没有直接差分测试，必须验证 CLI、SQLite/NATS、Dashboard、重启及 Graph 生产调用一致
- **`src/script-task-adapter.ts`**：缺独立公开 API 差分和生产 Rust 调用引用；需要真实 Script Worker 子进程、回执、终止/超时、结果持久化门禁
- **`src/browser-worker-runtime.ts`**：缺独立原 Node/Rust 动态/失联 WebHelm 会话租约验证；不能把 Pool mock 看作实际 Provider 生命周期
- **`src/interactive-resume.ts`**：缺直接复审/恢复差分及真实执行调用；必须保护 human approval、过期回执、重启幂等
- **`src/github-client.ts`**：10 个运行导出、没有直接差分或 Rust 调用引用；如属显式淘汰 API，应经契约核准标为 EXCLUDED，不能默认为 PASS
- **`src/projection-outbox.ts`**：独立 canonical strict SQLite 差分覆盖排队、优先级、回执、回滚与升级，但仍需验证 25 公开接口的实际生产调用及历史共享 C 工作树的 provenance 隔离
- **`src/dashboard.ts`**：Rust Dashboard 服务/静态资源存在，但缺完整服务器入口的 Node/Rust 差分与真实浏览器/API/restart 验证，不能以 DOM/CSS 字节匹配认证整个服务

## 全部 107 个模块逐项核对

| # | Node 源模块 | 状态 | API | 直接差分引用 | Rust 引用 | 类型/形状审查 | 尚缺证据 |
|---:|---|---|---:|---:|---:|---:|---|
| 1 | `src/adapters.ts` | **HOLD** | 12 | 2 | 4 | 14 | 结构审核、模块特定场景／生产门禁 |
| 2 | `src/blocker-recovery.ts` | **HOLD** | 1 | 0 | 0 | 1 | 直接差分、运行调用、结构审核、模块特定场景／生产门禁 |
| 3 | `src/blockers.ts` | **HOLD** | 2 | 0 | 3 | 2 | 直接差分、结构审核、模块特定场景／生产门禁 |
| 4 | `src/browser-worker-pool.ts` | **PASS** | 15 | 1 | 3 | 3 | 直接差分、原生和生产调用证据已关闭 |
| 5 | `src/browser-worker-routing.ts` | **HOLD** | 1 | 0 | 0 | 0 | 直接差分、运行调用、模块特定场景／生产门禁 |
| 6 | `src/browser-worker-runtime.ts` | **HOLD** | 2 | 0 | 1 | 3 | 直接差分、结构审核、模块特定场景／生产门禁 |
| 7 | `src/chatgpt-platform-fallback.ts` | **HOLD** | 5 | 0 | 1 | 0 | 直接差分、模块特定场景／生产门禁 |
| 8 | `src/cli-artifact.ts` | **HOLD** | 2 | 4 | 1 | 0 | 模块特定场景／生产门禁 |
| 9 | `src/cli-coordinator.ts` | **HOLD** | 1 | 1 | 1 | 0 | 模块特定场景／生产门禁 |
| 10 | `src/cli-escalation.ts` | **HOLD** | 4 | 1 | 1 | 0 | 模块特定场景／生产门禁 |
| 11 | `src/cli-foreground.ts` | **HOLD** | 2 | 0 | 0 | 0 | 直接差分、运行调用、模块特定场景／生产门禁 |
| 12 | `src/cli-job-create.ts` | **HOLD** | 1 | 0 | 1 | 0 | 直接差分、模块特定场景／生产门禁 |
| 13 | `src/cli-prompt.ts` | **HOLD** | 5 | 0 | 0 | 0 | 直接差分、运行调用、模块特定场景／生产门禁 |
| 14 | `src/cli-review.ts` | **HOLD** | 3 | 1 | 1 | 0 | 模块特定场景／生产门禁 |
| 15 | `src/cli-support.ts` | **HOLD** | 38 | 4 | 5 | 2 | 结构审核、模块特定场景／生产门禁 |
| 16 | `src/cli-unblock.ts` | **HOLD** | 2 | 1 | 1 | 0 | 模块特定场景／生产门禁 |
| 17 | `src/cli-worker-task.ts` | **PASS** | 3 | 0 | 1 | 0 | 直接差分、模块特定场景／生产门禁 |
| 18 | `src/cli.ts` | **HOLD** | 6 | 3 | 3 | 9 | 结构审核、模块特定场景／生产门禁 |
| 19 | `src/continuation.ts` | **PASS** | 7 | 1 | 11 | 4 | 直接差分、原生和生产调用证据已关闭 |
| 20 | `src/dag-result-contract.ts` | **PASS** | 1 | 1 | 3 | 0 | 直接差分、原生和生产调用证据已关闭 |
| 21 | `src/dag-task-runtime.ts` | **HOLD** | 5 | 0 | 2 | 2 | 直接差分、结构审核、模块特定场景／生产门禁 |
| 22 | `src/dashboard-actions.ts` | **HOLD** | 3 | 0 | 1 | 0 | 直接差分、模块特定场景／生产门禁 |
| 23 | `src/dashboard-data.ts` | **PASS** | 8 | 1 | 3 | 4 | 直接差分、原生和生产调用证据已关闭 |
| 24 | `src/dashboard.ts` | **HOLD** | 1 | 0 | 3 | 6 | 直接差分、结构审核、模块特定场景／生产门禁 |
| 25 | `src/decision-audit.ts` | **HOLD** | 13 | 1 | 1 | 5 | 结构审核、模块特定场景／生产门禁 |
| 26 | `src/decision.ts` | **PASS** | 11 | 2 | 2 | 12 | 直接差分、原生和生产调用证据已关闭 |
| 27 | `src/dependency-revision-execution.ts` | **HOLD** | 3 | 0 | 1 | 0 | 直接差分、模块特定场景／生产门禁 |
| 28 | `src/escalation-notifier.ts` | **HOLD** | 2 | 0 | 0 | 3 | 直接差分、运行调用、结构审核、模块特定场景／生产门禁 |
| 29 | `src/events.ts` | **HOLD** | 13 | 3 | 36 | 1 | 结构审核、模块特定场景／生产门禁 |
| 30 | `src/execution-context.ts` | **HOLD** | 6 | 1 | 0 | 10 | 运行调用、结构审核、模块特定场景／生产门禁 |
| 31 | `src/execution-process-tracker.ts` | **HOLD** | 2 | 0 | 0 | 0 | 直接差分、运行调用、模块特定场景／生产门禁 |
| 32 | `src/execution-recovery.ts` | **HOLD** | 2 | 0 | 1 | 1 | 直接差分、结构审核、模块特定场景／生产门禁 |
| 33 | `src/execution-routing.ts` | **HOLD** | 6 | 1 | 2 | 5 | 结构审核、模块特定场景／生产门禁 |
| 34 | `src/feedback.ts` | **HOLD** | 23 | 2 | 0 | 12 | 运行调用、结构审核、模块特定场景／生产门禁 |
| 35 | `src/force-restate-validation.ts` | **PASS** | 6 | 0 | 1 | 1 | 直接差分、结构审核、模块特定场景／生产门禁 |
| 36 | `src/force-restate.ts` | **HOLD** | 1 | 0 | 0 | 0 | 直接差分、运行调用、模块特定场景／生产门禁 |
| 37 | `src/github-auth.ts` | **HOLD** | 2 | 0 | 1 | 0 | 直接差分、模块特定场景／生产门禁 |
| 38 | `src/github-client.ts` | **HOLD** | 10 | 0 | 0 | 0 | 直接差分、运行调用、模块特定场景／生产门禁 |
| 39 | `src/interactive-invocation.ts` | **HOLD** | 12 | 1 | 5 | 12 | 结构审核、模块特定场景／生产门禁 |
| 40 | `src/interactive-request.ts` | **HOLD** | 5 | 1 | 2 | 0 | 模块特定场景／生产门禁 |
| 41 | `src/interactive-resume.ts` | **HOLD** | 2 | 0 | 0 | 0 | 直接差分、运行调用、模块特定场景／生产门禁 |
| 42 | `src/job-actions.ts` | **PASS** | 4 | 0 | 3 | 0 | 直接差分、模块特定场景／生产门禁 |
| 43 | `src/job-pause.ts` | **HOLD** | 2 | 0 | 0 | 0 | 直接差分、运行调用、模块特定场景／生产门禁 |
| 44 | `src/job-worktree-cleanup.ts` | **HOLD** | 1 | 0 | 1 | 0 | 直接差分、模块特定场景／生产门禁 |
| 45 | `src/legacy-orchestrator-repair.ts` | **HOLD** | 1 | 0 | 0 | 1 | 直接差分、运行调用、结构审核、模块特定场景／生产门禁 |
| 46 | `src/local-authority-store.ts` | **PASS** | 33 | 4 | 5 | 1 | 直接差分、原生和生产调用证据已关闭 |
| 47 | `src/local-git-merge.ts` | **PASS** | 6 | 1 | 5 | 1 | 直接差分、原生和生产调用证据已关闭 |
| 48 | `src/local-job-registry.ts` | **HOLD** | 2 | 0 | 1 | 0 | 直接差分、模块特定场景／生产门禁 |
| 49 | `src/local-managed-store.ts` | **HOLD** | 1 | 0 | 0 | 1 | 直接差分、运行调用、结构审核、模块特定场景／生产门禁 |
| 50 | `src/local-merge-delivery.ts` | **PASS** | 1 | 1 | 1 | 1 | 认证已完成 |
| 51 | `src/local-merge-projection.ts` | **PASS** | 1 | 1 | 2 | 0 | 认证已完成
| 52 | `src/managed-worker-input.ts` | **HOLD** | 1 | 0 | 1 | 0 | 直接差分、模块特定场景／生产门禁 |
| 53 | `src/manual-plan.ts` | **HOLD** | 1 | 0 | 1 | 0 | 直接差分、模块特定场景／生产门禁 |
| 54 | `src/model-redecision.ts` | **HOLD** | 2 | 1 | 1 | 3 | 结构审核、模块特定场景／生产门禁 |
| 55 | `src/model-routing.ts` | **PASS** | 4 | 1 | 4 | 3 | 结构审核、模块特定场景／生产门禁 |
| 56 | `src/outcome-review.ts` | **HOLD** | 5 | 2 | 2 | 2 | 结构审核、模块特定场景／生产门禁 |
| 57 | `src/owned-process.ts` | **PASS** | 5 | 1 | 19 | 1 | 直接差分、原生和生产调用证据已关闭 |
| 58 | `src/planner-child-recovery.ts` | **HOLD** | 1 | 0 | 0 | 0 | 直接差分、运行调用、模块特定场景／生产门禁 |
| 59 | `src/planner-runtime.ts` | **HOLD** | 7 | 4 | 5 | 2 | 结构审核、模块特定场景／生产门禁 |
| 60 | `src/planner.ts` | **HOLD** | 22 | 2 | 7 | 11 | 结构审核、模块特定场景／生产门禁 |
| 61 | `src/pool.ts` | **PASS** | 15 | 5 | 3 | 0 | 直接差分、原生和生产调用证据已关闭 |
| 62 | `src/projected-store.ts` | **HOLD** | 34 | 2 | 1 | 3 | 结构审核、模块特定场景／生产门禁 |
| 63 | `src/projection-outbox.ts` | **PASS** | 25 | 2 | 1 | 9 | 直接差分、原生和生产调用证据已关闭 |
| 64 | `src/reconcile-coordinator.ts` | **PASS** | 7 | 2 | 5 | 1 | 直接差分、原生和生产调用证据已关闭 |
| 65 | `src/reconciler-context.ts` | **HOLD** | 3 | 0 | 0 | 0 | 直接差分、运行调用、模块特定场景／生产门禁 |
| 66 | `src/reconciler-review.ts` | **PASS** | 1 | 1 | 3 | 0 | 直接差分、原生和生产调用证据已关闭 |
| 67 | `src/reconciler-runtime.ts` | **HOLD** | 10 | 2 | 3 | 4 | 结构审核、模块特定场景／生产门禁 |
| 68 | `src/reconciler.ts` | **PASS** | 8 | 6 | 6 | 3 | 直接差分、原生和生产调用证据已关闭 |
| 69 | `src/relay-store-discovery.ts` | **PASS** | 3 | 0 | 4 | 0 | 直接差分、模块特定场景／生产门禁 |
| 70 | `src/relay-store.ts` | **HOLD** | 46 | 8 | 20 | 17 | 结构审核、模块特定场景／生产门禁 |
| 71 | `src/relayd-control.ts` | **PASS** | 1 | 1 | 1 | 0 | 直接差分、原生和生产调用证据已关闭 |
| 72 | `src/relayd-dashboard-actions.ts` | **HOLD** | 1 | 1 | 1 | 0 | 模块特定场景／生产门禁 |
| 73 | `src/relayd-main.ts` | **HOLD** | 0 | 0 | 0 | 0 | 直接差分、运行调用、模块特定场景／生产门禁 |
| 74 | `src/relayd-utilities.ts` | **HOLD** | 10 | 1 | 2 | 2 | 结构审核、模块特定场景／生产门禁 |
| 75 | `src/relayd.ts` | **HOLD** | 1 | 0 | 2 | 7 | 直接差分、结构审核、模块特定场景／生产门禁 |
| 76 | `src/review-replan.ts` | **PASS** | 3 | 3 | 4 | 0 | 认证已完成 |
| 77 | `src/review-revision-execution.ts` | **PASS** | 3 | 3 | 2 | 0 | 直接差分、原生和生产调用证据已关闭 |
| 78 | `src/review-revision-model.ts` | **PASS** | 7 | 3 | 3 | 1 | 直接差分、原生和生产调用证据已关闭 |
| 79 | `src/review-revision-settlement.ts` | **PASS** | 1 | 1 | 3 | 0 | 直接差分、原生和生产调用证据已关闭 |
| 80 | `src/review-revision-stale.ts` | **PASS** | 1 | 1 | 2 | 0 | 直接差分、原生和生产调用证据已关闭 |
| 81 | `src/reviewer-thread.ts` | **PASS** | 9 | 2 | 6 | 1 | 直接差分、原生和生产调用证据已关闭 |
| 82 | `src/route-outcome-recording.ts` | **HOLD** | 5 | 1 | 2 | 1 | 结构审核、模块特定场景／生产门禁 |
| 83 | `src/router-evals.ts` | **HOLD** | 2 | 0 | 0 | 0 | 直接差分、运行调用、模块特定场景／生产门禁 |
| 84 | `src/script-task-adapter.ts` | **HOLD** | 3 | 0 | 0 | 3 | 直接差分、运行调用、结构审核、模块特定场景／生产门禁 |
| 85 | `src/service-external-actions.ts` | **HOLD** | 2 | 0 | 0 | 0 | 直接差分、运行调用、模块特定场景／生产门禁 |
| 86 | `src/single-job-task-control.ts` | **HOLD** | 1 | 0 | 0 | 0 | 直接差分、运行调用、模块特定场景／生产门禁 |
| 87 | `src/store-github.ts` | **HOLD** | 21 | 1 | 6 | 0 | 模块特定场景／生产门禁 |
| 88 | `src/store.ts` | **HOLD** | 22 | 8 | 4 | 16 | 结构审核、模块特定场景／生产门禁 |
| 89 | `src/task-actions.ts` | **HOLD** | 18 | 1 | 8 | 4 | 结构审核、模块特定场景／生产门禁 |
| 90 | `src/task-inactivity-watchdog.ts` | **PASS** | 6 | 3 | 2 | 0 | 直接差分、原生和生产调用证据已关闭 |
| 91 | `src/task-recovery.ts` | **HOLD** | 4 | 0 | 2 | 1 | 直接差分、结构审核、模块特定场景／生产门禁 |
| 92 | `src/task-transitions.ts` | **PASS** | 6 | 2 | 21 | 2 | 直接差分、原生和生产调用证据已关闭 |
| 93 | `src/task-update.ts` | **HOLD** | 2 | 1 | 1 | 0 | 模块特定场景／生产门禁 |
| 94 | `src/troubleshooter-fallback.ts` | **HOLD** | 2 | 1 | 1 | 0 | 模块特定场景／生产门禁 |
| 95 | `src/troubleshooter.ts` | **PASS** | 6 | 0 | 2 | 0 | 直接差分、模块特定场景／生产门禁 |
| 96 | `src/types.ts` | **HOLD** | 7 | 1 | 6 | 33 | 结构审核、模块特定场景／生产门禁 |
| 97 | `src/unblock.ts` | **PASS** | 4 | 1 | 4 | 1 | 结构审核、模块特定场景／生产门禁 |
| 98 | `src/usage.ts` | **HOLD** | 26 | 3 | 5 | 18 | 结构审核、模块特定场景／生产门禁 |
| 99 | `src/worker-failure-recovery.ts` | **PASS** | 1 | 1 | 2 | 1 | 直接差分、原生和生产调用证据已关闭 |
| 100 | `src/worker-routing.ts` | **PASS** | 8 | 1 | 4 | 4 | 结构审核、模块特定场景／生产门禁 |
| 101 | `src/workflow-effect-failures.ts` | **HOLD** | 2 | 0 | 0 | 0 | 直接差分、运行调用、模块特定场景／生产门禁 |
| 102 | `src/workflow/durable-transition.ts` | **HOLD** | 4 | 1 | 0 | 1 | 运行调用、结构审核、模块特定场景／生产门禁 |
| 103 | `src/workflow/planner-orchestration-v2.ts` | **PASS** | 4 | 3 | 3 | 1 | 认证已完成 |
| 104 | `src/workflow/task-resolution.ts` | **PASS** | 12 | 3 | 9 | 2 | 认证已完成 |
| 105 | `src/workspace.ts` | **HOLD** | 21 | 1 | 4 | 3 | 结构审核、模块特定场景／生产门禁 |
| 106 | `src/z-adapter.ts` | **HOLD** | 5 | 0 | 0 | 3 | 直接差分、运行调用、结构审核、模块特定场景／生产门禁 |
| 107 | `src/z-oauth.ts` | **HOLD** | 2 | 0 | 1 | 0 | 直接差分、模块特定场景／生产门禁 |

## 待证模块的具体旧清单缺口（逐项）

以下是原清单的模块特定未完事项，部分早期 “未编译/未测试” 文案已经过时，不能作为当前事实；具体缺口仍须由新测试/调用证据确认。

1. **`src/adapters.ts`** — 原记录：Phase1 serial native Worker adapter/Repository Pool draft; not compiled/tested, Stage2 parity/wiring pending.
   - 差分参考：`rust/tests/head_to_head_stage2_pool_adapters.mjs`, `rust/tests/head_to_head_webhelm_preflight.mjs`
   - 类型/形状需复核：`Execution`, `LaunchContext`, `CodexAdapter.name`, `CodexAdapter.id`, `CodexAdapter.capabilities`, `BrowserWorkerRequest`, `BrowserWorkerResponse`, `AgentRun`, `ChatGptAgentRunner`, `ChatGptAdapterOptions`, `ChatGptAdapter.name`, `ChatGptAdapter.id`, `ChatGptAdapter.capabilities`, `ChatGptAdapter.tabClosePolicy`

2. **`src/blocker-recovery.ts`** — 原记录：Phase1 serial authorized Blocker Graph recovery creation/adoption/dependency receipt native Rust draft; uncompiled/untested, cross-Job CAS Phase2.
   - 类型/形状需复核：`BlockerRecoveryInput`
   - 当前静态引用缺口：未发现其他 Rust 模块引用该模块

3. **`src/blockers.ts`** — 原记录：Serial Phase1 native Rust port for authoritative Graph/SQLite and guarded Git side effects. UNCOMPILED/UNTESTED, finish production bindings in Phase2.
   - 类型/形状需复核：`DependentStoreFactory`, `BlockerDependentTarget`

4. **`src/browser-worker-pool.ts`** — 原记录：Wave4 A: 48 concurrent disposable SQLite manager initializations with bounded SQLITE_BUSY/LOCKED retry; prior real FIFO/lease/quarantine and Graph branch tests pass. Production acquire/session/error mapping remains unverified (native_wave4_graph.rs; head_to_head_process_browser_worker.mjs).
   - 差分参考：`rust/tests/head_to_head_process_browser_worker.mjs`
   - 类型/形状需复核：`BrowserProvider`, `BrowserPoolState`, `BrowserPoolAdmissionError.submitted`

5. **`src/browser-worker-routing.ts`** — 原记录：Phase1 serial first native Rust draft; uncompiled and untested, production API/wiring still requires parity closure.
   - 当前静态引用缺口：未发现其他 Rust 模块引用该模块

6. **`src/browser-worker-runtime.ts`** — 原记录：Phase1 serial native WebHelm Browser Pool lease/session/probe/recovery first port; uncompiled/untested; end-to-end wiring Phase2.
   - 类型/形状需复核：`BrowserReceipt`, `PoolSubmission`, `PooledRun`

7. **`src/chatgpt-platform-fallback.ts`** — 原记录：Phase1 serial native Rust source port; uncompiled/unverified, production integration and head-to-head differential pending Phase2.

8. **`src/cli-artifact.ts`** — 原记录：Wave4 B: original Node/Ajv schema-compile errors, CLI output/error priority, UTF16 Unicode/unknown-format tests plus Wave3 277 filesystem comparisons. Recursive $ref, full Ajv dialect/format and CLI edge parity remain unverified (head_to_head_wave4_artifact.mjs; head_to_head_wave3_artifact.mjs).
   - 差分参考：`rust/tests/head_to_head_batch6.mjs`, `rust/tests/head_to_head_cli_core.mjs`, `rust/tests/head_to_head_wave3_artifact.mjs`, `rust/tests/head_to_head_wave4_artifact.mjs`

9. **`src/cli-coordinator.ts`** — 原记录：Phase1 serial first native Rust draft; uncompiled and untested; production API/wiring still requires parity closure.
   - 差分参考：`rust/tests/head_to_head_coordinator_cli.mjs`

10. **`src/cli-escalation.ts`** — 原记录：Phase1 serial first native Rust draft; uncompiled and untested; production API/wiring still requires parity closure.
   - 差分参考：`rust/tests/head_to_head_escalation_executor.mjs`

11. **`src/cli-foreground.ts`** — 原记录：Phase1 serial first native Rust draft; uncompiled and untested, production API/wiring still requires parity closure.
   - 当前静态引用缺口：未发现其他 Rust 模块引用该模块

12. **`src/cli-job-create.ts`** — 原记录：Serial Phase1 native SQLite Job creation and bounded/redacted JSONL routing audit port; uncompiled/untested, Stage2 bindings+differential pending.

13. **`src/cli-prompt.ts`** — 原记录：Phase1 serial native Rust Script Agent and read-only CLI Prompt port; uncompiled/untested, API integration Phase2.
   - 当前静态引用缺口：未发现其他 Rust 模块引用该模块

14. **`src/cli-review.ts`** — 原记录：Phase1 serial native Rust draft; uncompiled, untested and not production-wired; parity pending.
   - 差分参考：`rust/tests/head_to_head_cli_review.mjs`

15. **`src/cli-support.ts`** — 原记录：Phase1 native CLI immutable Job bindings, HTTP control, Git workspace identity/worktree port; no compilation/tests; Stage2 head-to-head pending.
   - 差分参考：`rust/tests/head_to_head_cli_support_closure.mjs`, `rust/tests/head_to_head_cli_support_public_api.mjs`, `rust/tests/head_to_head_cli_support_publish_closure.mjs`, `rust/tests/head_to_head_service_event_bus_closure.mjs`
   - 类型/形状需复核：`ServiceEventBus.constructor`, `EventBusResolution`

16. **`src/cli-unblock.ts`** — 原记录：Phase1 serial native Rust draft; uncompiled, untested and not production-wired; parity pending.
   - 差分参考：`rust/tests/head_to_head_cli_unblock.mjs`

17. **`src/cli-worker-task.ts`** — 原记录：Phase1 serial native Rust draft; uncompiled and untested, production API/binding and differential to close in Phase2.

18. **`src/cli.ts`** — 原记录：Phase1 serial Rust source first draft of Reconciler/daemon/Control/CLI; UNCOMPILED/UNTESTED, missing direct API wiring and parity must be repaired in Phase2. Dashboard browser client unchanged.
   - 差分参考：`rust/tests/head_to_head_cli_runtime_factory.mjs`, `rust/tests/head_to_head_cli_runtime_public.mjs`, `rust/tests/head_to_head_cli_service_public.mjs`
   - 类型/形状需复核：`dashboardJobSetState`, `dashboardTaskAction`, `dashboardTaskSetState`, `helpText`, `runtimeReviewer`, `SERVICE_DEFAULTS`, `eventBus`, `chatGptTabClosePolicy`, `ensureManagedGitHubJob`

19. **`src/continuation.ts`** — 原记录：Wave4 C: owned subprocess group with real pipe/exit/timeout/cancel effects and 125 randomized original Node/Rust command cases; prior local webhook POST. Exact ENOENT/error precedence and production caller remain unverified (head_to_head_wave4_delivery.mjs; native_wave4_delivery.rs).
   - 差分参考：`rust/tests/head_to_head_wave4_delivery.mjs`
   - 类型/形状需复核：`ContinuationAdapter`, `CodexThreadContinuation.kind`, `CommandContinuation.kind`, `WebhookContinuation.kind`

20. **`src/dag-result-contract.ts`** — 原记录：Wave4 C: 42 direct Node/Rust actual isolated stage verifier subprocess cases plus prior 105 file/rejection cases; native timeout/cancel. Abnormal signal/large output and Graph terminal caller binding remain unverified (head_to_head_wave4_delivery.mjs; native_wave4_delivery.rs).
   - 差分参考：`rust/tests/head_to_head_wave4_delivery.mjs`

21. **`src/dag-task-runtime.ts`** — 原记录：Phase1 serial native DAG Task projection and Troubleshooter recovery first port; uncompiled/unverified, production bindings Phase2.
   - 类型/形状需复核：`DAGChild`, `DAGCheckpoint`

22. **`src/dashboard-actions.ts`** — 原记录：Phase1 serial Rust SERVER-only source draft; uncompiled/unverified; preserve original Dashboard client HTML/CSS/JS.

23. **`src/dashboard-data.ts`** — 原记录：PROVENANCE QUARANTINE: prior Worker C used duplicate shared worktree; its source and differential output are not admissible PASS evidence. Pending independent canonical commit and direct Node/Rust/native verification from `hotfix/rust2-parallel-projection-canonical-20261117` and `/tmp/rust2-parallel-projection-canonical-20261117.handoff.md`. Existing Rust is retained for compatibility with later Wave2/3/4; not yet reverified.
   - 差分参考：`rust/tests/head_to_head_worker_c.mjs`
   - 类型/形状需复核：`DashboardWorkflowGraph`, `EffectiveGitHubUsage`, `DashboardJobLike`, `DashboardJobsSearchResult`

24. **`src/dashboard.ts`** — 原记录：PWA-preserving native Dashboard API integration: rust/src/dashboard.rs remains the shared PWA/SSE HTTP transport, rust/src/dashboard_api.rs provides injected Graph/SQLite API route mapping, webhook signature/durable-ack dedup and error paths. Native integration: rust/tests/native_dashboard_api.rs (3/3), native_dashboard_pwa.rs (4/4); Node dashboard 117/117; dashboard JEL/style/data differential 3/3. Production service callback binding, physical browser install, and full endpoint parity remain unverified; do NOT claim production-ready.
   - 类型/形状需复核：`dashboardWorkflowGraphs`, `githubPrUrl`, `searchDashboardJobs`, `dashboardHtml`, `dashboardVersion`, `dashboardSourceRevision`

25. **`src/decision-audit.ts`** — 原记录：Serial Phase1 native SQLite Job creation and bounded/redacted JSONL routing audit port; uncompiled/untested, Stage2 bindings+differential pending.
   - 差分参考：`rust/tests/head_to_head_wave4_delivery.mjs`
   - 类型/形状需复核：`AuditFailureEvidence`, `DecisionAuditRecord`, `DecisionOutcomeRecord`, `DecisionAuditStore`, `RouterRouteResult`

26. **`src/decision.ts`** — 原记录：Wave3 A real isolated Laya owned shell, stdout/stderr, timeout and prior 4401 decision cases pass; actual external decision service caller and complete error/export paths still unproven (head_to_head_wave3_graph.mjs).
   - 差分参考：`rust/tests/head_to_head_wave2_decision.mjs`, `rust/tests/head_to_head_wave3_graph.mjs`
   - 类型/形状需复核：`JsonValue`, `ChoiceDecisionContract`, `DecisionContract`, `DecisionRequest`, `ChoiceDecisionResult`, `DecisionResult`, `DecisionMode`, `DecisionEngine`, `DecisionEvidence`, `DecisionChoice`, `JevDecisionEngine.name`, `LayaCliDecisionEngine.name`

27. **`src/dependency-revision-execution.ts`** — 原记录：Phase1 serial native Rust source port; uncompiled/unverified, production integration and head-to-head differential pending Phase2.

28. **`src/escalation-notifier.ts`** — 原记录：Phase1 serial native Rust source port; uncompiled/unverified, production integration and head-to-head differential pending Phase2.
   - 类型/形状需复核：`EscalationNotification`, `NotificationReceipt`, `EscalationNotifier`
   - 当前静态引用缺口：未发现其他 Rust 模块引用该模块

29. **`src/events.ts`** — 原记录：PROVENANCE QUARANTINE: prior Worker C used duplicate shared worktree; its source and differential output are not admissible PASS evidence. Pending independent canonical commit and direct Node/Rust/native verification from `hotfix/rust2-parallel-projection-canonical-20261117` and `/tmp/rust2-parallel-projection-canonical-20261117.handoff.md`. Existing Rust is retained for compatibility with later Wave2/3/4; not yet reverified.
   - 差分参考：`rust/tests/head_to_head_cli_support_publish_closure.mjs`, `rust/tests/head_to_head_service_event_bus_closure.mjs`, `rust/tests/head_to_head_worker_c.mjs`
   - 类型/形状需复核：`EventBus`

30. **`src/execution-context.ts`** — 原记录：Serial Phase1 native interactive invocation Graph/Host and layered execution context port; uncompiled/untested, store integration Stage2.
   - 差分参考：`rust/tests/head_to_head_agent_graph.mjs`
   - 类型/形状需复核：`ExecutionRole`, `ContextSource`, `ResolvedInstruction`, `ResolvedSkill`, `ResolvedAgent`, `ResolvedRuntime`, `ExecutionContext`, `ProviderInstructions`, `ExecutionContextRoots`, `ExecutionContextOptions`
   - 当前静态引用缺口：未发现其他 Rust 模块引用该模块

31. **`src/execution-process-tracker.ts`** — 原记录：Phase1 serial first native Rust draft; uncompiled and untested; production API/wiring still requires parity closure.
   - 当前静态引用缺口：未发现其他 Rust 模块引用该模块

32. **`src/execution-recovery.ts`** — 原记录：Phase1 serial first native Rust draft; uncompiled and untested; production API/wiring still requires parity closure.
   - 类型/形状需复核：`ExecutionRecoveryPorts`

33. **`src/execution-routing.ts`** — 原记录：Serial Phase1 native Worker+Model routing policy, hard gates and source profile discovery port; uncompiled/unverified, decision audit/service binding Phase2.
   - 差分参考：`rust/tests/head_to_head_route_facades.mjs`
   - 类型/形状需复核：`ExecutionRouteCandidate`, `ExecutionRouteEvaluation`, `WorkerGateEvaluation`, `ExecutionRoutingDecision`, `ExecutionRoutingOptions`

34. **`src/feedback.ts`** — 原记录：PROVENANCE QUARANTINE: prior Worker C used duplicate shared worktree; its source and differential output are not admissible PASS evidence. Pending independent canonical commit and direct Node/Rust/native verification from `hotfix/rust2-parallel-projection-canonical-20261117` and `/tmp/rust2-parallel-projection-canonical-20261117.handoff.md`. Existing Rust is retained for compatibility with later Wave2/3/4; not yet reverified.
   - 差分参考：`rust/tests/head_to_head_worker_c.mjs`, `rust/tests/head_to_head_worker_c_feedback_store.mjs`
   - 类型/形状需复核：`FeedbackSource`, `FeedbackActorClass`, `FeedbackVisibility`, `FeedbackTriageStatus`, `FeedbackProvenance`, `LegacyFeedbackAttachmentInput`, `LegacyFeedbackSubmission`, `LegacyFeedbackRecord`, `FeedbackAttachment`, `FeedbackDownstreamReference`, `FeedbackRecord`, `FileFeedbackStore.root`
   - 当前静态引用缺口：未发现其他 Rust 模块引用该模块

35. **`src/force-restate-validation.ts`** — 原记录：Phase1 serial native Rust source port; uncompiled/unverified, production integration and head-to-head differential pending Phase2.
   - 类型/形状需复核：`HistoryValidation`

36. **`src/force-restate.ts`** — 原记录：Wave3 A retained tested forceRestate forwarding; actual manual plan apply/store/launch effects still require a Rust production binding (native_wave2_graph.rs).
   - 当前静态引用缺口：未发现其他 Rust 模块引用该模块

37. **`src/github-auth.ts`** — 原记录：Wave3 C 102 Node/Rust identity/probe cases with injected GhApiClient pass; real App Auth client, provider login probe and runtime factory not yet ported (head_to_head_wave3_delivery.mjs).

38. **`src/github-client.ts`** — 原记录：Phase1 native owned GitHub CLI transport and provider usage/capacity readers port; UNCOMPILED UNTESTED, runtime API/parity closure Phase2.
   - 当前静态引用缺口：未发现其他 Rust 模块引用该模块

39. **`src/interactive-invocation.ts`** — 原记录：Serial Phase1 native interactive invocation Graph/Host and layered execution context port; uncompiled/untested, store integration Stage2.
   - 差分参考：`rust/tests/head_to_head_host_invocation_ports.mjs`
   - 类型/形状需复核：`InteractiveDecision`, `InteractiveInvocationStatus`, `InteractiveInvocation`, `InteractiveDecisionDelivery`, `InteractiveDecisionOutcome`, `InteractiveDecisionResult`, `AcceptedInteractiveDecision`, `HostInvocationCoordinatorOptions`, `GenericInteractiveFeedback`, `HostInteractiveContext`, `HostInteractiveInvocationCoordinator.constructor`, `WorkerInteractiveContinuation`

40. **`src/interactive-request.ts`** — 原记录：Phase1 serial native Rust draft; uncompiled, untested and not production-wired; parity pending.
   - 差分参考：`rust/tests/head_to_head_atomic_public_apis.mjs`

41. **`src/interactive-resume.ts`** — 原记录：Phase1 serial native Rust draft; uncompiled, untested and not production-wired; parity pending.
   - 当前静态引用缺口：未发现其他 Rust 模块引用该模块

42. **`src/job-actions.ts`** — 原记录：Phase1 serial native Rust source port; uncompiled/unverified, production integration and head-to-head differential pending Phase2.

43. **`src/job-pause.ts`** — 原记录：Phase1 serial first native Rust draft; uncompiled and untested; production API/wiring still requires parity closure.
   - 当前静态引用缺口：未发现其他 Rust 模块引用该模块

44. **`src/job-worktree-cleanup.ts`** — 原记录：Wave4 C: bounded owned Git command effect; prior 142 real disposable Git/identity/path/dirty checks. Production canonical cwd resolver and legacy path/error mapping remain unverified (head_to_head_wave3_delivery.mjs; local_git_merge.rs).

45. **`src/legacy-orchestrator-repair.ts`** — 原记录：Phase1 serial native Rust source port; uncompiled/unverified, production integration and head-to-head differential pending Phase2.
   - 类型/形状需复核：`LegacyOrchestratorRepairPorts`
   - 当前静态引用缺口：未发现其他 Rust 模块引用该模块

46. **`src/local-authority-store.ts`** — 原记录：Phase1 serial native Store/SQLite authoritative facade over existing transaction/outbox primitives; UNCOMPILED UNTESTED, API parity Phase2.
   - 差分参考：`rust/tests/head_to_head_cli_unblock.mjs`, `rust/tests/head_to_head_host_invocation_ports.mjs`, `rust/tests/head_to_head_local_blocker_port.mjs`, `rust/tests/head_to_head_store_facade_closure.mjs`
   - 类型/形状需复核：`LocalAuthorityDurableStore.projection`

47. **`src/local-git-merge.ts`** — 原记录：Wave4 C: 40 direct original Node/Rust real isolated Git merges, exact refs/SHA/error/idempotency; 30s owned process plus prior 270 Graph facts. Preemptive maxBuffer/error text and production completion Graph caller remain unverified (head_to_head_wave4_delivery_git.mjs; native_wave4_delivery.rs).
   - 差分参考：`rust/tests/head_to_head_wave4_delivery_git.mjs`
   - 类型/形状需复核：`LocalMergeReceipt`

48. **`src/local-job-registry.ts`** — 原记录：Phase1 serial first native Rust draft; uncompiled and untested, production API/wiring still requires parity closure.

49. **`src/local-managed-store.ts`** — 原记录：Phase1 serial first native Rust draft; uncompiled and untested; production API/wiring still requires parity closure.
   - 类型/形状需复核：`LocalManagedStore`
   - 当前静态引用缺口：未发现其他 Rust 模块引用该模块

52. **`src/managed-worker-input.ts`** — 原记录：Wave3 C native layered Agent resolver and 75 original Node prompt comparisons pass; daemon execution-context entrypoint integration unverified (head_to_head_wave3_delivery.mjs).

53. **`src/manual-plan.ts`** — 原记录：Phase1 serial native Rust draft; uncompiled and untested, production API/binding and differential to close in Phase2.

54. **`src/model-redecision.ts`** — 原记录：Phase1 serial first native Rust draft; uncompiled and untested, production API/wiring still requires parity closure.
   - 差分参考：`rust/tests/head_to_head_model_redecision.mjs`
   - 类型/形状需复核：`FailureEvidenceInput`, `ModelRedecisionOptions`, `ModelRedecisionResult`

55. **`src/model-routing.ts`** — 原记录：Serial Phase1 native Worker+Model routing policy, hard gates and source profile discovery port; uncompiled/unverified, decision audit/service binding Phase2.
   - 差分参考：`rust/tests/head_to_head_route_facades.mjs`
   - 类型/形状需复核：`ModelCandidate`, `ModelRoutingDecision`, `ModelRoutingOptions`

56. **`src/outcome-review.ts`** — 原记录：Wave4 B: 500 randomized args/aggregate Node/Rust comparisons and native injected real file/role runner/exit-code effects. Full agent resolver, owned reviewer subprocess and production binding remain unverified (head_to_head_wave4_review_pure.mjs; outcome_review.rs).
   - 差分参考：`rust/tests/head_to_head_outcome_review_public.mjs`, `rust/tests/head_to_head_wave2_review.mjs`
   - 类型/形状需复核：`OutcomeReview`, `ReviewOptions`

57. **`src/owned-process.ts`** — 原记录：Wave3 A isolated pipe/exit/timeout, waitpid stop-handshake and POSIX process-group tests pass; Windows taskkill, full SpawnOptions mapping and parent caller integration remain (native_wave3_graph.rs).
   - 差分参考：`rust/tests/head_to_head_process_browser_worker.mjs`
   - 类型/形状需复核：`OwnedProcessTerminationReason`

58. **`src/planner-child-recovery.ts`** — 原记录：Phase1 serial native Rust source port; uncompiled/unverified, production integration and head-to-head differential pending Phase2.
   - 当前静态引用缺口：未发现其他 Rust 模块引用该模块

59. **`src/planner-runtime.ts`** — 原记录：Phase1 serial native Planner protocol and Graph-owned execution runtime source port; uncompiled/unverified, Stage2 API and differential closure pending.
   - 差分参考：`rust/tests/head_to_head_planner_activation.mjs`, `rust/tests/head_to_head_planner_finish_public.mjs`, `rust/tests/head_to_head_planner_launch_public.mjs`, `rust/tests/head_to_head_planner_unblocks.mjs`
   - 类型/形状需复核：`PlannerApplyValidationError.code`, `PlannerRuntimePorts`

60. **`src/planner.ts`** — 原记录：Phase1 serial native Planner protocol and Graph-owned execution runtime source port; uncompiled/unverified, Stage2 API and differential closure pending.
   - 差分参考：`rust/tests/head_to_head_planner_finish_public.mjs`, `rust/tests/head_to_head_planner_public_ports.mjs`
   - 类型/形状需复核：`ObjectiveStatus`, `PlannerTaskSpec`, `PlannerUnblockSpec`, `PlannerResult`, `PlannerContext`, `SemanticTaskTreeEntry`, `ObjectivePlanner`, `PlannerRoundOptions`, `validatePlannerAgentRoles`, `CommandObjectivePlanner.constructor`, `AgentObjectivePlanner.constructor`

61. **`src/pool.ts`** — 原记录：Phase1 serial native Worker adapter/Repository Pool draft; not compiled/tested, Stage2 parity/wiring pending.
   - 差分参考：`rust/tests/head_to_head_pool_public_lifecycle.mjs`, `rust/tests/head_to_head_pool_reconcile_known.mjs`, `rust/tests/head_to_head_pool_webhook.mjs`, `rust/tests/head_to_head_stage2_pool_adapters.mjs`, `rust/tests/head_to_head_store_github_public.mjs`

62. **`src/projected-store.ts`** — 原记录：Serial Phase1 Rust GitHub marker Store and retryable SQLite projection transport; UNCOMPILED/UNTESTED; Graph/production API parity Phase2.
   - 差分参考：`rust/tests/head_to_head_projected_comments.mjs`, `rust/tests/head_to_head_store_facade_closure.mjs`
   - 类型/形状需复核：`ProjectionConflictEvent`, `ProjectionConflictObserver`, `ProjectedDurableStore.projection`

63. **`src/projection-outbox.ts`** — 原记录：PROVENANCE QUARANTINE: prior Worker C used duplicate shared worktree; its source and differential output are not admissible PASS evidence. Pending independent canonical commit and direct Node/Rust/native verification from `hotfix/rust2-parallel-projection-canonical-20261117` and `/tmp/rust2-parallel-projection-canonical-20261117.handoff.md`. Existing Rust is retained for compatibility with later Wave2/3/4; not yet reverified.
   - 差分参考：`rust/tests/head_to_head_projection_outbox_strict.mjs`, `rust/tests/head_to_head_worker_c_outbox.mjs`
   - 类型/形状需复核：`ProjectionOperation`, `ProjectionStatus`, `ProjectionRequest`, `ProjectionOutboxItem`, `ProjectionConflictDiagnostic`, `ProjectionConflictResolution`, `ProjectionConflictResolutionRequest`, `ProjectionConflictRecord`, `ProjectionOutboxPort`

64. **`src/reconcile-coordinator.ts`** — 原记录：Wave3 A explicit begin_turn batching adds 160 randomized same-turn Node/Rust cases to prior FIFO tests; implicit queueMicrotask scheduling at real Rust callers unproven (head_to_head_wave3_graph.mjs).
   - 差分参考：`rust/tests/head_to_head_wave2_coordinator.mjs`, `rust/tests/head_to_head_wave3_graph.mjs`
   - 类型/形状需复核：`ReconcileSignal`

65. **`src/reconciler-context.ts`** — 原记录：Phase1 serial first native Rust draft; uncompiled and untested, production API/wiring still requires parity closure.
   - 当前静态引用缺口：未发现其他 Rust 模块引用该模块

66. **`src/reconciler-review.ts`** — 原记录：Phase1 serial native Dashboard SERVER, Final Review and Event Runtime first draft; UNCOMPILED/UNTESTED, Stage2 integration and parity. Dashboard browser client unchanged.
   - 差分参考：`rust/tests/head_to_head_reconciler_review_base.mjs`

67. **`src/reconciler-runtime.ts`** — 原记录：Phase1 serial native Dashboard SERVER, Final Review and Event Runtime first draft; UNCOMPILED/UNTESTED, Stage2 integration and parity. Dashboard browser client unchanged.
   - 差分参考：`rust/tests/head_to_head_reconciler_apply_event.mjs`, `rust/tests/head_to_head_reconciler_runtime_base.mjs`
   - 类型/形状需复核：`executionEventSource`, `ReconcileOptions`, `EventHandlingResult`, `withExecutionBoundary`

68. **`src/reconciler.ts`** — 原记录：Phase1 serial Rust source first draft of Reconciler/daemon/Control/CLI; UNCOMPILED/UNTESTED, missing direct API wiring and parity must be repaired in Phase2. Dashboard browser client unchanged.
   - 差分参考：`rust/tests/head_to_head_reconciler_active_public.mjs`, `rust/tests/head_to_head_reconciler_apply_planner_tree.mjs`, `rust/tests/head_to_head_reconciler_git_head.mjs`, `rust/tests/head_to_head_reconciler_plan_job.mjs`, `rust/tests/head_to_head_reconciler_reconcile_public.mjs`, `rust/tests/head_to_head_reconciler_recover_lost.mjs`
   - 类型/形状需复核：`executionEventSource`, `ReconcileOptions`, `managedWorkerInput`

69. **`src/relay-store-discovery.ts`** — 原记录：Phase1 serial first native Rust draft; uncompiled and untested, production API/wiring still requires parity closure.

70. **`src/relay-store.ts`** — 原记录：Phase1 serial native Store/SQLite authoritative facade over existing transaction/outbox primitives; UNCOMPILED UNTESTED, API parity Phase2.
   - 差分参考：`rust/tests/head_to_head_cli_support_public_api.mjs`, `rust/tests/head_to_head_cli_unblock.mjs`, `rust/tests/head_to_head_coordinator_cli.mjs`, `rust/tests/head_to_head_host_invocation_ports.mjs`, `rust/tests/head_to_head_local_blocker_port.mjs`, `rust/tests/head_to_head_planner_unblocks.mjs`, `rust/tests/head_to_head_projected_comments.mjs`, `rust/tests/head_to_head_store_facade_closure.mjs`
   - 类型/形状需复核：`mergeInboundJobSnapshot`, `ProjectionConflictDiagnostic`, `ProjectionConflictRecord`, `ProjectionConflictResolution`, `ProjectionConflictResolutionRequest`, `ProjectionOperation`, `ProjectionOutboxItem`, `ProjectionRequest`, `ProjectionStatus`, `PullRequestFacts`, `RelayStore`, `SQLiteRelayStore.constructor`, `relayStoreDirectory`, `relayUnifiedStorePath` …

71. **`src/relayd-control.ts`** — 原记录：Phase1 serial Rust source first draft of Reconciler/daemon/Control/CLI; UNCOMPILED/UNTESTED, missing direct API wiring and parity must be repaired in Phase2. Dashboard browser client unchanged.
   - 差分参考：`rust/tests/head_to_head_workspace_control_factory.mjs`

72. **`src/relayd-dashboard-actions.ts`** — 原记录：Phase1 Rust daemon-side Dashboard actions draft only; client HTML/CSS/JS frozen unchanged; uncompiled/unverified.
   - 差分参考：`rust/tests/head_to_head_dashboard_factory.mjs`

73. **`src/relayd-main.ts`** — 原记录：Phase1 serial first native Rust draft; uncompiled and untested, production API/wiring still requires parity closure.
   - 当前静态引用缺口：未发现其他 Rust 模块引用该模块

74. **`src/relayd-utilities.ts`** — 原记录：Phase1 serial Rust SERVER-only source draft; uncompiled/unverified; preserve original Dashboard client HTML/CSS/JS.
   - 差分参考：`rust/tests/head_to_head_daemon_public_setup.mjs`
   - 类型/形状需复核：`PullRequestRefreshTrigger`, `GitHubReadPathDiagnostics`

75. **`src/relayd.ts`** — 原记录：Phase1 serial Rust source first draft of Reconciler/daemon/Control/CLI; UNCOMPILED/UNTESTED, missing direct API wiring and parity must be repaired in Phase2. Dashboard browser client unchanged.
   - 类型/形状需复核：`daemonHelp`, `normalizeDaemonArguments`, `overlayOperationalOverviews`, `mergeOperationalInventory`, `recoveryScanRepositories`, `shouldCoalescePullRequestRefresh`, `configureExecutionRouterRulesPath`

77. **`src/review-revision-execution.ts`** — 原记录：Wave4 B: 1050 direct randomized original Node/Graph vs Rust reconcile scenarios; prior real SQLite atomic/idempotent native tests. Publication failure order and malformed legacy persisted requests remain unverified (head_to_head_wave4_review_revision.mjs; native_wave3_review_store.rs).
   - 差分参考：`rust/tests/head_to_head_wave2_graph.mjs`, `rust/tests/head_to_head_wave2_review.mjs`, `rust/tests/head_to_head_wave4_review_revision.mjs`

78. **`src/review-revision-model.ts`** — 原记录：Wave4 B: 720 randomized request/dependency vector and 1050 reconcile cases; prior SQLite ID/request/comment atomic rollback tests. Alternate stores and legacy JavaScript undefined/invalid fields remain unverified (head_to_head_wave4_review_revision.mjs; native_wave3_review_store.rs).
   - 差分参考：`rust/tests/head_to_head_wave2_review.mjs`, `rust/tests/head_to_head_wave3_review_model.mjs`, `rust/tests/head_to_head_wave4_review_revision.mjs`
   - 类型/形状需复核：`SubmitReviewRevision`

79. **`src/review-revision-settlement.ts`** — 原记录：Wave3 B SQLite read/recheck/write settlement with stale-head rollback passes; multi-round ownership and concurrent Graph error edge parity incomplete (native_wave3_review_store.rs).
   - 差分参考：`rust/tests/head_to_head_wave2_review_effects.mjs`

80. **`src/review-revision-stale.ts`** — 原记录：Wave3 B SQLite stale-cancel commit fence and zero post-failure side effects pass; actual owned-process cancel callback/failure wiring unverified (native_wave3_review_store.rs).
   - 差分参考：`rust/tests/head_to_head_wave2_review_effects.mjs`

81. **`src/reviewer-thread.ts`** — 原记录：Wave4 B: 7700 mixed API randomized direct Node/Rust comparisons (includes reviewer destinations, revision threads, empty reviewHeadSha fix), native legacy load/save and Wave3 SQLite atomic thread receipts. Real remote sender/timeouts/publication remain unverified (scripts/head_to_head_wave4_review_b.mjs).
   - 差分参考：`rust/tests/head_to_head_wave2_review.mjs`, `rust/tests/head_to_head_wave4_review_pure.mjs`
   - 类型/形状需复核：`ReviewThreadDestination`

82. **`src/route-outcome-recording.ts`** — 原记录：Wave4 C: 180 randomized direct Node/Rust durable JSONL append/redaction, best-effort failure and multi-record cases; prior outcome classification. Full post-Graph/SQLite production audit caller sequencing remains unverified (head_to_head_wave4_delivery.mjs; native_wave4_delivery.rs).
   - 差分参考：`rust/tests/head_to_head_wave4_delivery.mjs`
   - 类型/形状需复核：`DecisionAuditStore`

83. **`src/router-evals.ts`** — 原记录：Phase1 serial first native Rust draft; uncompiled and untested; production API/wiring still requires parity closure.
   - 当前静态引用缺口：未发现其他 Rust 模块引用该模块

84. **`src/script-task-adapter.ts`** — 原记录：Phase1 serial native Rust Script Agent and read-only CLI Prompt port; uncompiled/untested, API integration Phase2.
   - 类型/形状需复核：`ScriptTaskAdapter.name`, `ScriptTaskAdapter.id`, `ScriptTaskAdapter.capabilities`
   - 当前静态引用缺口：未发现其他 Rust 模块引用该模块

85. **`src/service-external-actions.ts`** — 原记录：Phase1 serial first native Rust draft; uncompiled and untested, production API/wiring still requires parity closure.
   - 当前静态引用缺口：未发现其他 Rust 模块引用该模块

86. **`src/single-job-task-control.ts`** — 原记录：Phase1 serial first native Rust draft; uncompiled and untested, production API/wiring still requires parity closure.
   - 当前静态引用缺口：未发现其他 Rust 模块引用该模块

87. **`src/store-github.ts`** — 原记录：Serial Phase1 Rust GitHub marker Store and retryable SQLite projection transport; UNCOMPILED/UNTESTED; Graph/production API parity Phase2.
   - 差分参考：`rust/tests/head_to_head_projected_comments.mjs`

88. **`src/store.ts`** — 原记录：Phase1 serial native Store/SQLite authoritative facade over existing transaction/outbox primitives; UNCOMPILED UNTESTED, API parity Phase2.
   - 差分参考：`rust/tests/head_to_head_cli_runtime_factory.mjs`, `rust/tests/head_to_head_cli_unblock.mjs`, `rust/tests/head_to_head_host_invocation_ports.mjs`, `rust/tests/head_to_head_local_blocker_port.mjs`, `rust/tests/head_to_head_reconciler_git_head.mjs`, `rust/tests/head_to_head_resolve_pull_request.mjs`, `rust/tests/head_to_head_store_facade_closure.mjs`, `rust/tests/head_to_head_store_github_public.mjs`
   - 类型/形状需复核：`Comment`, `PullRequestState`, `ManagedJobOverview`, `GitHubPullRequestSeed`, `ManagedGitHubPullRequestSnapshot`, `AtomicJobMutation`, `DurableStore`, `GitHubGraphqlDiagnostics`, `GitHubClient`, `GitHubRateLimitBucket`, `GitHubRateLimitSnapshot`, `PullRequest`, `GhApiClient`, `createGitHubAppJwt` …

89. **`src/task-actions.ts`** — 原记录：Phase1 serial Rust native Task Graph/SQLite snapshot draft; compile and head-to-head differential deferred to Phase2.
   - 差分参考：`rust/tests/head_to_head_atomic_public_apis.mjs`
   - 类型/形状需复核：`TaskActionId`, `TaskActionRequest`, `TaskActionResult`, `TaskRetryPolicy`

90. **`src/task-inactivity-watchdog.ts`** — 原记录：Wave4 A: 500 randomized direct Node/Rust classification/deadline cases, native cancellation/re-arm/old-generation timers; Wave3 250 SQLite progress/idempotency cases. Full production timer/caller and transition wiring remain unverified (head_to_head_wave4_watchdog.mjs; native_wave4_graph.rs).
   - 差分参考：`rust/tests/head_to_head_process_browser_worker.mjs`, `rust/tests/head_to_head_wave3_graph.mjs`, `rust/tests/head_to_head_wave4_watchdog.mjs`

91. **`src/task-recovery.ts`** — 原记录：Phase1 serial native Rust draft; uncompiled and untested, production API/binding and differential to close in Phase2.
   - 类型/形状需复核：`EscalationRequest`

92. **`src/task-transitions.ts`** — 原记录：Wave3 A async Task/Job Graph effect callback ordering and 180 Node/Rust cases pass; public durable transition runtime/production dispatcher binding unproven (head_to_head_wave3_graph.mjs).
   - 差分参考：`rust/tests/head_to_head_wave2_graph.mjs`, `rust/tests/head_to_head_wave3_graph.mjs`
   - 类型/形状需复核：`dependencyReady`, `detectCycles`

93. **`src/task-update.ts`** — 原记录：Phase1 serial Task mutable-field/identity guard draft; uncompiled, untested, and not production-wired.
   - 差分参考：`rust/tests/head_to_head_atomic_public_apis.mjs`

94. **`src/troubleshooter-fallback.ts`** — 原记录：Wave4 B: canonical Graph-authorized SQLite atomic escalation state plus outbox intent, native idempotency and rollback 3/3; prior fallback native cases. Actual downstream human delivery and all legacy saveTask/concurrent request effects remain unverified (native_wave4_review_escalation.rs).
   - 差分参考：`rust/tests/head_to_head_wave2_review_effects.mjs`

95. **`src/troubleshooter.ts`** — 原记录：Phase1 serial native DAG Task projection and Troubleshooter recovery first port; uncompiled/unverified, production bindings Phase2.

96. **`src/types.ts`** — 原记录：Serial Phase1 native Rust wire contract and Worker Router first port; uncompiled and unverified, differential/binding Phase2.
   - 差分参考：`rust/tests/head_to_head_legacy_migrations.mjs`
   - 类型/形状需复核：`ChatGptTabClosePolicy`, `PlanningDecisionSource`, `AgentAvailability`, `AgentEndpoint`, `AgentEvidence`, `AgentRegistration`, `DecisionEvidence`, `ResourceUsageWindow`, `BrowserWorkspaceCapacity`, `Result`, `TaskResolutionPath`, `TaskResolutionOwner`, `TaskResolutionState`, `TaskResolutionProposal` …

97. **`src/unblock.ts`** — 原记录：Phase1 native Rust draft for Graph authority and Z WebHelm adapter request contract; uncompiled/unverified; no Dashboard client changes.
   - 差分参考：`rust/tests/head_to_head_atomic_public_apis.mjs`
   - 类型/形状需复核：`UnblockSource`

98. **`src/usage.ts`** — 原记录：Phase1 native owned GitHub CLI transport and provider usage/capacity readers port; UNCOMPILED UNTESTED, runtime API/parity closure Phase2.
   - 差分参考：`rust/tests/head_to_head_codex_api_usage.mjs`, `rust/tests/head_to_head_usage_readers_mitigation.mjs`, `rust/tests/head_to_head_usage_registry_closure.mjs`
   - 类型/形状需复核：`AccountUsageWindow`, `AccountUsageSnapshot`, `AccountUsageProvider`, `CreditBalance`, `CreditSnapshot`, `CreditProvider`, `AccountUsageOverview`, `UsageSnapshot`, `CreditReader`, `BrowserWorkspaceCapacityReader`, `BrowserWorkspaceUsageReader.constructor`, `CodexApiUsageReader.constructor`, `CodexSessionUsageReader.constructor`, `ZaiUsageReader.constructor` …

99. **`src/worker-failure-recovery.ts`** — 原记录：Phase1 serial native Rust draft; uncompiled and untested, production API/binding and differential to close in Phase2.
   - 差分参考：`rust/tests/head_to_head_worker_failure_orchestration.mjs`
   - 类型/形状需复核：`WorkerFailurePorts`

100. **`src/worker-routing.ts`** — 原记录：Serial Phase1 native Rust wire contract and Worker Router first port; uncompiled and unverified, differential/binding Phase2.
   - 差分参考：`rust/tests/head_to_head_route_facades.mjs`
   - 类型/形状需复核：`WorkerCandidate`, `WorkerRoutingDecision`, `WorkerRoutingOptions`, `WorkerEligibilityOptions`

101. **`src/workflow-effect-failures.ts`** — 原记录：Phase1 serial first native Rust draft; uncompiled and untested, production API/wiring still requires parity closure.
   - 当前静态引用缺口：未发现其他 Rust 模块引用该模块

102. **`src/workflow/durable-transition.ts`** — 原记录：Phase1 serial Rust native Task Graph/SQLite snapshot draft; compile and head-to-head differential deferred to Phase2.
   - 差分参考：`rust/tests/head_to_head_wave3_graph.mjs`
   - 类型/形状需复核：`DurableTaskTransitionResult`
   - 当前静态引用缺口：未发现其他 Rust 模块引用该模块

105. **`src/workspace.ts`** — 原记录：Phase1 native CLI immutable Job bindings, HTTP control, Git workspace identity/worktree port; no compilation/tests; Stage2 head-to-head pending.
   - 差分参考：`rust/tests/head_to_head_managed_workspace.mjs`
   - 类型/形状需复核：`DiscoveredRepository`, `ManagedPullRequestHead`, `ManagedWorktreeCleanupResult`

106. **`src/z-adapter.ts`** — 原记录：Phase1 native Rust draft for Graph authority and Z WebHelm adapter request contract; uncompiled/unverified; no Dashboard client changes.
   - 类型/形状需复核：`ZAdapter.name`, `ZAdapter.id`, `ZAdapter.capabilities`
   - 当前静态引用缺口：未发现其他 Rust 模块引用该模块

107. **`src/z-oauth.ts`** — 原记录：Wave3 C real local fake HTTP PKCE/redirect/revoke flow and prior mocked negatives pass; production HTTPS provider/TLS/identity environment integration unverified (head_to_head_wave3_delivery.mjs).

## 认证下一步约束

针对 HOLD 项逐个补齐与原 Node 可执行 API 直接对比、Rust 原生负面/恢复场景、权威 Graph/SQLite 和真实生产入口；证据完备后才在主 Ledger 将 `PORTING` 改为 `PASS`，随后重新生成 API matrix。禁止根据名称匹配率或某一条 Mock 断言自动升级。
