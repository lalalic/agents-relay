// Node provenance: src/planner-runtime.ts. Deterministic Plan execution
// leases, durable Task creation, rollback and Troubleshooter admission.
// All workflow actions are selected by existing Mermaid Plan Graph policies.
use crate::{
    events::{event_for,random_uuid},
    local_merge_lock::iso8601_now,
    planner::{
        parse_planner_result,validate_planner_hierarchy,
        validate_planner_lifecycle_ownership,validate_planner_progress,
        validate_planner_resolution_materialization,materialize_planner_child,
    },
    planner_task_ids::assign_planner_task_ids,
    workflow::{
        policy_graph::choose_policy,
        task_resolution::attach_resolution_ownership,
    },
};
use chrono::{DateTime,SecondsFormat,Utc};
use serde_json::{json,Value};
use std::{
    collections::HashSet,
    future::Future,
    path::Path,
    sync::atomic::{AtomicBool,Ordering},
    time::{Duration,Instant},
};
fn field<'a>(v:&'a Value,key:&str)->&'a str{
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn plan_index(job:&Value,plan_id:&str)->Option<usize>{
    job.get("plans").and_then(Value::as_array)
        .and_then(|plans|plans.iter().position(|p|field(p,"id")==plan_id))
}
fn task_ids(job:&Value)->HashSet<String>{
    job.get("tasks").and_then(Value::as_array).into_iter().flatten()
        .map(|t|field(t,"id").to_owned()).collect()
}
fn actions(decision:&Value)->Vec<String>{
    decision.get("actions").and_then(Value::as_array).into_iter().flatten()
        .filter_map(|a|a.get("id").and_then(Value::as_str))
        .map(str::to_owned).collect()
}
fn graph_action(
    directory:&Path,state:&str,event:&str,facts:&Value,
    expected:&str,
)->Result<Value,String>{
    let decision=choose_policy(directory,"planner-orchestration",state,event,facts,14,|s|s.starts_with("check_"))?;
    if decision.get("accepted")!=Some(&Value::Bool(true))
        ||!actions(&decision).iter().any(|action|action==expected){
        return Err(format!(
            "Planner Graph rejected {event} at {state} (required action {expected})"));
    }
    Ok(decision)
}
fn next_time(previous:&str,proposed:&str)->String{
    let before=DateTime::parse_from_rfc3339(previous)
        .ok().map(|v|v.timestamp_millis()).unwrap_or(0);
    let after=DateTime::parse_from_rfc3339(proposed)
        .ok().map(|v|v.timestamp_millis()).unwrap_or(0);
    DateTime::<Utc>::from_timestamp_millis(before.saturating_add(1).max(after))
        .map(|t|t.to_rfc3339_opts(SecondsFormat::Millis,true))
        .unwrap_or_else(iso8601_now)
}
pub fn claim_plan_execution(
    directory:&Path,job:&Value,plan_id:&str,owner:&str,
    execution_id:&str,lease_timeout_ms:u64,now:&str,
)->Result<Value,String>{
    let mut candidate=job.clone();
    let idx=plan_index(&candidate,plan_id)
        .ok_or_else(||format!("Plan {plan_id} not found"))?;
    let plan=&candidate["plans"][idx];
    let state=field(plan,"status");
    let current_lease=plan.get("leaseExpiresAt").and_then(Value::as_str)
        .and_then(|value|DateTime::parse_from_rfc3339(value).ok())
        .map(|time|time.timestamp_millis());
    let now_ms=DateTime::parse_from_rfc3339(now)
        .map_err(|e|e.to_string())?.timestamp_millis();
    let available=field(plan,"leaseOwner").is_empty()
        ||current_lease.is_none_or(|expire|expire<=now_ms)
        ||field(plan,"leaseOwner")==owner;
    let facts=json!({
        "claimAvailable":available,
        "retryAvailable":plan.get("attempt").and_then(Value::as_u64).unwrap_or(0)
            <plan.get("maxAttempts").and_then(Value::as_u64).unwrap_or(3),
        "activeJob":field(&candidate,"state")=="ACTIVE",
        "notPaused":candidate.get("pause").is_none_or(Value::is_null)
    });
    graph_action(directory,state,"planner.claim",&facts,"planner.reserveLease")?;
    let plan=&mut candidate["plans"][idx];
    plan["leaseOwner"]=json!(owner);
    plan["leaseExpiresAt"]=json!(DateTime::<Utc>::from_timestamp_millis(
        now_ms+lease_timeout_ms as i64)
        .ok_or("Invalid Planner lease deadline")?
        .to_rfc3339_opts(SecondsFormat::Millis,true));
    plan["executionId"]=json!(execution_id);
    plan["attempt"]=json!(plan.get("attempt").and_then(Value::as_u64).unwrap_or(0)+1);
    plan["updatedAt"]=json!(now);
    Ok(candidate)
}
fn execution_current(job:&Value,plan_id:&str,execution_id:&str)->bool{
    plan_index(job,plan_id).is_some_and(|index|{
        let plan=&job["plans"][index];
        field(plan,"status")=="PLANNING"
            &&field(plan,"executionId")==execution_id
    })
}
pub fn settlement_result(
    graph_directory:&Path,job:&Value,plan_id:&str,
    execution_id:&str,planner_result:&Value,
    context:&Value,now:&str,
)->Result<Value,String>{
    if !execution_current(job,plan_id,execution_id){
        return Err("Stale Planner execution cannot apply Plan".into());
    }
    let mut candidate=job.clone();
    let normalized=parse_planner_result(planner_result)?;
    validate_planner_progress(&candidate,&normalized)?;
    let next=normalized.get("next_tasks").and_then(Value::as_array)
        .cloned().unwrap_or_default();
    validate_planner_hierarchy(&candidate,&next)?;
    validate_planner_lifecycle_ownership(&candidate,&next)?;
    validate_planner_resolution_materialization(&candidate,&next)?;
    let existing=task_ids(&candidate);
    let plans=candidate.get("plans").and_then(Value::as_array)
        .ok_or("Job Plans missing")?;
    let plan=plans.iter().find(|p|field(p,"id")==plan_id)
        .ok_or("Plan disappeared")?.clone();
    let mut appended=Vec::new();
    for spec in &next {
        let id=field(spec,"id");
        if existing.contains(id){
            return Err(format!("Planner Task {id} conflicts with an existing Job Task"));
        }
        let child=materialize_planner_child(graph_directory,&candidate,
            &plan,spec,context)?;
        if let Some(resolution)=spec.get("resolution")
            .filter(|v|!v.is_null()){
            candidate["tasks"]=json!(candidate.get("tasks")
                .and_then(Value::as_array).cloned().unwrap_or_default());
            attach_resolution_ownership(graph_directory,&mut candidate,
                &child,resolution,&json!("planner"),now)?;
        }
        candidate.get_mut("tasks").and_then(Value::as_array_mut)
            .ok_or("Job Task array missing")?.push(child.clone());
        appended.push(child);
    }
    graph_action(graph_directory,"PLANNING","planner.succeeded",
        &json!({"executionCurrent":true,
            "resultValid":true}),"planner.persistSuccess")?;
    let idx=plan_index(&candidate,plan_id).ok_or("Plan disappeared")?;
    let changed=&mut candidate["plans"][idx];
    changed["status"]=json!("SUCCEEDED");
    changed["objectiveStatus"]=normalized.get("objective_status")
        .cloned().unwrap_or(Value::Null);
    changed["assessment"]=normalized.get("assessment")
        .cloned().unwrap_or(Value::Null);
    changed["plannerResult"]=normalized.clone();
    changed["generatedTaskIds"]=json!(appended.iter()
        .filter_map(|t|t.get("id")).collect::<Vec<_>>());
    changed["appliedExecutionId"]=json!(execution_id);
    changed["leaseOwner"]=Value::Null;
    changed["leaseExpiresAt"]=Value::Null;
    changed["executionId"]=Value::Null;
    changed["updatedAt"]=json!(now);
    candidate["updatedAt"]=json!(now);
    let saved_plan=candidate["plans"][idx].clone();
    Ok(json!({"job":candidate,"plan":saved_plan,
        "children":appended,"result":normalized}))
}
pub fn fail_plan_execution(
    directory:&Path,job:&Value,plan_id:&str,
    execution_id:&str,error:&str,now:&str,
)->Result<Value,String>{
    if !execution_current(job,plan_id,execution_id){
        return Ok(job.clone());
    }
    let mut candidate=job.clone();
    let idx=plan_index(&candidate,plan_id).ok_or("Plan disappeared")?;
    let plan=&candidate["plans"][idx];
    let attempts=plan.get("attempt").and_then(Value::as_u64).unwrap_or(0);
    let max=plan.get("maxAttempts").and_then(Value::as_u64).unwrap_or(3);
    let decision=choose_policy(directory,"planner-orchestration","PLANNING",
        "planner.failed",&json!({
            "executionCurrent":true,"retryAvailable":attempts<max,
            "maxAttempts":max,"attempts":attempts,
        }),14,|s|s.starts_with("check_"))?;
    if decision.get("accepted")!=Some(&Value::Bool(true)){
        return Err("Planner Graph did not accept failed execution".into());
    }
    let plan=&mut candidate["plans"][idx];
    let terminal=field(&decision,"target")=="FAILED";
    plan["status"]=json!(if terminal{"FAILED"}else{"PLANNING"});
    plan["error"]=json!(error);
    plan["assessment"]=json!(format!("Planning failed: {error}"));
    plan["executionId"]=Value::Null;
    plan["leaseOwner"]=Value::Null;
    plan["leaseExpiresAt"]=Value::Null;
    plan["updatedAt"]=json!(now);
    candidate["updatedAt"]=json!(now);
    Ok(candidate)
}
pub struct PlannerExecutionPorts<Load,Save,Launch,Emit>{
    pub load:Load,pub save:Save,pub launch:Launch,pub emit:Emit,
}
pub async fn run_planner_execution<Load,LFut,Save,SFut,Launch,AFut,Emit,EFut>(
    graph_dir:&Path,job_id:&str,plan_id:&str,owner:&str,
    timeout_ms:u64,cancelled:&AtomicBool,
    mut ports:PlannerExecutionPorts<Load,Save,Launch,Emit>,
)->Result<Value,String>
where
    Load:FnMut(&str)->LFut,LFut:Future<Output=Result<Value,String>>,
    Save:FnMut(Value)->SFut,SFut:Future<Output=Result<Value,String>>,
    Launch:FnMut(Value,Value,&AtomicBool)->AFut,
    AFut:Future<Output=Result<Value,String>>,
    Emit:FnMut(Value)->EFut,EFut:Future<Output=Result<(),String>>,
{
    if cancelled.load(Ordering::Acquire){
        return Err("Planner execution cancelled".into());
    }
    let job=(ports.load)(job_id).await?;
    let execution_id=random_uuid();
    let lease=claim_plan_execution(graph_dir,&job,plan_id,owner,
        &execution_id,timeout_ms,&iso8601_now())?;
    let claimed=(ports.save)(lease).await?;
    let plan=claimed.get("plans").and_then(Value::as_array).into_iter().flatten()
        .find(|p|field(p,"id")==plan_id).ok_or("Claimed Plan missing")?.clone();
    (ports.emit)(event_for(job_id,plan_id,None,"planner.started","running",
        "Planner execution started",Some("orchestrator"),
        Some(json!({"executionId":execution_id})),
        Some(json!({"agent":"planner","component":"agents-relay"})))).await?;
    let launched=(ports.launch)(claimed.clone(),plan.clone(),cancelled).await;
    match launched{
        Ok(output)=>{
            if cancelled.load(Ordering::Acquire){
                return Err("Planner execution cancelled".into());
            }
            let current=(ports.load)(job_id).await?;
            let result=settlement_result(graph_dir,&current,plan_id,
                &execution_id,&output,&json!({}),&iso8601_now())?;
            let next=(ports.save)(result["job"].clone()).await?;
            (ports.emit)(event_for(job_id,plan_id,None,
                "planner.completed","succeeded","Planner round committed",
                Some("orchestrator"),Some(json!({
                    "executionId":execution_id,
                    "objectiveStatus":result.pointer("/result/objective_status"),
                    "generatedTaskIds":result.pointer("/plan/generatedTaskIds")
                })),Some(json!({"agent":"planner","component":"agents-relay"})))).await?;
            Ok(next)
        },
        Err(error)=>{
            let current=(ports.load)(job_id).await?;
            let failed=fail_plan_execution(graph_dir,&current,plan_id,
                &execution_id,&error,&iso8601_now())?;
            let updated=(ports.save)(failed).await?;
            (ports.emit)(event_for(job_id,plan_id,None,
                "planner.failed","failed",&error,
                Some("orchestrator"),Some(json!({"executionId":execution_id})),
                Some(json!({"agent":"planner","component":"agents-relay"})))).await?;
            Ok(updated)
        },
    }
}
pub fn planner_recovery_needed(job:&Value)->Vec<Value>{
    job.get("plans").and_then(Value::as_array).into_iter().flatten()
        .filter(|plan|field(plan,"status")=="PLANNING"
            &&plan.get("executionId").is_some_and(|v|!v.is_null())
            &&plan.get("leaseExpiresAt").and_then(Value::as_str)
                .and_then(|s|DateTime::parse_from_rfc3339(s).ok())
                .is_some_and(|t|t.timestamp_millis()<Utc::now().timestamp_millis()))
        .cloned().collect()
}
pub fn planner_reconciler_step(
    directory:&Path,job:&Value,now:&str,
)->Result<Value,String>{
    let mut candidate=job.clone();
    let current=DateTime::parse_from_rfc3339(now)
        .map_err(|e|e.to_string())?.timestamp_millis();
    if let Some(plans)=candidate.get_mut("plans").and_then(Value::as_array_mut){
        for plan in plans{
            if field(plan,"status")!="PLANNING"{continue;}
            let expiration=plan.get("leaseExpiresAt").and_then(Value::as_str)
                .and_then(|s|DateTime::parse_from_rfc3339(s).ok())
                .map(|d|d.timestamp_millis());
            if expiration.is_none_or(|t|t>current){continue;}
            let attempt=plan.get("attempt").and_then(Value::as_u64).unwrap_or(0);
            let max=plan.get("maxAttempts").and_then(Value::as_u64).unwrap_or(3);
            let decision=choose_policy(directory,"planner-orchestration","PLANNING",
                "planner.lease_expired",&json!({"retryAvailable":attempt<max,
                    "executionCurrent":true}),14,|s|s.starts_with("check_"))?;
            if decision.get("accepted")!=Some(&Value::Bool(true)){continue;}
            if field(&decision,"target")=="FAILED"{
                plan["status"]=json!("FAILED");
                plan["error"]=json!("Planner lease expired after maximum attempts");
            }
            plan["leaseOwner"]=Value::Null;
            plan["leaseExpiresAt"]=Value::Null;
            plan["executionId"]=Value::Null;
            plan["updatedAt"]=json!(now);
        }
    }
    Ok(candidate)
}
