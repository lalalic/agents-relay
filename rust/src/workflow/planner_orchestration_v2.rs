// Direct port of src/workflow/planner-orchestration-v2.ts. Graph owns all
// planning decisions. These functions only derive facts from supplied durable Job.
use super::dispatcher::{dispatch_workflow_graph, DispatchOptions};
use super::policy_graph::{choose_policy, execute_policy, load_policy_graph};
use serde_json::{json, Value};
use std::{collections::HashSet, future::Future, path::Path};

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn rows(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn truthy(value: &Value) -> bool {
    !value.is_null() && value != false && value != "" && value != 0
}
fn review_needs_replan(job: &Value) -> bool {
    let review = &job["review"];
    if !truthy(&review["taskId"]) || review["revisionDisposition"] == "targeted" {
        return false;
    }
    let changes = review["outcome"] == "changes_required"
        || (review["outcome"] == "stale"
            && rows(&job["reviewRevisionRounds"]).iter().any(|round| {
                round["reviewTaskId"] == review["taskId"] && round["status"] == "changes_required"
            }));
    changes
        && !rows(&job["plans"]).iter().any(|plan| {
            plan.pointer("/trigger/source") == Some(&json!("review"))
                && plan.pointer("/trigger/reviewTaskId") == Some(&review["taskId"])
                && plan["status"] != "FAILED"
        })
}
fn unconsumed_unblock_task_ids(job: &Value) -> Option<Vec<Value>> {
    let consumed: HashSet<String> = rows(&job["plans"])
        .iter()
        .filter(|p| {
            p["status"] == "SUCCEEDED" && p.pointer("/trigger/source") == Some(&json!("unblock"))
        })
        .flat_map(|p| {
            rows(&p["trigger"]["taskIds"])
                .iter()
                .filter_map(|id| id.as_str().map(str::to_owned))
        })
        .collect();
    let tasks = rows(&job["tasks"])
        .iter()
        .filter(|task| {
            task["agentName"] != "troubleshooter"
                && truthy(&task["unblock"])
                && !consumed.contains(s(task, "id"))
                && (task["state"] == "DRAFT" || task["state"] == "QUEUED")
        })
        .map(|t| t["id"].clone())
        .collect::<Vec<_>>();
    if !tasks.is_empty() {
        return Some(tasks);
    }
    let cycle = &job["changeCycle"];
    if cycle.is_null() || truthy(&cycle["consumedByPlannerTaskId"]) {
        return None;
    }
    Some(rows(&cycle["taskIds"]).to_vec())
}
fn unblock_needs_new_plan(latest: &Value, pending: &Option<Vec<Value>>) -> bool {
    let Some(ids) = pending else {
        return false;
    };
    !(latest["status"] == "FAILED"
        && latest.pointer("/trigger/source") == Some(&json!("unblock"))
        && rows(&latest["trigger"]["taskIds"])
            .iter()
            .any(|id| ids.contains(id)))
}
fn plan_order(a: &Value, b: &Value) -> std::cmp::Ordering {
    a["round"]
        .as_f64()
        .unwrap_or(0.0)
        .partial_cmp(&b["round"].as_f64().unwrap_or(0.0))
        .unwrap_or(std::cmp::Ordering::Equal)
        .then_with(|| s(a, "createdAt").cmp(s(b, "createdAt")))
}
pub fn planner_orchestration_facts(job: &Value, recoverable_pending_plan: bool) -> Value {
    let tasks = rows(&job["tasks"]);
    let mut plans = rows(&job["plans"]).to_vec();
    plans.sort_by(plan_order);
    let latest = plans.last().cloned().unwrap_or(Value::Null);
    let failed = if latest["status"] == "FAILED" {
        &latest
    } else {
        &Value::Null
    };
    let recovery = if failed.is_null() {
        None
    } else {
        tasks.iter().find(|task| {
            task["agentName"] == "troubleshooter" && task["recoveryPlanId"] == failed["id"]
        })
    };
    let recovery_verified = recovery.is_some_and(|task| {
        task["state"] == "SUCCEEDED"
            && task.pointer("/result/data/verified") == Some(&Value::Bool(true))
            && task
                .pointer("/result/data/evidence")
                .and_then(Value::as_str)
                .is_some_and(|e| !e.trim().is_empty())
    });
    let legacy = if plans.is_empty() {
        tasks
            .iter()
            .filter(|t| {
                t["kind"] == "planner" && t["state"] == "SUCCEEDED" && truthy(&t["plannerResult"])
            })
            .max_by(|a, b| {
                s(a, "createdAt")
                    .cmp(s(b, "createdAt"))
                    .then_with(|| s(a, "id").cmp(s(b, "id")))
            })
    } else {
        None
    };
    let latest_id = if latest.is_null() {
        legacy.map(|t| t["id"].clone()).unwrap_or(Value::Null)
    } else {
        latest["id"].clone()
    };
    let latest_objective = if latest.is_null() {
        legacy
            .map(|t| {
                t.pointer("/plannerResult/objective_status")
                    .cloned()
                    .unwrap_or(Value::Null)
            })
            .unwrap_or(Value::Null)
    } else {
        latest["objectiveStatus"].clone()
    };
    let pending = unconsumed_unblock_task_ids(job);
    let unblock_new = unblock_needs_new_plan(&latest, &pending);
    let no_active_planner = if failed["manualPlanning"] == true {
        false
    } else {
        (unblock_new || pending.is_none()) && !plans.iter().any(|p| p["status"] == "PLANNING")
    };
    let no_blocked_work = pending.is_some()
        || !tasks.iter().any(|task| {
            task["kind"] != "planner"
                && task["agentName"] == "troubleshooter"
                && task["state"] == "BLOCKED"
        });
    let no_active_implementation = !tasks.iter().any(|task| {
        task["kind"] != "planner"
            && (task["state"] == "QUEUED"
                || task["state"] == "RUNNING"
                || task["state"] == "AWAITING_DECISION"
                || (task["state"] == "DRAFT" && !truthy(&task["unblock"])))
    });
    let review_replan = review_needs_replan(job);
    json!({
        "legacyPlanningPending":job.pointer("/initialPlanning/status")==Some(&json!("pending")),
        "recoverablePendingPlan":recoverable_pending_plan,
        "terminalPlanFailure":!failed.is_null()&&(!truthy(&failed["manualPlanning"])||truthy(&failed["forceRestate"]))
            &&failed.pointer("/trigger/source")!=Some(&json!("unblock")),
        "planRecoveryExists":recovery.is_some(),
        "planRecoveryVerified":recovery_verified,
        "hasSeedWork": !(plans.is_empty()&&tasks.iter().filter(|task|task["kind"]!="planner").count()==0),
        "planningRequested":truthy(&job["initialPlanning"])||!plans.is_empty()
            ||tasks.iter().any(|t|t["kind"]=="planner")
            ||!tasks.iter().any(|t|truthy(&t["agentGraph"]))||review_replan,
        "noActivePlanner":no_active_planner,
        "noBlockedWork":no_blocked_work,
        "noActiveImplementation":no_active_implementation,
        "resolutionOwnedByTroubleshooter":tasks.iter().any(|task|task["kind"]!="planner"
            &&task.pointer("/resolution/owner")==Some(&json!("troubleshooter"))
            &&matches!(task.pointer("/resolution/state").and_then(Value::as_str),Some("active"|"waiting"))),
        "continuationMaterialized":pending.is_some()
            ||!(latest_objective=="in_progress"&&truthy(&latest_id)
                &&!tasks.iter().any(|task|task["kind"]!="planner"&&task["planningDecisionId"]==latest_id)),
        "reviewNeedsReplan":review_replan||pending.is_some()
            ||(job["reviewEnabled"]==false&&latest_objective!="satisfied")
            ||(!plans.iter().any(|plan|plan["status"]=="SUCCEEDED")
                &&!tasks.iter().any(|task|task["kind"]=="planner"&&task["state"]=="SUCCEEDED"))
    })
}
fn transient(state: &str) -> bool {
    state.starts_with("check_")
}
pub fn decide_planner_orchestration(directory: &Path, facts: &Value) -> Result<Value, String> {
    choose_policy(
        directory,
        "planner-orchestration",
        "idle",
        "planner.reconcile",
        facts,
        14,
        transient,
    )
}
pub fn dispatch_planner_orchestration(
    directory: &Path,
    facts: &Value,
    execute: impl FnMut(&str) -> Result<Value, String>,
) -> Result<Value, String> {
    execute_policy(
        directory,
        "planner-orchestration",
        "idle",
        "planner.reconcile",
        facts,
        14,
        transient,
        execute,
    )
}

/// Async Node-equivalent effect dispatch: Graph owns choices, each effect is awaited.
pub async fn dispatch_planner_orchestration_async<Effect, Fut>(
    directory: &Path,
    facts: &Value,
    effect: Effect,
) -> Result<Value, String>
where
    Effect: FnMut(String) -> Fut,
    Fut: Future<Output = Result<Value, String>>,
{
    let runtime = load_policy_graph(directory, "planner-orchestration")?;
    let mut options = DispatchOptions::event("idle", "planner.reconcile", facts, 14);
    options.graph_name = Some("planner-orchestration".into());
    dispatch_workflow_graph(
        &runtime,
        &options,
        transient,
        |_, _| async { Ok(()) },
        effect,
        |_, _| async { Ok(()) },
    )
    .await
}
