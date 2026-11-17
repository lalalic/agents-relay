// Node provenance: src/task-recovery.ts. SQLite-bound Troubleshooter
// escalation, immutable fingerprinting and human response receipt handling.
use crate::{
    events::{event_for,random_uuid},
    local_merge_lock::iso8601_now,
    task_transitions::try_transition_task_event,
    workflow::task_resolution::{dispatch_task_resolution_sync,materialize_resolution},
};
use chrono::DateTime;
use serde_json::{json, Value};
use sha2::{Digest,Sha256};
use std::path::Path;
fn text<'a>(v:&'a Value,key:&str)->&'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn active_recovery(job:&Value,original:&Value)->Option<Value> {
    job.get("tasks").and_then(Value::as_array).into_iter().flatten()
        .find(|task|text(task,"agentName")=="troubleshooter"
            && task.get("parentTaskId")==original.get("id")
            && matches!(text(task,"state"),"DRAFT"|"QUEUED"|"RUNNING"|"BLOCKED"))
        .cloned()
}
fn fingerprint(request:&Value,execution_id:Option<&Value>)->String {
    let raw=json!([
        text(request,"requiredAction").trim(),
        text(request,"resolutionCondition").trim(),
        text(request,"context").trim(),
        execution_id.unwrap_or(&Value::Null)
    ]).to_string();
    format!("{:x}",Sha256::digest(raw.as_bytes()))
}
fn clear_execution(task:&mut Value) {
    for key in ["leaseOwner","leaseExpiresAt","executionId"] {task[key]=Value::Null;}
}
pub fn request_troubleshooter_escalation(
    graph_directory:&Path, current:&Value, recovery_task_id:&str,
    request:&Value, now:Option<&str>,
)->Result<Value,String>{
    for (key,error) in [
        ("requiredAction","Escalation requires a concrete required action"),
        ("resolutionCondition","Escalation requires a resolution condition"),
        ("context","Escalation requires diagnostic context"),
    ] {
        if text(request,key).trim().is_empty() {return Err(error.into());}
    }
    let mut job=current.clone();
    let job_id=text(&job,"id").to_string();
    let Some(recovery)=job.get("tasks").and_then(Value::as_array).into_iter().flatten()
        .find(|task|text(task,"id")==recovery_task_id).cloned()
    else{return Err(format!("Task {recovery_task_id} is not a Troubleshooter recovery"));};
    if text(&recovery,"agentName")!="troubleshooter"
        || (text(&recovery,"parentTaskId").is_empty() && text(&recovery,"recoveryPlanId").is_empty()) {
        return Err(format!("Task {recovery_task_id} is not a Troubleshooter recovery"));
    }
    if matches!(text(&job,"state"),"COMPLETED"|"CANCELLED"){
        return Err(format!("Job {job_id} is terminal"));
    }
    let original=job.get("tasks").and_then(Value::as_array).into_iter().flatten()
        .find(|task|task.get("id")==recovery.get("parentTaskId")).cloned();
    let original_plan=job.get("plans").and_then(Value::as_array).into_iter().flatten()
        .find(|plan|plan.get("id")==recovery.get("recoveryPlanId")).cloned();
    if !original.as_ref().is_some_and(|v|text(v,"state")=="FAILED")
        && !original_plan.as_ref().is_some_and(|v|text(v,"status")=="FAILED") {
        return Err(format!("Troubleshooter {recovery_task_id} has no current FAILED original Task or Plan"));
    }
    let execution=original.as_ref().and_then(|v|v.get("executionId"))
        .filter(|v|!v.is_null()).or_else(||original_plan.as_ref()
            .and_then(|v|v.get("executionId")).filter(|v|!v.is_null()));
    let fp=fingerprint(request,execution);
    let previous=recovery.get("escalation");
    if previous.is_some_and(|e|text(e,"fingerprint")==fp)
        || (previous.is_some_and(|e|text(e,"status")=="pending")
            && text(&recovery,"state")=="BLOCKED") {
        return Ok(json!({"job":job,"task":recovery,
            "escalation":previous,"duplicate":true}));
    }
    if !matches!(text(&recovery,"state"),"QUEUED"|"RUNNING"|"FAILED") {
        return Err(format!("Troubleshooter {recovery_task_id} cannot escalate from {}",
            text(&recovery,"state")));
    }
    let now=now.map(str::to_owned).unwrap_or_else(iso8601_now);
    if let Some(original)=original.as_ref() {
        let proposal=json!({
            "path":"escalation_gate","targetTaskId":text(original,"id"),
            "recoveryExecutionId":recovery.get("executionId"),
            "rootCause":text(request,"context").trim(),
            "solution":text(request,"requiredAction").trim()
        });
        let mut selected=false;
        let decision=dispatch_task_resolution_sync(graph_directory,original,
            &proposal,&json!("troubleshooter"),|action|{
                if action!="resolution.createEscalationGate"{
                    return Err(format!("Unexpected resolution action {action}"));
                }
                selected=true;
                Ok(())
            })?;
        if decision.get("accepted")!=Some(&Value::Bool(true)) || !selected {
            return Err(format!("Task resolution graph rejected escalation for {}",text(original,"id")));
        }
        if let Some(task)=job.get_mut("tasks").and_then(Value::as_array_mut)
            .and_then(|items|items.iter_mut().find(|t|t.get("id")==original.get("id"))){
            task["resolution"]=materialize_resolution(&proposal,&json!("troubleshooter"),&now);
        }
    }
    let recovery_index=job.get("tasks").and_then(Value::as_array).into_iter().flatten()
        .position(|task|text(task,"id")==recovery_task_id)
        .ok_or("Troubleshooter disappeared")?;
    let task=&mut job["tasks"][recovery_index];
    let event_id=if text(task,"state")=="QUEUED"{"block"}else{"task.blocked"};
    let transition=try_transition_task_event(graph_directory,task,event_id,
        &json!({"recoverableExecution":true}),&now)?;
    if transition.get("accepted")!=Some(&Value::Bool(true)){
        return Err(format!("Troubleshooter {recovery_task_id} cannot be blocked"));
    }
    let escalation_id=random_uuid();
    let channel=request.pointer("/notification/channel").and_then(Value::as_str)
        .unwrap_or("relay-event");
    let escalation=json!({
        "id":escalation_id,"originalTaskId":original.as_ref().and_then(|v|v.get("id")),
        "originalPlanId":original_plan.as_ref().and_then(|v|v.get("id")),
        "fingerprint":fp,"originalExecutionId":original.as_ref().and_then(|v|v.get("executionId")),
        "recoveryExecutionId":recovery.get("executionId"),
        "requiredAction":text(request,"requiredAction").trim(),
        "resolutionCondition":text(request,"resolutionCondition").trim(),
        "context":text(request,"context").trim(),"status":"pending","requestedAt":now,
        "notification":{"status":"pending","channel":channel,"requestedAt":now}
    });
    let event=event_for(&job_id,recovery_task_id,
        original.as_ref().and_then(|v|v.get("id")).and_then(Value::as_str),
        "escalation.requested","blocked",
        &format!("Human action required: {}",text(&escalation,"requiredAction")),
        Some("user"),Some(json!({
            "escalationId":escalation_id,
            "originalTaskId":escalation.get("originalTaskId"),
            "originalPlanId":escalation.get("originalPlanId"),
            "requiredAction":escalation.get("requiredAction"),
            "resolutionCondition":escalation.get("resolutionCondition"),
            "notificationStatus":"pending"
        })),Some(json!({"agent":"relay","component":"agents-relay"})));
    let mut event=event;
    event["event_id"]=json!(format!("escalation/{escalation_id}"));
    task["escalation"]=escalation.clone();
    task["error"]=json!(format!("Waiting for human action: {}",text(&escalation,"requiredAction")));
    task["failureReason"]=json!("human_action_required");
    clear_execution(task);
    task["updatedAt"]=json!(now);
    let updated_task=task.clone();
    job["updatedAt"]=json!(now);
    Ok(json!({"job":job,"task":updated_task,"escalation":escalation,
        "duplicate":false,"event":event}))
}

pub fn resume_troubleshooter(graph_dir:&Path, current:&Value,task_id:&str,
    response:&str,now:Option<&str>)->Result<Value,String>{
    if response.trim().is_empty(){return Err("Troubleshooter response is required".into());}
    let mut job=current.clone();
    let now=now.map(str::to_owned).unwrap_or_else(iso8601_now);
    let Some(task)=job.get_mut("tasks").and_then(Value::as_array_mut)
        .and_then(|tasks|tasks.iter_mut().find(|task|text(task,"id")==task_id))
    else {return Err(format!("Task {task_id} is not a Troubleshooter escalation"));};
    if text(task,"agentName")!="troubleshooter"
        || task.get("escalation").is_none_or(Value::is_null) {
        return Err(format!("Task {task_id} is not a Troubleshooter escalation"));
    }
    let esc_id=text(&task["escalation"],"id").to_owned();
    if text(&task["escalation"],"status")!="pending"{
        return Err(format!("Escalation {esc_id} already has a response"));
    }
    if text(task,"state")!="BLOCKED"{
        return Err(format!("Task {task_id} is not a blocked Troubleshooter escalation"));
    }
    let decision=try_transition_task_event(graph_dir,task,"task.unblocked",&json!({}),&now)?;
    if decision.get("accepted")!=Some(&Value::Bool(true)) {
        return Err(format!("Troubleshooter {task_id} cannot be resumed"));
    }
    task["escalation"]["status"]=json!("responded");
    task["escalation"]["response"]=json!(response.trim());
    task["escalation"]["respondedAt"]=json!(now);
    task["result"]=Value::Null;
    task["error"]=Value::Null;
    if let Some(map)=task.as_object_mut(){map.remove("failureReason");}
    clear_execution(task);
    task["updatedAt"]=json!(now);
    let updated=task.clone();
    job["updatedAt"]=json!(now);
    Ok(json!({"job":job,"task":updated}))
}
pub fn has_pending_troubleshooter_escalation(job:&Value,original:&Value)->bool {
    active_recovery(job,original).is_some_and(|task|
        text(&task,"state")=="BLOCKED" && task.get("escalation")
            .is_some_and(|esc|text(esc,"status")=="pending"))
}
pub fn record_escalation_notification_delivery(
    current:&Value,recovery_task_id:&str,escalation_id:&str,
    receipt:&Value,
)->Result<Value,String>{
    let valid=receipt.get("channel").and_then(Value::as_str)
        .is_some_and(|s|!s.trim().is_empty())
        && receipt.get("deliveryId").and_then(Value::as_str)
            .is_some_and(|s|!s.trim().is_empty())
        && receipt.get("deliveredAt").and_then(Value::as_str)
            .is_some_and(|s|DateTime::parse_from_rfc3339(s).is_ok());
    if !valid {return Err("Escalation delivery requires a real channel, provider receipt ID and timestamp".into());}
    let mut job=current.clone();
    let Some(task)=job.get_mut("tasks").and_then(Value::as_array_mut)
        .and_then(|tasks|tasks.iter_mut().find(|task|text(task,"id")==recovery_task_id
            && text(task,"agentName")=="troubleshooter"))
    else {return Err("Unknown escalation delivery identity".into());};
    let Some(escalation)=task.get_mut("escalation") else{
        return Err("Unknown escalation delivery identity".into());
    };
    if text(escalation,"id")!=escalation_id {
        return Err("Unknown escalation delivery identity".into());
    }
    if text(escalation,"status")!="pending" {
        return Err("Escalation no longer pending".into());
    }
    if text(&escalation["notification"],"status")=="delivered" {
        if escalation["notification"]["deliveryId"]!=receipt["deliveryId"]
            || escalation["notification"]["channel"]!=receipt["channel"] {
            return Err("Escalation delivery receipt conflict".into());
        }
    }else{
        escalation["notification"]=json!({
            "status":"delivered","channel":receipt.get("channel"),
            "deliveryId":receipt.get("deliveryId"),"deliveredAt":receipt.get("deliveredAt")
        });
        task["updatedAt"]=receipt.get("deliveredAt").cloned().unwrap_or(Value::Null);
    }
    let confirmed=task["escalation"].clone();
    Ok(json!({"job":job,"escalation":confirmed}))
}
