// Node provenance: src/local-merge-delivery.ts. A completed local Git
// merge is the Graph-selected durable effect. Publication is optional,
// separate and never inferred from historical COMPLETED Jobs.
use crate::{
    events::event_for,
    local_git_merge::{deliver_local_merge, local_merge_facts_bound},
    local_merge_lock::iso8601_now,
    task_transitions::transition_job_event,
    workflow::lifecycle::decide_job_lifecycle,
};
use chrono::{DateTime,SecondsFormat,Utc};
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use std::{future::Future,path::Path};
fn field<'a>(value:&'a Value,key:&str)->&'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
fn millis(input:&str)->Option<i64> {
    DateTime::parse_from_rfc3339(input).ok().map(|t|t.timestamp_millis())
}
fn iso_at(millis:i64)->Result<String,String>{
    DateTime::<Utc>::from_timestamp_millis(millis)
        .map(|t|t.to_rfc3339_opts(SecondsFormat::Millis,true))
        .ok_or("Invalid Git merge retry deadline".into())
}
fn record_pending_remote_delivery(job:&mut Value){
    if field(job,"state")!="COMPLETED" ||
        job.pointer("/localMerge/status").and_then(Value::as_str)!=Some("succeeded"){
        return;
    }
    let Some(sha)=job.pointer("/localMerge/mergedCommitSha")
        .and_then(Value::as_str).filter(|s|!s.is_empty()) else{return;};
    if job.pointer("/remoteDelivery/mergedCommitSha")
        .and_then(Value::as_str)==Some(sha){return;}
    job["remoteDelivery"]=json!({
        "mergedCommitSha":sha,"status":"pending","attempts":0,
        "updatedAt":iso8601_now()
    });
}
fn event_identity(job:&Value,receipt:&Value)->String{
    let id=format!("{}:{}:{}:{}:{}",
        field(job,"id"),
        field(receipt,"sourceSha"),
        receipt.get("attempts").and_then(Value::as_i64).unwrap_or(0),
        field(receipt,"status"),
        field(receipt,"mergedCommitSha"));
    format!("workflow-local-merge-{:x}",Sha256::digest(id.as_bytes()))
}
fn outcome_event(job:&Value,receipt:&Value)->Value{
    let succeeded=field(receipt,"status")=="succeeded";
    let message=if succeeded {
        "Local merge succeeded".to_owned()
    }else{
        receipt.get("error").and_then(Value::as_str)
            .unwrap_or("Local merge failed").to_string()
    };
    let reason=if message.contains("tracked or index changes"){
        "dirty_target_worktree"
    }else{"merge_delivery_failed"};
    let data=if succeeded{
        json!({"mergedCommitSha":receipt.get("mergedCommitSha"),
            "sourceSha":receipt.get("sourceSha")})
    }else {
        json!({"reason":reason,"message":receipt.get("error"),
            "attempts":receipt.get("attempts"),"retryable":true,
            "nextAttemptAt":receipt.get("nextAttemptAt")})
    };
    let job_id=field(job,"id");
    let attempts=receipt.get("attempts").and_then(Value::as_i64).unwrap_or(0);
    let mut event=event_for(job_id,"merge",None,
        if succeeded{"job.merge.succeeded"}else{"job.merge.failed"},
        if succeeded{"succeeded"}else{"failed"},
        &message,Some("user"),Some(data),
        Some(json!({"id":format!("job/{job_id}/task/merge/execution/attempt-{attempts}"),
            "agent":"relay"})));
    event["event_id"]=json!(event_identity(job,receipt));
    event
}
/// The actual Git merge is called only when the canonical Job Graph
/// explicitly selected effect.deliverLocalMerge. The SQLite writer must
/// fence source/target refs and append the event in the same transaction.
pub async fn reconcile_local_git_completion<Save,SaveFuture,Merge>(
    directory:&Path,final_state:&mut Value,head_sha:Option<&str>,
    no_github:bool,repo_path:Option<&Path>,now_ms:i64,
    mut save:Save,mut merge_effect:Merge,
)->Result<bool,String>
where
    Save:FnMut(Value,Option<Value>)->SaveFuture,
    SaveFuture:Future<Output=Result<Value,String>>,
    Merge:FnMut(&Path,&Value)->Result<Value,String>,
{
    let _ = no_github;
    let facts=local_merge_facts_bound(final_state,head_sha,now_ms);
    let decision=decide_job_lifecycle(directory,final_state,
        "local.completed",&facts)?;
    if field(&decision,"target")=="COMPLETED"{
        let timestamp=iso8601_now();
        transition_job_event(directory,final_state,"local.completed",&facts,&timestamp)?;
        record_pending_remote_delivery(final_state);
        *final_state=save(final_state.clone(),None).await?;
        return Ok(true);
    }
    let requested=decide_job_lifecycle(directory,final_state,
        "local.merge.requested",&facts)?;
    if !requested.get("actions").and_then(Value::as_array).is_some_and(|actions|
        actions.iter().any(|action|action=="effect.deliverLocalMerge")){
        return Ok(false);
    }
    let original=final_state.get("localMerge").filter(|value|!value.is_null())
        .cloned();
    let Some(original)=original else{return Ok(false);};
    let due=original.get("nextAttemptAt").and_then(Value::as_str)
        .and_then(millis).is_none_or(|time|time<=now_ms);
    if field(&original,"status")!="succeeded" && due{
        let mut receipt=original.clone();
        let original_ref=field(&original,"sourceRef").to_string();
        let target_ref=field(&original,"targetRef").to_string();
        let now=iso8601_now();
        let result=(||->Result<Value,String>{
            if head_sha.is_some_and(|head|field(&receipt,"sourceSha")!=head){
                receipt["sourceSha"]=json!(head_sha);
                receipt["status"]=json!("pending");
                final_state["localMerge"]=receipt.clone();
                final_state["updatedAt"]=json!(now);
            }
            let cwd=repo_path.ok_or("Local Git merge requires an explicit project path")?;
            let mut input=receipt.clone();
            if field(&input,"sourceSha").is_empty(){
                input["sourceSha"]=json!(head_sha);
            }
            input["correlationJobId"]=final_state.get("id").cloned().unwrap_or(Value::Null);
            if let Some(pr)=final_state.get("prNumber").and_then(Value::as_i64)
                .filter(|pr|*pr>0){input["displayPrNumber"]=json!(pr);}
            merge_effect(cwd,&input)
        })();
        match result{
            Ok(delivered)=>{
                if let Some(source)=delivered.get("sourceSha"){
                    receipt["sourceSha"]=source.clone();
                }
                if let Some(sha)=delivered.get("mergedCommitSha"){
                    receipt["mergedCommitSha"]=sha.clone();
                }
                receipt["status"]=json!("succeeded");
                receipt["projectionStrategy"]=json!("target_ref_push");
                if let Some(map)=receipt.as_object_mut(){
                    map.remove("error");map.remove("nextAttemptAt");
                }
                receipt["updatedAt"]=json!(now);
            },
            Err(error)=>{
                let attempts=receipt.get("attempts").and_then(Value::as_i64)
                    .unwrap_or(0).saturating_add(1);
                let delay=(1000i64.saturating_mul(1i64 << attempts.min(8)))
                    .min(300_000);
                receipt["status"]=json!("failed");
                receipt["attempts"]=json!(attempts);
                receipt["error"]=json!(error);
                receipt["nextAttemptAt"]=json!(iso_at(now_ms.saturating_add(delay))?);
                receipt["updatedAt"]=json!(now);
            }
        }
        // The caller must preserve concurrent Task and Review changes: only
        // the new localMerge receipt can replace the old one, with source/
        // target/status SQLite generation constraints.
        if field(&original,"sourceRef")!=original_ref ||
            field(&original,"targetRef")!=target_ref{
            return Err("stale local merge outcome".into());
        }
        final_state["localMerge"]=receipt.clone();
        final_state["updatedAt"]=json!(now);
        let event=outcome_event(final_state,&receipt);
        *final_state=save(final_state.clone(),Some(event)).await?;
    }
    if final_state.pointer("/localMerge/status")
        .and_then(Value::as_str)==Some("succeeded"){
        let completion_facts=local_merge_facts_bound(final_state,head_sha,now_ms);
        let timestamp=iso8601_now();
        transition_job_event(directory,final_state,"local.completed",
            &completion_facts,&timestamp)?;
        record_pending_remote_delivery(final_state);
        *final_state=save(final_state.clone(),None).await?;
        return Ok(true);
    }
    Ok(false)
}
/// Native default Git merge backend, never called by the Phase1 migration.
pub fn native_merge_effect(repo:&Path,receipt:&Value)->Result<Value,String>{
    let result=deliver_local_merge(repo,receipt)?;
    Ok(json!({"sourceSha":result.source_sha,
        "mergedCommitSha":result.merged_commit_sha}))
}
