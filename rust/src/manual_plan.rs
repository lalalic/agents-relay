// Node provenance: src/manual-plan.ts. Plan injection through canonical
// SQLite Job mutation and Job Graph activation, never a second scheduler.
use crate::{
    local_merge_lock::iso8601_now,
    workflow::lifecycle::dispatch_job_lifecycle_sync,
};
use serde_json::{json,Value};
use std::future::Future;
use std::path::Path;
use std::time::Duration;

fn field<'a>(value:&'a Value,key:&str)->&'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
pub fn pending_plan(job:&Value)->Option<Value> {
    let mut plans:Vec<Value>=job.get("plans").and_then(Value::as_array).into_iter()
        .flatten().filter(|plan|field(plan,"status")=="PLANNING").cloned().collect();
    plans.sort_by_key(|plan|plan.get("round").and_then(Value::as_i64).unwrap_or(0));
    plans.into_iter().next()
}
fn validate_job(job:&Value)->Result<(),String> {
    if matches!(field(job,"state"),"COMPLETED"|"CANCELLED") {
        return Err(format!("Cannot plan terminal job {} ({})",field(job,"id"),field(job,"state")));
    }
    if job.get("pause").is_some_and(|p|!p.is_null()) {
        return Err(format!("Cannot plan paused Job {}; resume it first",field(job,"id")));
    }
    Ok(())
}
/// Inside a mutateJob callback, keep the original Plan on a retry, and do
/// not force-restate while any planning round is pending.
pub fn prepare_manual_plan<Create>(
    graph_directory:&Path,job:&Value, guidance:Option<&str>,
    timeout_ms:u64,force_restate:bool,
    mut create_round:Create,
)->Result<(Value,Value),String>
where Create: FnMut(&Value,Option<&str>,u64)->Result<Value,String>,
{
    validate_job(job)?;
    let mut current=job.clone();
    let previous=pending_plan(&current);
    if let Some(ref pending)=previous {
        if force_restate {
            return Err(format!("--force-restate requires no pending Plan ({})",field(pending,"id")));
        }
        if pending.get("executionId").is_some_and(|v|!v.is_null()) {
            return Err(format!("Planning round {} is already PLANNING",field(pending,"id")));
        }
    }
    let round=if let Some(pending)=previous {pending}
    else {
        let mut created=create_round(&current,guidance,timeout_ms)?;
        if force_restate {
            created["forceRestate"]=json!(true);
            let ids:Vec<Value>=current.get("tasks").and_then(Value::as_array)
                .into_iter().flatten().filter(|task|
                    field(task,"kind")!="planner" && field(task,"state")=="FAILED"
                        && task.get("resolutionClassification").is_none_or(Value::is_null))
                .filter_map(|task|task.get("id").cloned()).collect();
            created["restateTaskIds"]=json!(ids);
        }
        let plans=current.get_mut("plans").and_then(Value::as_array_mut);
        if let Some(plans)=plans {plans.push(created.clone());plans.sort_by_key(|p|
            p.get("round").and_then(Value::as_i64).unwrap_or(0));}
        else {current["plans"]=json!([created.clone()]);}
        created
    };
    if field(&current,"state")=="DRAFT" {
        let now=iso8601_now();
        let activation=dispatch_job_lifecycle_sync(graph_directory,&mut current,"activate",
            &json!({}),&now)?;
        if activation.get("accepted")!=Some(&Value::Bool(true)) {
            return Err(format!("Job {} activation rejected",field(&current,"id")));
        }
    }
    Ok((current,round))
}
pub async fn execute_manual_plan<Load,LFut,Commit,CFut,Create,Launch,AFut>(
    graph_directory:&Path,job_id:&str,guidance:Option<&str>,timeout_ms:u64,
    force_restate:bool,has_atomic_store:bool,
    mut load:Load,mut commit:Commit,create_round:Create,mut launch:Launch,
)->Result<(Value,Value),String>
where
    Load: FnMut()->LFut, LFut:Future<Output=Result<Value,String>>,
    Commit: FnMut(Value)->CFut,CFut:Future<Output=Result<Value,String>>,
    Create:FnMut(&Value,Option<&str>,u64)->Result<Value,String>,
    Launch:FnMut(Value,Value)->AFut,AFut:Future<Output=Result<(),String>>,
{
    if force_restate && !has_atomic_store {
        return Err("--force-restate requires atomic durable SQLite mutations".into());
    }
    let initial=load().await?;
    let (candidate,round)=prepare_manual_plan(graph_directory,&initial,guidance,
        timeout_ms,force_restate,create_round)?;
    // Commit must perform a generation-checked authoritative SQLite mutation;
    // no unverified overwrite of concurrent Planner state is permitted.
    let committed=commit(candidate).await?;
    if !committed.get("plans").and_then(Value::as_array).into_iter().flatten()
        .any(|p|p.get("id")==round.get("id")) {
        return Err(format!("Planning round {} was not persisted",field(&round,"id")));
    }
    launch(committed.clone(),round.clone()).await?;
    loop {
        let completed=load().await?;
        let saved=completed.get("plans").and_then(Value::as_array)
            .and_then(|plans|plans.iter().find(|p|p.get("id")==round.get("id")));
        let Some(saved)=saved else {
            return Err(format!("Planning round {} disappeared",field(&round,"id")));
        };
        if field(saved,"status")!="PLANNING" {
            if field(saved,"status")!="SUCCEEDED" {
                return Err(saved.get("error").and_then(Value::as_str)
                    .map(str::to_owned).unwrap_or_else(||format!("Planning round {} ended {}",
                        field(&round,"id"),field(saved,"status"))));
            }
            return Ok((completed.clone(),saved.clone()));
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}
