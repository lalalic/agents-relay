// Port of Node src/task-actions.ts. Graph-authorized Task domain mutations.
// Store writes are intentionally separated from pure snapshot mutation:
// the daemon must use an atomic SQLite mutateJob transaction.
use crate::{
    local_merge_lock::iso8601_now,
    relay_store::SQLiteRelayStore,
    task_transitions::{extend_retry_budget, transition_task_event, try_transition_task_event},
    workflow::{
        task_action_policy::select_related_task_mutations,
        task_resolution::{classify_task_resolution, dispatch_task_resolution_sync, materialize_resolution},
    },
};
use serde_json::{json, Value};
use std::path::Path;

pub const TASK_RETRY_ACTION: &str="task.retry";
pub const TASK_RECOVER_ACTION: &str="task.recover";
pub const TASK_UNBLOCK_RETRY_ACTION: &str="task.unblock.retry";
pub const TASK_CANCEL_ACTION: &str="task.cancel";
pub const TASK_RELEASE_ACTION: &str="task.release";
pub const TASK_HOLD_ACTION: &str="task.hold";
pub const TASK_QUEUE_ACTION: &str="task.queue";
fn field<'a>(v:&'a Value,key:&str)->&'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn find_task<'a>(job:&'a Value,id:&str)->Option<&'a Value>{
    job.get("tasks").and_then(Value::as_array).into_iter().flatten()
        .find(|task|field(task,"id")==id)
}
fn find_task_mut<'a>(job:&'a mut Value,id:&str)->Option<&'a mut Value>{
    job.get_mut("tasks").and_then(Value::as_array_mut)
        .and_then(|ts|ts.iter_mut().find(|task|field(task,"id")==id))
}
fn lifecycle_rejection(task:&Value,action:&str)->String{
    format!("Task {} is not {} ({})",field(task,"id"),action,field(task,"state"))
}
fn clear_execution(task:&mut Value) {
    task["error"]=Value::Null;
    task["executionId"]=Value::Null;
}
fn transition(
    directory:&Path,task:&mut Value,event:&str,action:&str,facts:&Value,now:&str
)->Result<Value,String>{
    let previous=task.clone();
    match transition_task_event(directory,task,event,facts,now){
        Err(message) if message.starts_with("No enabled workflow transition")=>{
            Err(lifecycle_rejection(&previous,action))
        },
        other=>other,
    }
}
pub fn apply_task_retry_action(
    directory:&Path,task:&mut Value,extend_budget:bool,now:&str
)->Result<(),String> {
    if field(task,"kind")=="planner"{
        return Err(format!("Legacy planner Task {} is read-only; retry the Plan instead",field(task,"id")));
    }
    if field(task,"agentName")=="troubleshooter"{
        return Err("Troubleshooter is one-shot: unresolved failure must escalate, not retry".into());
    }
    transition(directory,task,"retry","restartable",&json!({}),now)?;
    if extend_budget {
        let attempt=task.get("attempt").and_then(Value::as_f64).unwrap_or(0.0);
        let budget=task.get("maxAttempts").and_then(Value::as_f64).unwrap_or(0.0);
        let extended=extend_retry_budget(attempt,budget,3.0)?;
        // JS Number emits whole values without a decimal point.
        task["maxAttempts"]=if extended.fract()==0.0{
            json!(extended as i64)
        }else{json!(extended)};
    }
    clear_execution(task);
    Ok(())
}
pub fn apply_task_unblock_retry_action(directory:&Path,task:&mut Value,now:&str)->Result<(),String>{
    if field(task,"agentName")=="troubleshooter"{
        return Err("Troubleshooter is one-shot: human response must recover original Task, not retry Troubleshooter".into());
    }
    if field(task,"state")=="BLOCKED" {
        transition(directory,task,"task.unblocked","retryable after unblock",&json!({}),now)?;
    }
    if !matches!(field(task,"state"),"QUEUED"|"DRAFT"){
        return Err(lifecycle_rejection(task,"retryable after unblock"));
    }
    task["attempt"]=json!(0);
    task["maxAttempts"]=json!(task.get("maxAttempts").and_then(Value::as_u64).unwrap_or(0).max(3));
    clear_execution(task);
    if let Some(obj)=task.as_object_mut(){obj.remove("blockedBy");}
    Ok(())
}
pub fn try_apply_task_cancel_action(
    directory:&Path,task:&mut Value,reason:&str,now:&str
)->Result<bool,String>{
    if field(task,"kind")=="planner"{return Ok(false);}
    let decision=try_transition_task_event(directory,task,"cancel",&json!({}),now)?;
    if decision.get("accepted")!=Some(&Value::Bool(true)) {return Ok(false);}
    task["error"]=json!(reason);
    task["executionId"]=Value::Null;
    Ok(true)
}
pub fn apply_task_cancel_action(
    directory:&Path,task:&mut Value,reason:&str,now:&str
)->Result<(),String>{
    if field(task,"kind")=="planner"{
        return Err(format!("Legacy planner Task {} is read-only",field(task,"id")));
    }
    if !try_apply_task_cancel_action(directory,task,reason,now)?{
        return Err(lifecycle_rejection(task,"cancellable"));
    }
    Ok(())
}
pub fn apply_task_release_action(directory:&Path,task:&mut Value,now:&str)->Result<(),String>{
    transition(directory,task,"release","releasable",&json!({}),now)?;
    Ok(())
}
pub fn apply_task_hold_action(directory:&Path,task:&mut Value,now:&str)->Result<(),String>{
    transition(directory,task,"hold","holdable",&json!({}),now)?;
    Ok(())
}
pub fn apply_task_queue_action(
    directory:&Path,job:&Value,task:&mut Value,now:&str
)->Result<(),String>{
    let satisfied=task.get("dependencies").and_then(Value::as_array)
        .into_iter().flatten().all(|dependency|{
            job.get("tasks").and_then(Value::as_array).into_iter().flatten()
                .any(|candidate|candidate.get("id")==Some(dependency)
                    && field(candidate,"state")=="SUCCEEDED")
        });
    transition(directory,task,"queue","queueable",&json!({
        "dependenciesSatisfied":satisfied
    }),now)?;
    clear_execution(task);
    Ok(())
}
fn record_recovery_routing(task:&mut Value,request:&Value,now:&str)->Result<(),String>{
    let Some(diagnosis)=request.get("recoveryDiagnosis").filter(|v|!v.is_null()) else{return Ok(());};
    let kind=field(diagnosis,"failureKind");
    if !matches!(kind,"adapter_failure"|"model_failure"|"provider_failure"|"task_failure"|"unknown"){
        return Err("Invalid recovery failureKind".into());
    }
    if field(diagnosis,"reason").trim().is_empty(){
        return Err("Recovery diagnosis requires reason".into());
    }
    let reroute=diagnosis.get("reroute")==Some(&Value::Bool(true));
    let excluded=diagnosis.get("excludeCurrentRoute")==Some(&Value::Bool(true));
    if excluded && !reroute{return Err("Cannot exclude route without reroute".into());}
    if excluded {
        if let Some(route)=task.get("routing").filter(|v|!v.is_null()).cloned(){
            let exclusions=task.get("routingExclusions").and_then(Value::as_array)
                .cloned().unwrap_or_default();
            let duplicate=exclusions.iter().any(|item|
                item.get("provider")==route.get("provider")
                && item.get("model")==route.get("model")
                && item.get("profile")==route.get("profile"));
            if !duplicate {
                let mut next=exclusions;
                let mut record=json!({
                    "provider":route.get("provider"),"model":route.get("model"),
                    "reason":field(diagnosis,"reason"),"at":now
                });
                if let Some(profile)=route.get("profile").filter(|v|!v.is_null()){
                    record["profile"]=profile.clone();
                }
                next.push(record);
                task["routingExclusions"]=json!(next);
            }
        }
    }
    let mut context=json!({
        "failureKind":kind,"reason":field(diagnosis,"reason"),
        "recoveryTaskId":request.get("recoveryTaskId"),"at":now,
        "reroute":reroute
    });
    if let Some(evidence)=diagnosis.get("evidence").and_then(Value::as_str)
        .filter(|s|!s.is_empty()) {context["evidence"]=json!(evidence);}
    task["recoveryContext"]=context;
    if reroute {
        if let Some(obj)=task.as_object_mut(){
            obj.remove("routing");
            obj.remove("workerSelection");
        }
    }
    Ok(())
}
fn mark_cancelled_task_superseded(
    directory:&Path,task:&mut Value,reason:&str,now:&str
)->Result<(),String>{
    if field(task,"kind")=="planner"{
        return Err(format!("Legacy planner Task {} is read-only",field(task,"id")));
    }
    if field(task,"state")!="CANCELLED"{
        return Err(format!("Task {} must already be CANCELLED before supersede annotation",field(task,"id")));
    }
    if reason.trim().is_empty(){return Err("task supersede requires a reason".into());}
    let proposal=json!({
        "path":"cancel_supersede","targetTaskId":task.get("id"),
        "rootCause":reason.trim(),
        "solution":"Superseded by later corrected durable work",
    });
    let mut accepted_action=false;
    let decision=dispatch_task_resolution_sync(directory,task,&proposal,&json!("external"),|action|{
        if action!="resolution.cancelSupersede"{
            return Err(format!("Unsupported resolution action {action}"));
        }
        accepted_action=true;
        Ok(())
    })?;
    if decision.get("accepted")!=Some(&Value::Bool(true)) || !accepted_action {
        return Err(format!("Task resolution graph rejected cancellation supersede for {}",field(task,"id")));
    }
    let mut resolution=materialize_resolution(&proposal,&json!("external"),now);
    resolution["state"]=json!("resolved");
    task["resolution"]=resolution;
    task["error"]=json!(format!("Superseded {}",reason.trim()));
    task["updatedAt"]=json!(now);
    Ok(())
}
pub fn supersede_cancelled_task_snapshot(
    directory:&Path,job:&Value,task_id:&str,reason:&str,now:Option<&str>,
)->Result<Value,String>{
    let mut updated=job.clone();
    let current=now.map(str::to_owned).unwrap_or_else(iso8601_now);
    let task=find_task_mut(&mut updated,task_id)
        .ok_or_else(||format!("Task {task_id} not found"))?;
    mark_cancelled_task_superseded(directory,task,reason,&current)?;
    Ok(updated)
}
pub fn classify_failed_task_snapshot(
    directory:&Path,job:&Value,task_id:&str,classification:&Value,now:Option<&str>,
)->Result<Value,String>{
    let mut updated=job.clone();
    if classification.get("targetTaskId")==Some(&json!(task_id))
        || !updated.get("tasks").and_then(Value::as_array).into_iter().flatten()
            .any(|candidate|candidate.get("id")==classification.get("targetTaskId")){
        return Err("Task classification targetTaskId must identify a different durable Task in this Job".into());
    }
    let current=now.map(str::to_owned).unwrap_or_else(iso8601_now);
    let task=find_task_mut(&mut updated,task_id)
        .ok_or_else(||format!("Task {task_id} not found"))?;
    classify_task_resolution(directory,task,classification,&current)?;
    Ok(updated)
}

/// Source-compatible Task Action dispatch on a candidate Job snapshot.
/// The daemon owns the SQLite mutateJob transaction and resulting wake.
/// Exactly the same Graph and related-task selection are used for every mode.
pub fn dispatch_task_action_snapshot(
    directory:&Path,job:&Value,request:&Value,now:Option<&str>,
)->Result<(Value,Value),String>{
    let current=now.map(str::to_owned).unwrap_or_else(iso8601_now);
    let mut updated=job.clone();
    let action=field(request,"id");
    let task_id=field(request,"taskId");
    let original=find_task(job,task_id)
        .ok_or_else(||format!("Task {task_id} not found"))?;
    let related=if action=="task.recover"{Vec::new()}
        else{select_related_task_mutations(directory,job,original,action)?};
    match action {
        TASK_RETRY_ACTION=>{
            let task=find_task_mut(&mut updated,task_id).expect("task from original");
            apply_task_retry_action(directory,task,true,&current)?;
            // An explicit operator retry starts a fresh routing cycle.
            // Automatic recovery still honors its current route exclusions.
            if let Some(map)=task.as_object_mut(){
                map.insert("lastManualRetry".into(),json!({
                    "at":current,"attempt":original.get("attempt"),
                    "previousRouting":original.get("routing"),
                    "previousExclusions":original.get("routingExclusions"),
                    "error":original.get("error")
                }));
                for key in ["routing","workerSelection","routingExclusions","providerRecoveryCount","providerRecoveryPending"]{
                    map.remove(key);
                }
            }
        },
        TASK_RECOVER_ACTION=>{
            let recovery_id=field(request,"recoveryTaskId");
            let recovery=find_task(job,recovery_id)
                .ok_or_else(||format!("task recover requires an active Troubleshooter recovery for {task_id}"))?;
            if field(recovery,"agentName")!="troubleshooter"
                || recovery.get("parentTaskId")!=original.get("id")
                || !matches!(field(recovery,"state"),"QUEUED"|"RUNNING"){
                return Err(format!("task recover requires an active Troubleshooter recovery for {task_id}"));
            }
            let execution_id=field(recovery,"executionId");
            if execution_id.is_empty(){
                return Err(format!("Troubleshooter {} has no current execution for a fresh resolution",field(recovery,"id")));
            }
            let proposal=json!({
                "path":"exact_original_retry","targetTaskId":task_id,
                "recoveryExecutionId":execution_id,
                "rootCause":original.get("failureReason").and_then(Value::as_str)
                    .or_else(||original.get("error").and_then(Value::as_str))
                    .unwrap_or("durable failure"),
                "solution":format!("Recover exact original Task via {recovery_id}")
            });
            let mut accepted_action=false;
            let decision=dispatch_task_resolution_sync(
                directory,original,&proposal,&json!("troubleshooter"),
                |selected|{
                    if selected!="resolution.activateRecovery" {
                        return Err(format!("Unsupported recovery action {selected}"));
                    }
                    accepted_action=true;
                    Ok(())
                }
            )?;
            if decision.get("accepted")!=Some(&Value::Bool(true)) || !accepted_action {
                return Err(format!("Task resolution graph rejected exact-original recovery for {task_id}"));
            }
            let task=find_task_mut(&mut updated,task_id).expect("task from original");
            apply_task_retry_action(directory,task,true,&current)?;
            record_recovery_routing(task,request,&current)?;
            let mut resolution=materialize_resolution(&proposal,&json!("troubleshooter"),&current);
            resolution["state"]=json!("resolved");
            task["resolution"]=resolution;
        },
        TASK_UNBLOCK_RETRY_ACTION=>{
            let task=find_task_mut(&mut updated,task_id).expect("task from original");
            apply_task_unblock_retry_action(directory,task,&current)?;
        },
        TASK_CANCEL_ACTION=>{
            let task=find_task_mut(&mut updated,task_id).expect("task from original");
            apply_task_cancel_action(directory,task,"Cancelled by user",&current)?;
        },
        TASK_RELEASE_ACTION=>{
            let task=find_task_mut(&mut updated,task_id).expect("task from original");
            apply_task_release_action(directory,task,&current)?;
        },
        TASK_HOLD_ACTION=>{
            let task=find_task_mut(&mut updated,task_id).expect("task from original");
            apply_task_hold_action(directory,task,&current)?;
        },
        TASK_QUEUE_ACTION=>{
            let mut task=find_task(&updated,task_id).expect("task from original").clone();
            apply_task_queue_action(directory,&updated,&mut task,&current)?;
            *find_task_mut(&mut updated,task_id).expect("task from original")=task;
        },
        _=>return Err(format!("Unsupported task action {action}")),
    }
    for mutation in related {
        let related_id=field(&mutation,"taskId");
        let target=find_task_mut(&mut updated,related_id)
            .ok_or_else(||format!("Related task {related_id} not found"))?;
        if field(&mutation,"mutation")=="cancel"{
            apply_task_cancel_action(directory,target,field(&mutation,"reason"),&current)?;
        }
    }
    let task=find_task(&updated,task_id).expect("task from original").clone();
    Ok((updated,task))
}


/// Node's fixed-Job unblock helper has no separate workflow policy. The
/// canonical Task Graph decides the transition and validates the snapshot.
pub fn apply_task_unblock_retry_snapshot(
    directory: &Path, task: &mut Value,
) -> Result<(), String> {
    apply_task_unblock_retry_action(directory, task, &iso8601_now())
}

/// Resolve a failed Task's next owner and classification in one local
/// authoritative transaction. The result contains the actually committed Task.
pub fn classify_failed_task(
    directory: &Path, store: &SQLiteRelayStore, job_id: &str,
    task_id: &str, classification: &Value,
) -> Result<Value, String> {
    let mut changed = None;
    let job = store.mutate_job(job_id, |current| {
        let updated = classify_failed_task_snapshot(
            directory, &current, task_id, classification, None,
        )?;
        changed = updated.get("tasks").and_then(Value::as_array)
            .and_then(|items| items.iter().find(|task| field(task,"id")==task_id))
            .cloned();
        Ok(updated)
    })?;
    Ok(json!({"job": job, "task": changed.ok_or_else(||
        format!("Task {task_id} classification was not committed"))?}))
}

/// Record a supersession only after the Task is durably cancelled and the
/// Task Resolution Graph permits its cancellation annotation.
pub fn supersede_cancelled_task(
    directory: &Path, store: &SQLiteRelayStore, job_id: &str,
    task_id: &str, reason: &str,
) -> Result<Value, String> {
    let mut changed = None;
    let job = store.mutate_job(job_id, |current| {
        let updated = supersede_cancelled_task_snapshot(
            directory, &current, task_id, reason, None,
        )?;
        changed = updated.get("tasks").and_then(Value::as_array)
            .and_then(|items| items.iter().find(|task|field(task,"id")==task_id))
            .cloned();
        Ok(updated)
    })?;
    Ok(json!({"job":job,"task":changed.ok_or_else(||
        format!("Task {task_id} was not updated"))?}))
}

/// Full Task Action public entrypoint: both the requested Task and Graph-
/// selected related Task effects commit in the same SQLite transaction.
pub fn dispatch_task_action(
    directory: &Path, store: &SQLiteRelayStore, request: &Value,
) -> Result<Value, String> {
    let job_id=field(request,"jobId");
    let mut changed = None;
    let job = store.mutate_job(job_id, |current| {
        let (updated, task) = dispatch_task_action_snapshot(
            directory, &current, request, None,
        )?;
        changed = Some(task);
        Ok(updated)
    })?;
    Ok(json!({"job":job,"task":changed.ok_or_else(||
        format!("Task {} was not updated",field(request,"taskId")))?}))
}
