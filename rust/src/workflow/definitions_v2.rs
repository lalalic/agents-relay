// Direct port of Node src/workflow/definitions-v2.ts: canonical Workflow Graph instances, condition guards, and topology-owned state transition validation.
use super::{
    conditions::{boolean_condition, ConditionRegistry},
    contracts::{WORKFLOW_EFFECT_NAMES, WORKFLOW_EVENT_NAMES, WORKFLOW_MUTATION_NAMES},
    graph_v2::{Graph, GraphRegistry, GraphRuntime, Guard},
};
use serde_json::Value;
use std::{collections::HashSet, path::Path, sync::Arc};
pub const TASK_STATES: &[&str] = &[
    "DRAFT",
    "QUEUED",
    "RUNNING",
    "AWAITING_DECISION",
    "BLOCKED",
    "SUCCEEDED",
    "FAILED",
    "CANCELLED",
];
pub const JOB_STATES: &[&str] = &["DRAFT", "ACTIVE", "COMPLETED", "CANCELLED"];
pub const LIFECYCLE_CONDITION_NAMES: &[&str] = &[
    "dependenciesSatisfied",
    "dependenciesUnsatisfied",
    "runnable",
    "dispatchable",
    "recoverableExecution",
    "sourceDeliveryVerified",
    "troubleshooterRecovery",
    "troubleshooterTask",
    "awaitingInteractiveDecision",
    "retryAvailable",
    "notMerged",
    "autoMerge",
    "prOpen",
    "reviewDisabled",
    "implementationComplete",
    "headAvailable",
    "mergeCapable",
    "localCompletionAllowed",
    "localMergeReady",
];
pub fn lifecycle_conditions() -> Result<ConditionRegistry, String> {
    ConditionRegistry::new(
        LIFECYCLE_CONDITION_NAMES
            .iter()
            .map(|id| boolean_condition(id))
            .collect(),
    )
}
fn bool_fact(facts: &Value, name: &str) -> bool {
    facts
        .pointer(&format!("/durableFacts/{name}"))
        .and_then(Value::as_bool)
        == Some(true)
}
fn guard(name: &str) -> Guard {
    let guard_name = name.to_string();
    Arc::new(move |facts| match guard_name.as_str() {
        "localCompletionAllowed" => {
            [
                "jobActive",
                "autoMergeEnabled",
                "implementationComplete",
                "completionGateSatisfied",
                "reviewSatisfied",
            ]
            .iter()
            .all(|key| bool_fact(facts, key))
                && (!bool_fact(facts, "localMergeRequired")
                    || bool_fact(facts, "localMergeSucceeded"))
        }
        "localMergeReady" => [
            "jobActive",
            "autoMergeEnabled",
            "implementationComplete",
            "completionGateSatisfied",
            "reviewSatisfied",
            "localMergePresent",
            "reviewHeadCurrent",
            "mergeAttemptReady",
        ]
        .iter()
        .all(|key| bool_fact(facts, key)),
        key => bool_fact(facts, key),
    })
}
fn load(
    name: &str,
    states: &[&str],
    guards: &[&str],
    directory: &Path,
) -> Result<GraphRuntime, String> {
    let source = std::fs::read_to_string(directory.join(format!("{name}.mmd")))
        .map_err(|e| e.to_string())?;
    let mut registry = GraphRegistry {
        states: states
            .iter()
            .map(|state| state.to_string())
            .collect::<HashSet<_>>(),
        ..Default::default()
    };
    for &name in guards {
        registry.guards.insert(name.into(), guard(name));
    }
    for &name in WORKFLOW_MUTATION_NAMES.iter().chain(WORKFLOW_EFFECT_NAMES) {
        registry.actions.insert(name.into(), (None, None));
    }
    for &name in WORKFLOW_EVENT_NAMES {
        registry.events.insert(name.into(), None);
    }
    GraphRuntime::new(&source, registry)
}
pub fn task_lifecycle_v2(directory: &Path) -> Result<GraphRuntime, String> {
    let names = [
        "dependenciesSatisfied",
        "dependenciesUnsatisfied",
        "runnable",
        "dispatchable",
        "shortcutEffectsSafe",
        "recoverableExecution",
        "sourceDeliveryVerified",
        "troubleshooterRecovery",
        "troubleshooterTask",
        "awaitingInteractiveDecision",
        "retryAvailable",
        "platformFallbackSafe",
        "noStartFallbackAllowed",
    ];
    load("task-lifecycle", TASK_STATES, &names, directory)
}
pub fn job_lifecycle_v2(directory: &Path) -> Result<GraphRuntime, String> {
    let names = [
        "notMerged",
        "autoMerge",
        "prOpen",
        "reviewDisabled",
        "implementationComplete",
        "headAvailable",
        "mergeCapable",
        "localCompletionAllowed",
        "localMergeReady",
    ];
    load("job-lifecycle", JOB_STATES, &names, directory)
}
fn topology_targets(graph: &Graph, from: &str) -> Result<HashSet<String>, String> {
    let source = graph
        .nodes
        .iter()
        .find(|node| node.kind == "state" && node.semantic_id == from)
        .ok_or_else(|| format!("Unknown workflow state {from}"))?;
    let mut found = HashSet::new();
    fn walk(graph: &Graph, node_id: &str, seen: &mut HashSet<String>, found: &mut HashSet<String>) {
        if !seen.insert(node_id.to_string()) {
            return;
        }
        let Some(node) = graph.node(node_id) else {
            return;
        };
        if node.kind == "state" {
            found.insert(node.semantic_id.clone());
            return;
        }
        for edge in graph
            .edges
            .iter()
            .filter(|edge| edge.from == node_id && edge.kind != "emit")
        {
            let mut history = seen.clone();
            walk(graph, &edge.to, &mut history, found);
        }
    }
    for edge in graph
        .edges
        .iter()
        .filter(|edge| edge.from == source.id && matches!(edge.kind.as_str(), "on" | "request"))
    {
        let mut visited = HashSet::new();
        visited.insert(source.id.clone());
        walk(graph, &edge.to, &mut visited, &mut found);
    }
    Ok(found)
}
pub fn assert_v2_state_transition(
    graph: &Graph,
    from: &str,
    to: &str,
    kind: &str,
) -> Result<(), String> {
    if from == to {
        return Ok(());
    }
    let states = graph
        .nodes
        .iter()
        .filter(|node| node.kind == "state")
        .map(|node| node.semantic_id.as_str())
        .collect::<HashSet<_>>();
    if !states.contains(from) || !states.contains(to) {
        return Err(format!(
            "Unknown {kind} state {}",
            if !states.contains(from) { from } else { to }
        ));
    }
    if !topology_targets(graph, from)?.contains(to) {
        return Err(format!("Invalid {kind} transition {from} -> {to}"));
    }
    Ok(())
}
