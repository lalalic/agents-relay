// New rust2 library: routes one-to-one ports of Node src modules without importing the retired Rust rewrite.
pub mod audit_tail;
pub mod cli_local_merge_config;
pub mod cli_shutdown;
pub mod cli_workflow_action;
pub mod dag_stage_contract;
pub mod dependency_validity;
pub mod execution_boundary;
pub mod final_review_role;
pub mod github_binding_order;
pub mod github_branch_projection;
pub mod job_execution_slot;
pub mod js_text;
pub mod local_job_path;
pub mod local_merge_lock;
pub mod planned_review_head;
pub mod planner_agent_roles;
pub mod planner_history_cleanup;
pub mod planner_task_context;
pub mod planner_task_title;
pub mod process_identity;
pub mod projection_failure_dedupe;
pub mod registry;
pub mod review_evidence;
pub mod review_revision_merge;
pub mod review_revision_policy;
pub mod review_terminal_normalization;
pub mod router_rules;
pub mod routing_policy;
pub mod task_tag;
pub mod worker_rejection;
pub mod workflow {
    pub mod conditions;
    // Direct Node src/workflow/graph-v2.ts executable state/guard/action/event Graph.
    pub mod graph_v2;
    // Companion grammar/topology half of the Node src/workflow/graph-v2.ts direct port.
    pub mod graph_v2_parser;
    // Direct Node src/workflow/usage-index.ts readonly Graph symbol usage index.
    pub mod usage_index;
    // Direct Node src/workflow/durable-publication.ts transactional workflow outbox/inbox.
    pub mod durable_publication;
    // Direct Node src/workflow/definitions-v2.ts canonical Task/Job Graph registries and transitions.
    // Direct Node src/workflow/dispatcher.ts transition/action/event boundary.
    pub mod dispatcher;
    // Verified-effect/atomic-outbox half of direct Node dispatcher port.
    pub mod dispatcher_verification;
    // Direct ports of nine Node Graph-backed domain policy adapters.
    pub mod authoritative_unblock_v2;
    pub mod blocker_recovery;
    pub mod blocker_resolution_v2;
    pub mod dependency_revision_v2;
    pub mod force_restate_validation_v2;
    pub mod planner_trigger_v2;
    pub mod projection_conflict_v2;
    pub mod revision_v2;
    pub mod troubleshooter_v2;
    // Shared loader for Graph-driven v2 workflow wrappers.
    pub mod definitions_v2;
    // Direct Node workflow/lifecycle.ts Graph façade for Job/Task transitions.
    pub mod lifecycle;
    // Direct Node Review, Job reconciliation and related Task Graph policies.
    pub mod job_reconcile_v2;
    pub mod policy_graph;
    pub mod review_v2;
    pub mod task_action_policy;
    // Direct Node Task/Job entity creation, prehuman escalation and legacy orchestrator rescue.
    pub mod entity_creation;
    pub mod escalation;
    pub mod orchestrator_rescue;
    // Isolated Node/Rust multi-module lifecycle differential fixture.
    pub mod lifecycle_parity_harness;
    pub mod task_related_action_v2;
    // Isolated direct Node/Rust policy and dispatcher fixture adapters.
    pub mod policy_parity_harness;
    // Direct Node src/workflow/runtime.ts mechanical Graph-selected Task/Job effects.
    pub mod runtime;
    // Direct Node src/workflow/action-ledger.ts Graph-authorized durable effect receipts.
    pub mod action_ledger;
    pub mod contracts;
    pub mod effects;
    pub mod mermaid;
}
pub mod cli_artifact;
pub mod dashboard_jel;
pub mod dashboard_style;
pub mod dashboard_workflow_inspection;
pub mod task_title;
pub mod terminal_event_recovery;
pub mod troubleshooter_qa_api;
pub mod webhelm_daemon_client;

// Direct Node src/agent-prompt-builder.ts implementation.
pub mod agent_prompt_builder;

// Direct Node src/agent-content-resolver.ts implementation.
pub mod agent_content_resolver;

// Direct offline SQLite migration port of Node src/task-id-migration.ts.
pub mod task_id_migration;

// Direct Node src/planner-child.ts field-projection equality port.
pub mod planner_child;
// Direct Node src/observability.ts implementation; observational only.
pub mod observability;

// Direct Node src/reconciler-pause.ts port: durable pause generation cancellation.
pub mod reconciler_pause;

// Direct Node src/github-runtime-usage.ts rate-limit telemetry and CLI response handling.
pub mod github_runtime_usage;

// Direct Node src/execution-event-identity.ts execution source binding port.
pub mod execution_event_identity;
// Direct Node src/local-commit-events.ts post-SQLite pub/sub port.
pub mod local_commit_events;

// Direct Node src/events-bus-runtime.ts configured HTTP history transport port.
pub mod events_bus_runtime;

// Direct Node src/review-generation-fence.ts immutable Review generation fence.
pub mod review_generation_fence;
// Direct Node src/unified-pr-facts.ts job-scoped monotonic SQLite facts.
pub mod unified_pr_facts;

// Direct Node src/job-task-id-sequence.ts global persistent numeric IDs.
pub mod job_task_id_sequence;

// Direct Node src/unified-job-registry.ts immutable local Job identity and transactions.
pub mod unified_job_registry;

// Direct Node src/legacy-blocked-task-migration.ts historical Task state migration.
pub mod legacy_blocked_task_migration;
// Direct Node src/job-pr-number-migration.ts historical PR-number and Task-title migration.
pub mod job_pr_number_migration;

// Direct Node src/unified-relay-schema.ts authoritative SQLite DDL port.
pub mod unified_relay_schema;

// Direct Node src/relay-job-snapshot-reads.ts durable Job normalization/reads.
pub mod relay_job_snapshot_reads;
// Direct Node src/no-github.ts fail-closed transport guard.
pub mod no_github;

// Direct Node src/task-comments.ts immutable comment history and reconciliation.
pub mod task_comments;

// Direct Node src/cli-help.ts production static CLI usage/help strings.
pub mod cli_help;
// Direct Node src/github-pr-archive.ts optional display-only GitHub PR archival policy.
pub mod github_pr_archive;

// Direct Node src/runtime-status.ts computed Job and implementation lifecycle.
pub mod runtime_status;

// Direct Node src/runtime-summary.ts lease-fenced worker/model runtime summary.
pub mod runtime_summary;

// Direct Node src/runtime-status-events.ts process-local status transition notifications.
pub mod runtime_status_events;

// Direct Node src/relay-job-merge.ts immutable Job/Plan/Task inbound merge.
pub mod relay_job_merge;
// Direct Node src/relay-create.ts atomic SQLite Job create-if-absent.
pub mod relay_create;
// Direct Node src/store-task-definition.ts immutable definition comparison.
pub mod store_task_definition;

// Direct Node src/task-context.ts immutable Task execution context and prompts.
pub mod task_context;
// Direct Node src/publication-store.ts transactional publication receipts.
pub mod publication_store;

// Direct Node src/github-webhook.ts trusted GitHub wake/webhook parsing and deduplication.
pub mod github_webhook;

// Direct Node src/markers.ts HTML metadata and legacy markdown read/render.
pub mod markers;

// Direct Node src/reconciler-workflow-outbox.ts transport publication effect.
pub mod reconciler_workflow_outbox;

// Direct Node src/graph-runtime.ts re-export alias to graph-v2 runtime.
pub mod graph_runtime;

// Direct Node src/agent-graph.ts production Agent DAG parsing and prompt text.
pub mod agent_graph;
