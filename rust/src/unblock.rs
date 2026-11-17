// Node provenance: src/unblock.ts. Canonical Graph-authorized unblock and
// durable baseline evidence. Only SQLite owns the mutation; no Dashboard JS.
use crate::{
    local_merge_lock::iso8601_now,
    task_transitions::try_transition_task_event,
    workflow::authoritative_unblock_v2::decide_authoritative_unblock,
};
use chrono::DateTime;
use serde_json::{json,Value};
use std::{collections::HashSet,path::Path};
fn field<'a>(v:&'a Value,key:&str)->&'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
pub fn is_effectively_blocked(task:&Value)->bool{
    field(task,"kind")!="planner"
        && field(task,"agentName")=="troubleshooter"
        && field(task,"state")=="BLOCKED"
}
fn baseline_for(task:&Value)->Value{
    task.get("blockedBaseline").filter(|v|!v.is_null()).cloned()
        .unwrap_or_else(||{
            let mut baseline=json!({"blockedAt":task.get("updatedAt")});
            if let Some(reason)=task.get("error").filter(|v|!v.is_null()){
                baseline["reason"]=reason.clone();
            }
            baseline
        })
}
fn unique(values:impl Iterator<Item=String>)->Vec<String>{
    let mut seen=HashSet::new();
    values.filter(|item|seen.insert(item.clone())).collect()
}
fn millis(value:&str)->Option<i64>{
    DateTime::parse_from_rfc3339(value).ok().map(|t|t.timestamp_millis())
}
pub fn unblock_facts(job:&Value,selected:&[Value],head:Option<&str>,reason:&str)->Vec<String>{
    let baselines:Vec<Value>=selected.iter().map(baseline_for).collect();
    let heads=unique(baselines.iter().filter_map(|v|
        v.get("headSha").and_then(Value::as_str)).filter(|s|!s.is_empty())
        .map(str::to_owned));
    let mut facts=vec![format!("unblock: {reason}")];
    if head.is_some_and(|sha|heads.iter().any(|prior|prior!=sha)) {
        facts.push(format!("PR head advanced from {} to {}",heads.join(", "),head.unwrap_or("")));
    }
    let earliest=baselines.iter().filter_map(|v|v.get("blockedAt")
        .and_then(Value::as_str).and_then(millis)).min();
    if let Some(earliest)=earliest {
        for task in job.get("tasks").and_then(Value::as_array).into_iter().flatten() {
            if selected.iter().any(|item|item.get("id")==task.get("id")){continue;}
            if task.get("updatedAt").and_then(Value::as_str).and_then(millis)
                .is_none_or(|timestamp|timestamp<earliest){continue;}
            let detail=task.pointer("/result/summary").and_then(Value::as_str)
                .or_else(||task.get("error").and_then(Value::as_str))
                .unwrap_or_else(||field(task,"state"));
            facts.push(format!("task {} -> {}: {}",
                field(task,"id"),field(task,"state"),detail));
        }
    }
    unique(facts.into_iter())
}
pub fn unconsumed_unblock_trigger(job:&Value)->Option<Value>{
    let consumed:HashSet<String>=job.get("plans").and_then(Value::as_array)
        .into_iter().flatten()
        .filter(|plan|field(plan,"status")=="SUCCEEDED"
            && plan.pointer("/trigger/source").and_then(Value::as_str)==Some("unblock"))
        .flat_map(|plan|plan.pointer("/trigger/taskIds").and_then(Value::as_array)
            .into_iter().flatten().filter_map(Value::as_str).map(str::to_owned))
        .collect();
    let blocked:Vec<&Value>=job.get("tasks").and_then(Value::as_array)
        .into_iter().flatten().filter(|task|
            field(task,"agentName")!="troubleshooter"
                && task.get("unblock").is_some_and(|v|!v.is_null())
                && !consumed.contains(field(task,"id"))
                && matches!(field(task,"state"),"DRAFT"|"QUEUED")).collect();
    if blocked.is_empty(){
        let cycle=job.get("changeCycle").filter(|v|!v.is_null())?;
        if cycle.get("consumedByPlannerTaskId").is_some_and(|v|!v.is_null()){return None;}
        return Some(json!({
            "source":"unblock","taskIds":cycle.get("taskIds"),
            "reason":cycle.get("reason"),"facts":cycle.get("facts"),
            "blockedHeadShas":cycle.get("baselineHeadShas"),
            "currentHeadSha":cycle.get("currentHeadSha"),
            "unblockSource":cycle.get("source")
        }));
    }
    let records:Vec<&Value>=blocked.iter().filter_map(|task|task.get("unblock")).collect();
    let task_ids:Vec<Value>=blocked.iter().filter_map(|task|task.get("id").cloned()).collect();
    let reasons=unique(records.iter().map(|rec|field(rec,"reason").to_owned()));
    let facts=unique(records.iter().flat_map(|rec|{
        rec.get("facts").and_then(Value::as_array)
            .map(|facts|facts.iter().filter_map(Value::as_str).map(str::to_owned).collect())
            .unwrap_or_else(||vec![format!("unblock: {}",field(rec,"reason"))])
    }));
    let heads=unique(records.iter().filter_map(|rec|
        rec.pointer("/baseline/headSha").and_then(Value::as_str))
        .filter(|s|!s.is_empty()).map(str::to_owned));
    let current=records.iter().filter_map(|rec|
        rec.get("currentHeadSha").and_then(Value::as_str))
        .find(|s|!s.is_empty());
    Some(json!({
        "source":"unblock","taskIds":task_ids,"reason":reasons.join("; "),
        "facts":facts,"blockedHeadShas":heads,"currentHeadSha":current,
        "unblockSource":records.first().and_then(|rec|rec.get("source"))
    }))
}
pub fn unblock_needs_new_plan(job:&Value)->bool{
    let Some(pending)=unconsumed_unblock_trigger(job) else{return false;};
    let latest=job.get("plans").and_then(Value::as_array)
        .and_then(|items|items.last());
    !latest.is_some_and(|plan|
        field(plan,"status")=="FAILED"
            && plan.pointer("/trigger/source").and_then(Value::as_str)==Some("unblock")
            && plan.pointer("/trigger/taskIds").and_then(Value::as_array)
                .is_some_and(|task_ids|task_ids.iter().any(|id|
                    pending.get("taskIds").and_then(Value::as_array)
                        .is_some_and(|waiting|waiting.contains(id)))))
}
/// Called with the freshest SQLite snapshot, then persisted atomically by
/// the enclosing daemon. A Graph rejection never commits a partial mutation.
pub fn unblock_task_snapshot(
    directory:&Path,job:&Value,task_id:&str,source:&str,
    reason:&str,blocker_job_id:Option<&str>,resolution:Option<&str>,
    current_head:Option<&str>,now:Option<&str>,
)->Result<(Value,Value),String>{
    let mut current=job.clone();
    let task=current.get("tasks").and_then(Value::as_array).into_iter().flatten()
        .find(|task|field(task,"id")==task_id).cloned()
        .ok_or_else(||format!("Task {task_id} is not an effective BLOCKED work task"))?;
    if !is_effectively_blocked(&task){
        return Err(format!("Task {task_id} is not an effective BLOCKED work task"));
    }
    if task.pointer("/escalation/status").and_then(Value::as_str)==Some("pending"){
        return Err("Blocked Troubleshooter requires an authorized human response; use task unblock --response".into());
    }
    let decision=decide_authoritative_unblock(directory,true)?;
    let approved=decision.get("accepted")==Some(&Value::Bool(true))
        && decision.get("actions").and_then(Value::as_array).is_some_and(|actions|
            actions.iter().any(|a|field(a,"id")=="unblock.retry"));
    if !approved{return Err("Authoritative unblock graph rejected task.authoritative_unblock".into());}
    let now=now.map(str::to_owned).unwrap_or_else(iso8601_now);
    let baseline=baseline_for(&task);
    let facts=unblock_facts(job,&[task.clone()],current_head,reason);
    let mut record=json!({
        "event":"task.unblocked","at":now,"source":source,"reason":reason,
        "baseline":baseline,"facts":facts
    });
    if let Some(head)=current_head{record["currentHeadSha"]=json!(head);}
    if let Some(blocker)=blocker_job_id{record["blockerJobId"]=json!(blocker);}
    if let Some(resolution)=resolution{record["resolution"]=json!(resolution);}
    let updated=current.get_mut("tasks").and_then(Value::as_array_mut)
        .and_then(|tasks|tasks.iter_mut().find(|t|field(t,"id")==task_id))
        .ok_or("Task changed before authoritative unblock")?;
    let transition=try_transition_task_event(directory,updated,
        "task.unblocked",&json!({}),&now)?;
    if transition.get("accepted")!=Some(&Value::Bool(true)){
        return Err(format!("Task {task_id} cannot be authoritatively unblocked"));
    }
    if !matches!(field(updated,"state"),"DRAFT"|"QUEUED"){
        return Err(format!("Task {task_id} cannot be authoritatively unblocked"));
    }
    updated["blockedBaseline"]=baseline;
    updated["unblock"]=record;
    updated["attempt"]=json!(0);
    updated["maxAttempts"]=json!(updated.get("maxAttempts").and_then(Value::as_u64).unwrap_or(0).max(3));
    updated["error"]=Value::Null;
    updated["leaseOwner"]=Value::Null;
    updated["leaseExpiresAt"]=Value::Null;
    updated["executionId"]=Value::Null;
    if let Some(map)=updated.as_object_mut(){map.remove("blockedBy");}
    updated["updatedAt"]=json!(now);
    current["updatedAt"]=json!(now);
    Ok((current,json!({"replanning":false})))
}
