// Node provenance: src/blocker-recovery.ts. Cross-repository blocker Job
// recovery is authorized only by the canonical Blocker Recovery Mermaid
// Graph. Every identity and dependent attempt is fenced by SQLite.
use crate::{
    blockers::register_blocker_dependency,
    job_task_id_sequence::allocate_entity_id,
    local_merge_lock::iso8601_now,
    workflow::{
        blocker_recovery::dispatch_blocker_recovery,
        entity_creation::create_job_entity,
    },
};
use regex::Regex;
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use std::{collections::HashSet,path::Path};

fn field<'a>(v:&'a Value,key:&str)->&'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn normalized_intent(input:&str)->String{
    Regex::new(r"\s+").expect("fixed whitespace")
        .replace_all(input.trim()," ").into_owned()
}
pub fn normalize_repository(value:&str)->Result<String,String>{
    let trimmed=value.trim();
    if !Regex::new(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")
        .expect("fixed repository regex").is_match(trimmed)
        ||trimmed.contains(".."){
        return Err(format!("Invalid repository identity: {value}"));
    }
    Ok(trimmed.into())
}
pub fn validate_input(input:&Value)->Result<(),String>{
    if input.get("projectPath").is_some(){
        return Err("Blocker recovery projectPath is removed; use targetProjectRoot".into());
    }
    let request_id=field(input,"requestId").trim();
    if !Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$")
        .expect("fixed request ID regex").is_match(request_id){
        return Err("Blocker recovery requestId must be 8-200 safe identity characters".into());
    }
    let title=field(input,"title").trim();
    if !(10..=200).contains(&title.encode_utf16().count()){
        return Err("Blocker recovery title must be 10-200 characters".into());
    }
    let reason=normalized_intent(field(input,"reason"));
    if !(20..=1000).contains(&reason.encode_utf16().count()){
        return Err("Blocker recovery reason must be 20-1000 characters".into());
    }
    let objective=normalized_intent(field(input,"objective"));
    if !(120..=20_000).contains(&objective.encode_utf16().count()){
        return Err("Blocker recovery objective must contain 120-20000 characters of standalone context".into());
    }
    let target=normalize_repository(field(input,"targetRepository"))?;
    let dependent=normalize_repository(field(input,"dependentRepository"))?;
    if !matches!(field(input,"origin"),"planner"|"troubleshooter"){
        return Err("Blocker recovery origin must be planner or troubleshooter".into());
    }
    if !matches!(field(input,"resolutionMode"),"merge"|"verified"){
        return Err("Blocker recovery resolutionMode must be merge or verified".into());
    }
    if !objective.contains(&target){
        return Err(format!("Blocker recovery objective must identify target repository {target}"));
    }
    let task=field(input,"dependentTaskId");
    if !objective.contains(task){
        return Err(format!("Blocker recovery objective must identify dependent Task {task}"));
    }
    if target==dependent{
        return Err("Blocker recovery requires a distinct target repository".into());
    }
    if field(input,"targetProjectRoot").is_empty(){
        return Err("Blocker recovery requires an explicit targetProjectRoot".into());
    }
    Ok(())
}
pub fn intent_fingerprint(input:&Value,blocked_attempt:u64)
    ->Result<String,String>{
    let stable=json!({
        "targetRepository":normalize_repository(field(input,"targetRepository"))?,
        "dependentRepository":normalize_repository(field(input,"dependentRepository"))?,
        "dependentJobId":input.get("dependentJobId"),
        "dependentTaskId":input.get("dependentTaskId"),
        "blockedAttempt":blocked_attempt,
        "reason":normalized_intent(field(input,"reason")),
        "title":normalized_intent(field(input,"title")),
        "objective":normalized_intent(field(input,"objective")),
        "resolutionMode":input.get("resolutionMode")
    });
    Ok(format!("{:x}",Sha256::digest(stable.to_string().as_bytes())))
}
pub fn make_request(input:&Value,blocked_attempt:u64,now:&str)
    ->Result<Value,String>{
    Ok(json!({
        "requestId":field(input,"requestId").trim(),
        "intentFingerprint":intent_fingerprint(input,blocked_attempt)?,
        "reason":normalized_intent(field(input,"reason")),
        "status":"created",
        "targetRepository":normalize_repository(field(input,"targetRepository"))?,
        "dependentRepository":normalize_repository(field(input,"dependentRepository"))?,
        "dependentJobId":input.get("dependentJobId"),
        "dependentTaskId":input.get("dependentTaskId"),
        "blockedAttempt":blocked_attempt,
        "title":field(input,"title").trim(),
        "objective":field(input,"objective").trim(),
        "resolutionMode":input.get("resolutionMode"),
        "origin":input.get("origin"),
        "authorized":input.get("authorized"),
        "createdAt":now,"updatedAt":now
    }))
}
fn planning_required(job:&Value)->bool{
    if matches!(field(job,"state"),"COMPLETED"|"CANCELLED"){return false;}
    let latest=job.get("plans").and_then(Value::as_array)
        .into_iter().flatten().max_by_key(|p|
            p.get("round").and_then(Value::as_i64).unwrap_or(0));
    field(job,"state")=="DRAFT"||latest.is_none_or(|p|field(p,"status")!="SUCCEEDED")
}
fn request_status(job:&Value,planning:bool)->&'static str{
    if planning{"planning_required"}
    else if job.get("plans").and_then(Value::as_array).into_iter().flatten()
        .any(|p|field(p,"status")=="SUCCEEDED"){"planned"}
    else{"registered"}
}
pub fn receipt(input:&Value,blocker_job_id:&str,outcome:&str,
    planning:bool,request:&Value,now:&str)->Value{
    json!({
        "requestId":input.get("requestId"),
        "reason":request.get("reason"),
        "status":if planning{"planning_required"}
            else if field(request,"status")=="planned"{"planned"}else{"registered"},
        "blockerJobId":blocker_job_id,
        "blockerRepository":request.get("targetRepository"),
        "dependentRepository":request.get("dependentRepository"),
        "dependentJobId":request.get("dependentJobId"),
        "dependentTaskId":request.get("dependentTaskId"),
        "resolutionMode":request.get("resolutionMode"),
        "outcome":outcome,"planningRecoveryRequired":planning,
        "createdAt":request.get("createdAt"),"updatedAt":now
    })
}
pub fn adoption_valid(candidate:&Value,request:&Value)->bool{
    if field(candidate,"state")=="CANCELLED"
        ||candidate.get("repository")!=request.get("targetRepository")
        ||(!field(candidate,"blockerResolutionMode").is_empty()
            &&candidate.get("blockerResolutionMode")!=request.get("resolutionMode")){
        return false;
    }
    let prior=candidate.get("blockerRecoveryRequest");
    prior.is_none_or(|v|v.is_null()||[
        "intentFingerprint","targetRepository","dependentRepository",
        "dependentJobId","dependentTaskId"
    ].iter().all(|key|v.get(*key)==request.get(*key)))
}
fn intent_candidate<'a>(
    jobs:&'a [Value],request:&Value,
)->Result<Option<&'a Value>,String>{
    let matching:Vec<&Value>=jobs.iter().filter(|job|
        job.pointer("/blockerRecoveryRequest/requestId")==request.get("requestId"))
        .collect();
    if matching.len()>1{
        return Err(format!("Ambiguous blocker recovery requestId {}",
            field(request,"requestId")));
    }
    if let Some(found)=matching.first(){
        let bound=found.get("blockerRecoveryRequest")
            .ok_or("Missing stored blocker request")?;
        for key in [
            "intentFingerprint","targetRepository","dependentRepository",
            "dependentJobId","dependentTaskId"
        ]{
            if bound.get(key)!=request.get(key){
                return Err(format!(
                    "Blocker recovery requestId {} is already bound to a different durable intent",
                    field(request,"requestId")));
            }
        }
    }
    Ok(matching.first().copied())
}
fn authoritative_candidate<'a>(
    jobs:&'a [Value],request:&Value,
)->Result<Option<&'a Value>,String>{
    let matching:Vec<&Value>=jobs.iter().filter(|job|{
        job.get("repository")==request.get("targetRepository")
            &&job.get("unblocks").and_then(Value::as_array).into_iter().flatten()
                .any(|relation|relation.get("repository")==request.get("dependentRepository")
                    &&relation.get("jobId")==request.get("dependentJobId")
                    &&relation.get("taskId")==request.get("dependentTaskId")
                    &&relation.get("blockedAttempt")==request.get("blockedAttempt"))
    }).collect();
    if matching.len()>1{
        return Err(format!("Ambiguous authoritative blocker dependency for {}/{}",
            field(request,"dependentJobId"),field(request,"dependentTaskId")));
    }
    Ok(matching.first().copied())
}
#[derive(Clone,Debug)]
pub struct BlockerRecoveryPlan{
    pub blocker:Value,
    pub dependent:Value,
    pub receipt:Value,
    pub created:bool,
}
/// The caller supplies a read-only inventory of authoritative SQLite
/// Jobs and commits BOTH updated Job candidates via their own Store CAS.
pub async fn ensure_blocker_recovery(
    directory:&Path,store_directory:&Path,input:&Value,
    dependent:&Value,known_jobs:&[Value],now:Option<&str>,
)->Result<BlockerRecoveryPlan,String>{
    validate_input(input)?;
    let dependent_id=field(input,"dependentTaskId");
    let task=dependent.get("tasks").and_then(Value::as_array)
        .into_iter().flatten().find(|t|field(t,"id")==dependent_id)
        .ok_or_else(||format!("Dependent Task {dependent_id} not found"))?;
    if !matches!(field(task,"state"),"FAILED"|"BLOCKED"){
        return Err(format!("Dependent Task {dependent_id} must be failed or blocked before blocker recovery ({})",
            field(task,"state")));
    }
    let blocked_attempt=task.get("attempt").and_then(Value::as_u64).unwrap_or(0);
    let now=now.map(str::to_owned).unwrap_or_else(iso8601_now);
    let mut request=make_request(input,blocked_attempt,&now)?;
    let known=intent_candidate(known_jobs,&request)?;
    let authoritative=if known.is_none(){
        authoritative_candidate(known_jobs,&request)?
    }else{None};
    let found=known.or(authoritative);
    let allowed=input.get("authorizedRepositories").and_then(Value::as_array)
        .into_iter().flatten().filter_map(Value::as_str)
        .map(normalize_repository).collect::<Result<Vec<_>,_>>()?;
    let target_allowed=allowed.contains(&field(input,"targetRepository").to_owned());
    let dependent_allowed=allowed.contains(&field(input,"dependentRepository").to_owned());
    let facts=json!({
        "authorized":input.get("authorized")==Some(&Value::Bool(true)),
        "knownRequest":known.is_some(),
        "authoritativeDependency":authoritative.is_some(),
        "adoptionValid":found.is_some_and(|candidate|adoption_valid(candidate,&request)),
        "targetValid":target_allowed,
        "trustBoundaryValid":dependent_allowed
    });
    let mut blocker=found.cloned();
    let mut created=false;
    let mut outcome=if found.is_some(){"reused"}else{"created"};
    let mut registered=None;
    let decision=dispatch_blocker_recovery(directory,&facts,|action|{
        match action{
            "recovery.createBlocker"=>{
                let repository=field(&request,"targetRepository");
                let id=allocate_entity_id(store_directory,repository,"job",
                    Some(&format!("blocker-recovery:{}",field(&request,"requestId"))),
                    &HashSet::new())?;
                let created_job=json!({
                    "id":id,"title":request.get("title"),
                    "objective":request.get("objective"),
                    "projectRoot":input.get("targetProjectRoot"),
                    "repository":repository,"prNumber":0,
                    "continuation":null,"tasks":[],
                    "blockerRecoveryRequest":request,
                    "blockerResolutionMode":request.get("resolutionMode"),
                    "createdAt":now,"updatedAt":now
                });
                blocker=Some(create_job_entity(directory,&created_job,false,&now)?);
                created=true;
                outcome="created";
                Ok(json!({}))
            },
            "recovery.adoptExistingBlocker"=>{
                if blocker.is_none(){
                    return Err("Graph selected adoption without a verified blocker Job".into());
                }
                outcome="reused";
                Ok(json!({}))
            },
            "recovery.registerDependency"=>{
                let current=blocker.as_ref().ok_or(
                    "Graph selected dependency registration without a blocker Job")?;
                let previous=current.get("unblocks").and_then(Value::as_array)
                    .into_iter().flatten().any(|item|
                        item.get("jobId")==request.get("dependentJobId")
                            &&item.get("taskId")==request.get("dependentTaskId"));
                let result=register_blocker_dependency(directory,current,dependent,
                    dependent_id,Some(blocked_attempt),
                    Some(field(&request,"resolutionMode")),Some(&now))?;
                let mut next=result.blocker;
                let mut candidate=result.dependent;
                if next.get("blockerRecoveryRequest").is_some_and(|v|!v.is_null()
                    &&v.get("intentFingerprint")!=request.get("intentFingerprint")){
                    return Err(format!("Blocker Job {} is already bound to a different recovery intent",
                        field(&next,"id")));
                }
                let planning=planning_required(&next);
                request["status"]=json!(request_status(&next,planning));
                request["updatedAt"]=json!(now);
                next["blockerRecoveryRequest"]=request.clone();
                next["blockerResolutionMode"]=request.get("resolutionMode")
                    .cloned().unwrap_or(Value::Null);
                blocker=Some(next);
                registered=Some(candidate);
                if !created{outcome=if previous{"reused"}else{"registered"};}
                Ok(json!({}))
            },
            other=>Err(format!("Unsupported blocker recovery action {other}"))
        }
    }).await?;
    if decision.get("accepted")!=Some(&Value::Bool(true))
        ||field(&decision,"target")!="ready"||blocker.is_none(){
        return Err(format!("Blocker recovery graph did not produce ready state for {}",
            field(&request,"requestId")));
    }
    let final_blocker=blocker.ok_or("Blocker graph returned no Job")?;
    let mut final_dependent=registered.unwrap_or_else(||dependent.clone());
    let planning=planning_required(&final_blocker);
    let receipt=receipt(input,field(&final_blocker,"id"),outcome,
        planning,final_blocker.get("blockerRecoveryRequest").unwrap_or(&request),&now);
    let updated=final_dependent.get_mut("tasks").and_then(Value::as_array_mut)
        .and_then(|tasks|tasks.iter_mut().find(|task|field(task,"id")==dependent_id))
        .ok_or_else(||format!("Dependent Task {dependent_id} disappeared"))?;
    updated["blockerRecoveryReceipt"]=receipt.clone();
    final_dependent["updatedAt"]=json!(now);
    Ok(BlockerRecoveryPlan{blocker:final_blocker,dependent:final_dependent,
        receipt,created})
}
