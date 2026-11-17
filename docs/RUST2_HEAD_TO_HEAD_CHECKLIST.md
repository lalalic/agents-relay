# Rust2: Node.js → Rust head-to-head port checklist

> Migration contract: the historical 227-file inventory at `234a8151fe0fe616c39c0109b4b014326044e17e` is retained for provenance. The authoritative current Node source is `main` at `ba22e4cbdfa68cdd4ccb08dc7e02df49b57e7a90` (225 active source files: 3 removed, 1 added). The existing Rust rewrite is deliberately retired; **no legacy Rust implementation is reused**. No parity is claimed until independent differential verification passes.

## Rules and exit criteria

- [x] Create branch `rust2` at baseline Node implementation.
- [x] Remove the previous Rust implementation and its local build artifacts.
- [ ] Port every tracked Node `src/**/*.ts|js` file to a mapped Rust module, or document explicit evidence-backed exclusion.
- [ ] Port public CLI commands/flags, HTTP routes, state transitions, SQLite effects, Graph bindings, worker interfaces, scheduler and dashboard, recording independent tests per surface.
- [ ] Compare Node and Rust against the same isolated fixtures (inputs, stdout/stderr, exit code, JSON, SQLite snapshots and events); negative, restart and dedupe tests must pass.
- [ ] Validate L1 Graph, L2 adapter/provider and L3 deterministic sqlite/reconciliation checks. Production/live cutover requires independent approval and evidence.
- [ ] Every **new source/test/script** must start with a concise comment explaining its Node provenance and purpose. File removals are explained in the corresponding Git commit, not in this checklist.

## Architecture lens

Node `workflow/*.mmd` owns decisions; Rust modules may port only effects, adapters, parsing, I/O and SQLite durable behavior. Both CLIs and dashboard must call the same authoritative Graph actions. No independent Rust workflow policy; SQLite remains the single lifecycle authority; no caller-specific Neo dependency.

## Source-by-source ledger

Status meanings: `PENDING` = not implemented; `PORTING` = in progress; `PASS` = port + Node/Rust differential tests passed; `EXCLUDED` = explicit documented semantic removal. A Rust file existing is not PASS.

| Node.js source (authoritative) | Intended Rust module | Status | Evidence / reason |
|---|---|---|---|
| `src/adapters.ts` | `rust/src/adapters.rs` | PORTING | Phase1 serial native Worker adapter/Repository Pool draft; not compiled/tested, Stage2 parity/wiring pending. |
| `src/agent-content-resolver.ts` | `rust/src/agent_content_resolver.rs` | PASS | Direct hotfix: 500 Node/Rust source-layer fixtures, 252 isolated Agent files/section inheritance cases, 120 multi-layer snapshots; 5 native tests, 18 focused Node regressions (rust/tests/head_to_head_agent_content_resolver.mjs; rust/tests/native_agent_content_resolver.rs) |
| `src/agent-graph.ts` | `rust/src/agent_graph.rs` | PASS | Eight-module Graph/Outbox batch: 1,050 DAG syntax/wave parses, 690 visibility policy cases, actual resolved Agent-contract prompt parity; `rust/tests/head_to_head_graph_*.mjs`, `rust/tests/head_to_head_agent_graph.mjs`, `rust/tests/head_to_head_workflow_*.mjs`, `rust/tests/native_graph_outbox_batch.rs` |
| `src/agent-prompt-builder.ts` | `rust/src/agent_prompt_builder.rs` | PASS | Direct hotfix: 1,100 pure prompt/render fixtures; 220 reference-first fixtures; 150 exact execution prompts; isolated immutable SHA-256 snapshots and filesystem/error semantics; 5 Rust-native tests, 19 Node regressions (rust/tests/head_to_head_agent_prompt_builder.mjs; rust/tests/native_agent_prompt_builder.rs) |
| `src/agent-script-discovery.ts` | `rust/src/agent_script_discovery.rs` | PASS | CLI Core 98 shared Node/Rust filesystem/Graph fixtures including layered Script Agent discovery and symlink confinement; rust/tests/head_to_head_cli_core.mjs |
| `src/audit-tail.ts` | `rust/src/audit_tail.rs` | PASS | Batch 5: isolated temp-file differential covers absent path, newest-first records, multiline JSON strings, malformed trailing line and a record spanning the 64 KiB reverse-read boundary (`rust/tests/head_to_head_batch5.mjs`) |
| `src/blocker-recovery.ts` | `rust/src/blocker_recovery.rs` | PORTING | Phase1 serial authorized Blocker Graph recovery creation/adoption/dependency receipt native Rust draft; uncompiled/untested, cross-Job CAS Phase2. |
| `src/blockers.ts` | `rust/src/blockers.rs` | PORTING | Serial Phase1 native Rust port for authoritative Graph/SQLite and guarded Git side effects. UNCOMPILED/UNTESTED, finish production bindings in Phase2. |
| `src/browser-worker-pool-graph.ts` | `rust/src/browser_worker_pool_graph.rs` | PASS | 7 integrated B Node/Rust scenario groups including all 15 resource Graph branches; rust/tests/head_to_head_process_browser_worker.mjs |
| `src/browser-worker-pool.ts` | `rust/src/browser_worker_pool.rs` | PORTING | Wave4 A: 48 concurrent disposable SQLite manager initializations with bounded SQLITE_BUSY/LOCKED retry; prior real FIFO/lease/quarantine and Graph branch tests pass. Production acquire/session/error mapping remains unverified (native_wave4_graph.rs; head_to_head_process_browser_worker.mjs). |
| `src/browser-worker-routing.ts` | `rust/src/browser_worker_routing.rs` | PORTING | Phase1 serial first native Rust draft; uncompiled and untested, production API/wiring still requires parity closure. |
| `src/browser-worker-runtime.ts` | `rust/src/browser_worker_runtime.rs` | PORTING | Phase1 serial native WebHelm Browser Pool lease/session/probe/recovery first port; uncompiled/untested; end-to-end wiring Phase2. |
| `src/chatgpt-platform-fallback.ts` | `rust/src/chatgpt_platform_fallback.rs` | PORTING | Phase1 serial native Rust source port; uncompiled/unverified, production integration and head-to-head differential pending Phase2. |
| `src/cli-artifact.ts` | `rust/src/cli_artifact.rs` | PORTING | Wave4 B: original Node/Ajv schema-compile errors, CLI output/error priority, UTF16 Unicode/unknown-format tests plus Wave3 277 filesystem comparisons. Recursive $ref, full Ajv dialect/format and CLI edge parity remain unverified (head_to_head_wave4_artifact.mjs; head_to_head_wave3_artifact.mjs). |
| `src/cli-blocker.ts` | `rust/src/cli_blocker.rs` | PASS | Shared 98-case CLI direct Node/Rust differential, isolated HTTP 403/receipt fixture and focused Node regressions; rust/tests/head_to_head_cli_core.mjs, cli_http_native.rs |
| `src/cli-context.ts` | `rust/src/cli_context.rs` | PASS | Layered CLI execution context and error/file behavior in 98-case shared Node/Rust direct suite; rust/tests/head_to_head_cli_core.mjs |
| `src/cli-coordinator.ts` | `rust/src/cli_coordinator.rs` | PORTING | Phase1 serial first native Rust draft; uncompiled and untested; production API/wiring still requires parity closure. |
| `src/cli-escalation.ts` | `rust/src/cli_escalation.rs` | PORTING | Phase1 serial first native Rust draft; uncompiled and untested; production API/wiring still requires parity closure. |
| `src/cli-foreground.ts` | `rust/src/cli_foreground.rs` | PORTING | Phase1 serial first native Rust draft; uncompiled and untested, production API/wiring still requires parity closure. |
| `src/cli-help.ts` | `rust/src/cli_help.rs` | PASS | Rebased to current main: all 47 CLI help keys, obsolete PR/projection/merge commands removed; direct Node/Rust byte-level CLI help and fallback differential (`rust/tests/head_to_head_cli_help.mjs`, `rust/tests/native_cli_help.rs`) |
| `src/cli-job-create.ts` | `rust/src/cli_job_create.rs` | PORTING | Serial Phase1 native SQLite Job creation and bounded/redacted JSONL routing audit port; uncompiled/untested, Stage2 bindings+differential pending. |
| `src/cli-local-merge-config.ts` | `rust/src/cli_local_merge_config.rs` | PASS | 626 shared differential fixtures across 14 ports; merge success and validation errors compared (`rust/tests/head_to_head.mjs`) |
| `src/cli-projection.ts` | `rust/src/cli_projection.rs` | EXCLUDED | Removed by main local-Git-only CLI lifecycle; PR projection commands and their Rust mirror/differential tests are retired, no longer an executable public CLI surface. |
| `src/cli-prompt.ts` | `rust/src/cli_prompt.rs` | PORTING | Phase1 serial native Rust Script Agent and read-only CLI Prompt port; uncompiled/untested, API integration Phase2. |
| `src/cli-review.ts` | `rust/src/cli_review.rs` | PORTING | Phase1 serial native Rust draft; uncompiled, untested and not production-wired; parity pending. |
| `src/cli-revision.ts` | `rust/src/cli_revision.rs` | PASS | Findings/receipt/input bounds and native HTTP request parity in 98-case shared CLI suite; rust/tests/head_to_head_cli_core.mjs, cli_http_native.rs |
| `src/cli-shutdown.ts` | `rust/src/cli_shutdown.rs` | PASS | Batch 5: exit status precedence, serving mode, delayed default/custom grace and injected force-exit callback verified without terminating the test process (`rust/tests/native_batch5.rs`, `rust/tests/head_to_head_batch5.mjs`). |
| `src/cli-support.ts` | `rust/src/cli_support.rs` | PORTING | Phase1 native CLI immutable Job bindings, HTTP control, Git workspace identity/worktree port; no compilation/tests; Stage2 head-to-head pending. |
| `src/cli-unblock.ts` | `rust/src/cli_unblock.rs` | PORTING | Phase1 serial native Rust draft; uncompiled, untested and not production-wired; parity pending. |
| `src/cli-worker-task.ts` | `rust/src/cli_worker_task.rs` | PORTING | Phase1 serial native Rust draft; uncompiled and untested, production API/binding and differential to close in Phase2. |
| `src/cli-workflow-action.ts` | `rust/src/cli_workflow_action.rs` | PASS | Batch 5: direct Node/Rust mapping and unsupported/missing argument errors; Rust exposes async delegated effect (`rust/tests/head_to_head_batch5.mjs`) |
| `src/cli-workflow.ts` | `rust/src/cli_workflow.rs` | PASS | Read-only Graph workflow commands, predicate error paths and isolated SQLite trace/verify in 98-case CLI Node/Rust suite; rust/tests/head_to_head_cli_core.mjs |
| `src/cli.ts` | `rust/src/cli.rs` | PENDING | — |
| `src/continuation.ts` | `rust/src/continuation.rs` | PORTING | Wave4 C: owned subprocess group with real pipe/exit/timeout/cancel effects and 125 randomized original Node/Rust command cases; prior local webhook POST. Exact ENOENT/error precedence and production caller remain unverified (head_to_head_wave4_delivery.mjs; native_wave4_delivery.rs). |
| `src/dag-result-contract.ts` | `rust/src/dag_result_contract.rs` | PORTING | Wave4 C: 42 direct Node/Rust actual isolated stage verifier subprocess cases plus prior 105 file/rejection cases; native timeout/cancel. Abnormal signal/large output and Graph terminal caller binding remain unverified (head_to_head_wave4_delivery.mjs; native_wave4_delivery.rs). |
| `src/dag-stage-contract.ts` | `rust/src/dag_stage_contract.rs` | PASS | Batch 4: 729 shared differential cases across 23 source ports; isolated temp project fixtures, symlink/run escape checks, malformed/failing validator outputs, and checked execution args (`rust/tests/head_to_head.mjs`) |
| `src/dag-task-runtime.ts` | `rust/src/dag_task_runtime.rs` | PORTING | Phase1 serial native DAG Task projection and Troubleshooter recovery first port; uncompiled/unverified, production bindings Phase2. |
| `src/dashboard-actions.ts` | `rust/src/dashboard_actions.rs` | PORTING | Phase1 serial Rust SERVER-only source draft; uncompiled/unverified; preserve original Dashboard client HTML/CSS/JS. |
| `src/dashboard-data.ts` | `rust/src/dashboard_data.rs` | PASS | 1,077 shared randomized Node/Rust feedback/events/dashboard cases, ordering/pagination/filters and focused Node dashboard regressions; rust/tests/head_to_head_worker_c.mjs |
| `src/dashboard-html.ts` | `rust/src/dashboard_html.rs` | EXCLUDED | USER REQUIREMENT: Dashboard client HTML/CSS/browser JavaScript MUST NOT CHANGE. Rust backend must serve existing original built client asset unchanged; excluded from Rust source translation. |
| `src/dashboard-jel.ts` | `rust/src/dashboard_jel.rs` | PASS | Direct hotfix: 1,429 exact fixed-clock Node/Rust dynamic DAG/Plan/Review/Retry/Merge Mermaid diagrams, native unit tests and Unicode surrogate JSON-wire fidelity (rust/tests/head_to_head_dashboard_jel.mjs; rust/tests/native_dashboard_jel.rs) |
| `src/dashboard-style.ts` | `rust/src/dashboard_style.rs` | PASS | Direct hotfix: exact 25,275 byte runtime dashboard CSS literal, SHA-256 676e173854d712a21bf4cf0a3dfaa59bf015a458ce9a2b54d8e632a082a56c34 (rust/tests/head_to_head_dashboard_style.mjs) |
| `src/dashboard-workflow-inspection.ts` | `rust/src/dashboard_workflow_inspection.rs` | PASS | Batch 6: Node/Rust differential fixtures cover valid exact Event/Action graph symbols, source/test references, malformed identifiers and traversal rejection (`rust/tests/head_to_head_batch6.mjs`); native path-safety test. |
| `src/dashboard.ts` | `rust/src/dashboard.rs` | PORTING | Phase1 serial native Dashboard SERVER, Final Review and Event Runtime first draft; UNCOMPILED/UNTESTED, Stage2 integration and parity. Dashboard browser client unchanged. |
| `src/decision-audit.ts` | `rust/src/decision_audit.rs` | PORTING | Serial Phase1 native SQLite Job creation and bounded/redacted JSONL routing audit port; uncompiled/untested, Stage2 bindings+differential pending. |
| `src/decision.ts` | `rust/src/decision.rs` | PORTING | Wave3 A real isolated Laya owned shell, stdout/stderr, timeout and prior 4401 decision cases pass; actual external decision service caller and complete error/export paths still unproven (head_to_head_wave3_graph.mjs). |
| `src/dependency-revision-execution.ts` | `rust/src/dependency_revision_execution.rs` | PORTING | Phase1 serial native Rust source port; uncompiled/unverified, production integration and head-to-head differential pending Phase2. |
| `src/dependency-validity.ts` | `rust/src/dependency_validity.rs` | PASS | 327 shared differential fixtures across 4 ports; Rust native tests 5/5; Node focused regression 4/4; clippy clean (`rust/tests/head_to_head.mjs`) |
| `src/escalation-notifier.ts` | `rust/src/escalation_notifier.rs` | PORTING | Phase1 serial native Rust source port; uncompiled/unverified, production integration and head-to-head differential pending Phase2. |
| `src/events-bus-runtime.ts` | `rust/src/events_bus_runtime.rs` | PASS | Direct port: native TLS/HTTP client, 662 Node/Rust config fixtures and 200 real localhost HTTP page/timeout/denial cases; 5 native regressions, 6 original Node tests (`rust/tests/head_to_head_events_bus_runtime.mjs`, `rust/tests/native_events_bus_runtime.rs`) |
| `src/events.ts` | `rust/src/events.rs` | PASS | Event subjects and direct Node/Rust parity plus 2 native ephemeral fake-NATS TCP tests for publish/subscribe; rust/tests/head_to_head_worker_c.mjs, native_worker_c_events.rs |
| `src/execution-boundary.ts` | `rust/src/execution_boundary.rs` | PASS | Batch 5: controlled Node ordering/error release plus native Rust same-key serialization, different-key concurrency, panic release and reacquisition (`rust/tests/head_to_head_batch5.mjs`, `rust/tests/native_batch5.rs`) |
| `src/execution-context.ts` | `rust/src/execution_context.rs` | PORTING | Serial Phase1 native interactive invocation Graph/Host and layered execution context port; uncompiled/untested, store integration Stage2. |
| `src/execution-event-identity.ts` | `rust/src/execution_event_identity.rs` | PASS | Direct port: 2,525 Node/Rust source/terminal claim fixtures, 3 native generation-binding tests (`rust/tests/head_to_head_execution_event_identity.mjs`, `rust/tests/native_execution_event_identity.rs`) |
| `src/execution-process-tracker.ts` | `rust/src/execution_process_tracker.rs` | PORTING | Phase1 serial first native Rust draft; uncompiled and untested; production API/wiring still requires parity closure. |
| `src/execution-recovery.ts` | `rust/src/execution_recovery.rs` | PORTING | Phase1 serial first native Rust draft; uncompiled and untested; production API/wiring still requires parity closure. |
| `src/execution-routing.ts` | `rust/src/execution_routing.rs` | PORTING | Serial Phase1 native Worker+Model routing policy, hard gates and source profile discovery port; uncompiled/unverified, decision audit/service binding Phase2. |
| `src/feedback.ts` | `rust/src/feedback.rs` | PASS | 1,077 shared Node/Rust fixtures, 84 real disposable-filesystem materializations, byte equality/errors, native tests and focused Node regressions; rust/tests/head_to_head_worker_c*.mjs |
| `src/final-review-role.ts` | `rust/src/final_review_role.rs` | PASS | 587 shared differential fixtures across 7 ports; Rust native tests 8/8; Node focused regression 18/18; clippy clean (`rust/tests/head_to_head.mjs`) |
| `src/force-restate-validation.ts` | `rust/src/force_restate_validation.rs` | PORTING | Phase1 serial native Rust source port; uncompiled/unverified, production integration and head-to-head differential pending Phase2. |
| `src/force-restate.ts` | `rust/src/force_restate.rs` | PORTING | Wave3 A retained tested forceRestate forwarding; actual manual plan apply/store/launch effects still require a Rust production binding (native_wave2_graph.rs). |
| `src/github-auth.ts` | `rust/src/github_auth.rs` | PORTING | Wave3 C 102 Node/Rust identity/probe cases with injected GhApiClient pass; real App Auth client, provider login probe and runtime factory not yet ported (head_to_head_wave3_delivery.mjs). |
| `src/github-binding-order.ts` | `rust/src/github_binding_order.rs` | PASS | 626 shared differential fixtures across 14 ports; stable ordering and priority groups compared (`rust/tests/head_to_head.mjs`) |
| `src/github-branch-projection.ts` | `rust/src/github_branch_projection.rs` | PASS | 626 shared differential fixtures across 14 ports; normal and force-with-lease argv compared (`rust/tests/head_to_head.mjs`) |
| `src/github-client.ts` | `rust/src/github_client.rs` | PORTING | Phase1 native owned GitHub CLI transport and provider usage/capacity readers port; UNCOMPILED UNTESTED, runtime API/parity closure Phase2. |
| `src/github-pr-archive.ts` | `rust/src/github_pr_archive.rs` | PASS | Direct callback port: 1,156 Node/Rust fake GitHubClient display-only PR scenarios, 4 native tests and original Node PR archive regression (`rust/tests/head_to_head_github_pr_archive.mjs`, `rust/tests/native_github_pr_archive.rs`) |
| `src/github-runtime-usage.ts` | `rust/src/github_runtime_usage.rs` | PASS | Direct port: 1,793 Node/Rust rate/header/Unicode/datetime fixtures, 5 native tests, 8 original Node runtime-rate regressions (`rust/tests/head_to_head_github_runtime_usage.mjs`, `rust/tests/native_github_runtime_usage.rs`) |
| `src/github-webhook.ts` | `rust/src/github_webhook.rs` | PASS | Eight-file hotfix: 580 event/trusted comment fixtures, 1,000 package marker cases, 280 HMAC signatures, 240 delivery dedup windows; native HMAC/receipt tests; `rust/tests/head_to_head_eight_batch_*.mjs`, `rust/tests/native_eight_batch_*.rs` |
| `src/graph-runtime.ts` | `rust/src/graph_runtime.rs` | PASS | Eight-module Graph/Outbox batch: alias to canonical Graph-v2 runtime with 1,300 Graph runtime differential cases; `rust/tests/head_to_head_graph_*.mjs`, `rust/tests/head_to_head_agent_graph.mjs`, `rust/tests/head_to_head_workflow_*.mjs`, `rust/tests/native_graph_outbox_batch.rs` |
| `src/host-invocation-store.ts` | `rust/src/host_invocation_store.rs` | PASS | Wave2 C: Node/Rust in-memory SQLite event/decision ledger, generation fences, duplicate/stale decisions and rollback native tests (`head_to_head_wave2_delivery.mjs`) |
| `src/interactive-invocation.ts` | `rust/src/interactive_invocation.rs` | PORTING | Serial Phase1 native interactive invocation Graph/Host and layered execution context port; uncompiled/untested, store integration Stage2. |
| `src/interactive-request.ts` | `rust/src/interactive_request.rs` | PORTING | Phase1 serial native Rust draft; uncompiled, untested and not production-wired; parity pending. |
| `src/interactive-resume.ts` | `rust/src/interactive_resume.rs` | PORTING | Phase1 serial native Rust draft; uncompiled, untested and not production-wired; parity pending. |
| `src/job-actions.ts` | `rust/src/job_actions.rs` | PORTING | Phase1 serial native Rust source port; uncompiled/unverified, production integration and head-to-head differential pending Phase2. |
| `src/job-execution-slot.ts` | `rust/src/job_execution_slot.rs` | PASS | 587 shared differential fixtures across 7 ports; Rust native tests 8/8; Node focused regression 18/18; clippy clean (`rust/tests/head_to_head.mjs`) |
| `src/job-local-repository-migration.ts` | `rust/src/job_local_repository_migration.rs` | PASS | Wave2 C: 34 Node/Rust temp Git/SQLite migration cases, preflight collisions/backup/atomic rewrite and native tests (`head_to_head_wave2_delivery.mjs`) |
| `src/job-pause.ts` | `rust/src/job_pause.rs` | PORTING | Phase1 serial first native Rust draft; uncompiled and untested; production API/wiring still requires parity closure. |
| `src/job-pr-number-migration.ts` | `rust/src/job_pr_number_migration.rs` | PASS | Direct hotfix: 2,401 combined Node/Rust Task/Job normalization fixtures, 190 in-memory SQLite migration histories, five native tests including JavaScript lone-surrogate escape fidelity (`rust/tests/head_to_head_legacy_migrations.mjs`, `rust/tests/native_job_pr_number_migration.rs`) |
| `src/job-task-id-sequence.ts` | `rust/src/job_task_id_sequence.rs` | PASS | Main repo-scoped Task and Job idempotency, 170 independent SQLite allocation histories, 240 grammar fixtures, 5 native tests plus cross-process concurrency (`rust/tests/head_to_head_job_task_id_sequence.mjs`, `rust/tests/native_job_task_id_sequence.rs`) |
| `src/job-worktree-cleanup.ts` | `rust/src/job_worktree_cleanup.rs` | PORTING | Wave4 C: bounded owned Git command effect; prior 142 real disposable Git/identity/path/dirty checks. Production canonical cwd resolver and legacy path/error mapping remain unverified (head_to_head_wave3_delivery.mjs; local_git_merge.rs). |
| `src/legacy-blocked-task-migration.ts` | `rust/src/legacy_blocked_task_migration.rs` | PASS | Direct hotfix: task lifecycle Node/Rust normalization, 190 in-memory SQLite update histories, four native tests (`rust/tests/head_to_head_legacy_migrations.mjs`, `rust/tests/native_legacy_blocked_task_migration.rs`) |
| `src/legacy-orchestrator-repair.ts` | `rust/src/legacy_orchestrator_repair.rs` | PORTING | Phase1 serial native Rust source port; uncompiled/unverified, production integration and head-to-head differential pending Phase2. |
| `src/local-authority-store.ts` | `rust/src/local_authority_store.rs` | PORTING | Phase1 serial native Store/SQLite authoritative facade over existing transaction/outbox primitives; UNCOMPILED UNTESTED, API parity Phase2. |
| `src/local-commit-events.ts` | `rust/src/local_commit_events.rs` | PASS | Direct port: 621 Node/Rust listener/clone/unsubscribe fixtures, 4 native tests for reentrancy, Set semantics, panic propagation (`rust/tests/head_to_head_local_commit_events.mjs`, `rust/tests/native_local_commit_events.rs`) |
| `src/local-git-merge.ts` | `rust/src/local_git_merge.rs` | PORTING | Wave4 C: 40 direct original Node/Rust real isolated Git merges, exact refs/SHA/error/idempotency; 30s owned process plus prior 270 Graph facts. Preemptive maxBuffer/error text and production completion Graph caller remain unverified (head_to_head_wave4_delivery_git.mjs; native_wave4_delivery.rs). |
| `src/local-job-path.ts` | `rust/src/local_job_path.rs` | PASS | Batch 5: configured, empty and absent store-directory override compared directly with Node including default home path (`rust/tests/head_to_head_batch5.mjs`) |
| `src/local-job-registry.ts` | `rust/src/local_job_registry.rs` | PORTING | Phase1 serial first native Rust draft; uncompiled and untested, production API/wiring still requires parity closure. |
| `src/local-managed-store.ts` | `rust/src/local_managed_store.rs` | PORTING | Phase1 serial first native Rust draft; uncompiled and untested; production API/wiring still requires parity closure. |
| `src/local-merge-delivery.ts` | `rust/src/local_merge_delivery.rs` | PORTING | Serial Phase1 native Rust port for authoritative Graph/SQLite and guarded Git side effects. UNCOMPILED/UNTESTED, finish production bindings in Phase2. |
| `src/local-merge-lock.ts` | `rust/src/local_merge_lock.rs` | PASS | Direct hotfix: real Node↔Rust cross-process directory locking, stale/foreign/live PID and owner recovery, timeout/error/panic-safe release (rust/tests/head_to_head_local_merge_lock.mjs; rust/tests/native_local_merge_lock.rs) |
| `src/local-merge-projection.ts` | `rust/src/local_merge_projection.rs` | PORTING | Serial Phase1 native Rust port for authoritative Graph/SQLite and guarded Git side effects. UNCOMPILED/UNTESTED, finish production bindings in Phase2. |
| `src/managed-worker-input.ts` | `rust/src/managed_worker_input.rs` | PORTING | Wave3 C native layered Agent resolver and 75 original Node prompt comparisons pass; daemon execution-context entrypoint integration unverified (head_to_head_wave3_delivery.mjs). |
| `src/manual-plan.ts` | `rust/src/manual_plan.rs` | PORTING | Phase1 serial native Rust draft; uncompiled and untested, production API/binding and differential to close in Phase2. |
| `src/markers.ts` | `rust/src/markers.rs` | PASS | Eight-file hotfix: 5,160 Node/Rust Job/Task/Plan/Agent HTML-comment render/parse cases, native round-trip/security tests; `rust/tests/head_to_head_eight_batch_*.mjs`, `rust/tests/native_eight_batch_*.rs` |
| `src/model-redecision.ts` | `rust/src/model_redecision.rs` | PORTING | Phase1 serial first native Rust draft; uncompiled and untested, production API/wiring still requires parity closure. |
| `src/model-routing.ts` | `rust/src/model_routing.rs` | PORTING | Serial Phase1 native Worker+Model routing policy, hard gates and source profile discovery port; uncompiled/unverified, decision audit/service binding Phase2. |
| `src/no-github.ts` | `rust/src/no_github.rs` | PASS | Main local-Git-only always-disabled mode with all four fail-closed GitHub transports, 900 Node/Rust flag fixtures and native tests (`rust/tests/head_to_head_no_github.mjs`, `rust/tests/native_no_github.rs`) |
| `src/observability.ts` | `rust/src/observability.rs` | PASS | Direct hotfix: 8,744 exact Node/Rust classification/redaction/correlation/environment fixtures; 6 Rust-native tests including interleaved Futures; 12 original Node regressions (rust/tests/head_to_head_observability.mjs; rust/tests/native_observability.rs) |
| `src/outcome-review.ts` | `rust/src/outcome_review.rs` | PORTING | Wave4 B: 500 randomized args/aggregate Node/Rust comparisons and native injected real file/role runner/exit-code effects. Full agent resolver, owned reviewer subprocess and production binding remain unverified (head_to_head_wave4_review_pure.mjs; outcome_review.rs). |
| `src/owned-process.ts` | `rust/src/owned_process.rs` | PORTING | Wave3 A isolated pipe/exit/timeout, waitpid stop-handshake and POSIX process-group tests pass; Windows taskkill, full SpawnOptions mapping and parent caller integration remain (native_wave3_graph.rs). |
| `src/planned-review-head.ts` | `rust/src/planned_review_head.rs` | PASS | 626 shared differential fixtures across 14 ports; head binding, exact prompt append, duplicate suppression, errors, and save count compared (`rust/tests/head_to_head.mjs`) |
| `src/planner-agent-roles.ts` | `rust/src/planner_agent_roles.rs` | PASS | 587 shared differential fixtures across 7 ports; Rust native tests 8/8; Node focused regression 18/18; clippy clean (`rust/tests/head_to_head.mjs`) |
| `src/planner-child-recovery.ts` | `rust/src/planner_child_recovery.rs` | PORTING | Phase1 serial native Rust source port; uncompiled/unverified, production integration and head-to-head differential pending Phase2. |
| `src/planner-child.ts` | `rust/src/planner_child.rs` | PASS | 355+ Node/Rust direct differential cases: field-by-field equality, absent/null, defaults, nested arrays/objects, Unicode, unrelated metadata; Rust native test (`rust/tests/head_to_head_planner_child.mjs`, `rust/src/planner_child.rs`) |
| `src/planner-history-cleanup.ts` | `rust/src/planner_history_cleanup.rs` | PASS | 626 shared differential fixtures across 14 ports; valid, missing, malformed, duplicate, and target-required payloads compared (`rust/tests/head_to_head.mjs`) |
| `src/planner-recovery.ts` | `rust/src/planner_recovery.rs` | PASS | Wave2 B/parent: sole exported recovery constructor, original Node vs Rust in isolated SQLite, idempotent Task IDs, second Plan, existing Task, wrong status, rollback rejection (`head_to_head_wave2_review_effects.mjs`) |
| `src/planner-runtime.ts` | `rust/src/planner_runtime.rs` | PORTING | Phase1 serial native Planner protocol and Graph-owned execution runtime source port; uncompiled/unverified, Stage2 API and differential closure pending. |
| `src/planner-task-context.ts` | `rust/src/planner_task_context.rs` | PASS | Batch 4: 729 shared differential cases across 23 source ports; bounded input/result/comment context, planner input omission, Unicode, and undefined-field JSON normalization (`rust/tests/head_to_head.mjs`) |
| `src/planner-task-ids.ts` | `rust/src/planner_task_ids.rs` | PASS | Wave2 C: direct randomized Node/Rust planner Task ID allocation, aliases and repeat idempotency; native global SQLite allocator (`head_to_head_wave2_delivery.mjs`) |
| `src/planner-task-title.ts` | `rust/src/planner_task_title.rs` | PASS | 327 shared differential fixtures across 4 ports; Rust native tests 5/5; Node focused regression 4/4; clippy clean (`rust/tests/head_to_head.mjs`) |
| `src/planner.ts` | `rust/src/planner.rs` | PORTING | Phase1 serial native Planner protocol and Graph-owned execution runtime source port; uncompiled/unverified, Stage2 API and differential closure pending. |
| `src/pool.ts` | `rust/src/pool.rs` | PORTING | Phase1 serial native Worker adapter/Repository Pool draft; not compiled/tested, Stage2 parity/wiring pending. |
| `src/process-identity.ts` | `rust/src/process_identity.rs` | PASS | Direct hotfix: real Node/Rust OS ps identity, isolated detached PGID leaders, lease owner inspection, stale generation fences and two actual disposable child-process terminations (rust/tests/head_to_head_process_identity.mjs; rust/tests/native_process_identity.rs) |
| `src/projected-store.ts` | `rust/src/projected_store.rs` | PORTING | Serial Phase1 Rust GitHub marker Store and retryable SQLite projection transport; UNCOMPILED/UNTESTED; Graph/production API parity Phase2. |
| `src/projection-failure-dedupe.ts` | `rust/src/projection_failure_dedupe.rs` | PASS | 626 shared differential fixtures across 14 ports; sequential duplicate/change/classification/reset vectors compared (`rust/tests/head_to_head.mjs`) |
| `src/projection-failure-recovery.ts` | `rust/src/projection_failure_recovery.rs` | PASS | Wave2 C: 12 Node/Rust optional remote projection failure/dedupe/error cases plus native no-Job-transition test (`head_to_head_wave2_delivery.mjs`) |
| `src/projection-outbox.ts` | `rust/src/projection_outbox.rs` | PASS | In-memory Node/Rust SQLite 52 seeded histories / 3,673 observations and 5 strict 39-operation rollback/ordering/idempotency/upgrade cases; rust/tests/head_to_head_worker_c_outbox.mjs, head_to_head_projection_outbox_strict.mjs |
| `src/projection-recovery-runtime.ts` | `rust/src/projection_recovery_runtime.rs` | EXCLUDED | Deleted in main; the old GitHub projection-recovery runtime is not part of the local-Git-only lifecycle. |
| `src/projection-recovery.ts` | `rust/src/projection_recovery.rs` | EXCLUDED | Deleted in main; retired GitHub PR projection repair does not own Job completion. |
| `src/publication-store.ts` | `rust/src/publication_store.rs` | PASS | Eight-file hotfix: Transactional delivery dedupe and monotonic Job publication state: 285 independent in-memory SQLite histories plus native tests; `rust/tests/head_to_head_eight_batch_*.mjs`, `rust/tests/native_eight_batch_*.rs` |
| `src/reconcile-coordinator.ts` | `rust/src/reconcile_coordinator.rs` | PORTING | Wave3 A explicit begin_turn batching adds 160 randomized same-turn Node/Rust cases to prior FIFO tests; implicit queueMicrotask scheduling at real Rust callers unproven (head_to_head_wave3_graph.mjs). |
| `src/reconciler-cancellation.ts` | `rust/src/reconciler_cancellation.rs` | PASS | Direct Node/Rust deterministic plan-first Graph-selected cancellation, generation source fence and callback order; rust/tests/head_to_head_process_browser_worker.mjs |
| `src/reconciler-context.ts` | `rust/src/reconciler_context.rs` | PORTING | Phase1 serial first native Rust draft; uncompiled and untested, production API/wiring still requires parity closure. |
| `src/reconciler-pause.ts` | `rust/src/reconciler_pause.rs` | PASS | Direct port: 905 Node/Rust generation-selection cases; 3 native tests; in-memory cancellation callbacks only (`rust/tests/head_to_head_reconciler_pause.mjs`, `rust/tests/native_reconciler_pause.rs`) |
| `src/reconciler-review.ts` | `rust/src/reconciler_review.rs` | PORTING | Phase1 serial native Dashboard SERVER, Final Review and Event Runtime first draft; UNCOMPILED/UNTESTED, Stage2 integration and parity. Dashboard browser client unchanged. |
| `src/reconciler-runtime.ts` | `rust/src/reconciler_runtime.rs` | PORTING | Phase1 serial native Dashboard SERVER, Final Review and Event Runtime first draft; UNCOMPILED/UNTESTED, Stage2 integration and parity. Dashboard browser client unchanged. |
| `src/reconciler-workflow-outbox.ts` | `rust/src/reconciler_workflow_outbox.rs` | PASS | Eight-module Graph/Outbox batch: 550 direct Node/Rust transport drain outcomes within SQLite outbox fixture histories; `rust/tests/head_to_head_graph_*.mjs`, `rust/tests/head_to_head_agent_graph.mjs`, `rust/tests/head_to_head_workflow_*.mjs`, `rust/tests/native_graph_outbox_batch.rs` |
| `src/reconciler.ts` | `rust/src/reconciler.rs` | PENDING | — |
| `src/registry.ts` | `rust/src/registry.rs` | PASS | Batch 4: 700 shared differential cases across 21 source ports; filtering, trust domains, labels, task-kind evidence, exploratory ordering and reliability ranking (`rust/tests/head_to_head.mjs`) |
| `src/relay-create.ts` | `rust/src/relay_create.rs` | PASS | Eight-file hotfix: Atomic SQLite create-if-absent and immutable metadata: 180 direct Node/Rust Job creation histories, native original Job and duplicate identity tests; `rust/tests/head_to_head_eight_batch_*.mjs`, `rust/tests/native_eight_batch_*.rs` |
| `src/relay-job-merge.ts` | `rust/src/relay_job_merge.rs` | PASS | Eight-file hotfix: Local-authored revision history + append-only Task comments: 440 Node/Rust inbound Job/Task/Plan merges, native provenance regression; `rust/tests/head_to_head_eight_batch_*.mjs`, `rust/tests/native_eight_batch_*.rs` |
| `src/relay-job-snapshot-reads.ts` | `rust/src/relay_job_snapshot_reads.rs` | PASS | Direct port: 400 Job metadata, 1,200 legacy Job normalization and 240 SQLite load/list Node/Rust fixtures; 4 native tests (`rust/tests/head_to_head_relay_job_snapshot_reads.mjs`, `rust/tests/native_relay_job_snapshot_reads.rs`) |
| `src/relay-store-discovery.ts` | `rust/src/relay_store_discovery.rs` | PORTING | Phase1 serial first native Rust draft; uncompiled and untested, production API/wiring still requires parity closure. |
| `src/relay-store.ts` | `rust/src/relay_store.rs` | PORTING | Phase1 serial native Store/SQLite authoritative facade over existing transaction/outbox primitives; UNCOMPILED UNTESTED, API parity Phase2. |
| `src/relay-workflow-operations.ts` | `rust/src/relay_workflow_operations.rs` | PASS | Wave2 A: 700 direct Node/Rust SQLite transactions/launch/outbox histories, three native rollback/idempotency/lease tests; `rust/tests/head_to_head_wave2_workflow_operations.mjs`, `native_wave2_workflow_operations.rs` |
| `src/relayd-control.ts` | `rust/src/relayd_control.rs` | PENDING | — |
| `src/relayd-dashboard-actions.ts` | `rust/src/relayd_dashboard_actions.rs` | PORTING | Phase1 Rust daemon-side Dashboard actions draft only; client HTML/CSS/JS frozen unchanged; uncompiled/unverified. |
| `src/relayd-main.ts` | `rust/src/relayd_main.rs` | PORTING | Phase1 serial first native Rust draft; uncompiled and untested, production API/wiring still requires parity closure. |
| `src/relayd-utilities.ts` | `rust/src/relayd_utilities.rs` | PORTING | Phase1 serial Rust SERVER-only source draft; uncompiled/unverified; preserve original Dashboard client HTML/CSS/JS. |
| `src/relayd.ts` | `rust/src/relayd.rs` | PENDING | — |
| `src/review-chair.ts` | `rust/src/review_chair.rs` | PASS | Wave2 B: all seven public runtime functions and 3,042 review-suite fixtures, invalid findings/panels, synthesis and attribution; 6 focused original Node Chair tests (`head_to_head_wave2_review.mjs`) |
| `src/review-evidence.ts` | `rust/src/review_evidence.rs` | PASS | Batch 4: 729 shared differential cases across 23 source ports; head precedence/fallback, finding aliases, malformed/null findings, trimming, Unicode and missing evidence (`rust/tests/head_to_head.mjs`) |
| `src/review-generation-fence.ts` | `rust/src/review_generation_fence.rs` | PASS | Main-only ACTIVE Job review fence, no projectionRecovery bypass; 1,950 randomized Node/Rust immutable review generations, 4 native regressions (`rust/tests/head_to_head_review_generation_fence.mjs`, `rust/tests/native_review_generation_fence.rs`) |
| `src/review-replan.ts` | `rust/src/review_replan.rs` | PORTING | Wave4 B: 1800 direct reviewWorkSettled and 1000 each reviewNeedsReplan/reviewPlanReady comparisons plus 350 randomized legacy cases. Legacy store ID allocation side effects and full production persisted generations remain unverified (scripts/head_to_head_wave4_review_b.mjs). |
| `src/review-revision-execution.ts` | `rust/src/review_revision_execution.rs` | PORTING | Wave4 B: 1050 direct randomized original Node/Graph vs Rust reconcile scenarios; prior real SQLite atomic/idempotent native tests. Publication failure order and malformed legacy persisted requests remain unverified (head_to_head_wave4_review_revision.mjs; native_wave3_review_store.rs). |
| `src/review-revision-merge.ts` | `rust/src/review_revision_merge.rs` | PASS | 626 shared differential fixtures across 14 ports; local history copy/delete and null handling compared (`rust/tests/head_to_head.mjs`) |
| `src/review-revision-model.ts` | `rust/src/review_revision_model.rs` | PORTING | Wave4 B: 720 randomized request/dependency vector and 1050 reconcile cases; prior SQLite ID/request/comment atomic rollback tests. Alternate stores and legacy JavaScript undefined/invalid fields remain unverified (head_to_head_wave4_review_revision.mjs; native_wave3_review_store.rs). |
| `src/review-revision-policy.ts` | `rust/src/review_revision_policy.rs` | PASS | Batch 4: 729 shared differential cases across 23 source ports; operator bounds/errors, normalized/deduplicated Unicode findings, SHA-256 identity, request-derived fingerprints and consecutive repeated rounds (`rust/tests/head_to_head.mjs`) |
| `src/review-revision-settlement.ts` | `rust/src/review_revision_settlement.rs` | PORTING | Wave3 B SQLite read/recheck/write settlement with stale-head rollback passes; multi-round ownership and concurrent Graph error edge parity incomplete (native_wave3_review_store.rs). |
| `src/review-revision-stale.ts` | `rust/src/review_revision_stale.rs` | PORTING | Wave3 B SQLite stale-cancel commit fence and zero post-failure side effects pass; actual owned-process cancel callback/failure wiring unverified (native_wave3_review_store.rs). |
| `src/review-terminal-normalization.ts` | `rust/src/review_terminal_normalization.rs` | PASS | Batch 4: 729 shared differential cases across 23 source ports; verdict aliases, required explicit head, findings preservation, blocked failure reason/default message (`rust/tests/head_to_head.mjs`) |
| `src/reviewer-thread.ts` | `rust/src/reviewer_thread.rs` | PORTING | Wave4 B: 7700 mixed API randomized direct Node/Rust comparisons (includes reviewer destinations, revision threads, empty reviewHeadSha fix), native legacy load/save and Wave3 SQLite atomic thread receipts. Real remote sender/timeouts/publication remain unverified (scripts/head_to_head_wave4_review_b.mjs). |
| `src/route-outcome-recording.ts` | `rust/src/route_outcome_recording.rs` | PORTING | Wave4 C: 180 randomized direct Node/Rust durable JSONL append/redaction, best-effort failure and multi-record cases; prior outcome classification. Full post-Graph/SQLite production audit caller sequencing remains unverified (head_to_head_wave4_delivery.mjs; native_wave4_delivery.rs). |
| `src/router-evals.ts` | `rust/src/router_evals.rs` | PORTING | Phase1 serial first native Rust draft; uncompiled and untested; production API/wiring still requires parity closure. |
| `src/router-rules.ts` | `rust/src/router_rules.rs` | PASS | Direct hotfix: 2,178 Node/Rust choices, routing-instruction byte preservation, Unicode whitespace, headers, duplicate routes, append helpers (rust/tests/head_to_head_direct_hotfix.mjs) |
| `src/routing-policy.ts` | `rust/src/routing_policy.rs` | PASS | Direct hotfix: 2,418 Node/Rust route eligibility/ranking/path fixtures; 20 isolated policy/rules file round-trips, SHA-256, sanitizer, missing/invalid files (rust/tests/head_to_head_routing_policy.mjs; rust/tests/native_routing_policy.rs) |
| `src/runtime-status-events.ts` | `rust/src/runtime_status_events.rs` | PASS | Direct port: 430 Node/Rust process-local change-event histories, original UUIDv4 and timestamp shape, two native tests (`rust/tests/head_to_head_runtime_status_events.mjs`, `rust/tests/native_runtime_status_events.rs`) |
| `src/runtime-status.ts` | `rust/src/runtime_status.rs` | PASS | Direct port: 4,500 Node/Rust status/implementation/supersession fixtures and four native regressions (`rust/tests/head_to_head_runtime_status.mjs`, `rust/tests/native_runtime_status.rs`) |
| `src/runtime-summary.ts` | `rust/src/runtime_summary.rs` | PASS | Direct port: 700 Node/Rust lease-fenced worker/model aggregation fixtures and three native regressions (`rust/tests/head_to_head_runtime_summary.mjs`, `rust/tests/native_runtime_summary.rs`) |
| `src/script-task-adapter.ts` | `rust/src/script_task_adapter.rs` | PORTING | Phase1 serial native Rust Script Agent and read-only CLI Prompt port; uncompiled/untested, API integration Phase2. |
| `src/service-external-actions.ts` | `rust/src/service_external_actions.rs` | PORTING | Phase1 serial first native Rust draft; uncompiled and untested, production API/wiring still requires parity closure. |
| `src/service-publication.ts` | `rust/src/service_publication.rs` | PASS | Wave2 C: exact SQLite commit/event receipt, dedupe and failed delivery paths with native failure test (`head_to_head_wave2_delivery.mjs`) |
| `src/single-job-task-control.ts` | `rust/src/single_job_task_control.rs` | PORTING | Phase1 serial first native Rust draft; uncompiled and untested, production API/wiring still requires parity closure. |
| `src/store-github.ts` | `rust/src/store_github.rs` | PORTING | Serial Phase1 Rust GitHub marker Store and retryable SQLite projection transport; UNCOMPILED/UNTESTED; Graph/production API parity Phase2. |
| `src/store-task-definition.ts` | `rust/src/store_task_definition.rs` | PASS | Eight-file hotfix: Immutable Task and Plan definitions, divergence and identity: 6,300 Node/Rust cases, native identity checks; `rust/tests/head_to_head_eight_batch_*.mjs`, `rust/tests/native_eight_batch_*.rs` |
| `src/store.ts` | `rust/src/store.rs` | PORTING | Phase1 serial native Store/SQLite authoritative facade over existing transaction/outbox primitives; UNCOMPILED UNTESTED, API parity Phase2. |
| `src/task-actions.ts` | `rust/src/task_actions.rs` | PORTING | Phase1 serial Rust native Task Graph/SQLite snapshot draft; compile and head-to-head differential deferred to Phase2. |
| `src/task-comments.ts` | `rust/src/task_comments.rs` | PASS | Direct hotfix: 2,620 Node/Rust comment append, context and stale snapshot fixtures; 5 native tests, original Node comment regressions (`rust/tests/head_to_head_task_comments.mjs`, `rust/tests/native_task_comments.rs`) |
| `src/task-context.ts` | `rust/src/task_context.rs` | PASS | Eight-file hotfix: Execution-bound read context, reviewer/troubleshooter history and exact reference prompt: 2,090 Node/Rust cases plus native stale-execution checks; `rust/tests/head_to_head_eight_batch_*.mjs`, `rust/tests/native_eight_batch_*.rs` |
| `src/task-id-migration.ts` | `rust/src/task_id_migration.rs` | PASS | Direct hotfix: 7 cloned SQLite Node/Rust migrations, 3 preflight refusals, verified constraint rollback + immutable backup, 4 native tests, 3 original Node regressions (rust/tests/head_to_head_task_id_migration.mjs; rust/tests/native_task_id_migration.rs) |
| `src/task-inactivity-watchdog.ts` | `rust/src/task_inactivity_watchdog.rs` | PORTING | Wave4 A: 500 randomized direct Node/Rust classification/deadline cases, native cancellation/re-arm/old-generation timers; Wave3 250 SQLite progress/idempotency cases. Full production timer/caller and transition wiring remain unverified (head_to_head_wave4_watchdog.mjs; native_wave4_graph.rs). |
| `src/task-recovery.ts` | `rust/src/task_recovery.rs` | PORTING | Phase1 serial native Rust draft; uncompiled and untested, production API/binding and differential to close in Phase2. |
| `src/task-tag.ts` | `rust/src/task_tag.rs` | PASS | Batch 4: 729 shared differential cases across 23 source ports; parse errors/limits, Unicode, allowed-tag filtering, data removal, and worker prompt (`rust/tests/head_to_head.mjs`) |
| `src/task-title.ts` | `rust/src/task_title.rs` | PASS | 327 shared differential fixtures across 4 ports; Rust native tests 5/5; Node focused regression 4/4; clippy clean (`rust/tests/head_to_head.mjs`) |
| `src/task-transitions.ts` | `rust/src/task_transitions.rs` | PORTING | Wave3 A async Task/Job Graph effect callback ordering and 180 Node/Rust cases pass; public durable transition runtime/production dispatcher binding unproven (head_to_head_wave3_graph.mjs). |
| `src/task-update.ts` | `rust/src/task_update.rs` | PORTING | Phase1 serial Task mutable-field/identity guard draft; uncompiled, untested, and not production-wired. |
| `src/terminal-event-recovery.ts` | `rust/src/terminal_event_recovery.rs` | PASS | 327 shared differential fixtures across 4 ports; Rust native tests 5/5; Node focused regression 4/4; clippy clean (`rust/tests/head_to_head.mjs`) |
| `src/troubleshooter-fallback.ts` | `rust/src/troubleshooter_fallback.rs` | PORTING | Wave4 B: canonical Graph-authorized SQLite atomic escalation state plus outbox intent, native idempotency and rollback 3/3; prior fallback native cases. Actual downstream human delivery and all legacy saveTask/concurrent request effects remain unverified (native_wave4_review_escalation.rs). |
| `src/troubleshooter-qa-api.ts` | `rust/src/troubleshooter_qa_api.rs` | PASS | Direct hotfix: 13 isolated real Node HTTP vs Rust request/response/file outcomes, SHA-256, UTF8 recovery, invalid inputs; Rust native IO regression (rust/tests/head_to_head_ipc_hotfix.mjs; rust/tests/native_ipc_hotfix.rs) |
| `src/troubleshooter.ts` | `rust/src/troubleshooter.rs` | PORTING | Phase1 serial native DAG Task projection and Troubleshooter recovery first port; uncompiled/unverified, production bindings Phase2. |
| `src/types.ts` | `rust/src/types.rs` | PORTING | Serial Phase1 native Rust wire contract and Worker Router first port; uncompiled and unverified, differential/binding Phase2. |
| `src/unblock.ts` | `rust/src/unblock.rs` | PORTING | Phase1 native Rust draft for Graph authority and Z WebHelm adapter request contract; uncompiled/unverified; no Dashboard client changes. |
| `src/unified-job-registry.ts` | `rust/src/unified_job_registry.rs` | PASS | Direct hotfix: 455 Node/Rust atomic SQLite registry/Job creation histories, 5 native immutable-repository and rollback tests (`rust/tests/head_to_head_unified_job_registry.mjs`, `rust/tests/native_unified_job_registry.rs`) |
| `src/unified-pr-facts.ts` | `rust/src/unified_pr_facts.rs` | PASS | Direct hotfix: 364 in-memory SQLite Node/Rust state-monotonic PR observations and Job scope scenarios; 3 Rust-native tests (`rust/tests/head_to_head_unified_pr_facts.mjs`, `rust/tests/native_unified_pr_facts.rs`) |
| `src/unified-relay-schema.ts` | `rust/src/unified_relay_schema.rs` | PASS | Direct Node SQL template, including hostInvocationTablesSql; 258 in-memory SQLite schema/index/FK/constraint comparisons, 4 native tests (`rust/tests/head_to_head_unified_relay_schema.mjs`, `rust/tests/native_unified_relay_schema.rs`) |
| `src/usage.ts` | `rust/src/usage.rs` | PORTING | Phase1 native owned GitHub CLI transport and provider usage/capacity readers port; UNCOMPILED UNTESTED, runtime API/parity closure Phase2. |
| `src/webhelm-daemon-client.ts` | `rust/src/webhelm_daemon_client.rs` | PASS | Direct hotfix: 15 real AF_UNIX Node/Rust socket response/timeout/abort/large-UTF8 fixtures, 1 malformed frame rejection, native cancellation/framing regression (rust/tests/head_to_head_ipc_hotfix.mjs; rust/tests/native_ipc_hotfix.rs) |
| `src/worker-failure-recovery.ts` | `rust/src/worker_failure_recovery.rs` | PORTING | Phase1 serial native Rust draft; uncompiled and untested, production API/binding and differential to close in Phase2. |
| `src/worker-rejection.ts` | `rust/src/worker_rejection.rs` | PASS | Batch 4: 729 shared differential cases across 23 source ports; rejection classes, all platform phases, typed pre-submit evidence and unsafe/ambiguous failures (`rust/tests/head_to_head.mjs`) |
| `src/worker-routing.ts` | `rust/src/worker_routing.rs` | PORTING | Serial Phase1 native Rust wire contract and Worker Router first port; uncompiled and unverified, differential/binding Phase2. |
| `src/worker-start-ack.ts` | `rust/src/worker_start_ack.rs` | PASS | Node/Rust exact job/task/source acknowledgment, spoof rejection, timeout, cancellation, unsubscribe ordering; rust/tests/head_to_head_process_browser_worker.mjs |
| `src/workflow-effect-failures.ts` | `rust/src/workflow_effect_failures.rs` | PORTING | Phase1 serial first native Rust draft; uncompiled and untested, production API/wiring still requires parity closure. |
| `src/workflow/action-ledger.ts` | `rust/src/workflow/action_ledger.rs` | PASS | Eight-file hotfix: Graph-approved effect reservations with immutable execution/lease/attempt fencing: 410 independent Node/Rust SQLite histories and 2 native tests; `rust/tests/head_to_head_eight_batch_*.mjs`, `rust/tests/native_eight_batch_*.rs` |
| `src/workflow/authoritative-conditions.ts` | `rust/src/workflow/authoritative_conditions.rs` | PASS | Wave2 A: direct in-memory SQLite process/lease/terminal predicate parity and native ended_at fencing; `rust/tests/head_to_head_wave2_graph.mjs` |
| `src/workflow/authoritative-unblock-v2.ts` | `rust/src/workflow/authoritative_unblock_v2.rs` | PASS | Graph policy + dispatcher batch: authoritative Task release Graph and action callback; 235 Node/Rust scenarios and native blocked guard; `rust/tests/head_to_head_graph_policy_batch.mjs`, `rust/tests/head_to_head_graph_dispatcher_verified.mjs`, `rust/tests/head_to_head_graph_observation.mjs`, `rust/tests/native_graph_policy_batch.rs` |
| `src/workflow/blocker-recovery.ts` | `rust/src/workflow/blocker_recovery.rs` | PASS | Graph policy + dispatcher batch: canonical blocker trust-boundary, adoption, registration, async effects; 235 Node/Rust scenarios; `rust/tests/head_to_head_graph_policy_batch.mjs`, `rust/tests/head_to_head_graph_dispatcher_verified.mjs`, `rust/tests/head_to_head_graph_observation.mjs`, `rust/tests/native_graph_policy_batch.rs` |
| `src/workflow/blocker-resolution-v2.ts` | `rust/src/workflow/blocker_resolution_v2.rs` | PASS | Graph policy + dispatcher batch: canonical blocker resolution, obsolete and draft release decisions; 235 Node/Rust scenarios; `rust/tests/head_to_head_graph_policy_batch.mjs`, `rust/tests/head_to_head_graph_dispatcher_verified.mjs`, `rust/tests/head_to_head_graph_observation.mjs`, `rust/tests/native_graph_policy_batch.rs` |
| `src/workflow/conditions.ts` | `rust/src/workflow/conditions.rs` | PASS | Batch 4: 729 shared differential cases across 23 source ports; tri-state guards, duplicate/unknown errors, sorted discovery, verification and safe-retry predicate (`rust/tests/head_to_head.mjs`) |
| `src/workflow/contracts.ts` | `rust/src/workflow/contracts.rs` | PASS | Direct hotfix: 2,178 shared Node/Rust event/fact/action inventories, ordered effect policies, classification, errors and empty decisions (rust/tests/head_to_head_direct_hotfix.mjs) |
| `src/workflow/definitions-v2.ts` | `rust/src/workflow/definitions_v2.rs` | PASS | Eight-module Graph/Outbox batch: 950 real Task/Job Graph topology transitions and 1,150 canonical Graph guard/decision cases; `rust/tests/head_to_head_graph_*.mjs`, `rust/tests/head_to_head_agent_graph.mjs`, `rust/tests/head_to_head_workflow_*.mjs`, `rust/tests/native_graph_outbox_batch.rs` |
| `src/workflow/dependency-revision-v2.ts` | `rust/src/workflow/dependency_revision_v2.rs` | PASS | Graph policy + dispatcher batch: canonical dependency-revision.mmd Graph event/state/guards; 235 randomized Node/Rust scenarios; `rust/tests/head_to_head_graph_policy_batch.mjs`, `rust/tests/head_to_head_graph_dispatcher_verified.mjs`, `rust/tests/head_to_head_graph_observation.mjs`, `rust/tests/native_graph_policy_batch.rs` |
| `src/workflow/dispatcher.ts` | `rust/src/workflow/dispatcher.rs` | PASS | Graph policy + dispatcher batch: Graph-owned dispatch, sync/async callback sequencing, transient path, structured observations, verified action lease/condition and SQLite atomic outbox; 760 + 280 + 230 Node/Rust differential scenarios; companion `dispatcher_verification.rs`; `rust/tests/head_to_head_graph_policy_batch.mjs`, `rust/tests/head_to_head_graph_dispatcher_verified.mjs`, `rust/tests/head_to_head_graph_observation.mjs`, `rust/tests/native_graph_policy_batch.rs` |
| `src/workflow/durable-publication.ts` | `rust/src/workflow/durable_publication.rs` | PASS | Eight-module Graph/Outbox batch: 550 direct Node/Rust SQLite outbox/inbox replay/commit/consumer histories and native rollback tests; `rust/tests/head_to_head_graph_*.mjs`, `rust/tests/head_to_head_agent_graph.mjs`, `rust/tests/head_to_head_workflow_*.mjs`, `rust/tests/native_graph_outbox_batch.rs` |
| `src/workflow/durable-transition.ts` | `rust/src/workflow/durable_transition.rs` | PORTING | Phase1 serial Rust native Task Graph/SQLite snapshot draft; compile and head-to-head differential deferred to Phase2. |
| `src/workflow/effects.ts` | `rust/src/workflow/effects.rs` | PASS | Direct hotfix: 762 stateful Node/Rust handler/receipt/onOutcome/observation fixtures; 8 Rust-native effect tests and 5 original Node regressions (rust/tests/head_to_head_workflow_effects.mjs; rust/tests/native_workflow_effects.rs) |
| `src/workflow/entity-creation.ts` | `rust/src/workflow/entity_creation.rs` | PASS | Eight-module Lifecycle batch: new Task/Job Graph activation, dependency validation and worker requirements, 780 Node/Rust fixtures; `rust/tests/head_to_head_lifecycle_batch.mjs` and `rust/tests/native_lifecycle_batch.rs` |
| `src/workflow/escalation.ts` | `rust/src/workflow/escalation.rs` | PASS | Eight-module Lifecycle batch: recovery/human escalation Graph exact action callback path, 340 Node/Rust scenarios; `rust/tests/head_to_head_lifecycle_batch.mjs` and `rust/tests/native_lifecycle_batch.rs` |
| `src/workflow/force-restate-validation-v2.ts` | `rust/src/workflow/force_restate_validation_v2.rs` | PASS | Graph policy + dispatcher batch: canonical Plan force-restate validation with transient check_ states; 235 Node/Rust scenarios; `rust/tests/head_to_head_graph_policy_batch.mjs`, `rust/tests/head_to_head_graph_dispatcher_verified.mjs`, `rust/tests/head_to_head_graph_observation.mjs`, `rust/tests/native_graph_policy_batch.rs` |
| `src/workflow/graph-v2.ts` | `rust/src/workflow/graph_v2.rs` | PASS | Eight-module Graph/Outbox batch: 1,100 strict Node/Rust Mermaid syntax/topology cases; 1,300 Graph runtime/dispatcher decisions and action receipts, companion parser `graph_v2_parser.rs`; `rust/tests/head_to_head_graph_*.mjs`, `rust/tests/head_to_head_agent_graph.mjs`, `rust/tests/head_to_head_workflow_*.mjs`, `rust/tests/native_graph_outbox_batch.rs` |
| `src/workflow/job-reconcile-v2.ts` | `rust/src/workflow/job_reconcile_v2.rs` | PASS | Eight-module Lifecycle batch: local Git-only Job reconcile and completion-fact projection, included in 1,400 lifecycle scenarios; `rust/tests/head_to_head_lifecycle_batch.mjs` and `rust/tests/native_lifecycle_batch.rs` |
| `src/workflow/lifecycle.ts` | `rust/src/workflow/lifecycle.rs` | PASS | Eight-module Lifecycle batch: Graph-owned Task/Job lifecycle decisions and exact mutation/persist actions, 1,400 Node/Rust multi-case suite; `rust/tests/head_to_head_lifecycle_batch.mjs` and `rust/tests/native_lifecycle_batch.rs` |
| `src/workflow/mermaid.ts` | `rust/src/workflow/mermaid.rs` | PASS | Direct hotfix: 924 Mermaid parser + 663 sync/async WorkflowEngine Node/Rust comparisons, real native callback/transition tests (rust/tests/head_to_head_mermaid.mjs; rust/tests/native_direct_hotfix.rs) |
| `src/workflow/orchestrator-rescue.ts` | `rust/src/workflow/orchestrator_rescue.rs` | PASS | Eight-module Lifecycle batch: legacy orphan execution safe quarantine/repair, 640 Node/Rust fixtures; `rust/tests/head_to_head_lifecycle_batch.mjs` and `rust/tests/native_lifecycle_batch.rs` |
| `src/workflow/planner-orchestration-v2.ts` | `rust/src/workflow/planner_orchestration_v2.rs` | PORTING | Wave4 A: exact Node/Rust GraphRuntime registry (17 states/13 guards/3 actions/1 event), 500 fact, 360 Graph decision, 210 async effect/error comparisons. Generic runtime edge cases and production planner entrypoint remain unverified (head_to_head_wave4_graph.mjs). |
| `src/workflow/planner-trigger-v2.ts` | `rust/src/workflow/planner_trigger_v2.rs` | PASS | Graph policy + dispatcher batch: canonical planner manual/unblock/review/initial path with transient check_ states; 235 Node/Rust scenarios; `rust/tests/head_to_head_graph_policy_batch.mjs`, `rust/tests/head_to_head_graph_dispatcher_verified.mjs`, `rust/tests/head_to_head_graph_observation.mjs`, `rust/tests/native_graph_policy_batch.rs` |
| `src/workflow/projection-conflict-v2.ts` | `rust/src/workflow/projection_conflict_v2.rs` | PASS | Graph policy + dispatcher batch: projection-conflict and historical outbox Graph; 470 Node/Rust scenarios with JS numeric retry guard; `rust/tests/head_to_head_graph_policy_batch.mjs`, `rust/tests/head_to_head_graph_dispatcher_verified.mjs`, `rust/tests/head_to_head_graph_observation.mjs`, `rust/tests/native_graph_policy_batch.rs` |
| `src/workflow/review-v2.ts` | `rust/src/workflow/review_v2.rs` | PASS | Eight-module Lifecycle batch: Review event/outcome, stale approval and exact Graph callback decisions, 820 Node/Rust scenarios; `rust/tests/head_to_head_lifecycle_batch.mjs` and `rust/tests/native_lifecycle_batch.rs` |
| `src/workflow/revision-v2.ts` | `rust/src/workflow/revision_v2.rs` | PASS | Graph policy + dispatcher batch: canonical Review revision lifecycle, authorized effects and immutable head checks; 235 Node/Rust scenarios; `rust/tests/head_to_head_graph_policy_batch.mjs`, `rust/tests/head_to_head_graph_dispatcher_verified.mjs`, `rust/tests/head_to_head_graph_observation.mjs`, `rust/tests/native_graph_policy_batch.rs` |
| `src/workflow/runtime.ts` | `rust/src/workflow/runtime.rs` | PASS | Eight-module Graph/Outbox batch: 1,160 Task/Job state mutations; 850 workflow Engine decisions and 90 no-start fallback semantic cases; `rust/tests/head_to_head_graph_*.mjs`, `rust/tests/head_to_head_agent_graph.mjs`, `rust/tests/head_to_head_workflow_*.mjs`, `rust/tests/native_graph_outbox_batch.rs` |
| `src/workflow/task-action-policy.ts` | `rust/src/workflow/task_action_policy.rs` | PASS | Eight-module Lifecycle batch: cancellation scope from related Task Graph, included in 760 fixtures; `rust/tests/head_to_head_lifecycle_batch.mjs` and `rust/tests/native_lifecycle_batch.rs` |
| `src/workflow/task-reconcile.ts` | `rust/src/workflow/task_reconcile.rs` | PASS | Wave2 A: dependency-ready, full cycle detection and Graph-authorized reconciliation compared against Node including negative/corrupt fixtures; `head_to_head_wave2_graph.mjs`, `native_wave2_graph.rs` |
| `src/workflow/task-related-action-v2.ts` | `rust/src/workflow/task_related_action_v2.rs` | PASS | Eight-module Lifecycle batch: authoritative Task related facts, transient Graph decisions and cancel source, 760 Node/Rust fixtures; `rust/tests/head_to_head_lifecycle_batch.mjs` and `rust/tests/native_lifecycle_batch.rs` |
| `src/workflow/task-resolution.ts` | `rust/src/workflow/task_resolution.rs` | PORTING | Wave4 A: 160 randomized cases across seven helper APIs and 350 direct Node/Rust sync/async Graph effect, rejection and ownership cases; malformed dependencies now fail closed. Concurrent production durable caller/observer paths remain unverified (head_to_head_wave4_graph.mjs). |
| `src/workflow/troubleshooter-v2.ts` | `rust/src/workflow/troubleshooter_v2.rs` | PASS | Graph policy + dispatcher batch: canonical Troubleshooter action, current execution and recovery boundary; 235 Node/Rust scenarios; `rust/tests/head_to_head_graph_policy_batch.mjs`, `rust/tests/head_to_head_graph_dispatcher_verified.mjs`, `rust/tests/head_to_head_graph_observation.mjs`, `rust/tests/native_graph_policy_batch.rs` |
| `src/workflow/usage-index.ts` | `rust/src/workflow/usage_index.rs` | PASS | Eight-module Graph/Outbox batch: 628 canonical Mermaid symbol usages and 480 synthetic reverse index and filter fixtures; `rust/tests/head_to_head_graph_*.mjs`, `rust/tests/head_to_head_agent_graph.mjs`, `rust/tests/head_to_head_workflow_*.mjs`, `rust/tests/native_graph_outbox_batch.rs` |
| `src/workspace.ts` | `rust/src/workspace.rs` | PORTING | Phase1 native CLI immutable Job bindings, HTTP control, Git workspace identity/worktree port; no compilation/tests; Stage2 head-to-head pending. |
| `src/z-adapter.ts` | `rust/src/z_adapter.rs` | PORTING | Phase1 native Rust draft for Graph authority and Z WebHelm adapter request contract; uncompiled/unverified; no Dashboard client changes. |
| `src/z-oauth.ts` | `rust/src/z_oauth.rs` | PORTING | Wave3 C real local fake HTTP PKCE/redirect/revoke flow and prior mocked negatives pass; production HTTPS provider/TLS/identity environment integration unverified (head_to_head_wave3_delivery.mjs). |

## Port notes

- Baseline is pinned, but each source port must re-check any subsequent Node main changes before calling itself equivalent.
- Never silently mark a test passed; include command, case fixture and output in evidence.
- Do not change Node `src/`, `test/`, `workflow/`, or deploy running services while the new Rust port is incomplete.

## Verified head-to-head batches

### Batch 1 — pure Node helpers (2026-11-16)

- [x] `src/task-title.ts` → `rust/src/task_title.rs`: JS whitespace, prefix removal, UTF-16 truncation including unmatched surrogate serializations.
- [x] `src/planner-task-title.ts` → `rust/src/planner_task_title.rs`: required string, whitespace trimming, 5–8-word validation, exact errors.
- [x] `src/dependency-validity.ts` → `rust/src/dependency_validity.rs`: valid/invalid policies, declared edges, object-property ordering, `__proto__`.
- [x] `src/terminal-event-recovery.ts` → `rust/src/terminal_event_recovery.rs`: recovery guard truth table and exact reminder text.
- [x] `npm run build` — rebuilt authoritative Node baseline before comparison.
- [x] `node --test rust/tests/head_to_head.mjs` — **327/327** Node/Rust cases matched, including negative/error outcomes.
- [x] `cargo test --offline --manifest-path rust/Cargo.toml` — **5/5** Rust-native tests passed.
- [x] `cargo clippy --offline --manifest-path rust/Cargo.toml --all-targets -- -D warnings` — passed.
- [x] `node --import ./test/test-store-env.mjs --test test/dependency-validity.test.js test/terminal-event-recovery.test.js` — **4/4** Node regressions passed in isolated store.

After Batch 1, ported source modules: **4 / 227**. The CLI used by this batch is a test-only differential entry point, **not** the runtime/daemon, dashboard, workflow, Graph, scheduler or SQLite service. Those remain `PENDING` until directly ported and verified.

### Batch 2 — role and active-execution slot rules (2026-11-16)

- [x] `src/final-review-role.ts` → `rust/src/final_review_role.rs`: canonical review identity and legacy reviewer alias.
- [x] `src/planner-agent-roles.ts` → `rust/src/planner_agent_roles.rs`: duplicate role protection and Final Review ownership rejection.
- [x] `src/job-execution-slot.ts` → `rust/src/job_execution_slot.rs`: Planner slot, coordinator slot exemption, sibling DAG concurrency, unrelated Task exclusion and interactive waits.
- [x] `node --test rust/tests/head_to_head.mjs` — **587/587** Node/Rust differential cases matched across seven ports, with errors and negative cases.
- [x] `cargo test --offline --manifest-path rust/Cargo.toml` — **8/8** native Rust tests passed.
- [x] `cargo clippy --offline --manifest-path rust/Cargo.toml --all-targets -- -D warnings` — passed.
- [x] `node --import ./test/test-store-env.mjs --test test/dependency-validity.test.js test/terminal-event-recovery.test.js test/targeted-revision-execution.test.js test/interactive-invocation.test.js` — **18/18** Node regression tests passed in isolated store.

Current verified source modules: **7 / 227**; remaining: **220**. These checks verify ported functions only, not end-to-end Relay daemon or scheduler compatibility.

### Batch 3 — GitHub projection, merge, and review-history effects (2026-11-16)

- [x] `src/github-branch-projection.ts` → `rust/src/github_branch_projection.rs`: normal push and force-with-lease argument construction.
- [x] `src/cli-local-merge-config.ts` → `rust/src/cli_local_merge_config.rs`: valid local merge configuration and exact validation failures.
- [x] `src/review-revision-merge.ts` → `rust/src/review_revision_merge.rs`: SQLite review history preservation and deletion semantics.
- [x] `src/github-binding-order.ts` → `rust/src/github_binding_order.rs`: priority ordering and stable timestamp tie ordering.
- [x] `src/planner-history-cleanup.ts` → `rust/src/planner_history_cleanup.rs`: optional payload parsing, field validation, duplicate rejection, and target requirements.
- [x] `src/projection-failure-dedupe.ts` → `rust/src/projection_failure_dedupe.rs`: terminal fault dedupe, classification reset, changed-version behavior, and explicit instance reset sequences.
- [x] `src/planned-review-head.ts` → `rust/src/planned_review_head.rs`: immutable head assignment, exact rule append/deduplication, missing-head failure, and save effect.
- [x] `node --test rust/tests/head_to_head.mjs` — **626/626** Node/Rust differential cases matched across fourteen ports, including negative and sequential stateful cases.
- [x] `cargo test --offline --manifest-path rust/Cargo.toml` — **8/8** Rust-native tests passed.
- [x] `cargo clippy --offline --manifest-path rust/Cargo.toml --all-targets -- -D warnings` — passed.
- [x] Focused Node regressions: authoritative branch projection **1/1**, GitHub binding/review-head/projection-dedupe **4/4**.
- [ ] Broader `test/core.test.js` run — **177/192** passed; 15 CLI subprocess tests failed (missing descendant PID file and child exit-code mismatches), so this is not recorded as a batch pass.

Current verified source modules: **14 / 227**; remaining: **213**. Node integration effects remain part of the Node application; this batch verifies the listed Rust source ports, not end-to-end Relay runtime compatibility.

### Independent adversarial review for Batch 3 (2026-11-16)

- [x] `node --test rust/tests/head_to_head.mjs rust/tests/head_to_head_adversarial.mjs` — **626 + 4132 = 4758** direct Node/Rust differential cases passed.
- [x] `cargo test --offline --manifest-path rust/Cargo.toml` — **15/15** Rust native cases passed.
- [x] `cargo clippy --offline --manifest-path rust/Cargo.toml --all-targets -- -D warnings` — clean.
- [x] Explicit `null` cleanup target rejected exactly as Node; mixed-case/diacritic ordering verified using macOS `en_US.UTF-8` POSIX collation; 4096-entry dedupe eviction verified. On non-macOS, non-ISO date-string collation still requires explicit cross-platform validation; canonical `createdAt` ISO values retain lexicographic parity.

### Batch 4 — DAG contracts, review policy, worker, registry, tag and condition helpers (2026-11-16)

- [x] `src/review-evidence.ts` → `rust/src/review_evidence.rs`.
- [x] `src/worker-rejection.ts` → `rust/src/worker_rejection.rs`.
- [x] `src/task-tag.ts` → `rust/src/task_tag.rs`.
- [x] `src/review-terminal-normalization.ts` → `rust/src/review_terminal_normalization.rs`.
- [x] `src/planner-task-context.ts` → `rust/src/planner_task_context.rs`.
- [x] `src/review-revision-policy.ts` → `rust/src/review_revision_policy.rs`.
- [x] `src/registry.ts` → `rust/src/registry.rs`.
- [x] `src/workflow/conditions.ts` → `rust/src/workflow/conditions.rs`.
- [x] `src/dag-stage-contract.ts` → `rust/src/dag_stage_contract.rs`, using isolated filesystem fixtures and a mocked execution callback; no real validator process is launched.
- [x] `node --test rust/tests/head_to_head.mjs` — **729/729** exact Node/Rust cases passed across 23 mapped source ports, including errors and serialized output.
- [x] `cargo test --offline --manifest-path rust/Cargo.toml` — **15/15** Rust native tests passed.
- [x] `cargo clippy --offline --manifest-path rust/Cargo.toml --all-targets -- -D warnings` — passed.
- [x] Focused isolated-store Node regressions — **15/15** passed (`workflow-conditions`, `worker-rejection`, `task-tag`, `reviewer-failure-normalization`, `review-revision-policy`, `workflow-action-integration`, `workflow-action-ledger`).
- [x] `node scripts/rust2-checklist-verify.mjs` — validated all 227 ledger rows; **PASS=23**, **PENDING=204**.

Reproduce from the repository root: `cargo fmt --manifest-path rust/Cargo.toml`; `npm run build`; `node --test rust/tests/head_to_head.mjs`; `cargo test --offline --manifest-path rust/Cargo.toml`; `cargo clippy --offline --manifest-path rust/Cargo.toml --all-targets -- -D warnings`; `node --import ./test/test-store-env.mjs --test test/workflow-conditions.test.js test/worker-rejection.test.js test/task-tag.test.js test/reviewer-failure-normalization.test.js test/review-revision-policy.test.js test/workflow-action-integration.test.js test/workflow-action-ledger.test.js`; `node scripts/rust2-checklist-verify.mjs`.

### Batch 4 independent adversarial self-review (2026-11-16)

- [x] Fixed Node regex semantics for Worker rejection messages with mixed `_ .-` separators, after six independent differential mismatches.
- [x] Fixed the five remaining UTF-16 truncation mismatches via lossless `planner_task_context_json_wire`; `serde_json::Value` cannot represent an unmatched JS surrogate, so HTTP/CLI JSON outputs use explicit `\uXXXX` escapes where needed.
- [x] Added native Graph `ConditionSpec` callbacks and `ConditionRegistry::new_custom` so guards can evaluate caller-supplied conditions, not only boolean JSON descriptors.
- [x] `node --test rust/tests/head_to_head.mjs rust/tests/head_to_head_adversarial.mjs rust/tests/head_to_head_batch4_edge.mjs`: **729 + 4132 + 70 = 4931** matching Node/Rust differential cases (including independent adversarial cases).
- [x] `cargo test --offline --manifest-path rust/Cargo.toml`: **19/19** Rust-native tests pass across earlier and Batch 4 tests.
- [x] `cargo clippy --offline --manifest-path rust/Cargo.toml --all-targets -- -D warnings` clean.

### Batch 5 — local path, CLI effects, execution lock and audit tail (2026-11-16)

- [x] `src/local-job-path.ts` → `rust/src/local_job_path.rs`.
- [x] `src/cli-shutdown.ts` → `rust/src/cli_shutdown.rs`, with delayed detached force-exit callback and injectable callback boundary.
- [x] `src/cli-workflow-action.ts` → `rust/src/cli_workflow_action.rs`.
- [x] `src/execution-boundary.ts` → `rust/src/execution_boundary.rs`.
- [x] `src/audit-tail.ts` → `rust/src/audit_tail.rs`.
- [x] `node --test rust/tests/head_to_head_batch5.mjs` — **5/5** differential/behavioral cases passed; shutdown uses an injected callback to protect the Node test process.
- [x] Native controlled Rust tests — **2/2** passed, including execution-boundary same-key ordering/different-key concurrency/error release and delayed injected shutdown callback.
- [x] `scripts/rust2-verify.sh` — passed: Rust fmt, **21/21** native Rust cases, clippy with warnings denied, and **4936** total Node/Rust cases across all four differential suites.
- [x] `npm run build --silent` — passed before focused Batch 5 comparison.

Current verified source modules: **28 / 227**; remaining: **199**. The parity CLI remains a test-only differential entry point, not the Relay runtime or service.

### Batch 6 — artifact validation, QA API, WebHelm IPC and graph inspection (2026-11-16)

- `src/cli-artifact.ts` → `rust/src/cli_artifact.rs`: filesystem-backed JSON and a partial JSON Schema validator. **PENDING** because Ajv keyword/format/reference parity is incomplete; supported basic object/property/required/type/minLength/enum cases were differential-tested.
- `src/troubleshooter-qa-api.ts` → `rust/src/troubleshooter_qa_api.rs`: filesystem-backed GET/PUT and SHA-256 handling. **Subsequently PASS** following isolated real Node HTTP differential and Rust-native QA tests.
- `src/webhelm-daemon-client.ts` → `rust/src/webhelm_daemon_client.rs`: native IPC framing and error/timeout handling. **Subsequently PASS** after real AF_UNIX listening was independently available on Neo Master and Node/Rust socket differential cases passed.
- `src/dashboard-workflow-inspection.ts` → `rust/src/dashboard_workflow_inspection.rs`: read-only graph token inspection and path-confined source/test references. **PASS**: Node/Rust differential fixture and native traversal test pass.
- `node --test rust/tests/head_to_head_batch6.mjs`: 2 differential tests passed; 1 Unix socket test skipped due sandbox `EPERM`.
- Focused Node regressions: artifact validation **1/1**; graph symbol inspection/source references **2/2**. The entire `test/dashboard.test.js` invocation was attempted: **90/108 passed**, with 18 HTTP listener tests blocked by sandbox `listen EPERM`; graph inspection tests passed.
- `cargo test --offline --manifest-path rust/Cargo.toml`: **25/25** native tests pass (including Batch 6).

### Direct Rust2 hotfix — router, canonical workflow contracts and Mermaid Engine (2026-11-16)

- [x] `src/router-rules.ts` → `rust/src/router_rules.rs`: explicit route parsing and deduplication; verbatim instruction body (CRLF, blank lines and Unicode separators); appended advisory preferences.
- [x] `src/workflow/contracts.ts` → `rust/src/workflow/contracts.rs`: all runtime event/fact/action inventories, effect policies, action classifications and decision factory.
- [x] `src/workflow/mermaid.ts` → `rust/src/workflow/mermaid.rs`: executable diagram parser; duplicate/ambiguous transition rejection; callback binding validation; synchronous and asynchronous guards/actions; same error messages and transition decisions.
- [x] `rust/tests/head_to_head_direct_hotfix.mjs`: **2,178** Node/Rust differential fixtures, including adversarial Unicode/line-terminator and negative/error cases.
- [x] `rust/tests/head_to_head_mermaid.mjs`: **924** parser and **663** WorkflowEngine Node/Rust cases; no durable store or production execution used.
- [x] `rust/tests/native_direct_hotfix.rs`: five Rust-native callback, error propagation, ordering and parser regression cases.
- [x] Reviewed and corrected JavaScript vs Rust regex Unicode whitespace differences before marking PASS.

The three module ports verify standalone executable mechanics; they do not establish that all CLI, Graph orchestration, Scheduler, Dashboard and live E2E features have reached production parity.

### Direct Rust2 hotfix — Routing Policy persistence and ranking (2026-11-16)

- [x] `src/routing-policy.ts` → `rust/src/routing_policy.rs`: Node-authored Router Rules adapter reuse, policy sanitization, SHA-256 of file content, raw JSON snapshots, optional home/env paths and real filesystem read/write in isolated test fixtures.
- [x] `rust/tests/head_to_head_routing_policy.mjs`: **2,418** independent eligibility, rank and path cases, plus **20** file I/O and JSON-policy snapshot cases against the built Node reference.
- [x] Native Rust regression tests cover invalid policy fields, profile/provider/quality ranking, file persistence and missing policy fallback.
- [x] Tests compare JSON-wire snapshots; Node's `undefined` object fields are omitted by JSON serialization and are not durable policy data.

Production Node.js Relay was not restarted or replaced; no canonical SQLite store or customer policy file was used.

### Direct Rust2 hotfix — Troubleshooter HTTP and WebHelm Unix IPC verification (2026-11-16)

- [x] `src/troubleshooter-qa-api.ts` → `rust/src/troubleshooter_qa_api.rs`: request/status/headers/body and actual file mutations on separately isolated Q&A markdown paths, including invalid UTF-8, SHA-256 conflicts, over-limit payloads, unsupported methods and missing file.
- [x] `src/webhelm-daemon-client.ts` → `rust/src/webhelm_daemon_client.rs`: actual Node and Rust clients against a disposable AF_UNIX mock server with matching requests, valid/invalid frames, JS truthy error coercions, timeouts, AbortSignal-equivalent cancellation and large UTF-8/UTF-16 payloads. No real WebHelm daemon or session used.
- [x] `rust/tests/head_to_head_ipc_hotfix.mjs`: **13** real HTTP comparisons, **15** real AF_UNIX comparisons and **1** malformed-frame rejection, comparing parsed JSON and sha256 digest of large payloads.
- [x] `rust/tests/native_ipc_hotfix.rs`: invalid UTF-8 QA hash, live UnixStream cancellation and truthy error regression tests.
- [x] Existing partial `src/cli-artifact.ts` remains **PENDING** because the Rust schema validator does not fully implement Node Ajv and must not be marked complete from basic schema fixtures.

These tests verify isolated protocol behavior but do not count as a production daemon cutover or an actual WebHelm deployment.

### Direct Rust2 hotfix — cross-process local Git merge lock (2026-11-16)

- [x] `src/local-merge-lock.ts` → `rust/src/local_merge_lock.rs`: atomic owner.json creation with mode 0600, PID/host/UTC timestamp, stable SHA-256 ref identity, 50-ms retry, 3-second stale grace, quarantined stale recovery lock, ownership-aware release.
- [x] `rust/tests/head_to_head_local_merge_lock.mjs`: real isolated filesystem head-to-head tests for uncontended/failing actions, both Node-holds-Rust-waits and Rust-holds-Node-waits processes, stale/crashed/malformed owner, active PID, foreign host and recent incomplete owner fencing.
- [x] `rust/tests/native_local_merge_lock.rs`: Rust panic-unwind release, different refs without contention, successor-owner preservation and SHA-256 lock naming.
- [x] No production Git lock directories or real Relay worktrees used; fixtures are disposable temporary directories.

### Direct Rust2 hotfix — process generation identity and orphan-group signals (2026-11-16)

- [x] `src/process-identity.ts` → `rust/src/process_identity.rs`: 1.5-second bounded `ps` observation, PGID/start-token matching to prevent PID reuse, process snapshot (UTC ISO timestamp), active Relay lease owner matching, and safe SIGTERM→SIGKILL only for validated local, leader-generation records.
- [x] `rust/tests/head_to_head_process_identity.mjs`: actual Node/Rust observations of freshly launched, disposable process-group leaders, wrong-host/PGID/token refusal, nonexistent/range PID probes, and real process termination verified separately for Node and Rust. Test never signals any production daemon or non-fixture PID.
- [x] `rust/tests/native_process_identity.rs`: negative PID and wrong-host generation safety checks.
- [x] Corrected out-of-range `process.kill(pid,0)` fallback to fail closed as `unknown`, and matched `pid=0` or negative PID probe behavior without transmitting a signal.

Only isolated, specifically created process groups were terminated in verification. Production Relay processes and leases remain unchanged.

### Direct Rust2 hotfix — static Dashboard CSS (2026-11-16)

- [x] `src/dashboard-style.ts` → `rust/src/dashboard_style.rs`: copy the actual compiled Node template-string contents as a Rust native static `&str`, not as a runtime dependency on JavaScript or a placeholder.
- [x] `rust/tests/head_to_head_dashboard_style.mjs`: assert every one of the **25,275** output bytes matches Node's runtime value, with SHA-256 `676e173854d712a21bf4cf0a3dfaa59bf015a458ce9a2b54d8e632a082a56c34`.
- [x] This verifies only the static stylesheet; Dashboard dynamic HTML, JEL, tabs, server APIs and live browser E2E are separately pending.

### Direct Rust2 hotfix — dynamic Dashboard JEL graph (2026-11-16)

- [x] `src/dashboard-jel.ts` → `rust/src/dashboard_jel.rs`: Node-authored Plan/Execute/Review/Merge/Job graph and Stage-DAG dependencies, worker execution duration, retry/failure/troubleshooter diagnostics, review revision rounds and safe Mermaid labels.
- [x] `rust/tests/head_to_head_dashboard_jel.mjs`: **1,429** fixed-clock Node/Rust comparisons, including adversarial Unicode/URL sanitization, ISO dates with and without timezone, future/invalid dates, mixed integer/float attempts and zero/missing Plan rounds.
- [x] For JavaScript `slice(0, 80)` boundaries that split an astral letter, Rust JSON-wire projection emits the exact lone UTF-16 surrogate escape; native display safely renders such data as a replacement glyph.
- [x] `rust/tests/native_dashboard_jel.rs`: basic graph lifecycle, task parent/dependency edges, retry/failed classes, duration, safe labels and UTF-16 wire behavior.
- [x] `node --import ./test/test-store-env.mjs --test test/dashboard-jel.test.js test/dashboard.test.js`: **114/114** focused Node regressions passed with isolated SQLite store and ephemeral dashboard HTTP fixture.

This is only the Job JEL graph projection; Dashboard HTTP routing, additional tabs and live browser parity remain separate PENDING items.

### Direct Rust2 hotfix — execution-bound Agent Prompt Builder (2026-11-16)

- [x] `src/agent-prompt-builder.ts` → `rust/src/agent_prompt_builder.rs`: implement **all seven exported functions** natively: `isPromptReferenceAccessible`, `buildAgentPrompt`, `promptFileReference`, `renderAgentPrompt`, `snapshotAgentInstructions`, `buildReferenceFirstPrompt`, and `buildRelayWorkPrompt`.
- [x] New Rust source begins with the Node provenance and rationale. Hash exact raw bytes using SHA-256; preserve source role vs user/Task data boundary, immutable snapshot path, reference-first strict vs fallback policy, project context ordering, contracts, execution-bound event source, Planner vs Task instructions, and independent worker self-review requirements.
- [x] `rust/tests/head_to_head_agent_prompt_builder.mjs`: **1,100** deterministic pure Node/Rust prompt/render cases, **220** reference-first cases, **150** full execution Prompt cases, and real isolated file/symlink/access/permission/error/digest-mismatch scenarios. Node-compatible `fs.access(path)` default is **F_OK**, not R_OK; this was corrected by differential testing.
- [x] `rust/tests/native_agent_prompt_builder.rs`: **5** native tests for immutable snapshot/permissions, trusted vs untrusted roles, strict fail-closed hash check, job/task/execution binding, and invalid arguments.
- [x] Original Node tests `test/agent-prompt-builder.test.js`, `test/agent-prompt-model-only.test.js`, `test/managed-prompt-assembly.test.js`, and `test/prompt-action-parity.test.js`: **19/19 PASS** with an isolated SQLite store.
- [x] Filesystem fixtures are disposable temporary directories. No production Agent prompt snapshots, process services, or Relay Jobs were modified.

### Direct Rust2 hotfix — layered Agent Content Resolver (2026-11-16)

- [x] `src/agent-content-resolver.ts` → `rust/src/agent_content_resolver.rs`: both exported functions `agentSourceLayers` and `resolveAgentMarkdown` implemented natively. Resolves builtin → global/shared → ancestor workspace → project Agent layers with deterministic path precedence and metadata, SHA-256 of merged Markdown, and strict symlink/realpath confinement.
- [x] Full Node frontmatter scalar/list grammar, `extends: relay/<name>`, shared same-name/cross-name inheritance, author-supplied absolute Markdown base, standalone replacement, nested `sections.replace` / `sections.extend`, duplicate heading rejection, and source-anchored Markdown links without importing linked document contents.
- [x] `rust/tests/head_to_head_agent_content_resolver.mjs`: **500** hierarchy path/deduplication fixtures; **252** real isolated file inheritance/section/validation cases; **120** true global/shared/workspace/parent/project multilevel Agent snapshots.
- [x] Differential self-review fixed Node vs Rust edge behavior: empty line within section frontmatter retains section parsing; quote stripping removes a single delimiter at each end, not all quotes; separately matched later YAML metadata; `\s` vs JavaScript Unicode whitespace semantics for Markdown links, headings and fenced code.
- [x] `rust/tests/native_agent_content_resolver.rs`: **5** Rust-native tests for ordered source roots, nested replace/extend, anchored links, symlink boundary, cross-name shared inheritance, and unknown Agent.
- [x] Original Node regression tests (`test/agent-content-resolver.test.js`, `test/agent-prompt-builder.test.js`, `test/managed-prompt-assembly.test.js`) **18/18 PASS**, with isolated SQLite and ephemeral project directories. No production Agent files, live Relay daemon or Jobs touched.

### Direct Rust2 hotfix — one-time numeric Task ID migration (2026-11-16)

- [x] `src/task-id-migration.ts` → `rust/src/task_id_migration.rs`: native `rusqlite` backup API and an **IMMEDIATE atomic transaction** for offline-only numeric Task-ID migration; no Node.js runtime or SQLite private-store shortcut.
- [x] Check `ACTIVE` Jobs and already-migrated marker before backup; verify backup `PRAGMA integrity_check` and snapshot count before any write. Preserve backup on later transaction failure; reject preexisting backup, invalid Task IDs and source=backup.
- [x] Globally allocate numeric Task IDs by deterministic Job ordering; preserve all duplicate historical Planner records while mapping references to the first chronological owner; update snapshot JSON and nested Task/Plan/revision/DAG references, relational ledgers, scoped JSON columns, Events Bus outbox, idempotency reservations and global Task sequence.
- [x] Two-phase intermediate rowid rekeying prevents transient UNIQUE/PK collisions. Transaction rollback preserves original SQLite state if any table/check fails; failed offline migration never sets completion marker.
- [x] `rust/tests/head_to_head_task_id_migration.mjs`: **7** complete migrations of independently cloned disposable SQLite databases (including duplicate IDs, cross-Job collisions, Unicode IDs, outbox, JSON, sequence), **3** fail-closed preflights, and late CHECK-constraint rollback compared against the original Node implementation; compare every SQLite table and backup snapshot.
- [x] `rust/tests/native_task_id_migration.rs`: **4** native tests for verified pre-write backup and one-time execution, ACTIVE preflight, collision-free relational renaming, and full atomic rollback.
- [x] Original Node `test/task-id-migration.test.js` **3/3 PASS** with isolated SQLite fixtures. No production SQLite files or live Relay writers accessed, stopped, or migrated.

### Direct Rust2 hotfix — observational-only lifecycle logging (2026-11-16)

- [x] `src/observability.ts` → `rust/src/observability.rs`: all public runtime behaviors exported as native Rust equivalents: `errorMessage`, `classifyFailure`, `sanitizeObservationValue`, `sanitizeObservationData`, synchronous `withObservabilityCorrelation`, `currentObservabilityCorrelation`, `RelayObservability`, `observability`, `setObservability`, `collectObservations` and documented constants.
- [x] Redact sensitive/credential/Prompt key names before recursing; preserve object depth, 512-unit JavaScript string bound, 20-item arrays, bulk-key omission, structured error retry classification and level-based noise suppression. A single high UTF-16 surrogate produced by JS `slice(0, 512)` is emitted as an exact JSON `\uD83D` escape; native scalar rendering safely uses the replacement glyph.
- [x] The Rust `CorrelationFuture` wrapper captures merged Job/Task context and restores the prior scope on *each* async poll, including when concurrent futures yield/interleave on the same thread; no process-global mutable correlation is leaked across tasks. Structured records remain observational only, never update SQLite or the workflow.
- [x] `rust/tests/head_to_head_observability.mjs`: **8,744** identical Node/Rust JSON-wire fixtures for exception/retry taxonomy, headers, payloads, nested secrets, bulk/Unicode string limits, environment levels, parent/child correlation and record filtering.
- [x] `rust/tests/native_observability.rs`: **6** Rust-native regressions for error precedence, recursive redaction, UTF-16 JSON boundary, panic restoration, async-local interleaving and no-op/filtered sinks.
- [x] Original Node `test/observability.test.js`: **12/12 PASS** with isolated SQLite and projected-store fixtures; full Rust2 differential **36/36 PASS**, 0 skipped, Cargo tests and Clippy clean.
- [x] No live Relay daemon, Job, event stream, production secret, durable database or external log service was modified during this port.

### Direct Rust2 hotfix — Workflow Effect Executor (2026-11-16)

- [x] `src/workflow/effects.ts` → `rust/src/workflow/effects.rs`: implements an injectable, asynchronous native `WorkflowEffectReceiptStore`, `MemoryWorkflowEffectReceiptStore`, `WorkflowEffectHandler`, `CallbackWorkflowEffectHandler` equivalent and `WorkflowEffectExecutor` keyed dispatch. Effect registration checks duplicate handlers; keys encode Job/Task/transition identity with optional explicit override.
- [x] Ordered Effect execution is idempotent through durable receipt callbacks: receipts are written only after success, failures may retry, and already completed keys produce deduplicated outcomes. Missing handlers and receipt-read errors fail closed; receipt-write/callback errors become failed effects, with verified `onOutcome` error semantics matching the Node reference.
- [x] Structured `workflow.effect` and `workflow.effect.failed` observations retain correlated execution IDs, exact idempotency keys, outcome statuses and classification via the previously ported `observability.rs`; an Effect observation never directly mutates lifecycle state.
- [x] `rust/tests/head_to_head_workflow_effects.mjs`: **762** stateful Node/Rust cases across multiple steps, real async handlers, explicit key reuse across different effects, error classification, injected read/write receipt failures, deduplication, exception propagation and `onOutcome` rejection.
- [x] `rust/tests/native_workflow_effects.rs`: **8** Rust-native tests for callback ordering, missing/duplicate handlers, idempotency, transient failures, completion-then-callback-error semantics and receipt recovery. The native tests filter by their own Job identity to remain independent under Cargo parallel test execution.
- [x] Original Node `test/workflow-effects.test.js`: **5/5 PASS** using isolated test store; full differential suite **38/38 PASS**, 0 skipped, cargo fmt/native tests/clippy clean.
- [x] No live Workflow Effect, Job/Task, SQLite database, PR, Git remote or running Relay process was used or modified.

### Direct Rust2 hotfix — Review Generation Fence and monotonic PR facts (2026-11-16)

- [x] `src/review-generation-fence.ts` → `rust/src/review_generation_fence.rs`: pure durable snapshot read against **latest** Job/Task head, execution ID, state and recovery status; competing new-Head reviewers may displace stale reviews only when they are the latest eligible reviewer; null vs undefined execution IDs remain distinct.
- [x] `rust/tests/head_to_head_review_generation_fence.mjs` compares **1,950** independent Node/Rust Review predicate fixtures across stale/new heads, competing reviewer order, cancellation, original/current review outcome and Planning Decision presence; four Rust-native focused tests.
- [x] `src/unified-pr-facts.ts` → `rust/src/unified_pr_facts.rs`: port SQL INSERT ON CONFLICT with non-regressing timestamps and irreversible MERGED state. All PR records are scoped by Job ID and remain observational, not local Git lifecycle truth.
- [x] `rust/tests/head_to_head_unified_pr_facts.mjs`: **364** multi-operation in-memory SQLite scenarios executed separately on Node and Rust, checking all stored rows and SQL constraint errors. Three native tests cover state monotonicity, equal-timestamp updates, cross-Job scoping and invalid states.
- [x] No running Relay process, authoritative Job SQLite DB or GitHub service touched; test stores are isolated in-memory.

### Direct Rust2 hotfix — global Job/Task ID sequence and immutable repository registry (2026-11-16)

- [x] `src/job-task-id-sequence.ts` → `rust/src/job_task_id_sequence.rs`: durable SQLite WAL + 10 s busy timeout, immediate transaction, global positive decimal Job and Task ID sequences, historic snapshot high-water marks, occupied-ID skipping, idempotency persistence with repository scope for Jobs and global scope for Task keys.
- [x] `rust/tests/head_to_head_job_task_id_sequence.mjs`: **240** Node/Rust generated ID grammar fixtures plus **170** independently cloned real SQLite allocation histories (all output IDs, durable sequence and idempotency table rows compared). `rust/tests/native_job_task_id_sequence.rs`: **5** native tests including 32 concurrent allocations through distinct SQLite connections with no ID reuse, malformed legacy snapshots, invalid keys, and global Job/Task separation.
- [x] `src/unified-job-registry.ts` → `rust/src/unified_job_registry.rs`: immutable scoped repository identity, once-only positive PR binding, atomic `BEGIN IMMEDIATE` create-if-absent, idempotent return of stored Job, collision check on local canonical `projectRoot`, callback write rollback.
- [x] `rust/tests/head_to_head_unified_job_registry.mjs`: **455** in-memory real SQLite histories separately executed with the Node and native Rust implementations; compares every registry binding, Job snapshot and outcome. `rust/tests/native_unified_job_registry.rs`: **5** native tests for immutable identity, collision and rollback.
- [x] Original Node `test/job-task-id-sequence.test.js` and `test/consolidated-sqlite.test.js` contain baseline incompatibilities with current local-worktree policy, global Task-key semantics and renamed error messages (five unrelated failures, no Node source edits). Exact source-module differential fixtures and Cargo tests are green.
- [x] No production SQLite, live Relay Job, process or GitHub service was accessed or changed.

### Direct Rust2 hotfix — pre-contract Task and PR-number migrations (2026-11-16)

- [x] `src/legacy-blocked-task-migration.ts` → `rust/src/legacy_blocked_task_migration.rs`: preserve historic `UNBLOCKED` recovery (worker FAILED/troubleshooter QUEUED), exact attempt floor, interactive DRAFT → AWAITING_DECISION only when bound and not executing, ordinary BLOCKED → FAILED while Planner and Troubleshooter remain unchanged; no append-only event rewrite.
- [x] `src/job-pr-number-migration.ts` → `rust/src/job_pr_number_migration.rs`: backfill positive legacy external PR number only when new binding absent, strip obsolete field, derive missing Task titles using the existing verified Rust Task title formatter.
- [x] Native `parse_js_json` plus `observability::json_wire` preserve JavaScript's JSON.stringify/JSON.parse acceptance of **unpaired UTF-16 surrogates** generated by 93-code-unit title truncation; valid surrogate pairs and escaped literal `\uD800` sequences remain correct.
- [x] `rust/tests/head_to_head_legacy_migrations.mjs`: **2,401** pure Node/Rust Task lifecycle/PR/title fixtures plus **190** separate in-memory SQLite migration histories, comparing every durable snapshot and changed-row trigger (unchanged records must not be updated).
- [x] `rust/tests/native_legacy_blocked_task_migration.rs` (**4**) and `rust/tests/native_job_pr_number_migration.rs` (**5**) verify worker recovery, interactive waits, immutable event history, legacy field cleanup, title fallback, and exact UTF-16 JSON wire.
- [x] No production SQLite database, running Task, or external PR altered; isolated in-memory fixtures only.

### Direct Rust2 hotfix — authoritative unified Relay SQLite schema (2026-11-16)

- [x] `src/unified-relay-schema.ts` → `rust/src/unified_relay_schema.rs`: embed the exact original Node `db.exec` SQL template and expand the existing `hostInvocationTablesSql` literal from `src/host-invocation-store.ts` verbatim. No Node runtime dependency remains in the native schema creation path.
- [x] `rust/tests/head_to_head_unified_relay_schema.mjs`: **258** in-memory SQLite scenarios with Node and Rust independently executing the source schema and then constraint operations; compares every `sqlite_master` table/index SQL definition, default migration metadata and failure outcomes including duplicate reinitialization.
- [x] Node `DatabaseSync` defaults `PRAGMA foreign_keys=ON`; the differential adapter explicitly configures native `Connection` to the same default. Production DB connection configuration remains caller-owned.
- [x] `rust/tests/native_unified_relay_schema.rs`: **4** native tests for Job/Task/PR/HostInvocation/Projection schemas, checks and foreign keys, uniqueness, and the existing second-boot metadata conflict semantics.
- [x] All tests run on transient in-memory SQLite databases. No live database migration or daemon restart occurred.

### Direct Rust2 hotfix — normalized SQLite Job snapshot reads and disabled GitHub transport (2026-11-16)

- [x] `src/relay-job-snapshot-reads.ts` → `rust/src/relay_job_snapshot_reads.rs`: all four exports `currentJobMetadata`, `normalizeRelayJob`, `loadRelayJob`, `listRelayJobs`. Compose the existing native `normalizeLegacyJobPrNumber` and `normalizeLegacyTaskLifecycle` ports, remove exactly six obsolete top-level Job fields, migrate historical Plan restatement fields, and keep SQLite reads strictly read-only.
- [x] `rust/tests/head_to_head_relay_job_snapshot_reads.mjs`: **400** immutable top-level metadata fixtures; **1,200** full legacy Job/Task/Plan normalization cases; **240** independent in-memory SQLite Job load/list histories; `rust/tests/native_relay_job_snapshot_reads.rs` (**4**) covers immutable/nested metadata, legacy PR/title/Task/Plan, scoped ordering and UTF-16 surrogate wire handling.
- [x] `src/no-github.ts` → `rust/src/no_github.rs`: exact public `DisabledGitHubClient` with four fail-closed transport methods and `noGitHubMode` across explicit arguments, process argv and strict `AGENTS_RELAY_NO_GITHUB=1` setting.
- [x] `rust/tests/head_to_head_no_github.mjs`: **900** disable-mode Node/Rust cases plus all four API methods, with no real network calls. Two Rust native tests and original Node disabled GitHub transport regression verify the fail-closed boundary.
- [x] No production Job SQLite, GitHub API, or Relay process touched. All test data lives in memory.

### Direct Rust2 hotfix — append-only Task comments and Projection CLI (2026-11-16)

- [x] `src/task-comments.ts` → `rust/src/task_comments.rs`: all three exports `appendTaskComment`, `taskCommentContext`, and `preserveTaskComments`. Generate OS-entropy RFC4122 UUID v4 for new comments; preserve immutable Task input/execution; idempotent retries return the exact existing comment; stale inbound comments are unioned by stable comment ID with authoritative comments first.
- [x] `rust/tests/head_to_head_task_comments.mjs`: **2,620** Node/Rust comment validation/append, source context formatting and stale snapshot merger fixtures; only nondeterministic new UUID/time fields are normalized for differential comparisons. Five native tests verify real UUID v4, UTC timestamp, exact append ordering, idempotency, and stale recovery.
- [x] `src/cli-projection.ts` → `rust/src/cli_projection.rs`: all public help/command semantics, first-value CLI flag parsing, strict nonnegative integer projection IDs, action canonicalization, optional notes, and real POST to caller-selected `http://host:port/api/control` using native Rust HTTP.
- [x] `rust/tests/head_to_head_cli_projection.mjs`: **507** help and invalid CLI cases and **250** real localhost HTTP control-command and status-response cases; exact JSON bodies and terminal output checked against Node. Five Rust native tests ensure help text, valid/invalid fields and real local HTTP.
- [x] All tests use isolated fixtures; no production Dashboard, live Job, remote GitHub service, or Task was modified.

### Direct Rust2 hotfix — production CLI Help and display-only GitHub PR archive (2026-11-16)

- [x] `src/cli-help.ts` → `rust/src/cli_help.rs`: all **49** original Node help keys and exact `usage` string statically compiled into Rust, including action-specific `job`, `task`, `blocker` and `context` help and default fallback. No Node runtime or additional files required for production help lookup.
- [x] `rust/tests/head_to_head_cli_help.mjs` compares **2,381** Node/Rust CLI usage/help cases against the original compiled `helpText`; 2 native tests ensure every source help entry is nonempty and action dispatch is consistent.
- [x] `src/github-pr-archive.ts` → `rust/src/github_pr_archive.rs`: injectable asynchronous GitHub request callback; PRs are display-only records after local Git completion. Skip non-OPEN PRs, check existing local-completion marker before adding exactly one comment, then close the PR with PATCH; never invoke remote PR merge.
- [x] `rust/tests/head_to_head_github_pr_archive.mjs`: **1,156** independent Node/Rust archive policy and injected failure scenarios using fake GitHub clients, no network. 4 native tests verify comment idempotency, callback order, no merge, fail-closed invalid history and never closing after rejected publication.
- [x] Original Node `test/github-pr-archive.test.js` passes with disposable fixtures. No live GitHub access or running Relay Job modified.

### Direct Rust2 runtime status batch (2026-11-17)

- [x] `src/runtime-status.ts` → `rust/src/runtime_status.rs`: preserve exact priority for human `AWAITING_DECISION` vs genuinely leased running execution, active implementation vs reviewer, planner failure, stale revision exclusions, `FAILED` vs `implementationComplete` and PR-independent Job status. 4,500 independent Node/Rust cases + 4 native tests.
- [x] `src/runtime-summary.ts` → `rust/src/runtime_summary.rs`: count only real, unexpired leased Task executions in ACTIVE Jobs, respect adapter selection, ignore ghost RUNNING flags, count models and preserve running order. 700 Node/Rust fixtures + 3 native tests.
- [x] `src/runtime-status-events.ts` → `rust/src/runtime_status_events.rs`: process-local status change observation with repository-qualified Job identity; first observation establishes baseline without event, repeated status dedupes; random UUIDv4 event + ISO timestamp and fail-closed callback. 430 Node/Rust histories + 2 native tests.
- [x] All ports/fixtures run in an isolated worktree without live process or production SQLite mutations. Full Rust2 checklist and combined Node/Rust gate execute once per batch after fast-forward merge.

### Rebase against main local-Git-only lifecycle (2026-11-17)

- [x] Merge main commit `ba22e4c` into an isolated rust2 integration worktree, preserving all five dirty files in the active Rust2 checkout.
- [x] Retire `cli-projection`, `projection-recovery`, and `projection-recovery-runtime` from the executable Rust2 target; retain their history as `EXCLUDED` rather than falsely counting them PASS.
- [x] Add newly-introduced `relay-job-merge.ts` as `PENDING`, with one-to-one future Rust path; 228 tracked historical+new files = 225 active current Node modules plus 3 excluded.
- [x] Refresh `cli-help`, repository-scoped global numeric Task idempotency, unconditional local-only GitHub mode, and ACTIVE-only review generation fencing from current main.

### Eight-file Rust2 direct-port batch (2026-11-17)

- [x] `src/relay-create.ts` → `rust/src/relay_create.rs`: `BEGIN IMMEDIATE` creates immutable SQLite Job metadata or returns the pre-existing normalized Job, never overwriting a local objective.
- [x] `src/relay-job-merge.ts` → `rust/src/relay_job_merge.rs`: latest-update field selection, comment merge, immutable review request/round preservation and plan round ordering.
- [x] `src/store-task-definition.ts` → `rust/src/store_task_definition.rs`: durable Task/Plan identity and top-level field divergence, ignoring mutable lifecycle fields, removing `planUrl` without reordering ordered JSON keys.
- [x] `src/task-context.ts` → `rust/src/task_context.rs`: execution generation, dependencies, reviewer/troubleshooter references, append-only comment histories, mandatory event-contract reference validation.
- [x] `src/publication-store.ts` → `rust/src/publication_store.rs`: independent SQL delivery ledger with per-Job state, timestamp monotonicity, transactional idempotency and sorted event listing.
- [x] `src/workflow/action-ledger.ts` → `rust/src/workflow/action_ledger.rs`: graph-authorized reservation and lease/generation fencing, postcondition tri-state and `Unknown` durability, never a second graph policy engine.
- [x] `src/github-webhook.ts` → `rust/src/github_webhook.rs`: signed HMAC-SHA256 verification, event/action classification, trusted bot-only publish comments, package marker validation, one-time delivery receipts.
- [x] `src/markers.ts` → `rust/src/markers.rs`: byte-accurate HTML comment rendering, safe angle-bracket escaping, historical Job/Task fallback content and Plan/Agent metadata handling.
- [x] Four direct Node/Rust head-to-head suites with 16,969 head-to-head fixture scenarios, plus 12 native Rust boundary tests and 28 focused original Node integration regressions. All data is isolated in-memory SQLite; no live Jobs, remote GitHub calls, or source checkout writes.

### Eight-module Graph, Agent DAG and durable Outbox batch (2026-11-17)

- [x] `src/workflow/graph-v2.ts`: strict parser, declarative Graph registry, Guard/Action/Event execution and dispatcher. Grammar/topology isolated in `graph_v2_parser.rs`; never duplicate Graph-owned lifecycle policy.
- [x] `src/graph-runtime.ts`: canonical Graph-v2 API re-export.
- [x] `src/workflow/definitions-v2.ts`: canonical Job/Task Graph bindings and topology-only state validation.
- [x] `src/workflow/usage-index.ts`: read-only canonical Mermaid reverse symbol inventory.
- [x] `src/agent-graph.ts`: Coordinator DAG parsing, deterministic waves, source-visible Agent contracts and Agent-Graph prompt.
- [x] `src/workflow/runtime.ts`: mechanical mutation effects, stale/blocked Task guards, Job/Task timestamp compatibility, no-start fallback receipts.
- [x] `src/workflow/durable-publication.ts`: atomic SQLite publication outbox/inbox, durable key/identity collision, consumer dedupe and failure replay.
- [x] `src/reconciler-workflow-outbox.ts`: publish pending events via caller-provided transports only, never mutate canonical state independently.
- [x] Six isolated direct Node/Rust differential suites plus four native Rust boundary checks; no production services, user Jobs, or current root checkout writes during port construction.

### Ten-module Graph policy/verified dispatcher direct-port batch (2026-11-17)

- [x] One canonical Graph Dispatcher, sync/async ports with ordered persist -> action -> validated emissions, transient-state path and stage=graph structured observations.
- [x] Verified Graph effects use lease/attempt/execution fence, observed durable postconditions and atomic SQLite transition + Outbox via existing Rust ports, not duplicate Graph policies; unverified effects stop without replay.
- [x] Nine domain Graph wrappers delegate only to the canonical executable Mermaid source: dependency revision, authoritative unblock, force restate, planner trigger, Troubleshooter, blocker recovery, blocker resolution, revision, projection conflict.
- [x] 3,620 Node/Rust head-to-head fixtures (2,350 domain policy, 760 dispatcher, 280 verified SQLite, 230 observation) and 7 native Rust boundary tests, plus 34 original Node integration regressions.
- [x] The separate Node/DAG/Graph source is untouched; all tests run in isolated fixtures, no live Relay or user Job operations.

### Eight-module Job/Task Lifecycle, Review and escalation batch (2026-11-17)

- [x] Eight source modules ported as direct Node/Rust implementations with Graph-owned state transitions and no duplicate state allow-lists.
- [x] 4,740 direct Node/Rust cases: 1,400 lifecycle/reconcile; 820 review; 760 related Task and effect-scope; 780 Task/Job construction; 640 legacy rescue; 340 escalation.
- [x] Seven native boundary tests: blocked authoritative unblock, review terminal guards, action scope, dependency validity, legacy outcome unknown quarantine, escalation exact callback and Job activation.
- [x] 31 original Node integration regressions. No production Rust cutover.
