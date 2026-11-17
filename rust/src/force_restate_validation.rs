// Node provenance: src/force-restate-validation.ts. Validate recovery
// convergence and apply Planner history dispositions through canonical Graphs.
use crate::{
    final_review_role::is_final_review_agent,
    runtime_status::is_superseded,
    task_transitions::try_transition_task_event,
    workflow::task_resolution::classify_task_resolution,
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;
fn text<'a>(value:&'a Value, key:&str)->&'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
fn map_tasks(job: &Value) -> HashMap<String, Value> {
    job.get("tasks").and_then(Value::as_array).into_iter().flatten()
        .filter_map(|task|Some((text(task,"id").to_string(),task.clone()))).collect()
}
fn dependency_satisfied(task: &Value, by_id: &HashMap<String,Value>) -> bool {
    task.get("dependencies").and_then(Value::as_array).into_iter().flatten().all(|id| {
        let Some(dependency)=id.as_str().and_then(|id|by_id.get(id)) else {return false;};
        if text(dependency,"state")=="SUCCEEDED" {return true;}
        let classification=dependency.get("resolutionClassification");
        classification.and_then(|r|r.get("kind")).and_then(Value::as_str)==Some("superseded")
            && classification.and_then(|r|r.get("targetTaskId")).and_then(Value::as_str)
                .and_then(|id|by_id.get(id)).is_some_and(|target|text(target,"state")=="SUCCEEDED")
    })
}
fn satisfies_worker(candidate: &Value, requirements: &Value) -> bool {
    if text(candidate,"availability")=="offline" {return false;}
    if let Some(runtime)=requirements.get("runtime").and_then(Value::as_str) {
        if text(candidate,"runtime")!=runtime {return false;}
    }
    if requirements.get("capabilities").and_then(Value::as_array)
        .is_some_and(|required|required.iter().any(|cap|!candidate.get("capabilities")
            .and_then(Value::as_array).is_some_and(|available|available.contains(cap))))
    {return false;}
    !(text(candidate,"adapter")=="chatgpt"
        && candidate.pointer("/browserWorkspaceCapacity/available").and_then(Value::as_i64)==Some(0))
}
fn eligible_worker_route(task:&Value,candidates:&[Value])->bool {
    let adapter=text(task,"adapter");
    if !matches!(adapter,"codex"|"chatgpt"|"z") {return false;}
    let requirements=task.get("workerRequirements").cloned().unwrap_or_else(||json!({
        "capabilities":task.get("capabilities").cloned().unwrap_or(json!([]))
    }));
    let required=requirements.get("capabilities").and_then(Value::as_array)
        .or_else(||task.get("capabilities").and_then(Value::as_array));
    if let Some(selection)=task.get("workerSelection").filter(|v|!v.is_null()) {
        if text(selection,"adapter")!=adapter
            || required.is_some_and(|req|req.iter().any(|cap|!selection
                .get("capabilities").and_then(Value::as_array)
                .is_some_and(|available|available.contains(cap)))) {return false;}
        return candidates.iter().any(|c|text(c,"adapter")==adapter
            && text(c,"workerId")==text(selection,"workerId")
            && satisfies_worker(c,&requirements));
    }
    candidates.iter().any(|candidate|text(candidate,"adapter")==adapter
        && satisfies_worker(candidate,&requirements))
}
fn runnable(task:&Value,by_id:&HashMap<String,Value>,candidates:&[Value])->bool {
    matches!(text(task,"state"),"QUEUED"|"RUNNING")
        && dependency_satisfied(task,by_id)
        && eligible_worker_route(task,candidates)
        && (text(task,"state")!="RUNNING"
            || (task.get("executionId").is_some_and(|v|!v.is_null())
                && task.get("leaseOwner").is_some_and(|v|!v.is_null())))
}
fn dependency_waiting(task:&Value,by_id:&HashMap<String,Value>,candidates:&[Value],
    visiting:&mut HashSet<String>) -> bool {
    let deps=task.get("dependencies").and_then(Value::as_array);
    if text(task,"state")!="DRAFT" || deps.is_none_or(|d|d.is_empty())
        || !visiting.insert(text(task,"id").to_string()) {return false;}
    let accounted=deps.into_iter().flatten().all(|id|{
        let Some(dependency)=id.as_str().and_then(|id|by_id.get(id)) else {return false;};
        text(dependency,"state")=="SUCCEEDED"
            || (dependency.pointer("/resolutionClassification/kind").and_then(Value::as_str)
                    ==Some("superseded")
                && dependency.pointer("/resolutionClassification/targetTaskId")
                    .and_then(Value::as_str).and_then(|id|by_id.get(id))
                    .is_some_and(|task|text(task,"state")=="SUCCEEDED"))
            || runnable(dependency,by_id,candidates)
            || dependency_waiting(dependency,by_id,candidates,visiting)
    });
    visiting.remove(text(task,"id"));
    accounted
}
pub fn force_restate_runnable(job:&Value,candidates:&[Value])->bool {
    let map=map_tasks(job);
    job.get("tasks").and_then(Value::as_array).into_iter().flatten().any(|task|
        text(task,"kind")!="planner" && runnable(task,&map,candidates))
}
pub fn force_restate_dependency_waiting(job:&Value,candidates:&[Value])->bool {
    let map=map_tasks(job);
    job.get("tasks").and_then(Value::as_array).into_iter().flatten().any(|task|
        text(task,"kind")!="planner" &&
            dependency_waiting(task,&map,candidates,&mut HashSet::new()))
}
pub fn force_restate_blocked(job:&Value,plan_id:Option<&str>)->bool {
    let Some(plan_id)=plan_id.filter(|s|!s.is_empty()) else{return false;};
    job.get("tasks").and_then(Value::as_array).into_iter().flatten().any(|task|{
        text(task,"agentName")=="troubleshooter" && text(task,"recoveryPlanId")==plan_id
            && text(task,"state")=="BLOCKED"
            && !text(task,"error").trim().is_empty()
            && !task.pointer("/result/data/evidence").and_then(Value::as_str)
                .unwrap_or("").trim().is_empty()
            && !task.pointer("/result/data/unblock_conditions").and_then(Value::as_str)
                .unwrap_or("").trim().is_empty()
    })
}
pub fn force_restate_converged(job:&Value,plan_id:Option<&str>,candidates:&[Value])->bool {
    let completed=text(job,"state")=="COMPLETED"
        && job.get("tasks").and_then(Value::as_array).into_iter().flatten().all(|task|
            text(task,"kind")=="planner"
                || !matches!(text(task,"state"),"DRAFT"|"QUEUED"|"RUNNING"|"BLOCKED"));
    completed || force_restate_runnable(job,candidates)
        || force_restate_dependency_waiting(job,candidates)
        || force_restate_blocked(job,plan_id)
}
pub fn objective_satisfied_for_review(job:&Value)->bool {
    let Some(latest)=job.get("plans").and_then(Value::as_array)
        .and_then(|plans|plans.last()) else{return false;};
    if text(latest,"status")!="SUCCEEDED" || text(latest,"objectiveStatus")!="satisfied" {return false;}
    let map=map_tasks(job);
    let implementation:Vec<&Value>=job.get("tasks").and_then(Value::as_array)
        .into_iter().flatten().filter(|task|
            text(task,"kind")!="planner"
                && !is_final_review_agent(task.get("agentName").and_then(Value::as_str))
                && text(task,"agentName")!="troubleshooter"
                && !is_superseded(task,&map)).collect();
    !implementation.is_empty() && implementation.iter().all(|t|text(t,"state")=="SUCCEEDED")
}

pub fn apply_planner_history_cleanup(
    job:&mut Value,expected_task_ids:&[String],cleanup:&[Value],
    now:&str,graph_dir:&Path,
)->Result<Value,String> {
    let mut issues=Vec::<String>::new();
    let mut expected:HashSet<String>=expected_task_ids.iter().cloned().collect();
    if cleanup.len()!=expected.len()
        || cleanup.iter().any(|item|!expected.remove(text(item,"taskId")))
        || !expected.is_empty() {
        issues.push(format!("Provide exactly one history_cleanup disposition for each snapshotted failed Task: {}.",
            if expected_task_ids.is_empty(){"(none)".to_string()}else{expected_task_ids.join(", ")}));
        return Ok(json!({"valid":false,"issues":issues}));
    }
    for item in cleanup {
        let task_id=text(item,"taskId");
        let snapshot=job.get("tasks").and_then(Value::as_array).into_iter().flatten()
            .find(|task|text(task,"id")==task_id).cloned();
        let Some(snapshot)=snapshot else {
            issues.push(format!("Task {task_id} changed since Force Restate began; reload the Planner context and revise this disposition."));
            continue;
        };
        if text(&snapshot,"kind")=="planner" || text(&snapshot,"state")!="FAILED"
            || snapshot.get("resolutionClassification").is_some_and(|v|!v.is_null()) {
            issues.push(format!("Task {task_id} changed since Force Restate began; reload the Planner context and revise this disposition."));
            continue;
        }
        let outcome=text(item,"outcome");
        if text(&snapshot,"failureReason")=="worker_outcome_unknown" && outcome!="unresolved" {
            issues.push(format!("Task {task_id} has an unknown execution outcome. Keep it unresolved until durable evidence proves the outcome."));
            continue;
        }
        if outcome=="unresolved" {continue;}
        let mut task=snapshot.clone();
        if outcome=="cancelled_review" {
            let attempted=if is_final_review_agent(snapshot.get("agentName").and_then(Value::as_str)) {
                try_transition_task_event(graph_dir,&mut task,"cancel",&json!({}),now)
                    .map(|decision|decision.get("accepted")==Some(&json!(true))).unwrap_or(false)
            }else{false};
            if !attempted {
                issues.push(format!("Task {task_id} cannot be cancelled as a failed review. Only a FAILED reviewer Task can use cancelled_review."));
                continue;
            }
            task["error"]=json!(format!("Cancelled by Force Restate: {}",text(item,"reason")));
            task["leaseOwner"]=Value::Null;
            task["leaseExpiresAt"]=Value::Null;
            task["executionId"]=Value::Null;
            task["updatedAt"]=json!(now);
        } else {
            let target_id=text(item,"targetTaskId");
            let succeeded=job.get("tasks").and_then(Value::as_array).into_iter().flatten()
                .any(|candidate|text(candidate,"id")==target_id
                    && text(candidate,"state")=="SUCCEEDED");
            if !succeeded {
                issues.push(format!("Task {task_id} classification target {} must be an existing SUCCEEDED Task.",
                    if target_id.is_empty(){"(missing)"}else{target_id}));
                continue;
            }
            let classification=json!({"kind":outcome,"targetTaskId":target_id,
                "evidence":item.get("evidence"),"reason":item.get("reason")});
            if let Err(error)=classify_task_resolution(graph_dir,&mut task,&classification,now) {
                issues.push(error);continue;
            }
        }
        if let Some(target)=job.get_mut("tasks").and_then(Value::as_array_mut)
            .and_then(|tasks|tasks.iter_mut().find(|t|text(t,"id")==task_id)) {
            *target=task;
        }
    }
    if issues.is_empty(){Ok(json!({"valid":true}))}
    else {Ok(json!({"valid":false,"issues":issues}))}
}
