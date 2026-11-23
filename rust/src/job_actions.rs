// Node provenance: src/job-actions.ts. Graph-selected Job activate/cancel
// and cancellation effects, applied inside a single authoritative SQLite mutation.
use crate::{
    local_merge_lock::iso8601_now,
    workflow::lifecycle::{decide_job_lifecycle, dispatch_job_lifecycle_sync},
    task_transitions::try_transition_task_event,
};
use serde_json::{json, Value};
use std::path::Path;

pub const JOB_ACTIVATE_ACTION:&str="job.activate";
pub const JOB_CANCEL_ACTION:&str="job.cancel";

pub fn apply_job_activate_action(
    graph_directory:&Path,job:&Value,
)->Result<Value,String>{
    let mut candidate=job.clone();
    let from=candidate.get("state").and_then(Value::as_str).unwrap_or("").to_owned();
    let now=iso8601_now();
    let decision=dispatch_job_lifecycle_sync(graph_directory,&mut candidate,
        "activate",&json!({}),&now)?;
    if decision.get("accepted")!=Some(&Value::Bool(true)) {
        return Err(format!("Job {} is not startable ({from})",
            job.get("id").and_then(Value::as_str).unwrap_or("undefined")));
    }
    Ok(candidate)
}
fn cancel_active_work(graph_directory:&Path,job:&mut Value,reason:&str,now:&str)
    ->Result<(),String>{
    if let Some(plans)=job.get_mut("plans").and_then(Value::as_array_mut){
        for plan in plans {
            if plan.get("status").and_then(Value::as_str)!=Some("PLANNING"){continue;}
            plan["status"]=json!("FAILED");
            plan["error"]=json!(reason);
            plan["assessment"]=json!(format!("Planning failed: {reason}"));
            plan["executionId"]=Value::Null;
            plan["updatedAt"]=json!(now);
        }
    }
    if let Some(tasks)=job.get_mut("tasks").and_then(Value::as_array_mut){
        for task in tasks {
            if task.get("kind").and_then(Value::as_str)==Some("planner"){continue;}
            let decision=try_transition_task_event(graph_directory,task,"cancel",&json!({}),now)?;
            if decision.get("accepted")!=Some(&Value::Bool(true)){continue;}
            task["error"]=json!(reason);
            task["executionId"]=Value::Null;
        }
    }
    Ok(())
}
pub fn apply_job_cancel_action(
    graph_directory:&Path,job:&Value,reason:Option<&str>,
)->Result<Value,String>{
    let mut candidate=job.clone();
    let id=candidate.get("id").and_then(Value::as_str).unwrap_or("undefined").to_owned();
    let from=candidate.get("state").and_then(Value::as_str).unwrap_or("").to_owned();
    let decision=decide_job_lifecycle(graph_directory,&candidate,"cancel",&json!({}))?;
    if decision.get("accepted")!=Some(&Value::Bool(true)) {
        return Err(format!("Job {id} is not cancellable ({from})"));
    }
    let effect=decision.get("effects").and_then(Value::as_array).is_some_and(|items|
        items.iter().any(|item|item.as_str()==Some("effect.cancelActiveTasks")));
    if !effect{return Err("Unsupported job.cancel effect".into());}
    let now=iso8601_now();
    let accepted=dispatch_job_lifecycle_sync(graph_directory,&mut candidate,
        "cancel",&json!({}),&now)?;
    if accepted.get("accepted")!=Some(&Value::Bool(true)){
        return Err(format!("Job {id} is not cancellable ({from})"));
    }
    cancel_active_work(graph_directory,&mut candidate,reason.unwrap_or("Job cancelled"),&now)?;
    candidate["updatedAt"]=json!(now);
    Ok(candidate)
}
