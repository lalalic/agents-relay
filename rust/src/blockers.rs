// Node provenance: src/blockers.ts. Cross-Job Blocker dependency
// registrations and Graph-selected dependent release. Live SQLite remains
// the sole Job/Task authority; this module computes candidate mutations.
use crate::{
    local_merge_lock::iso8601_now,
    task_actions::apply_task_release_action,
    unblock::is_effectively_blocked,
    workflow::{
        blocker_resolution_v2::decide_blocker_resolution,
        task_resolution::{
            dispatch_task_resolution_sync, materialize_resolution,
        },
    },
};
use serde_json::{json, Value};
use std::path::Path;
fn field<'a>(v:&'a Value,key:&str)->&'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn jobs_tasks(job:&Value)->&[Value] {
    job.get("tasks").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}
fn dependent_key(v:&Value)->String {
    format!("{}#{}:{}:{}:a{}",
        field(v,"repository"),
        v.get("prNumber").map(Value::to_string).unwrap_or_else(||"undefined".into()),
        field(v,"jobId"),field(v,"taskId"),
        v.get("blockedAttempt").map(Value::to_string).unwrap_or_else(||"undefined".into()))
}
fn same_blocker(left:&Value,right:&Value)->bool {
    left.get("repository")==right.get("repository")
        && left.get("prNumber")==right.get("prNumber")
        && left.get("jobId")==right.get("jobId")
}
#[derive(Clone,Debug)]
pub struct BlockerRegistration {
    pub blocker:Value,
    pub dependent:Value,
    pub relation:Value,
    pub existing:bool,
}
pub fn register_blocker_dependency(
    graph_dir:&Path,blocker:&Value,dependent:&Value,dependent_task_id:&str,
    expected_attempt:Option<i64>,resolution_mode:Option<&str>,now:Option<&str>,
)->Result<BlockerRegistration,String>{
    let mut blocking=blocker.clone();
    let mut waiting=dependent.clone();
    let now=now.map(str::to_owned).unwrap_or_else(iso8601_now);
    let blocker_id=field(&blocking,"id").to_string();
    let repository=field(&blocking,"repository").to_string();
    let pr=blocking.get("prNumber").cloned().unwrap_or(json!(0));
    let dependent_id=field(&waiting,"id").to_string();
    let dependent_repo=field(&waiting,"repository").to_string();
    let dependent_pr=waiting.get("prNumber").cloned().unwrap_or(json!(0));
    let task=jobs_tasks(&waiting).iter().find(|t|field(t,"id")==dependent_task_id)
        .cloned().ok_or_else(||format!("Dependent task {dependent_task_id} not found"))?;
    if !field(&task,"jobId").is_empty() && field(&task,"jobId")!=dependent_id {
        return Err(format!("Dependent task {dependent_task_id} is bound to another Job"));
    }
    let attempt=task.get("attempt").and_then(Value::as_i64).unwrap_or(0);
    if expected_attempt.is_some_and(|prior|prior!=attempt){
        return Err(format!("Dependent task {dependent_task_id} advanced from expected attempt {} to {attempt}",
            expected_attempt.unwrap_or_default()));
    }
    if !matches!(field(&task,"state"),"DRAFT"|"FAILED"|"BLOCKED"){
        return Err(format!("Dependent task {dependent_task_id} is not waiting/blocked/failed ({})",
            field(&task,"state")));
    }
    let requested_mode=resolution_mode
        .or_else(||blocker.get("blockerResolutionMode").and_then(Value::as_str))
        .unwrap_or("merge");
    let proposal=json!({"path":"blocker_job_dependency",
        "targetTaskId":dependent_task_id,"targetJobId":blocker_id,
        "mode":requested_mode});
    let mut selected=false;
    let decision=dispatch_task_resolution_sync(graph_dir,&task,
        &proposal,&json!("blocker-job"),|action|{
            if action!="resolution.registerBlockerDependency"{
                return Err(format!("Unsupported Task resolution action {action}"));
            }
            selected=true;Ok(())
        })?;
    if decision.get("accepted")!=Some(&Value::Bool(true))||!selected{
        return Err(format!("Task resolution graph rejected blocker dependency for {dependent_task_id}"));
    }
    let mut relation=json!({"repository":dependent_repo,"prNumber":dependent_pr,
        "jobId":dependent_id,"taskId":dependent_task_id,
        "blockedAttempt":attempt,"registeredAt":now,"state":"waiting"});
    let prior=blocking.get("unblocks").and_then(Value::as_array).into_iter().flatten()
        .find(|existing|dependent_key(existing)==dependent_key(&relation)).cloned();
    let original_at=prior.as_ref().and_then(|p|p.get("registeredAt"))
        .cloned().unwrap_or(json!(now));
    let blocked_by=json!({"repository":repository,"prNumber":pr,
        "jobId":blocker_id,"blockedAttempt":attempt,
        "registeredAt":original_at});
    let index=waiting.get("tasks").and_then(Value::as_array)
        .and_then(|tasks|tasks.iter().position(|t|field(t,"id")==dependent_task_id))
        .ok_or("Dependent task missing")?;
    let dependent_task=&mut waiting["tasks"][index];
    let mut resolution=materialize_resolution(&proposal,&json!("blocker-job"),&now);
    resolution["state"]=json!("waiting");
    dependent_task["resolution"]=resolution;
    let needs_blocker=dependent_task.get("blockedBy")
        .is_none_or(|v|v.is_null() || !same_blocker(v,&blocked_by)
            || v.get("blockedAttempt")!=Some(&json!(attempt)));
    if needs_blocker {
        dependent_task["blockedBy"]=blocked_by;
        dependent_task["updatedAt"]=json!(now);
    }
    if let Some(existing)=prior{
        return Ok(BlockerRegistration{blocker:blocking,
            dependent:waiting,relation:existing,existing:true});
    }
    if !field(&blocking,"blockerResolutionMode").is_empty()
        && field(&blocking,"blockerResolutionMode")!=requested_mode {
        return Err(format!("Blocker {blocker_id} already uses {} resolution",
            field(&blocking,"blockerResolutionMode")));
    }
    blocking["blockerResolutionMode"]=json!(requested_mode);
    if let Some(unblocks)=blocking.get_mut("unblocks").and_then(Value::as_array_mut){
        unblocks.push(relation.clone());
    }else{blocking["unblocks"]=json!([relation.clone()]);}
    blocking["updatedAt"]=json!(now);
    Ok(BlockerRegistration{blocker:blocking,dependent:waiting,relation,existing:false})
}
fn obsolete_reason(task:Option<&Value>,relation:&Value)->String {
    let Some(task)=task else{return "dependent task no longer exists".into();};
    if !matches!(field(task,"state"),"DRAFT"|"FAILED"|"BLOCKED"){
        return format!("dependent task advanced to {}",field(task,"state"));
    }
    if task.get("attempt")!=relation.get("blockedAttempt"){
        return format!("dependent task advanced from attempt {} to {}",
            relation.get("blockedAttempt").map(Value::to_string).unwrap_or_default(),
            task.get("attempt").map(Value::to_string).unwrap_or_default());
    }
    "dependent task no longer matches blocker registration".into()
}
#[derive(Clone,Debug)]
pub struct BlockerResolutionSummary {
    pub blocker:Value,
    pub resumed:usize,
    pub obsolete:usize,
    pub waiting:usize,
    pub unblocked:Vec<Value>,
    pub updated_dependents:Vec<(String,Value)>,
}
/// Deterministic Graph-selected resolution across dependent snapshots.
pub fn resolve_blocker_dependencies<Load>(
    directory:&Path,blocker:&Value,resolution:&str,
    mut load:Load,now:Option<&str>,
)->Result<BlockerResolutionSummary,String>
where Load:FnMut(&Value)->Result<Value,String>,
{
    let mut next_blocker=blocker.clone();
    let mode=blocker.get("blockerResolutionMode")
        .and_then(Value::as_str).unwrap_or("merge");
    let now=now.map(str::to_owned).unwrap_or_else(iso8601_now);
    let mut relations=blocker.get("unblocks").and_then(Value::as_array)
        .cloned().unwrap_or_default();
    let mut resumed=0;let mut obsolete=0;
    let mut unblocked=Vec::new();
    let mut updated_dependents=Vec::new();
    for relation in &mut relations {
        if field(relation,"state")!="waiting"{continue;}
        let mut load_error=None;
        let mut dependent=match load(relation) {
            Ok(job)=>Some(job),
            Err(error)=>{load_error=Some(error);None}
        };
        let task=dependent.as_ref().and_then(|job|
            jobs_tasks(job).iter().find(|task|
                task.get("id")==relation.get("taskId"))).cloned();
        let state=task.as_ref().map(|task|field(task,"state")).unwrap_or("").to_string();
        let matches=task.as_ref().is_some_and(|task|
            matches!(state.as_str(),"DRAFT"|"FAILED"|"BLOCKED"|"QUEUED")
                && task.get("attempt")==relation.get("blockedAttempt"));
        let already=task.as_ref().is_some_and(|task|
            task.get("unblock").is_some_and(|v|!v.is_null())
                && matches!(state.as_str(),"DRAFT"|"QUEUED"));
        let blocked=task.as_ref().is_some_and(is_effectively_blocked);
        let facts=json!({
            "resolutionConditionMet":field(blocker,"state")=="COMPLETED"
                && (if mode=="verified"{resolution=="verified"}else{resolution=="merge"}),
            "targetMatches":matches,
            "effectivelyBlocked":blocked,
            "alreadyUnblocked":already,
            "isDraft":state=="DRAFT","isBlocked":blocked,
            "isFailed":state=="FAILED","isUnblocked":already
        });
        let decision=decide_blocker_resolution(directory,&facts)?;
        if decision.get("accepted")!=Some(&Value::Bool(true))
            || field(&decision,"target")=="wait"{continue;}
        if field(&decision,"target")=="obsolete"{
            relation["state"]=json!("obsolete");
            relation["resolvedAt"]=json!(now);
            relation["resolution"]=json!(resolution);
            relation["note"]=json!(load_error.unwrap_or_else(||
                obsolete_reason(task.as_ref(),relation)));
            obsolete+=1;
            continue;
        }
        if field(&decision,"target")!="resumed"{
            return Err(format!("Blocker graph produced unsupported target {}",
                field(&decision,"target")));
        }
        if decision.get("actions").and_then(Value::as_array).is_some_and(|actions|
            actions.iter().any(|action|field(action,"id")=="blocker.releaseDraft")){
            let job=dependent.as_mut().ok_or("Blocker graph requested action without matching dependent")?;
            let task_id=field(relation,"taskId");
            let index=jobs_tasks(job).iter().position(|task|field(task,"id")==task_id)
                .ok_or("Blocker graph requested action without matching dependent task")?;
            let task=&mut job["tasks"][index];
            apply_task_release_action(directory,task,&now)?;
            task["error"]=Value::Null;
            task["updatedAt"]=json!(now);
            if let Some(map)=task.as_object_mut(){map.remove("blockedBy");}
            updated_dependents.push((field(relation,"jobId").to_string(),job.clone()));
        }
        relation["state"]=json!("resumed");
        relation["resolvedAt"]=json!(now);
        relation["resolution"]=json!(resolution);
        relation["note"]=json!("dependent task released from dependency wait");
        unblocked.push(json!({"repository":relation.get("repository"),
            "prNumber":relation.get("prNumber"),"jobId":relation.get("jobId"),
            "taskId":relation.get("taskId")}));
        if !already {resumed+=1;}
    }
    let waiting=relations.iter().filter(|relation|field(relation,"state")=="waiting")
        .count();
    if waiting!=relations.len(){
        if waiting>0{
            next_blocker["unblocks"]=json!(relations.iter()
                .filter(|r|field(r,"state")=="waiting").cloned().collect::<Vec<_>>());
        }else if let Some(map)=next_blocker.as_object_mut(){map.remove("unblocks");}
        next_blocker["blockerResolvedAt"]=json!(now);
        next_blocker["updatedAt"]=json!(now);
    }
    Ok(BlockerResolutionSummary{
        blocker:next_blocker,resumed,obsolete,waiting,unblocked,updated_dependents
    })
}
