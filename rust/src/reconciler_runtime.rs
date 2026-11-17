// Head-to-head Phase1 port: src/reconciler-runtime.ts
// Single authoritative event/lease runtime. Snapshot transitions must be
// persisted atomically by the owning SQLite Store before timers, process
// cancellations or terminal claims run. This is NOT a parallel scheduler.
use crate::{
    dag_result_contract::dag_completion_error,
    execution_event_identity::{
        claim_terminal_execution,event_source_id,execution_event_source,
        execution_id_from_source,terminal_execution_claimed,
    },
    events::event_for,
    final_review_role::is_final_review_agent,
    interactive_invocation::{
        apply_interactive_decision,HostInteractiveInvocationCoordinator,
    },
    local_merge_lock::iso8601_now,
    reconciler_review::{apply_review_event,ReviewSnapshot},
    route_outcome_recording::classify_routing_failure,
    task_actions::apply_task_retry_action,
    task_inactivity_watchdog::{
        inactivity_deadline,is_correlated_worker_event,
        is_recoverable_watchdog_failure,
    },
    task_transitions::try_transition_task_event,
};
use chrono::{DateTime,Utc};
use serde_json::{json,Value};
use std::{
    collections::{HashMap,HashSet},path::Path,
};
fn field<'a>(v:&'a Value,key:&str)->&'a str{
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn tasks<'a>(job:&'a Value)->&'a [Value]{
    job.get("tasks").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}
fn current<'a>(job:&'a Value,id:&str)->Option<&'a Value>{
    tasks(job).iter().find(|t|field(t,"id")==id)
}
fn is_browser(v:&Value)->bool{
    matches!(field(v,"adapter"),"chatgpt"|"z")
}
fn is_worker(v:&Value)->bool{
    matches!(field(v,"adapter"),"codex"|"chatgpt"|"z"|"script")
}
fn timestamp(event:&Value)->String {
    event.get("timestamp").and_then(Value::as_str)
        .filter(|s|!s.is_empty()).map(str::to_owned)
        .unwrap_or_else(iso8601_now)
}
fn event_execution_id(event:&Value)->Option<String>{
    execution_id_from_source(
        event_source_id(event).as_deref(),
        field(event,"job_id"),field(event,"task_id"))
}
fn correlated(task:&Value,event:&Value)->bool{
    is_correlated_worker_event(task,event)
}
fn task_index(job:&Value,id:&str)->Option<usize>{
    tasks(job).iter().position(|t|field(t,"id")==id)
}
#[derive(Clone,Debug)]
pub struct LiveExecution{
    pub job_id:String,pub task_id:String,pub execution_id:String,
    pub pid:Option<i64>,pub worker_started:bool,pub process_settled:bool,
    pub process_error:Option<String>,pub process_exit:Option<Value>,
}
#[derive(Clone,Debug)]
pub struct RuntimeEffect{
    pub job:Value,pub applied:bool,pub reconcile:bool,
    pub reconcile_detached:bool,pub reason:String,
    pub events:Vec<Value>,pub completed_generations:Vec<String>,
    pub cancel_generations:Vec<String>,
}
impl RuntimeEffect{
    pub fn ignored(job:&Value,reason:impl Into<String>)->Self{
        Self{job:job.clone(),applied:false,reconcile:false,
            reconcile_detached:false,reason:reason.into(),
            events:Vec::new(),completed_generations:Vec::new(),
            cancel_generations:Vec::new()}
    }
    pub fn recognized(job:&Value,reason:impl Into<String>,reconcile:bool)->Self{
        let mut output=Self::ignored(job,reason);
        output.applied=true;output.reconcile=reconcile;output
    }
}
pub struct ReconcilerRuntime {
    pub owner:String,
    pub grace_ms:i64,
    pub live:HashMap<String,LiveExecution>,
    pub planner_live:HashMap<String,String>,
    pub continuation_live:HashSet<String>,
    pub launch_failure_claims:HashSet<String>,
    pub terminal_waiters:HashMap<String,String>,
    pub inactive_deadlines:HashMap<String,i64>,
    pub host_invocations:HostInteractiveInvocationCoordinator,
    pub closed:bool,
}
impl ReconcilerRuntime{
    pub fn new(owner:impl Into<String>,grace_ms:i64)->Self{
        Self{owner:owner.into(),grace_ms,
            live:HashMap::new(),planner_live:HashMap::new(),
            continuation_live:HashSet::new(),
            launch_failure_claims:HashSet::new(),
            terminal_waiters:HashMap::new(),
            inactive_deadlines:HashMap::new(),
            host_invocations:HostInteractiveInvocationCoordinator::default(),
            closed:false}
    }
    pub fn register_execution(&mut self,job_id:&str,task_id:&str,
        execution_id:&str,pid:Option<i64>)->Result<(),String>{
        if self.closed{return Err("Reconciler Runtime closed".into());}
        if self.live.contains_key(task_id){
            return Err(format!("Task {task_id} has an active execution already"));
        }
        self.live.insert(task_id.into(),LiveExecution{
            job_id:job_id.into(),task_id:task_id.into(),
            execution_id:execution_id.into(),pid,worker_started:false,
            process_settled:false,process_error:None,process_exit:None});
        self.terminal_waiters.insert(task_id.into(),execution_id.into());
        Ok(())
    }
    pub fn cancel_execution_generation(
        &mut self,job_id:&str,task_id:&str,execution_id:&str,
    )->bool{
        let correct=self.live.get(task_id).is_some_and(|live|
            live.job_id==job_id&&live.execution_id==execution_id);
        if correct{
            self.live.remove(task_id);
            self.terminal_waiters.remove(task_id);
            self.inactive_deadlines.remove(task_id);
        }
        correct
    }
    pub fn clear_execution(&mut self,task_id:&str,execution_id:Option<&str>){
        let remove=execution_id.is_none_or(|id|
            self.live.get(task_id).is_some_and(|live|live.execution_id==id));
        if remove{
            self.live.remove(task_id);
            self.terminal_waiters.remove(task_id);
            self.inactive_deadlines.remove(task_id);
        }
    }
    pub fn arm_inactivity_watchdog(&mut self,task:&Value,execution_id:&str){
        let now=Utc::now().timestamp_millis();
        let deadline=inactivity_deadline(task,execution_id,self.grace_ms,now);
        self.inactive_deadlines.insert(field(task,"id").into(),deadline);
    }
    fn task_progress(
        &mut self,directory:&Path,job:&Value,event:&Value,
    )->Result<RuntimeEffect,String>{
        let id=field(event,"task_id");
        let Some(index)=task_index(job,id)else{return Ok(
            RuntimeEffect::ignored(job,"task.progress.ignored"));};
        let task=&job["tasks"][index];
        if !correlated(task,event)
            ||!matches!(field(task,"state"),"RUNNING"|"QUEUED"){
            return Ok(RuntimeEffect::ignored(job,"task.progress.ignored"));
        }
        let now=iso8601_now();
        let stamp=timestamp(event);
        if task.get("lastProgressEventAt").and_then(Value::as_str)
            .is_some_and(|previous|previous>=stamp.as_str()){
            return Ok(RuntimeEffect::ignored(job,"task.progress.ignored"));
        }
        let mut result=RuntimeEffect::recognized(job,"task.progress",false);
        let mut new_task=task.clone();
        new_task["updatedAt"]=json!(now);
        new_task["lastProgressAt"]=json!(now);
        new_task["lastProgressEventAt"]=json!(stamp);
        result.job["tasks"][index]=new_task.clone();
        if let Some(execution)=new_task.get("executionId").and_then(Value::as_str){
            self.arm_inactivity_watchdog(&new_task,execution);
        }
        let _=directory;
        Ok(result)
    }
    fn task_started(
        &mut self,directory:&Path,job:&Value,event:&Value,
    )->Result<RuntimeEffect,String>{
        let id=field(event,"task_id");
        let Some(index)=task_index(job,id)else{return Ok(
            RuntimeEffect::ignored(job,"task.started.ignored"));};
        let task=&job["tasks"][index];
        let execution=field(task,"executionId");
        let valid=DateTime::parse_from_rfc3339(field(event,"timestamp"))
            .ok().is_some_and(|stamp|
                stamp.timestamp_millis()<=Utc::now().timestamp_millis());
        if execution.is_empty()||!correlated(task,event)||!valid{
            return Ok(RuntimeEffect::ignored(job,"task.started.ignored"));
        }
        let lease=!field(task,"leaseOwner").is_empty();
        let live=self.live.get(id).is_some_and(|run|
            run.job_id==field(event,"job_id")&&run.execution_id==execution);
        if !lease&&!live&&!is_recoverable_watchdog_failure(task){
            return Ok(RuntimeEffect::ignored(job,"task.started.ignored"));
        }
        let old=field(task,"state");
        let mut result=RuntimeEffect::recognized(job,"task.started",false);
        let mut next=task.clone();
        let decision=try_transition_task_event(directory,&mut next,
            "task.started",&json!({
                "recoverableExecution":is_recoverable_watchdog_failure(task)
            }),&iso8601_now())?;
        if decision.get("accepted")!=Some(&Value::Bool(true)){
            return Ok(RuntimeEffect::ignored(job,"task.started.ignored"));
        }
        let now=iso8601_now();
        next["updatedAt"]=json!(now);
        next["lastProgressAt"]=json!(now);
        next["lastProgressEventAt"]=json!(field(event,"timestamp"));
        result.job["tasks"][index]=next.clone();
        if let Some(live)=self.live.get_mut(id){live.worker_started=true;}
        self.arm_inactivity_watchdog(&next,execution);
        if old=="FAILED"{
            result.reconcile=true;result.reconcile_detached=true;
            result.reason="task.started.recovery".into();
        }
        Ok(result)
    }
    fn terminal(
        &mut self,directory:&Path,job:&Value,event:&Value,trusted:bool,
    )->Result<RuntimeEffect,String>{
        let task_id=field(event,"task_id");
        let event_type=field(event,"type");
        let Some(index)=task_index(job,task_id)else{return Ok(
            RuntimeEffect::ignored(job,format!("{event_type}.ignored")));};
        let task=&job["tasks"][index];
        if !is_worker(task)&&field(task,"adapter")!="orchestrator"{
            return Ok(RuntimeEffect::ignored(job,format!("{event_type}.ignored")));
        }
        if event_type=="task.blocked"
            &&(!trusted||field(task,"agentName")!="troubleshooter"){
            return Ok(RuntimeEffect::ignored(job,format!("{event_type}.ignored")));
        }
        if event_type=="task.interactive_waiting"
            &&(task.pointer("/interactiveInvocation/status")
                .and_then(Value::as_str)!=Some("awaiting_decision")
                ||task.pointer("/interactiveInvocation/executionId")
                    .and_then(Value::as_str)!=task.get("executionId")
                    .and_then(Value::as_str)
                ||!correlated(task,event)){
            return Ok(RuntimeEffect::ignored(job,format!("{event_type}.ignored")));
        }
        if event_type=="task.completed"
            &&(is_final_review_agent(task.get("agentName").and_then(Value::as_str))
                ||task.pointer("/interactiveInvocation/status")
                    .and_then(Value::as_str).is_some_and(|s|s!="approved")){
            return Ok(RuntimeEffect::ignored(job,format!("{event_type}.ignored")));
        }
        let event_execution=event_execution_id(event);
        if !trusted&&is_worker(task)&&!correlated(task,event){
            let prior=event_execution.as_deref().and_then(|id|
                task.get("executionHistory").and_then(Value::as_array)
                    .into_iter().flatten().find(|item|field(item,"id")==id));
            if prior.is_none_or(|entry|
                entry.get("attempt")!=task.get("attempt")){
                return Ok(RuntimeEffect::ignored(job,format!("{event_type}.ignored")));
            }
        }
        if let Some(waiter)=self.terminal_waiters.get(task_id){
            if field(task,"executionId")!=waiter||!correlated(task,event){
                return Ok(RuntimeEffect::ignored(job,format!("{event_type}.ignored")));
            }
        }
        let prev=field(task,"executionId").to_string();
        let mut candidate=task.clone();
        let facts=json!({
            "recoverableExecution":is_recoverable_watchdog_failure(task)
                &&(field(task,"failureReason")=="worker_exit_without_terminal_event"
                    ||correlated(task,event)),
            "awaitingInteractiveDecision":event_type=="task.interactive_waiting"
                &&task.pointer("/interactiveInvocation/status")
                    .and_then(Value::as_str)==Some("awaiting_decision")
        });
        let decision=try_transition_task_event(directory,&mut candidate,
            event_type,&facts,&iso8601_now())?;
        if decision.get("accepted")!=Some(&Value::Bool(true)){
            return Ok(RuntimeEffect::ignored(job,format!("{event_type}.ignored")));
        }
        let mut result=RuntimeEffect::recognized(job,event_type,
            event_type!="task.interactive_waiting"
                &&(!is_final_review_agent(task.get("agentName").and_then(Value::as_str))
                    ||event_type=="task.failed"));
        let terminal_execution=event_execution.as_deref()
            .or_else(||(!prev.is_empty()).then_some(prev.as_str()));
        if let Some(generation)=terminal_execution{
            if is_worker(task){
                result.completed_generations.push(
                    execution_event_source(field(job,"id"),task_id,generation));
            }
        }
        if let Some(old)=event_execution.filter(|id|id!=&prev){
            result.cancel_generations.push(old);
        }
        if !prev.is_empty(){result.cancel_generations.push(prev.clone());}
        let now=iso8601_now();
        candidate["leaseOwner"]=Value::Null;
        candidate["leaseExpiresAt"]=Value::Null;
        candidate["executionId"]=Value::Null;
        candidate["updatedAt"]=json!(now);
        if let Some(tag)=event.pointer("/data/tag").filter(|v|v.is_object()){
            candidate["tag"]=tag.clone();
        }
        match event_type{
            "task.completed"=>{
                candidate["result"]=json!({"summary":
                    event.get("message").and_then(Value::as_str)
                        .unwrap_or("Task completed"),
                    "data":event.get("data")});
                candidate["error"]=Value::Null;
                if let Some(map)=candidate.as_object_mut(){
                    map.remove("failureReason");
                }
            },
            "task.failed"=>{
                candidate["error"]=json!(event.get("message")
                    .and_then(Value::as_str).unwrap_or("Task failed"));
                candidate["failureReason"]=event.pointer("/data/reason")
                    .cloned().unwrap_or(Value::Null);
            },
            "task.blocked"=>{
                let message=event.get("message").and_then(Value::as_str)
                    .unwrap_or("Task blocked");
                candidate["error"]=json!(message);
                let head=["candidate_head","candidate_head_sha",
                    "pr_head","head_sha"].iter()
                    .filter_map(|key|event.get("data").and_then(|v|v.get(*key)))
                    .filter_map(Value::as_str).find(|s|!s.is_empty())
                    .or_else(||job.get("headSha").and_then(Value::as_str));
                candidate["blockedBaseline"]=json!({
                    "blockedAt":timestamp(event),"headSha":head,
                    "reason":message});
                if let Some(map)=candidate.as_object_mut(){map.remove("unblock");}
            },
            "task.cancelled"=>{
                candidate["error"]=json!(event.get("message")
                    .and_then(Value::as_str).unwrap_or("Task cancelled"));
            },
            _=>{},
        }
        result.job["tasks"][index]=candidate;
        if !prev.is_empty(){self.clear_execution(task_id,Some(&prev));}
        result.reconcile_detached=!is_final_review_agent(task.get("agentName").and_then(Value::as_str))
            &&event_type!="task.interactive_waiting";
        Ok(result)
    }
    pub fn apply_event(
        &mut self,directory:&Path,job:&Value,event:&Value,
        verified_head:Option<&str>,
    )->Result<RuntimeEffect,String>{
        let kind=field(event,"type");
        match kind{
            "task.started"=>self.task_started(directory,job,event),
            "task.progress"=>self.task_progress(directory,job,event),
            "task.completed"=>{
                if let Some(task)=current(job,field(event,"task_id")){
                    if task.get("dagNode").is_some_and(|v|!v.is_null()){
                        if let Some(error)=dag_completion_error(task,None,"node",|_,_|
                            Err("DAG Stage validation requires an execution project".into())){
                            let mut failed=event.clone();
                            failed["type"]=json!("task.failed");
                            failed["message"]=json!(error);
                            failed["data"]["reason"]=json!("invalid_dag_result");
                            return self.terminal(directory,job,&failed,false);
                        }
                    }
                    if is_final_review_agent(task.get("agentName")
                        .and_then(Value::as_str)){
                        // Reviewer terminal conversion uses review evidence
                        // normalization prior to the graph verdict.
                        let candidate=crate::review_terminal_normalization::
                            normalize_reviewer_terminal_event(event);
                        if !candidate.is_null(){
                        let normalized=candidate;
                            if field(&normalized,"type")!="task.failed"{
                                let review=apply_review_event(directory,job,
                                    &normalized,verified_head)?;
                                return Ok(Self::map_review(review,"review.terminal"));
                            }
                            return self.terminal(directory,job,&normalized,false);
                        }
                    }
                }
                self.terminal(directory,job,event,false)
            },
            "task.failed"|"task.blocked"|"task.cancelled"
                |"task.interactive_waiting"=>self.terminal(directory,job,event,false),
            "review.blocked"=>{
                let mut failed=event.clone();
                failed["type"]=json!("task.failed");
                failed["data"]["reason"]=json!("review_evidence_unavailable");
                self.terminal(directory,job,&failed,false)
            },
            "review.started"|"review.approved"|"review.changes_required"=>{
                let result=apply_review_event(directory,job,event,verified_head)?;
                Ok(Self::map_review(result,"review.lifecycle"))
            },
            "task.interactive_decision"=>{
                let receipt=apply_interactive_decision(directory,job,event,false,None)?;
                let outcome=field(&receipt,"outcome");
                Ok(RuntimeEffect::recognized(job,
                    format!("task.interactive_decision.{outcome}"),
                    outcome=="accepted"))
            },
            "github.webhook"=>Ok(RuntimeEffect::recognized(
                job,"github.audit_only",false)),
            "job.wake"=>Ok(RuntimeEffect::recognized(job,"job.wake",true)),
            _=>Ok(RuntimeEffect::ignored(job,kind))
        }
    }
    fn map_review(review:ReviewSnapshot,reason:&str)->RuntimeEffect{
        RuntimeEffect{
            job:review.job,applied:review.wake||!review.events.is_empty()
                ||!review.cancel_execution_ids.is_empty(),
            reconcile:review.wake,reconcile_detached:false,
            reason:reason.into(),events:review.events,
            completed_generations:Vec::new(),
            cancel_generations:review.cancel_execution_ids
        }
    }
    pub fn runtime_settled(
        &mut self,job:&Value,task_id:&str,execution_id:&str,
        result:Option<&Value>,error:Option<&str>,
        process_exit:Option<&Value>,
    )->Result<RuntimeEffect,String>{
        if let Some(live)=self.live.get_mut(task_id){
            if live.execution_id==execution_id{
                live.process_settled=true;
                live.process_error=error.map(str::to_owned);
                live.process_exit=process_exit.cloned();
            }
        }
        let Some(task)=current(job,task_id)else{
            return Ok(RuntimeEffect::ignored(job,"process.exited.ignored"));
        };
        if is_browser(task)&&field(task,"state")=="QUEUED"
            &&field(task,"executionId")==execution_id
            &&error.is_some()
            &&self.live.get(task_id).is_none_or(|r|!r.worker_started){
            return Ok(RuntimeEffect::recognized(job,
                "worker.no-start-fallback",true));
        }
        if !is_browser(task) &&field(task,"executionId")!=execution_id{
            return Ok(RuntimeEffect::ignored(job,"process.exited.stale"));
        }
        let mut result_mut=RuntimeEffect::recognized(job,"process.exited",false);
        if let Some(index)=task_index(job,task_id){
            if !is_browser(task) {
                let now=iso8601_now();
                result_mut.job["tasks"][index]["processExitedAt"]=json!(now);
            }
        }
        let process=process_exit.cloned().unwrap_or(Value::Null);
        result_mut.events.push(event_for(field(job,"id"),task_id,
            task.get("parentTaskId").and_then(Value::as_str),
            if is_browser(task){"task.process.async_exited"}
                else{"task.process.exited"},
            if process.get("exitCode")==Some(&json!(0)){"succeeded"}
                else{"failed"},
            result.and_then(|v|v.get("summary")).and_then(Value::as_str)
                .or(error).unwrap_or("Worker runtime exited"),
            Some("orchestrator"),
            Some(json!({"authoritative":false,"waitingForTerminalEvent":true,
                "exitCode":process.get("exitCode"),"signal":process.get("signal"),
                "terminationReason":process.get("terminationReason"),
                "stderr":process.get("stderr"),"processError":error,
                "executionId":execution_id})),
            Some(json!({"id":execution_event_source(
                field(job,"id"),task_id,execution_id),
                "agent":"relay","component":"agents-relay"}))));
        Ok(result_mut)
    }
    pub fn timeout_task(
        &mut self,directory:&Path,job:&Value,
        task_id:&str,execution_id:&str,now_ms:i64,
    )->Result<RuntimeEffect,String>{
        let Some(index)=task_index(job,task_id)else{
            return Ok(RuntimeEffect::ignored(job,"watchdog.stale"));
        };
        let task=&job["tasks"][index];
        if field(task,"executionId")!=execution_id
            ||!matches!(field(task,"state"),"QUEUED"|"RUNNING"){
            return Ok(RuntimeEffect::ignored(job,"watchdog.stale"));
        }
        let deadline=inactivity_deadline(task,execution_id,self.grace_ms,now_ms);
        if deadline>now_ms{
            self.inactive_deadlines.insert(task_id.into(),deadline);
            return Ok(RuntimeEffect::ignored(job,"watchdog.deferred"));
        }
        let live=self.live.get(task_id);
        if is_browser(task)&&field(task,"state")=="QUEUED"
            &&live.is_none_or(|r|!r.worker_started){
            return Ok(RuntimeEffect::recognized(job,
                "watchdog.no-start-fallback",true));
        }
        let failed_exit=live.and_then(|run|run.process_exit.as_ref())
            .is_some_and(|exit|exit.get("exitCode")!=Some(&json!(0))
                ||exit.get("signal").is_some_and(|v|!v.is_null()));
        let stderr=live.and_then(|run|run.process_error.as_deref()
            .or_else(||run.process_exit.as_ref().and_then(|v|
                v.get("stderr").and_then(Value::as_str)))).unwrap_or("");
        let reason=if failed_exit{
            classify_routing_failure(stderr,"terminal_event_timeout")
        }else{"terminal_event_timeout".into()};
        let message=if failed_exit{
            if !stderr.trim().is_empty(){stderr.into()}
            else{"Worker process exited without terminal event".into()}
        }else{format!("Task {task_id} exceeded its inactivity timeout without a terminal event")};
        let mut candidate=task.clone();
        let decision=try_transition_task_event(directory,&mut candidate,
            "watchdog.failed",&json!({}),&iso8601_now())?;
        if decision.get("accepted")!=Some(&Value::Bool(true)){
            return Ok(RuntimeEffect::ignored(job,"watchdog.graph-rejected"));
        }
        candidate["error"]=json!(message);
        candidate["failureReason"]=json!(reason);
        candidate["leaseOwner"]=Value::Null;
        candidate["leaseExpiresAt"]=Value::Null;
        let mut result=RuntimeEffect::recognized(job,
            "watchdog.failed",true);
        result.job["tasks"][index]=candidate.clone();
        result.cancel_generations.push(execution_id.into());
        let max=candidate.get("maxAttempts").and_then(Value::as_u64).unwrap_or(3);
        let attempt=candidate.get("attempt").and_then(Value::as_u64).unwrap_or(0);
        if ["provider_rate_limited","provider_quota_exhausted",
            "worker_launch_failed","authentication_rejected"].contains(
                &reason.as_str()) &&attempt<max{
            let retry=&mut result.job["tasks"][index];
            let failed=retry.get("routing").filter(|v|!v.is_null()).cloned();
            apply_task_retry_action(directory,retry,true,&iso8601_now())?;
            if let Some(route)=failed{
                let duplicate=retry.get("routingExclusions")
                    .and_then(Value::as_array).into_iter().flatten()
                    .any(|ex|ex.get("provider")==route.get("provider")
                        &&ex.get("model")==route.get("model")
                        &&ex.get("profile")==route.get("profile"));
                if !duplicate{
                    let mut exclusion=route.clone();
                    exclusion["reason"]=json!(reason);
                    exclusion["at"]=json!(iso8601_now());
                    if let Some(array)=retry.get_mut("routingExclusions")
                        .and_then(Value::as_array_mut){array.push(exclusion);}
                    else{retry["routingExclusions"]=json!([exclusion]);}
                }
            }
            for key in ["routing","workerSelection"]{
                if let Some(map)=retry.as_object_mut(){map.remove(key);}
            }
            result.events.push(event_for(field(job,"id"),task_id,None,
                "task.rerouting","queued","Worker rejected route; retrying with fresh routing and usage data",
                Some("orchestrator"),Some(json!({"previousFailure":reason})),None));
        }
        result.events.push(event_for(field(job,"id"),task_id,None,
            "task.failed","failed",&message,Some("user"),
            Some(json!({"reason":reason,"workflowEvent":"watchdog.failed",
                "executionId":execution_id,"timeoutMs":task.get("timeoutMs")})),
            Some(json!({"agent":"relay","component":"agents-relay",
                "watchdog":true}))));
        Ok(result)
    }
    /// Source rule: all irrecoverable effects run after a successful SQLite
    /// commit. This function is the single post-commit reconciliation boundary.
    pub fn finalize_after_commit(&mut self,effect:&RuntimeEffect){
        for source in &effect.completed_generations{
            claim_terminal_execution(source);
        }
        for execution in &effect.cancel_generations{
            let ids=execution.split('/').collect::<Vec<_>>();
            if ids.len()==6&&ids[0]=="job"&&ids[2]=="task"
                &&ids[4]=="execution"{
                self.cancel_execution_generation(ids[1],ids[3],ids[5]);
            }
        }
    }
    pub fn close(&mut self){
        self.closed=true;self.live.clear();self.planner_live.clear();
        self.terminal_waiters.clear();self.inactive_deadlines.clear();
        self.continuation_live.clear();self.host_invocations.close();
    }
    pub fn idle(&self)->bool{
        !self.live.values().any(|run|!run.process_settled)
            &&self.planner_live.is_empty()&&self.continuation_live.is_empty()
    }
}
