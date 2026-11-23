//! Execution-correlated model Worker event ingestion. This is a reusable
//! internal EventBus/daemon port, NOT a public unauthenticated HTTP endpoint.
//! Remote providers must still have an authenticated transport and verified
//! sender before calling it. SQLite+Graph remain the sole Task-state owner.
use crate::{
    execution_event_identity::execution_event_source,
    reconciler_runtime::ReconcilerRuntime,
    relay_store::SQLiteRelayStore,
};
use regex::Regex;
use serde_json::{json,Value};
use std::path::Path;
fn field<'a>(value:&'a Value,name:&str)->&'a str{
    value.get(name).and_then(Value::as_str).unwrap_or("")
}
/// Persist a Task event only for an already-leased, exact current execution.
/// All event types use the canonical Graph transition logic, not direct Task
/// status updates. A completion receipt cannot override missing Git delivery
/// or a Review gate. A subprocess exit/HTTP submission is not an event.
pub fn apply_verified_worker_event(
    db_path:&Path,graph:&Path,
    job_id:&str,task_id:&str,execution_id:&str,event:&Value,
)->Result<Value,String>{
    if !matches!(field(event,"type"),
        "task.started"|"task.progress"|"task.completed"|"task.failed"){
        return Err("Model Worker event type not supported".into());
    }
    let event_id=field(event,"event_id");
    if !Regex::new(r"^[A-Za-z0-9_-]{8,100}$")
        .expect("fixed durable event ID pattern").is_match(event_id){
        return Err("Model Worker event requires a bounded unique identity".into());
    }
    if job_id.is_empty()||task_id.is_empty()||execution_id.is_empty()
        ||field(event,"job_id")!=job_id||field(event,"task_id")!=task_id{
        return Err("Model Worker event does not match the assigned Job/Task".into());
    }
    let expected=execution_event_source(job_id,task_id,execution_id);
    if event.pointer("/source/id").and_then(Value::as_str)!=Some(expected.as_str()){
        return Err("Model Worker event is missing the exact issued execution source".into());
    }
    let store=SQLiteRelayStore::open_without_claim_reset(db_path,Some(job_id))?;
    let prior=store.load_job(job_id)?.ok_or("Worker Job is missing from SQLite")?;
    let current=prior.get("tasks").and_then(Value::as_array)
        .into_iter().flatten().find(|task|field(task,"id")==task_id)
        .ok_or("Worker Task is not registered")?;
    if !matches!(field(current,"adapter"),"codex"|"chatgpt"|"z"){
        return Err("Model Worker event cannot mutate another adapter".into());
    }
    // Model DAG workers must complete through the daemon-owned validated
    // `task complete` action. Direct EventBus completion cannot return
    // actionable validation errors or guarantee a pre-terminal repair loop.
    if field(event,"type")=="task.completed"
        &&current.get("dagNode").is_some_and(|v|!v.is_null()){
        return Err("DAG_COMPLETION_REQUIRES_TASK_COMPLETE: use agents-relay task complete; repair validation errors in the same execution".into());
    }
    if field(current,"executionId")!=execution_id
        ||(field(event,"type")=="task.started" && field(current,"state")!="QUEUED")
        ||(field(event,"type")!="task.started" && field(current,"state")!="RUNNING"){
        return Err("Model Worker generation lease is missing, stale or terminal".into());
    }
    let mut runtime=ReconcilerRuntime::new("native-worker-event-ingress");
    let applied=runtime.apply_event(graph,&prior,event,None)?;
    if !applied.applied{
        return Err(format!("Model Worker Graph denied {}: {}",
            field(event,"type"),applied.reason));
    }
    let candidate=applied.job;
    // The event_id (rather than its type) is unique: progress messages from
    // the same execution may have many genuine, independently fenced events.
    // The authoritative Worker already published this event to Events Bus.
    // Keep its identity in the transactional outbox as an idempotency receipt,
    // but never re-publish it back into that same transport.
    let durable=json!({
        "key":format!("model-event/{job_id}/{task_id}/{execution_id}/{event_id}"),
        "event":event,
        "alreadyPublished":true,
    });
    store.commit_workflow_mutation_and_events(job_id,move |current|{
        if current!=prior{
            return Err("Concurrent SQLite execution generation changed".into());
        }
        Ok(candidate)
    },&[durable])
}
