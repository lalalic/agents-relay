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
| `src/agent-content-resolver.ts` | `rust/src/agent_content_resolver.rs` | PENDING | — |
| `src/agent-graph.ts` | `rust/src/agent_graph.rs` | PENDING | — |
| `src/agent-prompt-builder.ts` | `rust/src/agent_prompt_builder.rs` | PENDING | — |
| `src/agent-script-discovery.ts` | `rust/src/agent_script_discovery.rs` | PENDING | — |
| `src/audit-tail.ts` | `rust/src/audit_tail.rs` | PENDING | — |
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
| `src/cli-local-merge-config.ts` | `rust/src/cli_local_merge_config.rs` | PENDING | — |
| `src/cli-projection.ts` | `rust/src/cli_projection.rs` | PENDING | — |
| `src/cli-prompt.ts` | `rust/src/cli_prompt.rs` | PENDING | — |
| `src/cli-review.ts` | `rust/src/cli_review.rs` | PENDING | — |
| `src/cli-revision.ts` | `rust/src/cli_revision.rs` | PENDING | — |
| `src/cli-shutdown.ts` | `rust/src/cli_shutdown.rs` | PENDING | — |
| `src/cli-support.ts` | `rust/src/cli_support.rs` | PENDING | — |
| `src/cli-unblock.ts` | `rust/src/cli_unblock.rs` | PENDING | — |
| `src/cli-worker-task.ts` | `rust/src/cli_worker_task.rs` | PENDING | — |
| `src/cli-workflow-action.ts` | `rust/src/cli_workflow_action.rs` | PENDING | — |
| `src/cli-workflow.ts` | `rust/src/cli_workflow.rs` | PENDING | — |
| `src/cli.ts` | `rust/src/cli.rs` | PENDING | — |
| `src/continuation.ts` | `rust/src/continuation.rs` | PENDING | — |
| `src/dag-result-contract.ts` | `rust/src/dag_result_contract.rs` | PENDING | — |
| `src/dag-stage-contract.ts` | `rust/src/dag_stage_contract.rs` | PENDING | — |
| `src/dag-task-runtime.ts` | `rust/src/dag_task_runtime.rs` | PENDING | — |
| `src/dashboard-actions.ts` | `rust/src/dashboard_actions.rs` | PENDING | — |
| `src/dashboard-data.ts` | `rust/src/dashboard_data.rs` | PENDING | — |
| `src/dashboard-html.ts` | `rust/src/dashboard_html.rs` | PENDING | — |
| `src/dashboard-jel.ts` | `rust/src/dashboard_jel.rs` | PENDING | — |
| `src/dashboard-style.ts` | `rust/src/dashboard_style.rs` | PENDING | — |
| `src/dashboard-workflow-inspection.ts` | `rust/src/dashboard_workflow_inspection.rs` | PENDING | — |
| `src/dashboard.ts` | `rust/src/dashboard.rs` | PENDING | — |
| `src/decision-audit.ts` | `rust/src/decision_audit.rs` | PENDING | — |
| `src/decision.ts` | `rust/src/decision.rs` | PENDING | — |
| `src/dependency-revision-execution.ts` | `rust/src/dependency_revision_execution.rs` | PENDING | — |
| `src/dependency-validity.ts` | `rust/src/dependency_validity.rs` | PASS | 327 shared differential fixtures across 4 ports; Rust native tests 5/5; Node focused regression 4/4; clippy clean (`rust/tests/head_to_head.mjs`) |
| `src/escalation-notifier.ts` | `rust/src/escalation_notifier.rs` | PENDING | — |
| `src/events-bus-runtime.ts` | `rust/src/events_bus_runtime.rs` | PENDING | — |
| `src/events.ts` | `rust/src/events.rs` | PENDING | — |
| `src/execution-boundary.ts` | `rust/src/execution_boundary.rs` | PENDING | — |
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
| `src/github-binding-order.ts` | `rust/src/github_binding_order.rs` | PENDING | — |
| `src/github-branch-projection.ts` | `rust/src/github_branch_projection.rs` | PENDING | — |
| `src/github-client.ts` | `rust/src/github_client.rs` | PENDING | — |
| `src/github-pr-archive.ts` | `rust/src/github_pr_archive.rs` | PENDING | — |
| `src/github-runtime-usage.ts` | `rust/src/github_runtime_usage.rs` | PENDING | — |
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
| `src/local-job-path.ts` | `rust/src/local_job_path.rs` | PENDING | — |
| `src/local-job-registry.ts` | `rust/src/local_job_registry.rs` | PENDING | — |
| `src/local-managed-store.ts` | `rust/src/local_managed_store.rs` | PENDING | — |
| `src/local-merge-delivery.ts` | `rust/src/local_merge_delivery.rs` | PENDING | — |
| `src/local-merge-lock.ts` | `rust/src/local_merge_lock.rs` | PENDING | — |
| `src/local-merge-projection.ts` | `rust/src/local_merge_projection.rs` | PENDING | — |
| `src/managed-worker-input.ts` | `rust/src/managed_worker_input.rs` | PENDING | — |
| `src/manual-plan.ts` | `rust/src/manual_plan.rs` | PENDING | — |
| `src/markers.ts` | `rust/src/markers.rs` | PENDING | — |
| `src/model-redecision.ts` | `rust/src/model_redecision.rs` | PENDING | — |
| `src/model-routing.ts` | `rust/src/model_routing.rs` | PENDING | — |
| `src/no-github.ts` | `rust/src/no_github.rs` | PENDING | — |
| `src/observability.ts` | `rust/src/observability.rs` | PENDING | — |
| `src/outcome-review.ts` | `rust/src/outcome_review.rs` | PENDING | — |
| `src/owned-process.ts` | `rust/src/owned_process.rs` | PENDING | — |
| `src/planned-review-head.ts` | `rust/src/planned_review_head.rs` | PENDING | — |
| `src/planner-agent-roles.ts` | `rust/src/planner_agent_roles.rs` | PASS | 587 shared differential fixtures across 7 ports; Rust native tests 8/8; Node focused regression 18/18; clippy clean (`rust/tests/head_to_head.mjs`) |
| `src/planner-child-recovery.ts` | `rust/src/planner_child_recovery.rs` | PENDING | — |
| `src/planner-child.ts` | `rust/src/planner_child.rs` | PENDING | — |
| `src/planner-history-cleanup.ts` | `rust/src/planner_history_cleanup.rs` | PENDING | — |
| `src/planner-recovery.ts` | `rust/src/planner_recovery.rs` | PENDING | — |
| `src/planner-runtime.ts` | `rust/src/planner_runtime.rs` | PENDING | — |
| `src/planner-task-context.ts` | `rust/src/planner_task_context.rs` | PENDING | — |
| `src/planner-task-ids.ts` | `rust/src/planner_task_ids.rs` | PENDING | — |
| `src/planner-task-title.ts` | `rust/src/planner_task_title.rs` | PASS | 327 shared differential fixtures across 4 ports; Rust native tests 5/5; Node focused regression 4/4; clippy clean (`rust/tests/head_to_head.mjs`) |
| `src/planner.ts` | `rust/src/planner.rs` | PENDING | — |
| `src/pool.ts` | `rust/src/pool.rs` | PENDING | — |
| `src/process-identity.ts` | `rust/src/process_identity.rs` | PENDING | — |
| `src/projected-store.ts` | `rust/src/projected_store.rs` | PENDING | — |
| `src/projection-failure-dedupe.ts` | `rust/src/projection_failure_dedupe.rs` | PENDING | — |
| `src/projection-failure-recovery.ts` | `rust/src/projection_failure_recovery.rs` | PENDING | — |
| `src/projection-outbox.ts` | `rust/src/projection_outbox.rs` | PENDING | — |
| `src/projection-recovery-runtime.ts` | `rust/src/projection_recovery_runtime.rs` | PENDING | — |
| `src/projection-recovery.ts` | `rust/src/projection_recovery.rs` | PENDING | — |
| `src/publication-store.ts` | `rust/src/publication_store.rs` | PENDING | — |
| `src/reconcile-coordinator.ts` | `rust/src/reconcile_coordinator.rs` | PENDING | — |
| `src/reconciler-cancellation.ts` | `rust/src/reconciler_cancellation.rs` | PENDING | — |
| `src/reconciler-context.ts` | `rust/src/reconciler_context.rs` | PENDING | — |
| `src/reconciler-pause.ts` | `rust/src/reconciler_pause.rs` | PENDING | — |
| `src/reconciler-review.ts` | `rust/src/reconciler_review.rs` | PENDING | — |
| `src/reconciler-runtime.ts` | `rust/src/reconciler_runtime.rs` | PENDING | — |
| `src/reconciler-workflow-outbox.ts` | `rust/src/reconciler_workflow_outbox.rs` | PENDING | — |
| `src/reconciler.ts` | `rust/src/reconciler.rs` | PENDING | — |
| `src/registry.ts` | `rust/src/registry.rs` | PENDING | — |
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
| `src/review-evidence.ts` | `rust/src/review_evidence.rs` | PENDING | — |
| `src/review-generation-fence.ts` | `rust/src/review_generation_fence.rs` | PENDING | — |
| `src/review-replan.ts` | `rust/src/review_replan.rs` | PENDING | — |
| `src/review-revision-execution.ts` | `rust/src/review_revision_execution.rs` | PENDING | — |
| `src/review-revision-merge.ts` | `rust/src/review_revision_merge.rs` | PENDING | — |
| `src/review-revision-model.ts` | `rust/src/review_revision_model.rs` | PENDING | — |
| `src/review-revision-policy.ts` | `rust/src/review_revision_policy.rs` | PENDING | — |
| `src/review-revision-settlement.ts` | `rust/src/review_revision_settlement.rs` | PENDING | — |
| `src/review-revision-stale.ts` | `rust/src/review_revision_stale.rs` | PENDING | — |
| `src/review-terminal-normalization.ts` | `rust/src/review_terminal_normalization.rs` | PENDING | — |
| `src/reviewer-thread.ts` | `rust/src/reviewer_thread.rs` | PENDING | — |
| `src/route-outcome-recording.ts` | `rust/src/route_outcome_recording.rs` | PENDING | — |
| `src/router-evals.ts` | `rust/src/router_evals.rs` | PENDING | — |
| `src/router-rules.ts` | `rust/src/router_rules.rs` | PENDING | — |
| `src/routing-policy.ts` | `rust/src/routing_policy.rs` | PENDING | — |
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
| `src/task-id-migration.ts` | `rust/src/task_id_migration.rs` | PENDING | — |
| `src/task-inactivity-watchdog.ts` | `rust/src/task_inactivity_watchdog.rs` | PENDING | — |
| `src/task-recovery.ts` | `rust/src/task_recovery.rs` | PENDING | — |
| `src/task-tag.ts` | `rust/src/task_tag.rs` | PENDING | — |
| `src/task-title.ts` | `rust/src/task_title.rs` | PASS | 327 shared differential fixtures across 4 ports; Rust native tests 5/5; Node focused regression 4/4; clippy clean (`rust/tests/head_to_head.mjs`) |
| `src/task-transitions.ts` | `rust/src/task_transitions.rs` | PENDING | — |
| `src/task-update.ts` | `rust/src/task_update.rs` | PENDING | — |
| `src/terminal-event-recovery.ts` | `rust/src/terminal_event_recovery.rs` | PASS | 327 shared differential fixtures across 4 ports; Rust native tests 5/5; Node focused regression 4/4; clippy clean (`rust/tests/head_to_head.mjs`) |
| `src/troubleshooter-fallback.ts` | `rust/src/troubleshooter_fallback.rs` | PENDING | — |
| `src/troubleshooter-qa-api.ts` | `rust/src/troubleshooter_qa_api.rs` | PENDING | — |
| `src/troubleshooter.ts` | `rust/src/troubleshooter.rs` | PENDING | — |
| `src/types.ts` | `rust/src/types.rs` | PENDING | — |
| `src/unblock.ts` | `rust/src/unblock.rs` | PENDING | — |
| `src/unified-job-registry.ts` | `rust/src/unified_job_registry.rs` | PENDING | — |
| `src/unified-pr-facts.ts` | `rust/src/unified_pr_facts.rs` | PENDING | — |
| `src/unified-relay-schema.ts` | `rust/src/unified_relay_schema.rs` | PENDING | — |
| `src/usage.ts` | `rust/src/usage.rs` | PENDING | — |
| `src/webhelm-daemon-client.ts` | `rust/src/webhelm_daemon_client.rs` | PENDING | — |
| `src/worker-failure-recovery.ts` | `rust/src/worker_failure_recovery.rs` | PENDING | — |
| `src/worker-rejection.ts` | `rust/src/worker_rejection.rs` | PENDING | — |
| `src/worker-routing.ts` | `rust/src/worker_routing.rs` | PENDING | — |
| `src/worker-start-ack.ts` | `rust/src/worker_start_ack.rs` | PENDING | — |
| `src/workflow-effect-failures.ts` | `rust/src/workflow_effect_failures.rs` | PENDING | — |
| `src/workflow/action-ledger.ts` | `rust/src/workflow/action_ledger.rs` | PENDING | — |
| `src/workflow/authoritative-conditions.ts` | `rust/src/workflow/authoritative_conditions.rs` | PENDING | — |
| `src/workflow/authoritative-unblock-v2.ts` | `rust/src/workflow/authoritative_unblock_v2.rs` | PENDING | — |
| `src/workflow/blocker-recovery.ts` | `rust/src/workflow/blocker_recovery.rs` | PENDING | — |
| `src/workflow/blocker-resolution-v2.ts` | `rust/src/workflow/blocker_resolution_v2.rs` | PENDING | — |
| `src/workflow/conditions.ts` | `rust/src/workflow/conditions.rs` | PENDING | — |
| `src/workflow/contracts.ts` | `rust/src/workflow/contracts.rs` | PENDING | — |
| `src/workflow/definitions-v2.ts` | `rust/src/workflow/definitions_v2.rs` | PENDING | — |
| `src/workflow/dependency-revision-v2.ts` | `rust/src/workflow/dependency_revision_v2.rs` | PENDING | — |
| `src/workflow/dispatcher.ts` | `rust/src/workflow/dispatcher.rs` | PENDING | — |
| `src/workflow/durable-publication.ts` | `rust/src/workflow/durable_publication.rs` | PENDING | — |
| `src/workflow/durable-transition.ts` | `rust/src/workflow/durable_transition.rs` | PENDING | — |
| `src/workflow/effects.ts` | `rust/src/workflow/effects.rs` | PENDING | — |
| `src/workflow/entity-creation.ts` | `rust/src/workflow/entity_creation.rs` | PENDING | — |
| `src/workflow/escalation.ts` | `rust/src/workflow/escalation.rs` | PENDING | — |
| `src/workflow/force-restate-validation-v2.ts` | `rust/src/workflow/force_restate_validation_v2.rs` | PENDING | — |
| `src/workflow/graph-v2.ts` | `rust/src/workflow/graph_v2.rs` | PENDING | — |
| `src/workflow/job-reconcile-v2.ts` | `rust/src/workflow/job_reconcile_v2.rs` | PENDING | — |
| `src/workflow/lifecycle.ts` | `rust/src/workflow/lifecycle.rs` | PENDING | — |
| `src/workflow/mermaid.ts` | `rust/src/workflow/mermaid.rs` | PENDING | — |
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
