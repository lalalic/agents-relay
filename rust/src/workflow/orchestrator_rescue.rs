// Direct port of Node src/workflow/orchestrator-rescue.ts: preserve legacy repair
// semantics with canonical Rescue and Task lifecycle Graph validation (no blind retry).
use super::{
    graph_v2::GraphRuntime,
    lifecycle::dispatch_task_lifecycle_sync,
    policy_graph::{choose_policy, load_policy_graph},
};
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{json, Value};
use std::path::Path;
pub const STALE_ORCHESTRATOR_TASK_MS: i64 = 30 * 60 * 1000;
pub const ORCHESTRATOR_RESCUE_V2: &str = "orchestrator-rescue";
pub fn orchestrator_rescue_v2(directory: &Path) -> Result<GraphRuntime, String> {
    load_policy_graph(directory, ORCHESTRATOR_RESCUE_V2)
}
fn millis(raw: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|value| value.timestamp_millis())
}
fn no_execution(task:&Value)->bool {
    task.get("executionId").is_none_or(Value::is_null)
}
pub fn orchestrator_rescue_facts(task: &Value, now: i64) -> Value {
    let legacy_active = task["kind"] != "planner"
        && task["adapter"] == "orchestrator"
        && matches!(task["state"].as_str(), Some("QUEUED" | "RUNNING"));
    let verified = legacy_active
        && task.get("result").is_some_and(|value| !value.is_null())
        && task.pointer("/result/data/externalCompletionVerified") == Some(&Value::Bool(true));
    json!({"legacyActive":legacy_active,"verifiedExternalCompletion":verified,
        "unknownStartedOutcome":legacy_active&&task["state"]=="RUNNING"&&!verified&&no_execution(task),
        "rescuable":legacy_active&&task["state"]=="QUEUED"&&!verified&&no_execution(task)})
}
pub fn decide_orchestrator_rescue(
    directory: &Path,
    task: &Value,
    now: i64,
) -> Result<Value, String> {
    choose_policy(
        directory,
        ORCHESTRATOR_RESCUE_V2,
        "idle",
        "orchestrator.rescue.reconcile",
        &orchestrator_rescue_facts(task, now),
        4,
        |state| state == "check",
    )
}
pub fn prepare_orchestrator_repair(
    directory: &Path,
    task: &mut Value,
    now: i64,
) -> Result<Value, String> {
    let decision = decide_orchestrator_rescue(directory, task, now)?;
    let actions = decision["actions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|row| row["id"].as_str())
        .collect::<Vec<_>>();
    let external =
        decision["accepted"] == true && actions.contains(&"task.applyExternalCompletion");
    let failed = decision["accepted"] == true && actions.contains(&"task.failLegacyOrchestrator");
    let rescued = external
        || failed
        || (decision["accepted"] == true && actions.contains(&"task.rescueOrchestrator"));
    let age = task["createdAt"]
        .as_str()
        .and_then(millis)
        .map(|created| json!(now - created))
        .unwrap_or(Value::Null);
    let result = |repaired, externally_completed, failed| json!({"repaired":repaired,"externallyCompleted":externally_completed,"failed":failed,"ageMs":age});
    if external {
        let stamp = DateTime::<Utc>::from_timestamp_millis(now)
            .ok_or("invalid time")?
            .to_rfc3339_opts(SecondsFormat::Millis, true);
        dispatch_task_lifecycle_sync(directory, task, "task.completed", &json!({}), &stamp)?;
        for key in ["executionId", "threadId"] {
            task[key] = Value::Null;
        }
        task["updatedAt"] = json!(stamp);
        return Ok(result(true, true, false));
    }
    if !rescued {
        return Ok(result(false, false, false));
    }
    let stamp = DateTime::<Utc>::from_timestamp_millis(now)
        .ok_or("invalid time")?
        .to_rfc3339_opts(SecondsFormat::Millis, true);
    if failed {
        dispatch_task_lifecycle_sync(directory, task, "task.failed", &json!({}), &stamp)?;
        task["error"]=json!("Legacy orchestrator execution outcome is unknown; Troubleshooter diagnosis is required before retry.");
        task["failureReason"] = json!("worker_outcome_unknown");
        for key in ["executionId", "threadId"] {
            task[key] = Value::Null;
        }
        task["updatedAt"] = json!(stamp);
        return Ok(result(true, false, true));
    }
    task["adapter"] = json!("codex");
    task["workerRequirements"] = json!({"capabilities":task["capabilities"]});
    for key in ["workerSelection", "routing"] {
        if let Some(object) = task.as_object_mut() {
            object.shift_remove(key);
        }
    }
    for key in ["executionId", "threadId"] {
        task[key] = Value::Null;
    }
    task["timeoutMs"] = json!(match task["storySize"].as_str().unwrap_or("M") {
        "S" => 300000,
        "L" => 2700000,
        _ => 900000,
    });
    task["updatedAt"] = json!(stamp);
    Ok(result(true, false, false))
}
