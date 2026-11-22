//! Authenticated EventBus ingress for a human Review decision. The caller
//! must already own an explicit, trusted Events Bus subscription. An observed
//! approval is NEVER a Task terminal event: HostInvocation ledger and the
//! canonical Graph/SQLite transition authorize continuation.
use crate::{
    interactive_invocation::{
        normalize_interactive_decision,HostInteractiveInvocationCoordinator,
    },
    interactive_invocation_ports::host_invocation_ports,
    interactive_resume::recover_interactive_decisions,
    relay_store::SQLiteRelayStore,
};
use serde_json::Value;
use std::path::Path;

fn field<'a>(value:&'a Value,key:&str)->&'a str{
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

/// On acceptance, return the durable post-resume Job and accepted receipt.
/// Stale, unrelated, or already-processed events do not change Task state.
/// Exact Job/Task/execution, source, invocation, and revision are checked by
/// the shared HostInvocation Graph + SQLite ledger, not by the UI or sender.
pub fn apply_durable_host_review_event(
    db_path:&Path,graph_dir:&Path,job_id:&str,event:&Value,
)->Result<Option<(Value,Value)>,String>{
    if field(event,"type")!="task.interactive_decision"
        ||field(event,"job_id")!=job_id{
        return Ok(None);
    }
    let Some(delivery)=normalize_interactive_decision(event)else{return Ok(None)};
    if field(&delivery,"jobId")!=job_id{return Ok(None);}
    let mut store=SQLiteRelayStore::open_without_claim_reset(db_path,Some(job_id))?;
    let job=store.load_job(job_id)?.ok_or("Review Job missing from SQLite")?;
    let task=job.get("tasks").and_then(Value::as_array)
        .into_iter().flatten().find(|t|field(t,"id")==field(&delivery,"taskId"));
    let Some(task)=task else{return Ok(None)};
    let invocation=task.get("interactiveInvocation").unwrap_or(&Value::Null);
    if field(&job,"state")!="ACTIVE"||field(task,"state")!="AWAITING_DECISION"
        ||field(invocation,"executionId")!=field(&delivery,"executionId")
        ||field(invocation,"invocationId")!=field(&delivery,"invocationId")
        ||field(invocation,"revision")!=field(&delivery,"revision"){
        return Ok(None);
    }
    let mut accepted_event=None;
    let receipt={
        let mut coordinator=HostInteractiveInvocationCoordinator::default();
        let mut ports=host_invocation_ports(&mut store);
        coordinator.apply_event(&mut ports,graph_dir,event,
            |_,_|Ok(()),|accepted|{
                accepted_event=Some(accepted.clone());
                Ok(())
            })?
    };
    let outcome=field(&receipt,"outcome");
    if outcome!="accepted"&&outcome!="duplicate"{return Ok(None);}
    // A crash after the immutable HostInvocation ledger commit must be
    // recoverable without replaying approval. This Graph/CAS path is safe
    // to repeat for an already-decided invocation.
    let resumed=recover_interactive_decisions(graph_dir,&store,job_id)?;
    if !resumed{return Ok(None);}
    let current=store.load_job(job_id)?.ok_or("Review Job vanished after commit")?;
    Ok(Some((current,accepted_event.unwrap_or(Value::Null))))
}
