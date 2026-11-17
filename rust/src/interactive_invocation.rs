// Node provenance: src/interactive-invocation.ts. Generic UI Host submits
// review facts only. The authoritative Task execution and interactive
// invocation are fenced in SQLite by Relay's Graph and Store.
use crate::{
    events::random_uuid,
    execution_event_identity::execution_event_source,
    local_merge_lock::iso8601_now,
    workflow::{
        policy_graph::{choose_policy,load_policy_graph},
    },
};
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use std::{collections::HashMap,path::Path};

fn field<'a>(value:&'a Value,key:&str)->&'a str{
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
fn nonempty<'a>(value:&'a Value,key:&str)->Option<&'a str>{
    value.get(key).and_then(Value::as_str).filter(|s|!s.is_empty())
}
pub fn interactive_invocation_graph(
    directory:&Path,
)->Result<crate::workflow::graph_v2::GraphRuntime,String>{
    load_policy_graph(directory,"interactive-invocation")
}
pub fn host_interactive_decision_event(
    context:&Value,feedback:&Value,received_at:&str,
)->Result<Value,String>{
    let event_id=nonempty(feedback,"eventId");
    let decision=field(feedback,"decision");
    if event_id.is_none() || !matches!(decision,"approved"|"changes_requested"){
        return Err("Incomplete generic interactive decision".into());
    }
    let job=field(context,"jobId");
    let task=field(context,"taskId");
    let execution=field(context,"executionId");
    let mut details=context.clone();
    if !details.is_object(){details=json!({});}
    if let Some(object)=feedback.as_object(){
        for (key,value) in object {
            if key!="eventId"{details[key]=value.clone();}
        }
    }
    Ok(json!({
        "version":1,"event_id":event_id,
        "job_id":job,"task_id":task,"parent_task_id":null,
        "type":"task.interactive_decision","status":"running",
        "timestamp":received_at,"visibility":"orchestrator","level":"info",
        "message":format!("Host interactive decision received for execution {execution}"),
        "source":{"id":execution_event_source(job,task,execution),
            "component":"agents-relay"},"data":{"interactive":details}
    }))
}
pub fn normalize_interactive_decision(event:&Value)->Option<Value>{
    if field(event,"type")!="task.interactive_decision"{return None;}
    let value=event.pointer("/data/interactive")?.as_object()?;
    let payload=Value::Object(value.clone());
    let job=nonempty(&payload,"jobId")?;
    let task=nonempty(&payload,"taskId")?;
    let execution=nonempty(&payload,"executionId")?;
    let decision=field(&payload,"decision");
    if !matches!(decision,"approved"|"changes_requested"){return None;}
    for forbidden in ["invocationId","revision","commitSha","revisionId","contentHash"]{
        if value.contains_key(forbidden){return None;}
    }
    if event.pointer("/source/id").and_then(Value::as_str)
        !=Some(execution_event_source(job,task,execution).as_str()){return None;}
    let feedback=payload.get("feedback").and_then(Value::as_str)?;
    if let Some(comments)=payload.get("comments"){
        let comments=comments.as_array()?;
        if comments.len()>100 || comments.iter().any(|item|
            !item.is_object()||item.get("text").and_then(Value::as_str).is_none()){
            return None;
        }
    }
    let mut delivery=json!({
        "jobId":job,"taskId":task,"executionId":execution,
        "invocationId":execution,"revision":execution,
        "decision":decision,"feedback":feedback,
        "eventId":event.get("event_id"),
        "deliveredAt":event.get("timestamp")
    });
    for key in ["previewId","requestId","idempotencyKey","comments"]{
        if let Some(v)=payload.get(key){
            if key=="comments" || v.as_str().is_some_and(|s|!s.is_empty()){
                delivery[key]=v.clone();
            }
        }
    }
    Some(delivery)
}
pub fn interactive_decision_fingerprint(delivery:&Value)->String{
    let canonical=json!({
        "jobId":delivery.get("jobId"),"taskId":delivery.get("taskId"),
        "executionId":delivery.get("executionId"),
        "invocationId":delivery.get("invocationId"),
        "revision":delivery.get("revision"),
        "decision":delivery.get("decision"),
        "feedback":delivery.get("feedback"),
        "comments":delivery.get("comments")
    });
    format!("{:x}",Sha256::digest(canonical.to_string().as_bytes()))
}
pub fn event_only_review_eligible(_delivery:&Value)->bool{false}
fn invocation_state(invocation:Option<&Value>)->&str{
    invocation.and_then(|value|value.get("status")).and_then(Value::as_str)
        .unwrap_or("awaiting_decision")
}
pub fn decide_interactive_invocation(
    directory:&Path,job:&Value,task:&Value,delivery:&Value,duplicate:bool,
)->Result<Value,String>{
    let invocation=task.get("interactiveInvocation").filter(|v|!v.is_null());
    let same_invocation=invocation.and_then(|i|i.get("invocationId"))
        ==delivery.get("invocationId");
    let same_revision=invocation.and_then(|i|i.get("revision"))
        ==delivery.get("revision");
    let live=field(job,"state")=="ACTIVE";
    let same_execution=task.get("executionId")==delivery.get("executionId");
    let facts=json!({
        "currentInvocation":invocation.is_some()&&same_invocation,
        "awaitingDecision":invocation
            .is_some_and(|v|field(v,"status")=="awaiting_decision"),
        "currentRevision":invocation.is_some()&&same_revision,
        "eventOnlyCurrentExecution":live&&invocation.is_none()
            &&field(task,"state")=="RUNNING"&&same_execution
            &&event_only_review_eligible(delivery),
        "eventOnlyNextRevision":live&&invocation.is_some_and(|v|
            field(v,"status")=="changes_requested"
                &&v.get("executionId")==delivery.get("executionId"))
            &&field(task,"state")=="RUNNING"&&same_execution
            &&!same_revision&&event_only_review_eligible(delivery),
        "duplicateDelivery":duplicate,
        "changesRequested":field(delivery,"decision")=="changes_requested"
    });
    choose_policy(directory,"interactive-invocation",
        invocation_state(invocation),"task.interactive_decision",&facts,8,
        |_|false)
}
pub fn bind_interactive_invocation_snapshot(
    current:&Value,task_id:&str,execution_id:&str,now:&str,
)->Result<Value,String>{
    let mut job=current.clone();
    let Some(task)=job.get_mut("tasks").and_then(Value::as_array_mut)
        .and_then(|tasks|tasks.iter_mut().find(|t|field(t,"id")==task_id))
    else{return Err(format!("Task {task_id} must be RUNNING to bind an interactive invocation"));};
    if field(task,"state")!="RUNNING"{
        return Err(format!("Task {task_id} must be RUNNING to bind an interactive invocation"));
    }
    if field(task,"executionId")!=execution_id{
        return Err(format!("Task {task_id} does not own execution {execution_id}"));
    }
    if let Some(invocation)=task.get("interactiveInvocation").filter(|v|!v.is_null()){
        if field(invocation,"invocationId")==execution_id{
            if field(invocation,"revision")!=execution_id{
                return Err("Invocation identity cannot change revision".into());
            }
            return Ok(job);
        }
    }
    task["interactiveInvocation"]=json!({
        "invocationId":execution_id,"revision":execution_id,
        "executionId":execution_id,"status":"awaiting_decision","boundAt":now
    });
    Ok(job)
}
/// Produces only the Graph-approved candidate; a caller must persist the
/// decision identity and receipt atomically using host_invocation_store.
pub fn apply_interactive_decision(
    directory:&Path,job:&Value,event:&Value,duplicate:bool,
    persisted_receipt:Option<&Value>,
)->Result<Value,String>{
    let Some(delivery)=normalize_interactive_decision(event) else{
        return Ok(json!({"outcome":"ignored","reason":"invalid_interactive_delivery"}));
    };
    if delivery.get("jobId")!=event.get("job_id")
        ||delivery.get("taskId")!=event.get("task_id"){
        return Ok(json!({"outcome":"ignored","reason":"invalid_interactive_delivery"}));
    }
    let Some(task)=job.get("tasks").and_then(Value::as_array)
        .into_iter().flatten().find(|t|t.get("id")==delivery.get("taskId"))
    else{
        return Ok(json!({"outcome":"stale","reason":"execution_not_bound"}));
    };
    if task.get("executionId")!=delivery.get("executionId")
        &&field(task,"state")!="AWAITING_DECISION"{
        return Ok(json!({"outcome":"stale","reason":"execution_not_bound"}));
    }
    let graph=decide_interactive_invocation(directory,job,task,&delivery,duplicate)?;
    let selected=graph.get("actions").and_then(Value::as_array).is_some_and(|actions|
        actions.iter().any(|action|matches!(field(action,"id"),
            "interactive.requestChanges"|"interactive.approve")));
    let wake=graph.get("actions").and_then(Value::as_array).is_some_and(|actions|
        actions.iter().any(|action|field(action,"id")=="interactive.wakeWorker"));
    if graph.get("accepted")!=Some(&Value::Bool(true))
        ||!selected||duplicate{
        let outcome=if duplicate{"duplicate"}else{"stale"};
        return Ok(json!({"outcome":outcome,
            "reason":format!("{outcome}_interactive_decision"),
            "decision":delivery,"resumeWorker":duplicate&&wake
        }));
    }
    let receipt=persisted_receipt.ok_or(
        "Interactive invocation store does not support durable decisions")?;
    if field(receipt,"outcome")!="accepted"{
        return Ok(json!({"outcome":receipt.get("outcome"),
            "reason":receipt.get("reason")}));
    }
    Ok(json!({"outcome":"accepted","reason":"latest_interactive_decision",
        "invocation":receipt.get("invocation"),"decision":delivery,
        "resumeWorker":wake}))
}
pub fn accepted_interactive_event(delivery:&Value)->Value{
    let job=field(delivery,"jobId");
    let task=field(delivery,"taskId");
    let execution=field(delivery,"executionId");
    let mut interactive=delivery.clone();
    interactive["outcome"]=json!("accepted");
    json!({"version":1,"event_id":random_uuid(),
        "job_id":job,"task_id":task,"parent_task_id":null,
        "type":"task.interactive_decision.accepted",
        "status":"succeeded","timestamp":iso8601_now(),
        "visibility":"orchestrator","level":"info",
        "message":format!("Interactive decision {} accepted for revision {}",
            field(delivery,"decision"),field(delivery,"revision")),
        "source":{"id":execution_event_source(job,task,execution),
            "component":"agents-relay"},
        "data":{"interactive":interactive}
    })
}
pub fn should_recover_interactive_decision(
    directory:&Path,status:&str,
)->Result<bool,String>{
    let decision=choose_policy(directory,"interactive-invocation",status,
        "task.interactive_recover",&json!({}),8, |_|false)?;
    Ok(decision.get("accepted")==Some(&Value::Bool(true))
        &&decision.get("actions").and_then(Value::as_array).is_some_and(|actions|
            actions.iter().any(|action|field(action,"id")=="interactive.wakeWorker")))
}
#[derive(Default)]
pub struct HostInteractiveInvocationCoordinator {
    waiters:HashMap<String,Value>,
}
impl HostInteractiveInvocationCoordinator {
    pub fn binding_key(job_id:&str,task_id:&str,execution_id:&str)->String{
        format!("{job_id}:{task_id}:{execution_id}:{execution_id}")
    }
    pub fn bind(&mut self,job_id:&str,task_id:&str,execution_id:&str,
        now:&str,current:&Value)->Result<Value,String>{
        let next=bind_interactive_invocation_snapshot(current,task_id,execution_id,now)?;
        self.waiters.insert(Self::binding_key(job_id,task_id,execution_id),
            json!({"boundAt":now}));
        Ok(next)
    }
    pub fn accept(&mut self,delivery:&Value)->bool{
        let key=Self::binding_key(field(delivery,"jobId"),field(delivery,"taskId"),
            field(delivery,"executionId"));
        self.waiters.remove(&key).is_some()
    }
    pub fn close(&mut self){self.waiters.clear();}
}
