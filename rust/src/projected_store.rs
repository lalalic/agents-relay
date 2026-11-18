// Node provenance: src/projected-store.ts. GitHub is a retryable projection
// of authoritative SQLite facts, never a second Task scheduler.
// A deterministic Task/Plan definition mismatch is a Graph-classified
// durable conflict, not an endlessly retried HTTP operation.
use crate::{
    local_commit_events::publish_local_commit,
    local_merge_lock::iso8601_now,
    relay_store::SQLiteRelayStore,
    store_task_definition::same_task_definition,
    workflow::projection_conflict_v2::decide_projection_failure,
};
use chrono::{DateTime,SecondsFormat,Utc};
use regex::Regex;
use serde_json::{json,Value};
use std::{future::Future,path::Path};

fn field<'a>(v:&'a Value,key:&str)->&'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
pub fn task_key(task:&Value)->String {
    format!("task:{}:{}",field(task,"jobId"),field(task,"id"))
}
pub fn plan_key(plan:&Value)->String {
    format!("plan:{}:{}",field(plan,"jobId"),field(plan,"id"))
}
fn parse_number(value:Option<&Value>)->Option<f64>{
    value?.as_f64().or_else(||value?.as_str()?.parse::<f64>().ok())
        .filter(|v|v.is_finite())
}
fn headers<'a>(error:&'a Value)->Option<&'a Value>{
    error.pointer("/response/headers").or_else(||error.get("headers"))
}
fn retry_header(error:&Value,name:&str)->Option<String>{
    if name=="retry-after"{
        if let Some(value)=error.get("retryAfter")
            .filter(|v|!v.is_null()){
            return Some(value.as_str().map(str::to_owned)
                .unwrap_or_else(||value.to_string()));
        }
    }
    headers(error)?.as_object()?.iter().find(|(key,_)|
        key.eq_ignore_ascii_case(name)).map(|(_,value)|
        value.as_str().map(str::to_owned)
            .unwrap_or_else(||value.to_string()))
}
pub fn github_projection_retry_at(error:&Value,attempt:u64,now_ms:i64)
    ->Result<String,String>{
    let retry=retry_header(error,"retry-after")
        .and_then(|raw|raw.parse::<f64>().ok())
        .filter(|v|v.is_finite()&&*v>0.0);
    let target=if let Some(delay)=retry{
        now_ms+((delay*1_000.0) as i64)
    }else if let Some(reset)=retry_header(error,"x-ratelimit-reset")
        .and_then(|raw|raw.parse::<f64>().ok())
        .filter(|v|v.is_finite()&&*v>now_ms as f64/1_000.0){
        (reset*1_000.0) as i64+1_000
    }else{
        now_ms+(1_000i64.saturating_mul(1i64<<attempt.min(8))).min(300_000)
    };
    DateTime::<Utc>::from_timestamp_millis(target)
        .map(|d|d.to_rfc3339_opts(SecondsFormat::Millis,true))
        .ok_or("Invalid projection retry timestamp".into())
}
pub fn is_terminal_projection_failure(item:&Value,error:&Value)->bool {
    if !matches!(field(item,"operation"),"append_plan"|"append_task"){
        return false;
    }
    if field(error,"type")=="DurableDefinitionConflictError" {
        return true;
    }
    let message=error.get("message").and_then(Value::as_str)
        .unwrap_or("");
    message.ends_with("already exists with a different definition")
}
pub fn conflict_diagnostic(item:&Value,error:&Value,now:&str)->Value{
    let operation=field(item,"operation");
    let payload=&item["payload"]["value"];
    let kind=if operation=="append_plan"{"plan"}else{"task"};
    let mut diagnostic=json!({
        "kind":kind,"jobId":payload.get("jobId"),"subjectId":payload.get("id"),
        "operation":operation,"operationKey":item.get("operationKey"),
        "localDefinition":payload,"remoteDefinition":null,
        "divergingFields":[],"detectedAt":now,
        "message":error.get("message")
    });
    if field(error,"type")=="DurableDefinitionConflictError"{
        for key in ["kind","jobId","subjectId","local","remote","divergingFields"]{
            if let Some(value)=error.get(key){
                diagnostic[match key{"local"=>"localDefinition",
                    "remote"=>"remoteDefinition",_=>key}]=value.clone();
            }
        }
    }
    diagnostic
}
pub struct GitHubProjectionWriter<'a>{
    pub relay:&'a SQLiteRelayStore,
    pub external_only:bool,
}
impl<'a> GitHubProjectionWriter<'a>{
    pub fn new(relay:&'a SQLiteRelayStore,external_only:bool)->Self{
        Self{relay,external_only}
    }
    /// The `effect` port is an authenticated GitHub Store call or a
    /// separately authorized PR creation effect. No projection side effect
    /// runs during Phase1 source copy.
    pub async fn flush_once<Effect,Fut,Conflict,CFut>(
        &self,directory:&Path,limit:f64,now:&str,
        mut effect:Effect,mut on_conflict:Conflict,
    )->Result<Value,String>
    where
        Effect:FnMut(Value)->Fut,Fut:Future<Output=Result<(),Value>>,
        Conflict:FnMut(Value)->CFut,CFut:Future<Output=Result<(),String>>,
    {
        let queued=self.relay.claim_due_projections(limit,now)?;
        let mut projected=0;
        let mut deferred=0;
        let now_ms=DateTime::parse_from_rfc3339(now)
            .map_err(|e|e.to_string())?.timestamp_millis();
        for item in queued{
            let id=item.get("id").and_then(Value::as_i64).unwrap_or(0);
            let operation=field(&item,"operation");
            let key=field(&item,"operationKey");
            let attempts=item.get("attempts").and_then(Value::as_i64).unwrap_or(0);
            if self.external_only&&!matches!(operation,
                "merge_pull_request"|"close_pull_request"|"update_pr_body"
                    |"create_pull_request"|"append_task_comment"){
                self.relay.complete_projection(id)?;
                continue;
            }
            match effect(item.clone()).await{
                Ok(())=>{
                    if matches!(operation,"merge_pull_request"|"close_pull_request"){
                        let previous=self.relay.load_pull_request_facts()?;
                        self.relay.save_pull_request_facts(&json!({
                            "state":if operation=="merge_pull_request"{"MERGED"}else{"CLOSED"},
                            "head":previous.as_ref().and_then(|v|v.get("head")),
                            "observedAt":iso8601_now()
                        }))?;
                    }
                    self.relay.complete_projection_with_receipt(
                        id,key,"succeeded",attempts,&json!({"operation":operation}))?;
                    projected+=1;
                },
                Err(error)=>{
                    let message=field(&error,"message");
                    let deterministic=is_terminal_projection_failure(&item,&error);
                    let decision=decide_projection_failure(directory,
                        &json!({"deterministicDefinitionConflict":deterministic}))?;
                    if decision.get("accepted")==Some(&Value::Bool(true))
                        &&field(&decision,"target")=="conflict"{
                        let diagnostic=conflict_diagnostic(&item,&error,now);
                        self.relay.record_projection_conflict(id,&diagnostic)?;
                        if let Err(error)=on_conflict(json!({
                            "type":"projection.conflict","status":"conflict",
                            "visibility":"orchestrator","message":message,
                            "data":diagnostic
                        })).await{
                            eprintln!("warning: projection conflict event unavailable: {error}");
                        }
                    }else{
                        let retry_at=github_projection_retry_at(
                            &error,attempts as u64,now_ms)?;
                        self.relay.retry_projection_with_receipt(
                            id,key,message,&retry_at,attempts+1,
                            &json!({"operation":operation,"error":message}))?;
                        deferred+=1;
                    }
                }
            }
        }
        Ok(json!({"projected":projected,"deferred":deferred}))
    }
}
/// One Job-scoped projected store. All lifecycle changes first commit to
/// SQLite (with an outbox row). GitHub receives only subsequent projections.
pub struct ProjectedDurableStore{
    pub relay:SQLiteRelayStore,
    pub seeded_facts:Option<Value>,
}
impl ProjectedDurableStore{
    pub fn new(relay:SQLiteRelayStore,seed:Option<Value>)->Self{
        if let Some(facts)=seed.as_ref(){let _=relay.save_pull_request_facts(facts);}
        Self{relay,seeded_facts:seed}
    }
    // SQLite-first DurableStore API parity. These are exact delegations
    // to the canonical transaction/receipt store, not remote PR projections.
    pub fn mutate_job<F>(&self,job_id:&str,mutate:F)->Result<Value,String>
    where F:FnOnce(Value)->Result<Value,String>{
        self.relay.mutate_job(job_id,mutate)
    }
    pub fn mark_event_processed(&self,event_id:&str,stream:Option<&str>,
        sequence:Option<i64>)->Result<bool,String>{
        self.relay.mark_event_processed(event_id,stream,sequence)
    }
    pub fn record_host_invocation_event(
        &self,delivery:&Value,outcome:&str,fingerprint:&str,
    )->Result<(),String>{
        self.relay.record_host_invocation_event(delivery,outcome,fingerprint)
    }
    pub fn has_host_invocation_decision(
        &self,job_id:&str,task_id:&str,invocation_id:&str,
        fingerprint:Option<&str>,
    )->Result<bool,String>{
        self.relay.has_host_invocation_decision(job_id,task_id,
            invocation_id,fingerprint)
    }
    pub fn record_host_invocation_decision(
        &mut self,delivery:&Value,fingerprint:&str,
    )->Result<Value,String>{
        self.relay.record_host_invocation_decision(delivery,fingerprint)
    }
    pub fn record_execution_process(&self,record:&Value)->Result<(),String>{
        self.relay.record_execution_process(record)
    }
    pub fn load_execution_process(
        &self,job_id:&str,task_id:&str,execution_id:&str,
    )->Result<Option<Value>,String>{
        self.relay.load_execution_process(job_id,task_id,execution_id)
    }
    pub fn finish_execution_process(
        &self,job_id:&str,task_id:&str,execution_id:&str,
    )->Result<(),String>{
        self.relay.finish_execution_process(job_id,task_id,execution_id,None)
    }
    pub fn list_agents_with_remote<Load>(&self,mut load:Load)->Result<Vec<Value>,String>
    where Load:FnMut()->Result<Vec<Value>,String>{
        if let Some(local)=self.relay.load_agents()?{return Ok(local);}
        let remote=load()?;
        self.relay.save_agents(&remote)?;
        Ok(remote)
    }
    pub fn list_agents(&self)->Result<Vec<Value>,String>{
        self.list_agents_with_remote(||Err(
            "Projected agent registry requires an explicit remote store".into()))
    }
    pub fn save_agent_with_remote<Load>(
        &self,agent:&Value,load:Load,
    )->Result<(),String>
    where Load:FnMut()->Result<Vec<Value>,String>{
        // Preserve unseen historical agents before first local upsert.
        self.list_agents_with_remote(load)?;
        let id=field(agent,"id");
        self.relay.save_agent_with_projection(agent,&json!({
            "idempotencyKey":format!("save_agent:{id}"),
            "coalesceKey":format!("agent:{id}"),
            "operation":"save_agent",
            "payload":{"operation":"save_agent","value":agent},
            "priority":10
        }))
    }
    pub fn save_agent(&self,agent:&Value)->Result<(),String>{
        self.save_agent_with_remote(agent,||Err(
            "Projected agent registry requires an explicit remote store".into()))
    }
    pub fn apply_pull_request_facts(&self,facts:&Value)->Result<(),String>{
        self.relay.save_pull_request_facts(facts)
    }
    pub fn pull_request_state(&self)->Result<String,String>{
        Ok(self.relay.load_pull_request_facts()?.as_ref()
            .and_then(|facts|facts.get("state")).and_then(Value::as_str)
            .unwrap_or("UNKNOWN").into())
    }
    pub fn pull_request_head(&self)->Result<Option<Value>,String>{
        Ok(self.relay.load_pull_request_facts()?.and_then(|facts|
            facts.get("head").filter(|v|!v.is_null()).cloned()))
    }
    pub fn hydrate(&self,job:&Value)->Result<(),String>{
        self.relay.ingest_job_snapshot(job).map(|_|())
    }
    pub fn load<Remote>(&self,job_id:&str,mut remote:Remote)
        ->Result<Value,String>
    where Remote:FnMut(&str)->Result<Value,String>{
        if let Some(local)=self.relay.load_job(job_id)?{return Ok(local);}
        let result=remote(job_id)?;
        self.relay.save_job(&result)?;
        Ok(result)
    }
    pub fn save_job(&self,job:&Value)->Result<(),String>{
        let id=field(job,"id");
        let priority=if matches!(field(job,"state"),"COMPLETED"|"CANCELLED"){
            100
        }else{20};
        self.relay.save_job_with_projection(job,&json!({
            "idempotencyKey":format!("save_job:{id}"),
            "coalesceKey":format!("job:{id}"),
            "operation":"save_job","payload":{"operation":"save_job",
                "value":job},"priority":priority
        }))?;
        publish_local_commit(job);
        Ok(())
    }
    pub fn append_plan(&self,plan:&Value)->Result<(),String>{
        let job_id=field(plan,"jobId");
        self.relay.mutate_job(job_id,|mut job|{
            if let Some(plans)=job.get_mut("plans").and_then(Value::as_array_mut){
                if let Some(existing)=plans.iter().find(|p|p.get("id")==plan.get("id")){
                    if existing==plan{return Ok(job);}
                    return Err(format!(
                        "Plan {} already exists with a different definition",field(plan,"id")));
                }
                plans.push(plan.clone());
                plans.sort_by_key(|p|p.get("round").and_then(Value::as_i64).unwrap_or(0));
            }else{job["plans"]=json!([plan]);}
            Ok(job)
        })?;
        self.relay.enqueue_projection(&json!({
            "idempotencyKey":format!("append_plan:{job_id}:{}",field(plan,"id")),
            "operation":"append_plan","payload":{"operation":"append_plan",
                "value":plan},"priority":30
        }))
    }
    pub fn save_plan(&self,plan:&Value)->Result<(),String>{
        let job_id=field(plan,"jobId");
        self.relay.mutate_job(job_id,|mut job|{
            let next=job.get_mut("plans").and_then(Value::as_array_mut)
                .ok_or("Expected Job plans")?;
            if let Some(index)=next.iter().position(|p|p.get("id")==plan.get("id")){
                next[index]=plan.clone();
            }else{next.push(plan.clone());}
            next.sort_by_key(|p|p.get("round").and_then(Value::as_i64).unwrap_or(0));
            Ok(job)
        })?;
        self.relay.enqueue_projection(&json!({
            "idempotencyKey":format!("save_plan:{job_id}:{}",field(plan,"id")),
            "coalesceKey":plan_key(plan),
            "operation":"save_plan",
            "payload":{"operation":"save_plan","value":plan},
            "priority":30
        }))
    }
    pub fn append_task(&self,task:&Value)->Result<(),String>{
        let job_id=field(task,"jobId");
        if job_id.is_empty(){return Err("Projected task requires jobId".into());}
        let job=self.relay.mutate_job(job_id,|mut job|{
            let previous=job.get("tasks").and_then(Value::as_array)
                .into_iter().flatten().find(|t|t.get("id")==task.get("id"));
            if let Some(previous)=previous{
                if same_task_definition(previous,task){return Ok(job);}
                return Err(format!("Task {} already exists with a different definition",
                    field(task,"id")));
            }
            job.get_mut("tasks").and_then(Value::as_array_mut)
                .ok_or("Job tasks not an array")?.push(task.clone());
            Ok(job)
        })?;
        self.relay.enqueue_projection(&json!({
            "idempotencyKey":format!("append_task:{job_id}:{}",field(task,"id")),
            "operation":"append_task","payload":{"operation":"append_task",
                "value":task},"priority":40
        }))?;
        publish_local_commit(&job);
        Ok(())
    }
    pub fn save_task(&self,task:&Value)->Result<(),String>{
        let job_id=field(task,"jobId");
        if job_id.is_empty(){return Err("Projected task requires jobId".into());}
        let job=self.relay.mutate_job(job_id,|mut job|{
            let tasks=job.get_mut("tasks").and_then(Value::as_array_mut)
                .ok_or("Job tasks missing")?;
            if let Some(index)=tasks.iter().position(|t|t.get("id")==task.get("id")){
                tasks[index]=task.clone();
            }else{tasks.push(task.clone());}
            Ok(job)
        })?;
        self.relay.enqueue_projection(&json!({
            "idempotencyKey":format!("save_task:{job_id}:{}",field(task,"id")),
            "coalesceKey":task_key(task),
            "operation":"save_task","payload":{"operation":"save_task",
                "value":task},
            "priority":if matches!(field(task,"state"),
                "SUCCEEDED"|"FAILED"|"BLOCKED"|"CANCELLED"){100}else{50}
        }))?;
        publish_local_commit(&job);
        Ok(())
    }
    pub fn head_sha(&self)->Result<Option<String>,String>{
        Ok(self.relay.load_pull_request_facts()?.or(self.seeded_facts.clone())
            .and_then(|f|f.pointer("/head/sha").and_then(Value::as_str)
                .map(str::to_owned)))
    }
    pub fn merge_pull_request(&self,sha:Option<&str>)->Result<(),String>{
        self.relay.enqueue_projection(&json!({
            "idempotencyKey":format!("merge_pull_request:{}",
                sha.unwrap_or("current")),
            "operation":"merge_pull_request",
            "payload":{"operation":"merge_pull_request","expectedHeadSha":sha},
            "priority":200
        }))
    }
    pub fn close_pull_request(&self)->Result<(),String>{
        self.relay.enqueue_projection(&json!({
            "idempotencyKey":"close_pull_request",
            "operation":"close_pull_request",
            "payload":{"operation":"close_pull_request"},"priority":200
        }))
    }
    pub fn update_pull_request_body(&self,body:&str)->Result<(),String>{
        self.relay.enqueue_projection(&json!({
            "idempotencyKey":"update_pr_body","coalesceKey":"pr:body",
            "operation":"update_pr_body",
            "payload":{"operation":"update_pr_body","value":body},
            "priority":20
        }))
    }
}
