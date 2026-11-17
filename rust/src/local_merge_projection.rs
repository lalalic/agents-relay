// Node provenance: src/local-merge-projection.ts. Post-COMPLETED
// optional delivery of a verified local main SHA. Never force-push, never
// publish from a migrated historical Job without an explicit delivery marker.
//
// NOTE: all Git effects are dormant in Phase1. Phase2 must run isolated
// differential fixtures before any production wiring is permitted.
use crate::{
    events::random_uuid,
    local_merge_lock::iso8601_now,
    workflow::projection_conflict_v2::decide_projection_delivery,
};
use chrono::{DateTime,SecondsFormat,Utc};
use regex::Regex;
use serde_json::{json,Value};
use std::{
    collections::HashMap,
    path::Path,
    time::Duration,
};

pub const MAX_ATTEMPTS:u64=5;
pub const LEASE_MS:i64=120_000;
fn field<'a>(v:&'a Value,key:&str)->&'a str{
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn millis(value:&str)->Option<i64>{
    DateTime::parse_from_rfc3339(value).ok().map(|t|t.timestamp_millis())
}
fn iso_at(value:i64)->Result<String,String>{
    DateTime::<Utc>::from_timestamp_millis(value)
        .map(|t|t.to_rfc3339_opts(SecondsFormat::Millis,true))
        .ok_or("Invalid remote delivery timestamp".into())
}
fn now_ms()->i64 {Utc::now().timestamp_millis()}
fn git(repo:&Path,args:&[&str])->Result<String,String>{
    let mut owned=crate::owned_process::OwnedProcessManager::default();
    let mut argv=vec!["-C".to_string(),repo.to_string_lossy().into_owned()];
    argv.extend(args.iter().map(|a|(*a).to_string()));
    let command:Vec<&str>=argv.iter().map(String::as_str).collect();
    let mut env:HashMap<String,String>=std::env::vars().collect();
    env.insert("GIT_TERMINAL_PROMPT".into(),"0".into());
    let result=crate::continuation::run_delivery_owned_process(
        &mut owned,"git",&command,None,"remote.delivery.git",
        crate::continuation::DeliveryProcessOptions{
            timeout:Some(Duration::from_millis(LEASE_MS as u64)),
            cancelled:None,supervisor_path:None,environment:Some(&env),
        }
    )?;
    if result.code!=0 {
        let redact=Regex::new(r"(https?://)[^/@\s]+@")
            .expect("static git secret redaction");
        let message=if result.stderr.trim().is_empty(){
            format!("git exited {}",result.code)
        }else{
            result.stderr.trim().to_owned()
        };
        return Err(redact.replace_all(&message,"$1[redacted]@").into_owned());
    }
    Ok(result.stdout.trim().to_owned())
}
fn check_repository_root(path:&Path,repository:&str)->Result<(),String>{
    let canonical=std::fs::canonicalize(path).map_err(|e|e.to_string())?;
    if !canonical.is_dir(){
        return Err("Local projectRoot must be a directory".into());
    }
    if canonical.file_name().and_then(|s|s.to_str())!=Some(repository){
        return Err("Local projectRoot repository identity mismatch".into());
    }
    // A linked worktree uses a .git file; reject it as a canonical project root.
    if !canonical.join(".git").is_dir(){
        return Err("Local projectRoot must be an independent Git repository root".into());
    }
    let actual=git(&canonical,&["rev-parse","--show-toplevel"])?;
    let resolved=std::fs::canonicalize(actual).map_err(|e|e.to_string())?;
    if resolved!=canonical{
        return Err("Local projectRoot is not the top-level Git directory".into());
    }
    Ok(())
}
#[derive(Clone,Debug)]
pub struct RemoteInspection{
    pub remote_main_present:bool,
    pub remote_contains_main:bool,
    pub inspected_main_sha:String,
}
/// Git FF-only verification. Inspected immutable SHA must still be the
/// actual local main immediately before requesting a non-force push.
pub fn inspect_remote_main(
    repo:&Path,merged_sha:&str
)->Result<RemoteInspection,String>{
    let expected=git(repo,&["rev-parse","--verify",merged_sha])?;
    if expected!=merged_sha {
        return Err("Completed Job merged commit no longer resolves".into());
    }
    let main=git(repo,&["rev-parse","--verify","refs/heads/main"])?;
    if git(repo,&["merge-base","--is-ancestor",merged_sha,&main]).is_err(){
        return Err("Local main no longer contains completed Job merged commit".into());
    }
    let remote=git(repo,&["ls-remote","--heads","origin","refs/heads/main"])?;
    let head=remote.split_ascii_whitespace().next().unwrap_or("");
    if head.is_empty(){
        return Ok(RemoteInspection{
            remote_main_present:false,remote_contains_main:false,
            inspected_main_sha:main,
        });
    }
    git(repo,&["fetch","--no-tags","origin",
        "+refs/heads/main:refs/remotes/origin/main"])?;
    if git(repo,&["merge-base","--is-ancestor",
        &main,"refs/remotes/origin/main"]).is_ok(){
        return Ok(RemoteInspection{
            remote_main_present:true,remote_contains_main:true,
            inspected_main_sha:main,
        });
    }
    if git(repo,&["merge-base","--is-ancestor",
        "refs/remotes/origin/main",&main]).is_ok(){
        return Ok(RemoteInspection{
            remote_main_present:true,remote_contains_main:false,
            inspected_main_sha:main,
        });
    }
    Err(format!("origin/main diverged from local main ({head}); refusing non-fast-forward push"))
}
fn delivery_eligible(job:&Value,now:i64)->bool{
    let delivery=&job["remoteDelivery"];
    let sha=job.pointer("/localMerge/mergedCommitSha").and_then(Value::as_str);
    if field(job,"state")!="COMPLETED"
        || job.pointer("/localMerge/status").and_then(Value::as_str)!=Some("succeeded")
        || sha.is_none_or(|s|s.is_empty())
        || job.pointer("/localMerge/targetRef").and_then(Value::as_str)!=Some("refs/heads/main")
        || delivery.get("mergedCommitSha").and_then(Value::as_str)!=sha {
        return false;
    }
    if matches!(field(delivery,"status"),"skipped"|"succeeded"|"exhausted"){
        return false;
    }
    if field(delivery,"status")=="processing"
        && delivery.get("leaseUntil").and_then(Value::as_str)
            .and_then(millis).is_some_and(|until|until>now){
        return false;
    }
    true
}
fn try_claim(job:&mut Value,sha:&str,token:&str,now:i64)->Result<bool,String>{
    if field(job,"state")!="COMPLETED"
        || job.pointer("/localMerge/mergedCommitSha").and_then(Value::as_str)!=Some(sha)
        || job.pointer("/remoteDelivery/mergedCommitSha").and_then(Value::as_str)!=Some(sha){
        return Ok(false);
    }
    let delivery=&job["remoteDelivery"];
    let status=field(delivery,"status");
    if !matches!(status,"pending"|"failed"|"processing") ||
        delivery.get("attempts").and_then(Value::as_u64).unwrap_or(0)>=MAX_ATTEMPTS {
        return Ok(false);
    }
    if status=="processing" && delivery.get("leaseUntil")
        .and_then(Value::as_str).and_then(millis).is_some_and(|until|until>now){
        return Ok(false);
    }
    if status=="failed" && delivery.get("nextRetryAt")
        .and_then(Value::as_str).and_then(millis).is_some_and(|at|at>now){
        return Ok(false);
    }
    let attempts=delivery.get("attempts").and_then(Value::as_u64)
        .unwrap_or(0).saturating_add(1);
    job["remoteDelivery"]["status"]=json!("processing");
    job["remoteDelivery"]["attempts"]=json!(attempts);
    job["remoteDelivery"]["leaseToken"]=json!(token);
    job["remoteDelivery"]["leaseUntil"]=json!(iso_at(now+LEASE_MS)?);
    job["remoteDelivery"]["updatedAt"]=json!(iso_at(now)?);
    Ok(true)
}
fn update_owned(
    job:&mut Value,sha:&str,token:&str,status:&str,
    error:Option<&str>,delay_ms:Option<i64>,now:i64,
)->Result<bool,String>{
    if field(job,"state")!="COMPLETED"
        || job.pointer("/localMerge/mergedCommitSha").and_then(Value::as_str)!=Some(sha)
        || job.pointer("/remoteDelivery/mergedCommitSha").and_then(Value::as_str)!=Some(sha)
        || job.pointer("/remoteDelivery/leaseToken").and_then(Value::as_str)!=Some(token){
        return Ok(false);
    }
    let delivery=&mut job["remoteDelivery"];
    delivery["status"]=json!(status);
    delivery["updatedAt"]=json!(iso_at(now)?);
    if let Some(error)=error{delivery["error"]=json!(error);}
    else if let Some(obj)=delivery.as_object_mut(){obj.remove("error");}
    for key in ["leaseUntil","leaseToken","nextRetryAt"] {
        if let Some(obj)=delivery.as_object_mut(){obj.remove(key);}
    }
    if let Some(delay)=delay_ms {
        delivery["nextRetryAt"]=json!(iso_at(now.saturating_add(delay))?);
    }
    Ok(true)
}
/// Return only Graph-selected actions, never a homegrown retry policy.
fn selected_action(decision:&Value)->Result<&str,String>{
    if decision.get("accepted")!=Some(&Value::Bool(true)){
        return Err("Remote delivery Graph did not accept transition".into());
    }
    let actions=decision.get("actions").and_then(Value::as_array)
        .ok_or("Remote delivery Graph produced no actions")?;
    if actions.len()!=1{
        return Err("Remote delivery Graph must select exactly one action".into());
    }
    actions[0].get("id").and_then(Value::as_str)
        .ok_or("Remote delivery Graph action missing ID".into())
}


fn persist_owned<M>(job_id:&str,sha:&str,token:&str,
    status:&str,error:Option<&str>,delay:Option<i64>,mutate:&mut M,
)->Result<(),String>
where M:FnMut(&str,&dyn Fn(&mut Value)->Result<bool,String>)->Result<(Value,bool),String>{
    let now=now_ms();
    mutate(job_id,&|current:&mut Value|{
        update_owned(current,sha,token,status,error,delay,now)
    }).map(|_|())
}
fn record_failure<M>(directory:&Path,job_id:&str,sha:&str,token:&str,
    attempts:u64,from:&str,error:String,mutate:&mut M,
)->Result<(),String>
where M:FnMut(&str,&dyn Fn(&mut Value)->Result<bool,String>)->Result<(Value,bool),String>{
    let decision=decide_projection_delivery(directory,from,"delivery.failed",
        &json!({"attempts":attempts,"maxAttempts":MAX_ATTEMPTS}))?;
    let action=selected_action(&decision)?;
    let exhausted=action=="delivery.recordExhausted";
    if !exhausted && action!="delivery.scheduleRetry"{
        return Err(format!("Unexpected delivery action {action}"));
    }
    let delay=(1000i64.saturating_mul(1i64<<attempts.min(8))).min(300_000);
    persist_owned(job_id,sha,token,if exhausted{"exhausted"}else{"failed"},
        Some(&error),if exhausted{None}else{Some(delay)},mutate)
}
/// For an authoritative SQLite Store, `read` and `mutate` are the only
/// persistence ports. mutate must apply its update as BEGIN IMMEDIATE CAS,
/// not a stale whole-Job save. No push runs without a successful claim token.
pub fn reconcile_completed_local_delivery<Read,Mutate>(
    directory:&Path,job_id:&str,repo_path:&Path,
    mut read:Read,mut mutate:Mutate,
)->Result<(),String>
where
    Read:FnMut(&str)->Result<Value,String>,
    Mutate:FnMut(&str,&dyn Fn(&mut Value)->Result<bool,String>)
        ->Result<(Value,bool),String>,
{
    let snapshot=read(job_id)?;
    let now=now_ms();
    if !delivery_eligible(&snapshot,now) {return Ok(());}
    let sha=field(&snapshot["localMerge"],"mergedCommitSha").to_owned();
    let initial=&snapshot["remoteDelivery"];
    let status=field(initial,"status");
    let stage=if status=="pending"{"classify"}else{"waiting"};
    let event=if stage=="classify"{"job.completed"}else{"delivery.retry_due"};
    let retry_due=status=="processing"
        || initial.get("nextRetryAt").and_then(Value::as_str)
            .and_then(millis).is_none_or(|at|at<=now);
    let attempts=initial.get("attempts").and_then(Value::as_u64).unwrap_or(0);
    let opening=decide_projection_delivery(directory,stage,event,
        &json!({"retryDue":retry_due,"claimAvailable":attempts<MAX_ATTEMPTS}))?;
    let opening_action=selected_action(&opening)?;
    if opening_action=="delivery.recordExhausted" {
        let _=mutate(job_id,&|current:&mut Value|{
            if !delivery_eligible(current,now)
                || current.pointer("/remoteDelivery/attempts")
                    .and_then(Value::as_u64).unwrap_or(0)<MAX_ATTEMPTS{
                return Ok(false);
            }
            current["remoteDelivery"]["status"]=json!("exhausted");
            for key in ["leaseUntil","leaseToken","nextRetryAt"] {
                if let Some(obj)=current["remoteDelivery"].as_object_mut(){
                    obj.remove(key);
                }
            }
            current["remoteDelivery"]["updatedAt"]=json!(iso_at(now)?);
            Ok(true)
        })?;
        return Ok(());
    }
    if opening_action!="delivery.claimInspection"{
        return Err(format!("Unexpected delivery action before inspection: {opening_action}"));
    }
    let token=random_uuid();
    let (_,claimed)=mutate(job_id,&|current:&mut Value|{
        try_claim(current,&sha,&token,now)
    })?;
    if !claimed{return Ok(());}
    let claimed=read(job_id)?;
    let attempts=claimed.pointer("/remoteDelivery/attempts")
        .and_then(Value::as_u64).unwrap_or(0);
    let inspection=(||->Result<(bool,bool,bool,String),String>{
        check_repository_root(repo_path,field(&claimed,"repository"))?;
        let origin_usable=git(repo_path,&["remote"])?
            .lines().any(|r|r=="origin");
        if !origin_usable {
            return Ok((false,false,false,String::new()));
        }
        let fetch=git(repo_path,&["remote","get-url","origin"])?;
        let push=git(repo_path,&["remote","get-url","--push","--all","origin"])?;
        if fetch!=push{
            return Err("Origin push URL differs from verified fetch URL".into());
        }
        let inspected=inspect_remote_main(repo_path,&sha)?;
        Ok((true,inspected.remote_main_present,
            inspected.remote_contains_main,inspected.inspected_main_sha))
    })();
    let (origin_usable,remote_present,remote_contains,inspected_sha)=match inspection {
        Ok(value)=>value,
        Err(error)=>{record_failure(directory,job_id,&sha,&token,attempts,"inspect",error,&mut mutate)?;return Ok(());}
    };
    let decided=decide_projection_delivery(directory,"inspect","inspect.completed",
        &json!({"originUsable":origin_usable,
            "remoteMainPresent":remote_present,
            "remoteContainsMain":remote_contains}))?;
    match selected_action(&decided)? {
        "delivery.skip"=>{persist_owned(job_id,&sha,&token,"skipped",None,None,&mut mutate)?;return Ok(());},
        "delivery.recordDelivered"=>{persist_owned(job_id,&sha,&token,"succeeded",None,None,&mut mutate)?;return Ok(());},
        "delivery.pushMain"=>{},
        other=>return Err(format!("Unexpected delivery action {other}")),
    }
    if inspected_sha.is_empty(){
        return Err("Remote delivery cannot push without a verified local main SHA".into());
    }
    // A normal refspec with no '+' forbids force update. Remote-side
    // races reject safely and are recorded by the same Graph failure path.
    let push_spec=format!("{inspected_sha}:refs/heads/main");
    if let Err(error)=git(repo_path,&["push","origin",&push_spec]){
        record_failure(directory,job_id,&sha,&token,attempts,"push",error,&mut mutate)?;
        return Ok(());
    }
    let finished=decide_projection_delivery(directory,"push","delivery.pushed",&json!({}))?;
    if selected_action(&finished)?!="delivery.recordDelivered"{
        return Err("Delivery push had no graph transition".into());
    }
    persist_owned(job_id,&sha,&token,"succeeded",None,None,&mut mutate)?;
    Ok(())
}
