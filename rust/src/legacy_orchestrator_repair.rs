// Node provenance: src/legacy-orchestrator-repair.ts. Recover historical
// orchestrator executions only through canonical Rescue Graph and exact lease fence.
use crate::{
    events::event_for,
    workflow::orchestrator_rescue::{
        orchestrator_rescue_facts, prepare_orchestrator_repair,
    },
};
use serde_json::{json, Value};
use std::future::Future;
use std::path::Path;

pub async fn repair_legacy_orchestrators<Load, LFut, Reclaim, RFut, Persist, PFut, Emit, EFut>(
    graph_directory: &Path, job_id: &str, now_ms: i64,
    mut load: Load, mut reclaim: Reclaim,
    mut persist: Persist, mut emit: Emit,
)->Result<(),String>
where
    Load: FnMut() -> LFut,
    LFut: Future<Output=Result<Value,String>>,
    Reclaim: FnMut(Value) -> RFut,
    RFut: Future<Output=Result<bool,String>>,
    // Persists a mutated Task only if the latest Job still has its exact
    // execution ID, lease owner and expiry; else returns false.
    Persist: FnMut(String,Value,Value) -> PFut,
    PFut: Future<Output=Result<bool,String>>,
    Emit: FnMut(Value) -> EFut,
    EFut: Future<Output=Result<(),String>>,
{
    let initial=load().await?;
    let tasks=initial.get("tasks").and_then(Value::as_array)
        .ok_or("Job is missing tasks array")?.clone();
    for stale in tasks {
        let facts=orchestrator_rescue_facts(&stale,now_ms);
        if facts.get("legacyActive")!=Some(&Value::Bool(true))
            || !["verifiedExternalCompletion","unknownStartedOutcome","rescuable"]
                .iter().any(|name|facts.get(*name)==Some(&Value::Bool(true))) {continue;}
        if stale.get("executionId").is_some_and(|v|!v.is_null())
            && !reclaim(stale.clone()).await? {continue;}
        let Some(id)=stale.get("id").and_then(Value::as_str) else {continue;};
        let current=load().await?;
        let Some(current_task)=current.get("tasks").and_then(Value::as_array)
            .and_then(|ts|ts.iter().find(|t|t.get("id")==stale.get("id")))
            .cloned() else {continue;};
        let same_generation=["executionId","leaseOwner","leaseExpiresAt"]
            .iter().all(|key|current_task.get(*key)==stale.get(*key));
        if !same_generation {continue;}
        let mut repaired=current_task.clone();
        let outcome=prepare_orchestrator_repair(graph_directory,&mut repaired,now_ms)?;
        if outcome.get("repaired")!=Some(&Value::Bool(true)) {continue;}
        if !persist(id.to_string(),current_task,repaired.clone()).await? {continue;}
        let external=outcome.get("externallyCompleted")==Some(&Value::Bool(true));
        let failed=outcome.get("failed")==Some(&Value::Bool(true));
        let kind=if external {"task.external_completion_applied"}
            else if failed {"task.orchestrator_quarantined"}
            else {"task.orchestrator_rescued"};
        let status=if external {"succeeded"}else if failed {"failed"}else{"queued"};
        let message=if external {
            format!("Applied durable external completion for legacy orchestrator task {id}")
        }else if failed {
            format!("Failed legacy RUNNING orchestrator task {id}; worker outcome is unknown and Troubleshooter diagnosis is required")
        }else {
            format!("Recovered legacy orchestrator task {id} through Execution Router")
        };
        let mut data=json!({"ageMs":outcome.get("ageMs")});
        if !external && !failed {data["adapter"]=json!("execution-router");}
        emit(event_for(job_id,id,
            repaired.get("parentTaskId").and_then(Value::as_str),
            kind,status,&message,Some("orchestrator"),
            Some(data),Some(json!({"agent":"relay","component":"agents-relay"}))
        )).await?;
    }
    Ok(())
}
