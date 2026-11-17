# Rust2: Node.js → Rust head-to-head port checklist

> Migration contract: Node source at baseline commit `234a8151fe0fe616c39c0109b4b014326044e17e` is the behavioral reference. The existing Rust rewrite is deliberately retired; **no legacy Rust implementation is reused**. No parity is claimed until independent differential verification passes.

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
| `src/adapters.ts` | `rust/src/adapters.rs` | PENDING | — |
| `src/agent-content-resolver.ts` | `rust/src/agent_content_resolver.rs` | PASS | Direct hotfix: 500 Node/Rust source-layer fixtures, 252 isolated Agent files/section inheritance cases, 120 multi-layer snapshots; 5 native tests, 18 focused Node regressions (rust/tests/head_to_head_agent_content_resolver.mjs; rust/tests/native_agent_content_resolver.rs) |
| `src/agent-graph.ts` | `rust/src/agent_graph.rs` | PENDING | — |
| `src/agent-prompt-builder.ts` | `rust/src/agent_prompt_builder.rs` | PASS | Direct hotfix: 1,100 pure prompt/render fixtures; 220 reference-first fixtures; 150 exact execution prompts; isolated immutable SHA-256 snapshots and filesystem/error semantics; 5 Rust-native tests, 19 Node regressions (rust/tests/head_to_head_agent_prompt_builder.mjs; rust/tests/native_agent_prompt_builder.rs) |
| `src/agent-script-discovery.ts` | `rust/src/agent_script_discovery.rs` | PENDING | — |
| `src/audit-tail.ts` | `rust/src/audit_tail.rs` | PASS | Batch 5: isolated temp-file differential covers absent path, newest-first records, multiline JSON strings, malformed trailing line and a record spanning the 64 KiB reverse-read boundary (`rust/tests/head_to_head_batch5.mjs`) |
| `src/blocker-recovery.ts` | `rust/src/blocker_recovery.rs` | PENDING | — |
| `src/blockers.ts` | `rust/src/blockers.rs` | PENDING | — |
| `src/browser-worker-pool-graph.ts` | `rust/src/browser_worker_pool_graph.rs` | PENDING | — |
| `src/browser-worker-pool.ts` | `rust/src/browser_worker_pool.rs` | PENDING | — |
| `src/browser-worker-routing.ts` | `rust/src/browser_worker_routing.rs` | PENDING | — |
| `src/browser-worker-runtime.ts` | `rust/src/browser_worker_runtime.rs` | PENDING | — |
| `src/chatgpt-platform-fallback.ts` | `rust/src/chatgpt_platform_fallback.rs` | PENDING | — |
| `src/cli-artifact.ts` | `rust/src/cli_artifact.rs` | PENDING | — |
| `src/cli-blocker.ts` | `rust/src/cli_blocker.rs` | PENDING | — |
| `src/cli-context.ts` | `rust/src/cli_context.rs` | PENDING | — |
| `src/cli-coordinator.ts` | `rust/src/cli_coordinator.rs` | PENDING | — |
| `src/cli-escalation.ts` | `rust/src/cli_escalation.rs` | PENDING | — |
| `src/cli-foreground.ts` | `rust/src/cli_foreground.rs` | PENDING | — |
| `src/cli-help.ts` | `rust/src/cli_help.rs` | PENDING | — |
| `src/cli-job-create.ts` | `rust/src/cli_job_create.rs` | PENDING | — |
| `src/cli-local-merge-config.ts` | `rust/src/cli_local_merge_config.rs` | PASS | 626 shared differential fixtures across 14 ports; merge success and validation errors compared (`rust/tests/head_to_head.mjs`) |
| `src/cli-projection.ts` | `rust/src/cli_projection.rs` | PENDING | — |
| `src/cli-prompt.ts` | `rust/src/cli_prompt.rs` | PENDING | — |
| `src/cli-review.ts` | `rust/src/cli_review.rs` | PENDING | — |
| `src/cli-revision.ts` | `rust/src/cli_revision.rs` | PENDING | — |
| `src/cli-shutdown.ts` | `rust/src/cli_shutdown.rs` | PASS | Batch 5: exit status precedence, serving mode, delayed default/custom grace and injected force-exit callback verified without terminating the test process (`rust/tests/native_batch5.rs`, `rust/tests/head_to_head_batch5.mjs`). |
| `src/cli-support.ts` | `rust/src/cli_support.rs` | PENDING | — |
| `src/cli-unblock.ts` | `rust/src/cli_unblock.rs` | PENDING | — |
| `src/cli-worker-task.ts` | `rust/src/cli_worker_task.rs` | PENDING | — |
| `src/cli-workflow-action.ts` | `rust/src/cli_workflow_action.rs` | PASS | Batch 5: direct Node/Rust mapping and unsupported/missing argument errors; Rust exposes async delegated effect (`rust/tests/head_to_head_batch5.mjs`) |
| `src/cli-workflow.ts` | `rust/src/cli_workflow.rs` | PENDING | — |
| `src/cli.ts` | `rust/src/cli.rs` | PENDING | — |
| `src/continuation.ts` | `rust/src/continuation.rs` | PENDING | — |
| `src/dag-result-contract.ts` | `rust/src/dag_result_contract.rs` | PENDING | — |
| `src/dag-stage-contract.ts` | `rust/src/dag_stage_contract.rs` | PASS | Batch 4: 729 shared differential cases across 23 source ports; isolated temp project fixtures, symlink/run escape checks, malformed/failing validator outputs, and checked execution args (`rust/tests/head_to_head.mjs`) |
| `src/dag-task-runtime.ts` | `rust/src/dag_task_runtime.rs` | PENDING | — |
| `src/dashboard-actions.ts` | `rust/src/dashboard_actions.rs` | PENDING | — |
| `src/dashboard-data.ts` | `rust/src/dashboard_data.rs` | PENDING | — |
| `src/dashboard-html.ts` | `rust/src/dashboard_html.rs` | PENDING | — |
| `src/dashboard-jel.ts` | `rust/src/dashboard_jel.rs` | PASS | Direct hotfix: 1,429 exact fixed-clock Node/Rust dynamic DAG/Plan/Review/Retry/Merge Mermaid diagrams, native unit tests and Unicode surrogate JSON-wire fidelity (rust/tests/head_to_head_dashboard_jel.mjs; rust/tests/native_dashboard_jel.rs) |
| `src/dashboard-style.ts` | `rust/src/dashboard_style.rs` | PASS | Direct hotfix: exact 25,275 byte runtime dashboard CSS literal, SHA-256 676e173854d712a21bf4cf0a3dfaa59bf015a458ce9a2b54d8e632a082a56c34 (rust/tests/head_to_head_dashboard_style.mjs) |
| `src/dashboard-workflow-inspection.ts` | `rust/src/dashboard_workflow_inspection.rs` | PASS | Batch 6: Node/Rust differential fixtures cover valid exact Event/Action graph symbols, source/test references, malformed identifiers and traversal rejection (`rust/tests/head_to_head_batch6.mjs`); native path-safety test. |
| `src/dashboard.ts` | `rust/src/dashboard.rs` | PENDING | — |
| `src/decision-audit.ts` | `rust/src/decision_audit.rs` | PENDING | — |
| `src/decision.ts` | `rust/src/decision.rs` | PENDING | — |
| `src/dependency-revision-execution.ts` | `rust/src/dependency_revision_execution.rs` | PENDING | — |
| `src/dependency-validity.ts` | `rust/src/dependency_validity.rs` | PASS | 327 shared differential fixtures across 4 ports; Rust native tests 5/5; Node focused regression 4/4; clippy clean (`rust/tests/head_to_head.mjs`) |
| `src/escalation-notifier.ts` | `rust/src/escalation_notifier.rs` | PENDING | — |
| `src/events-bus-runtime.ts` | `rust/src/events_bus_runtime.rs` | PENDING | — |
| `src/events.ts` | `rust/src/events.rs` | PENDING | — |
| `src/execution-boundary.ts` | `rust/src/execution_boundary.rs` | PASS | Batch 5: controlled Node ordering/error release plus native Rust same-key serialization, different-key concurrency, panic release and reacquisition (`rust/tests/head_to_head_batch5.mjs`, `rust/tests/native_batch5.rs`) |
| `src/execution-context.ts` | `rust/src/execution_context.rs` | PENDING | — |
| `src/execution-event-identity.ts` | `rust/src/execution_event_identity.rs` | PENDING | — |
| `src/execution-process-tracker.ts` | `rust/src/execution_process_tracker.rs` | PENDING | — |
| `src/execution-recovery.ts` | `rust/src/execution_recovery.rs` | PENDING | — |
| `src/execution-routing.ts` | `rust/src/execution_routing.rs` | PENDING | — |
| `src/feedback.ts` | `rust/src/feedback.rs` | PENDING | — |
| `src/final-review-role.ts` | `rust/src/final_review_role.rs` | PASS | 587 shared differential fixtures across 7 ports; Rust native tests 8/8; Node focused regression 18/18; clippy clean (`rust/tests/head_to_head.mjs`) |
| `src/force-restate-validation.ts` | `rust/src/force_restate_validation.rs` | PENDING | — |
| `src/force-restate.ts` | `rust/src/force_restate.rs` | PENDING | — |
| `src/github-auth.ts` | `rust/src/github_auth.rs` | PENDING | — |
| `src/github-binding-order.ts` | `rust/src/github_binding_order.rs` | PASS | 626 shared differential fixtures across 14 ports; stable ordering and priority groups compared (`rust/tests/head_to_head.mjs`) |
| `src/github-branch-projection.ts` | `rust/src/github_branch_projection.rs` | PASS | 626 shared differential fixtures across 14 ports; normal and force-with-lease argv compared (`rust/tests/head_to_head.mjs`) |
| `src/github-client.ts` | `rust/src/github_client.rs` | PENDING | — |
| `src/github-pr-archive.ts` | `rust/src/github_pr_archive.rs` | PENDING | — |
| `src/github-runtime-usage.ts` | `rust/src/github_runtime_usage.rs` | PASS | Direct port: 1,793 Node/Rust rate/header/Unicode/datetime fixtures, 5 native tests, 8 original Node runtime-rate regressions (`rust/tests/head_to_head_github_runtime_usage.mjs`, `rust/tests/native_github_runtime_usage.rs`) |
| `src/github-webhook.ts` | `rust/src/github_webhook.rs` | PENDING | — |
| `src/graph-runtime.ts` | `rust/src/graph_runtime.rs` | PENDING | — |
| `src/host-invocation-store.ts` | `rust/src/host_invocation_store.rs` | PENDING | — |
| `src/interactive-invocation.ts` | `rust/src/interactive_invocation.rs` | PENDING | — |
| `src/interactive-request.ts` | `rust/src/interactive_request.rs` | PENDING | — |
| `src/interactive-resume.ts` | `rust/src/interactive_resume.rs` | PENDING | — |
| `src/job-actions.ts` | `rust/src/job_actions.rs` | PENDING | — |
| `src/job-execution-slot.ts` | `rust/src/job_execution_slot.rs` | PASS | 587 shared differential fixtures across 7 ports; Rust native tests 8/8; Node focused regression 18/18; clippy clean (`rust/tests/head_to_head.mjs`) |
| `src/job-local-repository-migration.ts` | `rust/src/job_local_repository_migration.rs` | PENDING | — |
| `src/job-pause.ts` | `rust/src/job_pause.rs` | PENDING | — |
| `src/job-pr-number-migration.ts` | `rust/src/job_pr_number_migration.rs` | PENDING | — |
| `src/job-task-id-sequence.ts` | `rust/src/job_task_id_sequence.rs` | PENDING | — |
| `src/job-worktree-cleanup.ts` | `rust/src/job_worktree_cleanup.rs` | PENDING | — |
| `src/legacy-blocked-task-migration.ts` | `rust/src/legacy_blocked_task_migration.rs` | PENDING | — |
| `src/legacy-orchestrator-repair.ts` | `rust/src/legacy_orchestrator_repair.rs` | PENDING | — |
| `src/local-authority-store.ts` | `rust/src/local_authority_store.rs` | PENDING | — |
| `src/local-commit-events.ts` | `rust/src/local_commit_events.rs` | PENDING | — |
| `src/local-git-merge.ts` | `rust/src/local_git_merge.rs` | PENDING | — |
| `src/local-job-path.ts` | `rust/src/local_job_path.rs` | PASS | Batch 5: configured, empty and absent store-directory override compared directly with Node including default home path (`rust/tests/head_to_head_batch5.mjs`) |
| `src/local-job-registry.ts` | `rust/src/local_job_registry.rs` | PENDING | — |
| `src/local-managed-store.ts` | `rust/src/local_managed_store.rs` | PENDING | — |
| `src/local-merge-delivery.ts` | `rust/src/local_merge_delivery.rs` | PENDING | — |
| `src/local-merge-lock.ts` | `rust/src/local_merge_lock.rs` | PASS | Direct hotfix: real Node↔Rust cross-process directory locking, stale/foreign/live PID and owner recovery, timeout/error/panic-safe release (rust/tests/head_to_head_local_merge_lock.mjs; rust/tests/native_local_merge_lock.rs) |
| `src/local-merge-projection.ts` | `rust/src/local_merge_projection.rs` | PENDING | — |
| `src/managed-worker-input.ts` | `rust/src/managed_worker_input.rs` | PENDING | — |
| `src/manual-plan.ts` | `rust/src/manual_plan.rs` | PENDING | — |
| `src/markers.ts` | `rust/src/markers.rs` | PENDING | — |
| `src/model-redecision.ts` | `rust/src/model_redecision.rs` | PENDING | — |
| `src/model-routing.ts` | `rust/src/model_routing.rs` | PENDING | — |
| `src/no-github.ts` | `rust/src/no_github.rs` | PENDING | — |
| `src/observability.ts` | `rust/src/observability.rs` | PASS | Direct hotfix: 8,744 exact Node/Rust classification/redaction/correlation/environment fixtures; 6 Rust-native tests including interleaved Futures; 12 original Node regressions (rust/tests/head_to_head_observability.mjs; rust/tests/native_observability.rs) |
| `src/outcome-review.ts` | `rust/src/outcome_review.rs` | PENDING | — |
| `src/owned-process.ts` | `rust/src/owned_process.rs` | PENDING | — |
| `src/planned-review-head.ts` | `rust/src/planned_review_head.rs` | PASS | 626 shared differential fixtures across 14 ports; head binding, exact prompt append, duplicate suppression, errors, and save count compared (`rust/tests/head_to_head.mjs`) |
| `src/planner-agent-roles.ts` | `rust/src/planner_agent_roles.rs` | PASS | 587 shared differential fixtures across 7 ports; Rust native tests 8/8; Node focused regression 18/18; clippy clean (`rust/tests/head_to_head.mjs`) |
| `src/planner-child-recovery.ts` | `rust/src/planner_child_recovery.rs` | PENDING | — |
| `src/planner-child.ts` | `rust/src/planner_child.rs` | PASS | 355+ Node/Rust direct differential cases: field-by-field equality, absent/null, defaults, nested arrays/objects, Unicode, unrelated metadata; Rust native test (`rust/tests/head_to_head_planner_child.mjs`, `rust/src/planner_child.rs`) |
| `src/planner-history-cleanup.ts` | `rust/src/planner_history_cleanup.rs` | PASS | 626 shared differential fixtures across 14 ports; valid, missing, malformed, duplicate, and target-required payloads compared (`rust/tests/head_to_head.mjs`) |
| `src/planner-recovery.ts` | `rust/src/planner_recovery.rs` | PENDING | — |
| `src/planner-runtime.ts` | `rust/src/planner_runtime.rs` | PENDING | — |
| `src/planner-task-context.ts` | `rust/src/planner_task_context.rs` | PASS | Batch 4: 729 shared differential cases across 23 source ports; bounded input/result/comment context, planner input omission, Unicode, and undefined-field JSON normalization (`rust/tests/head_to_head.mjs`) |
| `src/planner-task-ids.ts` | `rust/src/planner_task_ids.rs` | PENDING | — |
| `src/planner-task-title.ts` | `rust/src/planner_task_title.rs` | PASS | 327 shared differential fixtures across 4 ports; Rust native tests 5/5; Node focused regression 4/4; clippy clean (`rust/tests/head_to_head.mjs`) |
| `src/planner.ts` | `rust/src/planner.rs` | PENDING | — |
| `src/pool.ts` | `rust/src/pool.rs` | PENDING | — |
| `src/process-identity.ts` | `rust/src/process_identity.rs` | PASS | Direct hotfix: real Node/Rust OS ps identity, isolated detached PGID leaders, lease owner inspection, stale generation fences and two actual disposable child-process terminations (rust/tests/head_to_head_process_identity.mjs; rust/tests/native_process_identity.rs) |
| `src/projected-store.ts` | `rust/src/projected_store.rs` | PENDING | — |
| `src/projection-failure-dedupe.ts` | `rust/src/projection_failure_dedupe.rs` | PASS | 626 shared differential fixtures across 14 ports; sequential duplicate/change/classification/reset vectors compared (`rust/tests/head_to_head.mjs`) |
| `src/projection-failure-recovery.ts` | `rust/src/projection_failure_recovery.rs` | PENDING | — |
| `src/projection-outbox.ts` | `rust/src/projection_outbox.rs` | PENDING | — |
| `src/projection-recovery-runtime.ts` | `rust/src/projection_recovery_runtime.rs` | PENDING | — |
| `src/projection-recovery.ts` | `rust/src/projection_recovery.rs` | PENDING | — |
| `src/publication-store.ts` | `rust/src/publication_store.rs` | PENDING | — |
| `src/reconcile-coordinator.ts` | `rust/src/reconcile_coordinator.rs` | PENDING | — |
| `src/reconciler-cancellation.ts` | `rust/src/reconciler_cancellation.rs` | PENDING | — |
| `src/reconciler-context.ts` | `rust/src/reconciler_context.rs` | PENDING | — |
| `src/reconciler-pause.ts` | `rust/src/reconciler_pause.rs` | PASS | Direct port: 905 Node/Rust generation-selection cases; 3 native tests; in-memory cancellation callbacks only (`rust/tests/head_to_head_reconciler_pause.mjs`, `rust/tests/native_reconciler_pause.rs`) |
| `src/reconciler-review.ts` | `rust/src/reconciler_review.rs` | PENDING | — |
| `src/reconciler-runtime.ts` | `rust/src/reconciler_runtime.rs` | PENDING | — |
| `src/reconciler-workflow-outbox.ts` | `rust/src/reconciler_workflow_outbox.rs` | PENDING | — |
| `src/reconciler.ts` | `rust/src/reconciler.rs` | PENDING | — |
| `src/registry.ts` | `rust/src/registry.rs` | PASS | Batch 4: 700 shared differential cases across 21 source ports; filtering, trust domains, labels, task-kind evidence, exploratory ordering and reliability ranking (`rust/tests/head_to_head.mjs`) |
| `src/relay-create.ts` | `rust/src/relay_create.rs` | PENDING | — |
| `src/relay-job-snapshot-reads.ts` | `rust/src/relay_job_snapshot_reads.rs` | PENDING | — |
| `src/relay-store-discovery.ts` | `rust/src/relay_store_discovery.rs` | PENDING | — |
| `src/relay-store.ts` | `rust/src/relay_store.rs` | PENDING | — |
| `src/relay-workflow-operations.ts` | `rust/src/relay_workflow_operations.rs` | PENDING | — |
| `src/relayd-control.ts` | `rust/src/relayd_control.rs` | PENDING | — |
| `src/relayd-dashboard-actions.ts` | `rust/src/relayd_dashboard_actions.rs` | PENDING | — |
| `src/relayd-main.ts` | `rust/src/relayd_main.rs` | PENDING | — |
| `src/relayd-utilities.ts` | `rust/src/relayd_utilities.rs` | PENDING | — |
| `src/relayd.ts` | `rust/src/relayd.rs` | PENDING | — |
| `src/review-chair.ts` | `rust/src/review_chair.rs` | PENDING | — |
| `src/review-evidence.ts` | `rust/src/review_evidence.rs` | PASS | Batch 4: 729 shared differential cases across 23 source ports; head precedence/fallback, finding aliases, malformed/null findings, trimming, Unicode and missing evidence (`rust/tests/head_to_head.mjs`) |
| `src/review-generation-fence.ts` | `rust/src/review_generation_fence.rs` | PENDING | — |
| `src/review-replan.ts` | `rust/src/review_replan.rs` | PENDING | — |
| `src/review-revision-execution.ts` | `rust/src/review_revision_execution.rs` | PENDING | — |
| `src/review-revision-merge.ts` | `rust/src/review_revision_merge.rs` | PASS | 626 shared differential fixtures across 14 ports; local history copy/delete and null handling compared (`rust/tests/head_to_head.mjs`) |
| `src/review-revision-model.ts` | `rust/src/review_revision_model.rs` | PENDING | — |
| `src/review-revision-policy.ts` | `rust/src/review_revision_policy.rs` | PASS | Batch 4: 729 shared differential cases across 23 source ports; operator bounds/errors, normalized/deduplicated Unicode findings, SHA-256 identity, request-derived fingerprints and consecutive repeated rounds (`rust/tests/head_to_head.mjs`) |
| `src/review-revision-settlement.ts` | `rust/src/review_revision_settlement.rs` | PENDING | — |
| `src/review-revision-stale.ts` | `rust/src/review_revision_stale.rs` | PENDING | — |
| `src/review-terminal-normalization.ts` | `rust/src/review_terminal_normalization.rs` | PASS | Batch 4: 729 shared differential cases across 23 source ports; verdict aliases, required explicit head, findings preservation, blocked failure reason/default message (`rust/tests/head_to_head.mjs`) |
| `src/reviewer-thread.ts` | `rust/src/reviewer_thread.rs` | PENDING | — |
| `src/route-outcome-recording.ts` | `rust/src/route_outcome_recording.rs` | PENDING | — |
| `src/router-evals.ts` | `rust/src/router_evals.rs` | PENDING | — |
| `src/router-rules.ts` | `rust/src/router_rules.rs` | PASS | Direct hotfix: 2,178 Node/Rust choices, routing-instruction byte preservation, Unicode whitespace, headers, duplicate routes, append helpers (rust/tests/head_to_head_direct_hotfix.mjs) |
| `src/routing-policy.ts` | `rust/src/routing_policy.rs` | PASS | Direct hotfix: 2,418 Node/Rust route eligibility/ranking/path fixtures; 20 isolated policy/rules file round-trips, SHA-256, sanitizer, missing/invalid files (rust/tests/head_to_head_routing_policy.mjs; rust/tests/native_routing_policy.rs) |
| `src/runtime-status-events.ts` | `rust/src/runtime_status_events.rs` | PENDING | — |
| `src/runtime-status.ts` | `rust/src/runtime_status.rs` | PENDING | — |
| `src/runtime-summary.ts` | `rust/src/runtime_summary.rs` | PENDING | — |
| `src/script-task-adapter.ts` | `rust/src/script_task_adapter.rs` | PENDING | — |
| `src/service-external-actions.ts` | `rust/src/service_external_actions.rs` | PENDING | — |
| `src/service-publication.ts` | `rust/src/service_publication.rs` | PENDING | — |
| `src/single-job-task-control.ts` | `rust/src/single_job_task_control.rs` | PENDING | — |
| `src/store-github.ts` | `rust/src/store_github.rs` | PENDING | — |
| `src/store-task-definition.ts` | `rust/src/store_task_definition.rs` | PENDING | — |
| `src/store.ts` | `rust/src/store.rs` | PENDING | — |
| `src/task-actions.ts` | `rust/src/task_actions.rs` | PENDING | — |
| `src/task-comments.ts` | `rust/src/task_comments.rs` | PENDING | — |
| `src/task-context.ts` | `rust/src/task_context.rs` | PENDING | — |
| `src/task-id-migration.ts` | `rust/src/task_id_migration.rs` | PASS | Direct hotfix: 7 cloned SQLite Node/Rust migrations, 3 preflight refusals, verified constraint rollback + immutable backup, 4 native tests, 3 original Node regressions (rust/tests/head_to_head_task_id_migration.mjs; rust/tests/native_task_id_migration.rs) |
| `src/task-inactivity-watchdog.ts` | `rust/src/task_inactivity_watchdog.rs` | PENDING | — |
| `src/task-recovery.ts` | `rust/src/task_recovery.rs` | PENDING | — |
| `src/task-tag.ts` | `rust/src/task_tag.rs` | PASS | Batch 4: 729 shared differential cases across 23 source ports; parse errors/limits, Unicode, allowed-tag filtering, data removal, and worker prompt (`rust/tests/head_to_head.mjs`) |
| `src/task-title.ts` | `rust/src/task_title.rs` | PASS | 327 shared differential fixtures across 4 ports; Rust native tests 5/5; Node focused regression 4/4; clippy clean (`rust/tests/head_to_head.mjs`) |
| `src/task-transitions.ts` | `rust/src/task_transitions.rs` | PENDING | — |
| `src/task-update.ts` | `rust/src/task_update.rs` | PENDING | — |
| `src/terminal-event-recovery.ts` | `rust/src/terminal_event_recovery.rs` | PASS | 327 shared differential fixtures across 4 ports; Rust native tests 5/5; Node focused regression 4/4; clippy clean (`rust/tests/head_to_head.mjs`) |
| `src/troubleshooter-fallback.ts` | `rust/src/troubleshooter_fallback.rs` | PENDING | — |
| `src/troubleshooter-qa-api.ts` | `rust/src/troubleshooter_qa_api.rs` | PASS | Direct hotfix: 13 isolated real Node HTTP vs Rust request/response/file outcomes, SHA-256, UTF8 recovery, invalid inputs; Rust native IO regression (rust/tests/head_to_head_ipc_hotfix.mjs; rust/tests/native_ipc_hotfix.rs) |
| `src/troubleshooter.ts` | `rust/src/troubleshooter.rs` | PENDING | — |
| `src/types.ts` | `rust/src/types.rs` | PENDING | — |
| `src/unblock.ts` | `rust/src/unblock.rs` | PENDING | — |
| `src/unified-job-registry.ts` | `rust/src/unified_job_registry.rs` | PENDING | — |
| `src/unified-pr-facts.ts` | `rust/src/unified_pr_facts.rs` | PENDING | — |
| `src/unified-relay-schema.ts` | `rust/src/unified_relay_schema.rs` | PENDING | — |
| `src/usage.ts` | `rust/src/usage.rs` | PENDING | — |
| `src/webhelm-daemon-client.ts` | `rust/src/webhelm_daemon_client.rs` | PASS | Direct hotfix: 15 real AF_UNIX Node/Rust socket response/timeout/abort/large-UTF8 fixtures, 1 malformed frame rejection, native cancellation/framing regression (rust/tests/head_to_head_ipc_hotfix.mjs; rust/tests/native_ipc_hotfix.rs) |
| `src/worker-failure-recovery.ts` | `rust/src/worker_failure_recovery.rs` | PENDING | — |
| `src/worker-rejection.ts` | `rust/src/worker_rejection.rs` | PASS | Batch 4: 729 shared differential cases across 23 source ports; rejection classes, all platform phases, typed pre-submit evidence and unsafe/ambiguous failures (`rust/tests/head_to_head.mjs`) |
| `src/worker-routing.ts` | `rust/src/worker_routing.rs` | PENDING | — |
| `src/worker-start-ack.ts` | `rust/src/worker_start_ack.rs` | PENDING | — |
| `src/workflow-effect-failures.ts` | `rust/src/workflow_effect_failures.rs` | PENDING | — |
| `src/workflow/action-ledger.ts` | `rust/src/workflow/action_ledger.rs` | PENDING | — |
| `src/workflow/authoritative-conditions.ts` | `rust/src/workflow/authoritative_conditions.rs` | PENDING | — |
| `src/workflow/authoritative-unblock-v2.ts` | `rust/src/workflow/authoritative_unblock_v2.rs` | PENDING | — |
| `src/workflow/blocker-recovery.ts` | `rust/src/workflow/blocker_recovery.rs` | PENDING | — |
| `src/workflow/blocker-resolution-v2.ts` | `rust/src/workflow/blocker_resolution_v2.rs` | PENDING | — |
| `src/workflow/conditions.ts` | `rust/src/workflow/conditions.rs` | PASS | Batch 4: 729 shared differential cases across 23 source ports; tri-state guards, duplicate/unknown errors, sorted discovery, verification and safe-retry predicate (`rust/tests/head_to_head.mjs`) |
| `src/workflow/contracts.ts` | `rust/src/workflow/contracts.rs` | PASS | Direct hotfix: 2,178 shared Node/Rust event/fact/action inventories, ordered effect policies, classification, errors and empty decisions (rust/tests/head_to_head_direct_hotfix.mjs) |
| `src/workflow/definitions-v2.ts` | `rust/src/workflow/definitions_v2.rs` | PENDING | — |
| `src/workflow/dependency-revision-v2.ts` | `rust/src/workflow/dependency_revision_v2.rs` | PENDING | — |
| `src/workflow/dispatcher.ts` | `rust/src/workflow/dispatcher.rs` | PENDING | — |
| `src/workflow/durable-publication.ts` | `rust/src/workflow/durable_publication.rs` | PENDING | — |
| `src/workflow/durable-transition.ts` | `rust/src/workflow/durable_transition.rs` | PENDING | — |
| `src/workflow/effects.ts` | `rust/src/workflow/effects.rs` | PASS | Direct hotfix: 762 stateful Node/Rust handler/receipt/onOutcome/observation fixtures; 8 Rust-native effect tests and 5 original Node regressions (rust/tests/head_to_head_workflow_effects.mjs; rust/tests/native_workflow_effects.rs) |
| `src/workflow/entity-creation.ts` | `rust/src/workflow/entity_creation.rs` | PENDING | — |
| `src/workflow/escalation.ts` | `rust/src/workflow/escalation.rs` | PENDING | — |
| `src/workflow/force-restate-validation-v2.ts` | `rust/src/workflow/force_restate_validation_v2.rs` | PENDING | — |
| `src/workflow/graph-v2.ts` | `rust/src/workflow/graph_v2.rs` | PENDING | — |
| `src/workflow/job-reconcile-v2.ts` | `rust/src/workflow/job_reconcile_v2.rs` | PENDING | — |
| `src/workflow/lifecycle.ts` | `rust/src/workflow/lifecycle.rs` | PENDING | — |
| `src/workflow/mermaid.ts` | `rust/src/workflow/mermaid.rs` | PASS | Direct hotfix: 924 Mermaid parser + 663 sync/async WorkflowEngine Node/Rust comparisons, real native callback/transition tests (rust/tests/head_to_head_mermaid.mjs; rust/tests/native_direct_hotfix.rs) |
| `src/workflow/orchestrator-rescue.ts` | `rust/src/workflow/orchestrator_rescue.rs` | PENDING | — |
| `src/workflow/planner-orchestration-v2.ts` | `rust/src/workflow/planner_orchestration_v2.rs` | PENDING | — |
| `src/workflow/planner-trigger-v2.ts` | `rust/src/workflow/planner_trigger_v2.rs` | PENDING | — |
| `src/workflow/projection-conflict-v2.ts` | `rust/src/workflow/projection_conflict_v2.rs` | PENDING | — |
| `src/workflow/review-v2.ts` | `rust/src/workflow/review_v2.rs` | PENDING | — |
| `src/workflow/revision-v2.ts` | `rust/src/workflow/revision_v2.rs` | PENDING | — |
| `src/workflow/runtime.ts` | `rust/src/workflow/runtime.rs` | PENDING | — |
| `src/workflow/task-action-policy.ts` | `rust/src/workflow/task_action_policy.rs` | PENDING | — |
| `src/workflow/task-reconcile.ts` | `rust/src/workflow/task_reconcile.rs` | PENDING | — |
| `src/workflow/task-related-action-v2.ts` | `rust/src/workflow/task_related_action_v2.rs` | PENDING | — |
| `src/workflow/task-resolution.ts` | `rust/src/workflow/task_resolution.rs` | PENDING | — |
| `src/workflow/troubleshooter-v2.ts` | `rust/src/workflow/troubleshooter_v2.rs` | PENDING | — |
| `src/workflow/usage-index.ts` | `rust/src/workflow/usage_index.rs` | PENDING | — |
| `src/workspace.ts` | `rust/src/workspace.rs` | PENDING | — |
| `src/z-adapter.ts` | `rust/src/z_adapter.rs` | PENDING | — |
| `src/z-oauth.ts` | `rust/src/z_oauth.rs` | PENDING | — |

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
