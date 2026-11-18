// Node provenance: src/cli-unblock.ts. Restrict CLI unblock input and
// delegate all durable recovery decisions to the canonical Task effects.
use crate::cli_core_support::arg;
use serde_json::{json, Value};

pub fn task_unblock_request(
    args: &[String], task: &Value,
) -> Result<Value, String> {
    let reason = arg(args, "--reason", "");
    let response = arg(args, "--response", "");
    if reason.trim().is_empty() && response.trim().is_empty() {
        return Err("task unblock requires --reason or --response".into());
    }
    let troubleshooter = task.get("agentName").and_then(Value::as_str)
        == Some("troubleshooter");
    let pending = task.get("escalation").and_then(|e|e.get("status"))
        .and_then(Value::as_str) == Some("pending");
    let resume = troubleshooter && pending && !response.trim().is_empty();
    Ok(json!({
        "taskId":task.get("id"),
        "reason": reason,
        "response": response,
        "resumeTroubleshooter":resume,
        "source":"cli"
    }))
}
pub fn job_unblock_request(
    args: &[String], job: &Value, effectively_blocked: impl Fn(&Value) -> bool,
) -> Result<Value, String> {
    let reason = arg(args, "--reason", "");
    if reason.trim().is_empty() { return Err("job unblock requires --reason".into()); }
    let blocked: Vec<Value> = job.get("tasks").and_then(Value::as_array)
        .into_iter().flatten().filter(|task| effectively_blocked(task))
        .filter_map(|task| task.get("id").cloned()).collect();
    if blocked.is_empty() {
        let id = job.get("id").and_then(Value::as_str).unwrap_or("undefined");
        return Err(format!("Job {id} has no effective BLOCKED work task"));
    }
    Ok(json!({"jobId":job.get("id"),"resumedTasks":blocked,"reason":reason}))
}

use crate::{
    cli_support::save_local,
    cli_support_events::{
        publish_task_unblocked, publish_wake, ServiceEventBusPort,
    },
    relay_store::SQLiteRelayStore,
    task_recovery::resume_troubleshooter,
    unblock::{is_effectively_blocked,unblock_task_snapshot},
};
use std::path::Path;

/// Public task unblock command: Graph transitions and all Job updates are
/// committed before optional local export or best-effort EventBus observations.
/// Supplying a bus lets the daemon own NATS discovery and bounded shutdown.
pub fn run_task_unblock_command(
    graph_directory: &Path, args: &[String], store: &SQLiteRelayStore,
    job: &Value, task: &Value, local_file: Option<&Path>,
    bus: Option<&dyn ServiceEventBusPort>,
) -> Result<Value,String> {
    let request=task_unblock_request(args,task)?;
    let job_id=job.get("id").and_then(Value::as_str)
        .ok_or("Unblock Job is missing ID")?;
    let task_id=task.get("id").and_then(Value::as_str)
        .ok_or("Unblock Task is missing ID")?;
    let reason=request["reason"].as_str().unwrap_or("");
    if request["resumeTroubleshooter"]==true {
        let response=request["response"].as_str().unwrap_or("");
        let refreshed=store.mutate_job(job_id,|current|{
            let result=resume_troubleshooter(
                graph_directory,&current,task_id,response,None)?;
            Ok(result["job"].clone())
        })?;
        save_local(local_file,&refreshed)?;
        let event_reason=if reason.is_empty(){
            "Human response recorded"
        } else {reason};
        publish_task_unblocked(bus,&refreshed,task_id,event_reason);
        publish_wake(bus,&refreshed,task_id,
            "Troubleshooter resumed after human response");
        let updated_task=refreshed.get("tasks").and_then(Value::as_array)
            .and_then(|tasks|tasks.iter().find(|task|
                task.get("id").and_then(Value::as_str)==Some(task_id)))
            .cloned().ok_or("Resumed Troubleshooter missing Task")?;
        return Ok(json!({"taskId":task_id,"resumed":true,
            "task":updated_task}));
    }
    if !is_effectively_blocked(task){
        return Err(format!("Task {task_id} is not an effective BLOCKED work task"));
    }
    let mut outcome=None;
    store.mutate_job(job_id,|current|{
        let head=current.get("headSha").and_then(Value::as_str);
        let (next,result)=unblock_task_snapshot(
            graph_directory,&current,task_id,"cli",reason,
            None,None,head,None)?;
        outcome=Some(result);
        Ok(next)
    })?;
    let refreshed=store.load_job(job_id)?
        .ok_or_else(||format!("Local authoritative Job {job_id} not found"))?;
    save_local(local_file,&refreshed)?;
    publish_task_unblocked(bus,&refreshed,task_id,reason);
    publish_wake(bus,&refreshed,task_id,
        &format!("Task {task_id} unblocked{}",
            if outcome.as_ref().and_then(|o|o["replanning"].as_bool())
                .unwrap_or(false){" for replanning"}else{""}));
    let mut output=json!({"taskId":task_id,
        "task":refreshed.get("tasks").and_then(Value::as_array)
            .and_then(|tasks|tasks.iter().find(|item|
                item.get("id")==task.get("id"))).cloned().unwrap_or(Value::Null)});
    if let Some(fields)=outcome.as_ref().and_then(Value::as_object){
        for (key,value) in fields {output[key]=value.clone();}
    }
    Ok(output)
}

/// Public Job unblock uses the same Task Graph effect for each effectively
/// blocked Troubleshooter, with one atomic authoritative SQLite mutation per
/// Task. Partial progress is durable exactly as in the Node loop.
pub fn run_job_unblock_command(
    graph_directory: &Path,args:&[String],store:&SQLiteRelayStore,
    job:&Value,bus:Option<&dyn ServiceEventBusPort>,
) -> Result<Value,String> {
    let request=job_unblock_request(args,job,is_effectively_blocked)?;
    let id=job.get("id").and_then(Value::as_str)
        .ok_or("Unblock Job is missing ID")?;
    let reason=request["reason"].as_str().unwrap_or("");
    let blocked=request["resumedTasks"].as_array()
        .ok_or("Unblock did not resolve blocked tasks")?;
    for task_id in blocked {
        let task_id=task_id.as_str().ok_or("Unblock Task ID is not a string")?;
        store.mutate_job(id,|current|{
            let head=current.get("headSha").and_then(Value::as_str);
            let (next,_)=unblock_task_snapshot(graph_directory,&current,
                task_id,"cli",reason,None,None,head,None)?;
            Ok(next)
        })?;
    }
    let refreshed=store.load_job(id)?
        .ok_or_else(||format!("Local authoritative Job {id} not found"))?;
    for task_id in blocked {
        if let Some(task_id)=task_id.as_str(){
            publish_task_unblocked(bus,&refreshed,task_id,reason);
        }
    }
    publish_wake(bus,&refreshed,"job",
        &format!("Troubleshooter work in Job {id} resumed"));
    Ok(json!({"jobId":id,"resumedTasks":blocked}))
}
