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
