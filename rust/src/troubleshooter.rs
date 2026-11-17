// Node provenance: src/troubleshooter.ts. One durable Recovery identity
// per failed original Task. Only the canonical Troubleshooter Graph may create
// a recovery Task; the original failure and episode cannot be erased.
use crate::{
    job_task_id_sequence::allocate_entity_id,
    local_merge_lock::iso8601_now,
    workflow::{
        entity_creation::create_task_entity,
        troubleshooter_v2::dispatch_troubleshooter,
    },
};
use serde_json::{json,Value};
use std::{collections::HashSet,path::Path};
fn field<'a>(v:&'a Value,key:&str)->&'a str{
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn tasks(job:&Value)->&[Value]{
    job.get("tasks").and_then(Value::as_array)
        .map(Vec::as_slice).unwrap_or(&[])
}
pub fn troubleshooter_task_id(
    directory:&Path,job:&Value,original:&Value
)->Result<String,String>{
    let repository=job.get("repository").and_then(Value::as_str)
        .unwrap_or("relay");
    allocate_entity_id(directory,repository,"task",
        Some(&format!("troubleshooter:{}:{}",field(original,"jobId"),
            field(original,"id"))),&HashSet::new())
}
pub fn failure_input(job:&Value,task:&Value)->String {
    let routing=task.get("routing").filter(|v|!v.is_null())
        .map(Value::to_string).unwrap_or_else(||"unrouted".into());
    let worker=task.pointer("/workerSelection/workerId").and_then(Value::as_str)
        .unwrap_or_else(||field(task,"adapter"));
    let reason=task.get("failureReason").and_then(Value::as_str)
        .or_else(||task.get("error").and_then(Value::as_str))
        .unwrap_or("unknown");
    format!(r#"Recover the failed/blocked task below and make it move again if technically safe.

Original repository: {}
Local Git root: {}
Original job: {}
Original task: {}
Original task URL: {}
Original state: {}
Original attempt: {}
Original worker: {}
Original routing: {}
Failure reason: {}

MANDATORY EVENT EVIDENCE BEFORE DIAGNOSIS:
Retrieve this task's lifecycle event history before classifying the root cause or retrying:
Use the version-matched Relay CLI: task show --id {} --task-id {}; task events --id {} --task-id {} --limit 60 --order asc --after 0. If a page is full, continue using its nextCursor until all history is retrieved. Use the matching Relay CLI; --repo may additionally fence the Job identity.
Inspect event order, type/status, source, data/phase, duplicate events, missing expected lifecycle events, late events, and execution identifiers. If the event stream points to delivery/runtime failure, inspect the corresponding Relay/worker/tool logs too. Do not treat the final task.error string as the complete root cause.

Follow the selected Troubleshooter agent contract. Diagnose root cause from durable task state, append-only comments, task-scoped event history, and relevant runtime logs before retry. The final task.error string alone is never sufficient. Independently verify every human response against evidence from the exact original failing execution context; a response or historical resolution condition alone never proves recovery. Classify evidence as model/provider/runtime, worker/tool/infrastructure, semantic task failure, or timeout/unknown. Select one graph-enabled resolution path: exact_original_retry, same_job_dependency, blocker_job_dependency, escalation_gate, or cancel_supersede. For confirmed adapter/model/provider failure, include --failure-kind, --reason, --evidence and --reroute in task recover; use --exclude-current-route only if the exact failed route should not be selected again. For semantic task failure use --failure-kind task_failure without rerouting. For uncertain failures use --failure-kind unknown and preserve routing unless evidence justifies rerouting. Request the existing agents-relay task recover or agents-relay escalation operation; submission alone is not recovery. Reload the original Task with the Relay CLI and verify the requested resolution and exact-original retry postconditions before reporting success. Bound self-healing retries to the durable Task retry budget. For a shared worker/runtime/tool defect, use its owning repository's P0/self-job workflow and verify the durable fix before requesting recovery. Never use ordinary task retry from a Troubleshooter because manual retry intentionally supersedes active recovery. Do not manually choose a provider/model or create a replacement task. If diagnosis suggests a genuine human/external blocker, invoke the escalation command; do not publish task.blocked or implement a workflow branch procedurally. Follow the Relay CLI escalation result (resolved, failed, or needs_user); do not implement a parallel recovery path. Retry this exact original task only after the blocker is removed and verify the reported Job/Task progress through Relay CLI."#,
        field(job,"repository"),field(job,"projectRoot"),
        field(job,"id"),field(task,"id"),
        task.get("taskUrl").and_then(Value::as_str).unwrap_or("unknown"),
        field(task,"state"),
        task.get("attempt").and_then(Value::as_u64).unwrap_or(0),
        worker,routing,reason,
        field(job,"id"),field(task,"id"),field(job,"id"),field(task,"id"))
}
fn recovery_for(original:&Value,recovery:&Value)->bool{
    field(recovery,"agentName")=="troubleshooter"
        && recovery.get("parentTaskId")==original.get("id")
}
fn episode(recovery:&Value)->i64{
    recovery.get("recoveryForAttempt").and_then(Value::as_i64).unwrap_or(-1)
}
pub fn pending_troubleshooter_reopens(job:&Value)->Vec<Value>{
    let mut result=Vec::new();
    for original in tasks(job){
        if field(original,"kind")=="planner"
            ||field(original,"agentName")=="troubleshooter"
            ||field(original,"state")!="FAILED"{continue;}
        let recoveries:Vec<&Value>=tasks(job).iter().filter(|item|
            recovery_for(original,item)).collect();
        if recoveries.is_empty()||recoveries.iter().any(|r|
            matches!(field(r,"state"),"DRAFT"|"QUEUED"|"RUNNING"|"BLOCKED")){continue;}
        let best=recoveries.into_iter().max_by_key(|r|episode(r))
            .expect("recoveries non-empty");
        if !matches!(field(best,"state"),"SUCCEEDED"|"CANCELLED")
            ||episode(best)>=original.get("attempt").and_then(Value::as_i64).unwrap_or(0){
            continue;
        }
        result.push(json!({"original":original,"recovery":best}));
    }
    result
}
pub fn pending_troubleshooter_retries(job:&Value)->Vec<Value>{
    tasks(job).iter().filter_map(|recovery|{
        if field(recovery,"agentName")!="troubleshooter"
            ||field(recovery,"state")!="FAILED"
            ||recovery.get("attempt").and_then(Value::as_u64).unwrap_or(0)
                >=recovery.get("maxAttempts").and_then(Value::as_u64).unwrap_or(0){
            return None;
        }
        tasks(job).iter().find(|original|
            original.get("id")==recovery.get("parentTaskId")
                &&matches!(field(original,"state"),"FAILED"|"BLOCKED"))
            .map(|original|json!({"original":original,"recovery":recovery}))
    }).collect()
}
pub fn refresh_troubleshooter_input(job:&Value,original:&Value,recovery:&mut Value){
    recovery["input"]=json!(failure_input(job,original));
    recovery["recoveryForAttempt"]=original.get("attempt").cloned().unwrap_or(Value::Null);
    let attempt=recovery.get("attempt").and_then(Value::as_u64).unwrap_or(0);
    let budget=recovery.get("maxAttempts").and_then(Value::as_u64).unwrap_or(0);
    recovery["maxAttempts"]=json!(budget.max(attempt.saturating_add(3)));
    if let Some(object)=recovery.as_object_mut(){
        object.remove("routing");object.remove("workerSelection");
    }
}
pub fn pending_troubleshooter_tasks(
    graph_dir:&Path,store_dir:&Path,job:&Value,
)->Result<Vec<Value>,String>{
    let mut pending=Vec::new();
    for original in tasks(job){
        let existing=tasks(job).iter().any(|candidate|recovery_for(original,candidate));
        let blocked=field(original,"state")=="BLOCKED"
            &&(original.get("unblock").is_some_and(|v|!v.is_null())
                ||original.get("interactiveInvocation").is_some_and(|v|!v.is_null()));
        let facts=json!({
            "failedWork":field(original,"state")=="FAILED",
            "ordinaryWork":field(original,"kind")!="planner"
                &&field(original,"agentName")!="troubleshooter",
            "currentRun":true,"needsRecovery":!blocked,
            "idUnused":!existing,"noRecoveryBarrier":!existing
        });
        let mut create=false;
        let decision=dispatch_troubleshooter(graph_dir,&facts,||{
            create=true;Ok(())
        })?;
        if decision.get("accepted")!=Some(&Value::Bool(true)) ||!create{continue;}
        let id=troubleshooter_task_id(store_dir,job,original)?;
        let now=iso8601_now();
        let fields=json!({
            "jobId":job.get("id"),"id":id,"title":"Troubleshooter",
            "recoveryForAttempt":original.get("attempt"),
            "kind":"work","priority":"P0","storySize":"M",
            "projectName":job.get("title"),"agentName":"troubleshooter",
            "parentTaskId":original.get("id"),"dependencies":[],
            "capabilities":["troubleshoot","recovery"],
            "workerRequirements":{"capabilities":["model","local_repo","iterative_tools"],
                "runtime":"codex"},"adapter":"codex",
            "input":failure_input(job,original),"output":{"kind":"task_pr"},
            "continuation":null,"continuationDeliveredAt":null,
            "attempt":0,"maxAttempts":3,"leaseOwner":null,
            "leaseExpiresAt":null,"executionId":null,"threadId":null,
            "result":null,"plannerResult":null,"error":null,
            "timeoutMs":900_000,"createdAt":now,"updatedAt":now
        });
        pending.push(create_task_entity(graph_dir,job,&fields,false,&now)?);
    }
    Ok(pending)
}
pub fn exhausted_troubleshooter_recoveries(job:&Value)->Vec<Value>{
    let mut exhausted=Vec::new();
    for recovery in tasks(job){
        if field(recovery,"agentName")!="troubleshooter"
            ||field(recovery,"state")!="FAILED"
            ||recovery.get("attempt").and_then(Value::as_u64).unwrap_or(0)
                <recovery.get("maxAttempts").and_then(Value::as_u64).unwrap_or(0)
            ||field(recovery,"parentTaskId").is_empty(){continue;}
        let Some(original)=tasks(job).iter().find(|candidate|
            candidate.get("id")==recovery.get("parentTaskId")
                &&matches!(field(candidate,"state"),"FAILED"|"BLOCKED"))
        else{continue;};
        let recorded=job.get("recoveryFailures").and_then(Value::as_array)
            .is_some_and(|rows|rows.iter().any(|row|
                row.get("taskId")==original.get("id")
                    &&row.get("recoveryTaskId")==recovery.get("id")));
        if recorded{continue;}
        let reason=recovery.get("error").and_then(Value::as_str)
            .or_else(||recovery.get("failureReason").and_then(Value::as_str))
            .map(str::to_owned).unwrap_or_else(||format!(
                "Troubleshooter {} {}",field(recovery,"id"),
                field(recovery,"state").to_ascii_lowercase()));
        exhausted.push(json!({"original":original,"recovery":recovery,"reason":reason}));
    }
    exhausted
}
