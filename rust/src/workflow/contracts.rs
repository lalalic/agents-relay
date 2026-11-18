// Direct port of src/workflow/contracts.ts: canonical event/fact/action inventories, effect policies and decision helpers.
use serde_json::{json, Value};

pub const WORKFLOW_EVENT_NAMES: &[&str] = &[
    "activate",
    "block",
    "cancel",
    "dispatch",
    "effect.cancelActiveTasks.failed",
    "effect.cleanupJobWorktree.failed",
    "effect.launchTask.failed",
    "effect.mergePullRequest.failed",
    "execution.orphaned",
    "fail",
    "hold",
    "lease.expired",
    "implementation.completed",
    "task.interactive_waiting",
    "local.completed",
    "local.merge.requested",
    "effect.deliverLocalMerge.failed",
    "pr.closed",
    "pr.merged",
    "queue",
    "plan.requested",
    "pause",
    "planner.failed",
    "planner.unavailable",
    "reconcile",
    "recovery.reopen",
    "release",
    "interactive.resume",
    "retry",
    "review.started",
    "review.approved",
    "review.changes_required",
    "review.blocked",
    "review.retry",
    "task.blocked",
    "task.cancelled",
    "task.completed",
    "task.failed",
    "task.progress",
    "task.started",
    "task.unblocked",
    "watchdog.failed",
    "worker.delivery_failed",
    "worker.start_ack_failed",
    "worker.platform_failure",
    "worker.no_start_failed",
];
pub const WORKFLOW_FACT_NAMES: &[&str] = &[
    "dependenciesSatisfied",
    "dependenciesUnsatisfied",
    "runnable",
    "dispatchable",
    "shortcutEffectsSafe",
    "notMerged",
    "autoMerge",
    "recoverableExecution",
    "sourceDeliveryVerified",
    "retryAvailable",
    "reviewUnblocked",
    "initialPlan",
    "hasUnblock",
    "manualPlan",
    "reviewDisabled",
    "implementationComplete",
    "headAvailable",
    "mergeCapable",
    "platformFallbackSafe",
    "noStartFallbackAllowed",
];
pub const WORKFLOW_MUTATION_NAMES: &[&str] = &[
    "mutation.clearError",
    "mutation.clearFailureReason",
    "mutation.clearLease",
    "mutation.clearExecution",
    "mutation.markLeaseExpired",
    "mutation.markStartupOrphanedExhausted",
    "mutation.markUnknownOutcome",
    "mutation.markPlannerUnavailable",
    "mutation.preparePlatformFallback",
    "mutation.prepareNoStartFallback",
    "mutation.quarantinePlatformFailure",
];
pub const WORKFLOW_EFFECT_NAMES: &[&str] = &[
    "effect.launchTask",
    "effect.cancelActiveTasks",
    "effect.mergePullRequest",
    "effect.deliverLocalMerge",
    "effect.cleanupJobWorktree",
];

pub struct WorkflowEffectPolicy {
    pub idempotency: &'static str,
    pub failure_event: &'static str,
    pub retry: &'static str,
    pub observability: &'static str,
}

pub fn workflow_effect_policy(effect: &str) -> Option<WorkflowEffectPolicy> {
    let (idempotency, failure_event) = match effect {
        "effect.launchTask" => ("job-task-attempt", "effect.launchTask.failed"),
        "effect.cancelActiveTasks" => ("job-transition", "effect.cancelActiveTasks.failed"),
        "effect.cleanupJobWorktree" => ("job-completed", "effect.cleanupJobWorktree.failed"),
        "effect.deliverLocalMerge" => ("job-local-source-sha", "effect.deliverLocalMerge.failed"),
        "effect.mergePullRequest" => ("job-head-sha", "effect.mergePullRequest.failed"),
        _ => return None,
    };
    Some(WorkflowEffectPolicy {
        idempotency,
        failure_event,
        retry: "workflow",
        observability: "workflow.effect",
    })
}

pub fn workflow_effect_policies() -> Value {
    let mut policies = serde_json::Map::new();
    for &name in WORKFLOW_EFFECT_NAMES {
        let policy = workflow_effect_policy(name).expect("known effect policy");
        policies.insert(name.to_string(), json!({"idempotency":policy.idempotency,"failureEvent":policy.failure_event,"retry":policy.retry,"observability":policy.observability}));
    }
    Value::Object(policies)
}

pub fn workflow_effect_failure_event(effect: &str) -> Result<&'static str, String> {
    workflow_effect_policy(effect)
        .map(|x| x.failure_event)
        .ok_or_else(|| "Cannot read properties of undefined (reading 'failureEvent')".to_string())
}

pub fn classify_workflow_actions(actions: &[String]) -> Result<Value, String> {
    let mut mutations = Vec::new();
    let mut effects = Vec::new();
    for action in actions {
        if WORKFLOW_MUTATION_NAMES.contains(&action.as_str()) {
            mutations.push(action.clone());
        } else if WORKFLOW_EFFECT_NAMES.contains(&action.as_str()) {
            effects.push(action.clone());
        } else {
            return Err(format!("Unknown canonical workflow action {action}"));
        }
    }
    Ok(json!({"mutations":mutations,"effects":effects}))
}

pub fn empty_workflow_decision(reason: &str) -> Value {
    json!({"accepted":false,"target":null,"guard":null,"actions":[],"mutations":[],"effects":[],"reason":reason})
}
