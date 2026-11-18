// Exact Node Reconciler.planJob host boundary: atomic SQLite mutation must
// validate and create the round inside the transaction, never before it.
// Graph remains the sole job activation authority. No model subprocess here.
use crate::{
    job_actions::apply_job_activate_action,
    manual_plan::{pending_plan,prepare_manual_plan},
    planner::create_plan_round,
};
use serde_json::Value;
use std::{future::Future,path::Path,time::Duration};
fn field<'a>(value:&'a Value,key:&str)->&'a str{
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
pub async fn plan_job<Load,LFut,Mutate,Append,AFut,Save,SFut,Launch,PFut>(
    graph:&Path,job_id:&str,guidance:Option<&str>,force_restate:bool,
    timeout_ms:u64,atomic:bool,mut load:Load,mut mutate:Mutate,
    mut append_plan:Append,mut save_job:Save,mut launch:Launch,
)->Result<(Value,Value),String>
where
    Load:FnMut()->LFut,LFut:Future<Output=Result<Value,String>>,
    Mutate:FnMut(&mut dyn FnMut(Value)->Result<Value,String>)->Result<Value,String>,
    Append:FnMut(Value)->AFut,AFut:Future<Output=Result<(),String>>,
    Save:FnMut(Value)->SFut,SFut:Future<Output=Result<(),String>>,
    Launch:FnMut(Value,Value)->PFut,PFut:Future<Output=Result<(),String>>,
{
    if force_restate&&!atomic{
        return Err("--force-restate requires atomic durable SQLite mutations".into());
    }
    let initial=load().await?;
    if matches!(field(&initial,"state"),"COMPLETED"|"CANCELLED"){
        return Err(format!("Cannot plan terminal job {} ({})",
            field(&initial,"id"),field(&initial,"state")));
    }
    if initial.get("pause").is_some_and(|pause|!pause.is_null()){
        return Err(format!("Cannot plan paused Job {}; resume it first",
            field(&initial,"id")));
    }
    let pending=pending_plan(&initial);
    if let Some(active)=&pending {
        if active.get("executionId").and_then(Value::as_str)
            .is_some_and(|s|!s.is_empty()){
            return Err(format!("Planning round {} is already PLANNING",
                field(active,"id")));
        }
    }
    let (job,round)=if atomic{
        let mut round:Option<Value>=None;
        let mut callback=|current:Value|{
            // Node validates force-restate and concurrent pending rounds *in*
            // mutateJob's BEGIN IMMEDIATE SQLite transaction. Any error
            // must roll back the candidate and preserve existing Tasks.
            let (candidate,planned)=prepare_manual_plan(graph,&current,
                guidance,timeout_ms,force_restate,
                |job,guidance,timeout|create_plan_round(graph,job,
                    guidance,true,Some(timeout),None))?;
            round=Some(planned);
            Ok(candidate)
        };
        let committed=mutate(&mut callback)?;
        (committed,round.ok_or("Planner mutation did not select a round")?)
    }else{
        let round=match pending{
            Some(round)=>round,
            None=>{
                let created=create_plan_round(graph,&initial,guidance,
                    true,Some(timeout_ms),None)?;
                append_plan(created.clone()).await?;
                created
            },
        };
        let mut job=load().await?;
        if field(&job,"state")=="DRAFT"{
            let started=apply_job_activate_action(graph,&job)?;
            save_job(started).await?;
            job=load().await?;
        }
        (job,round)
    };
    let selected=job.get("plans").and_then(Value::as_array)
        .and_then(|items|items.iter().find(|plan|plan.get("id")==round.get("id")))
        .ok_or_else(||format!("Planning round {} was not persisted",field(&round,"id")))?;
    launch(job.clone(),selected.clone()).await?;
    loop{
        let completed=load().await?;
        let saved=completed.get("plans").and_then(Value::as_array)
            .and_then(|items|items.iter().find(|plan|plan.get("id")==round.get("id")))
            .ok_or_else(||format!("Planning round {} disappeared",field(&round,"id")))?;
        if field(saved,"status")!="PLANNING"{
            if field(saved,"status")!="SUCCEEDED"{
                return Err(saved.get("error").and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(||format!("Planning round {} ended {}",
                        field(&round,"id"),field(saved,"status"))));
            }
            return Ok((completed.clone(),saved.clone()));
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}
