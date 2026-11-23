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
    git_delivery::{source_completion_verified,started_source_baseline,bind_source_baseline},
    interactive_invocation::{
        apply_interactive_decision,HostInteractiveInvocationCoordinator,
    },
    local_merge_lock::iso8601_now,
    reconciler_review::{apply_review_event,ReviewSnapshot},
    task_inactivity_watchdog::{
        is_correlated_worker_event,is_recoverable_watchdog_failure,
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
    // Volatile effects are applied only after authoritative SQLite commit.
    pub start_acknowledgements:Vec<(String,String)>,
}
impl RuntimeEffect{
    pub fn ignored(job:&Value,reason:impl Into<String>)->Self{
        Self{job:job.clone(),applied:false,reconcile:false,
            reconcile_detached:false,reason:reason.into(),
            events:Vec::new(),completed_generations:Vec::new(),
            cancel_generations:Vec::new(),
            start_acknowledgements:Vec::new()}
    }
    pub fn recognized(job:&Value,reason:impl Into<String>,reconcile:bool)->Self{
        let mut output=Self::ignored(job,reason);
        output.applied=true;output.reconcile=reconcile;output
    }
}
pub struct ReconcilerRuntime {
    pub owner:String,
    pub live:HashMap<String,LiveExecution>,
    pub planner_live:HashMap<String,String>,
    pub continuation_live:HashSet<String>,
    pub launch_failure_claims:HashSet<String>,
    pub terminal_waiters:HashMap<String,String>,
    pub host_invocations:HostInteractiveInvocationCoordinator,
    pub closed:bool,
}
impl ReconcilerRuntime{
    pub fn new(owner:impl Into<String>)->Self{
        Self{owner:owner.into(),
            live:HashMap::new(),planner_live:HashMap::new(),
            continuation_live:HashSet::new(),
            launch_failure_claims:HashSet::new(),
            terminal_waiters:HashMap::new(),
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
        }
        correct
    }
    pub fn clear_execution(&mut self,task_id:&str,execution_id:Option<&str>){
        let remove=execution_id.is_none_or(|id|
            self.live.get(task_id).is_some_and(|live|live.execution_id==id));
        if remove{
            self.live.remove(task_id);
            self.terminal_waiters.remove(task_id);
        }
    }
    fn task_progress(
        &mut self,directory:&Path,job:&Value,event:&Value,
    )->Result<RuntimeEffect,String>{
        let id=field(event,"task_id");
        let Some(index)=task_index(job,id)else{return Ok(
            RuntimeEffect::ignored(job,"task.progress.ignored"));};
        let task=&job["tasks"][index];
        // Node acceptTaskProgress accepts only a RUNNING execution, never a
        // merely QUEUED lease. The event timestamp must be valid and not
        // future-dated before Graph can update progress facts.
        let parsed_at=DateTime::parse_from_rfc3339(field(event,"timestamp"));
        if !correlated(task,event)||field(task,"state")!="RUNNING"
            ||!parsed_at.ok().is_some_and(|at|
                at.timestamp_millis()<=Utc::now().timestamp_millis()){
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
        // Match Node markWorkerStarted: snapshot the exact source HEAD before
        // this execution's code changes, then bind it only on Graph acceptance.
        let baseline=started_source_baseline(job,id)?;
        let execution=field(task,"executionId");
        let valid=DateTime::parse_from_rfc3339(field(event,"timestamp"))
            .ok().is_some_and(|stamp|
                stamp.timestamp_millis()<=Utc::now().timestamp_millis());
        if execution.is_empty()||!correlated(task,event)||!valid{
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
        bind_source_baseline(&mut next,baseline.as_deref());
        let now=iso8601_now();
        next["updatedAt"]=json!(now);
        next["lastProgressAt"]=json!(now);
        next["lastProgressEventAt"]=json!(field(event,"timestamp"));
        result.job["tasks"][index]=next.clone();
        result.start_acknowledgements.push((id.into(),execution.into()));
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
        let source_verified=source_completion_verified(job,task,event_execution.as_deref());
        if event_type=="task.completed"&&!source_verified{
            return Ok(RuntimeEffect::ignored(job,"task.completed.unverified_git_delivery"));
        }
        let facts=json!({
            "sourceDeliveryVerified":source_verified,
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
        // Persist Task generation first; in-memory process cancellation only
        // occurs from finalize_after_commit, never on speculative snapshots.
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
            cancel_generations:review.cancel_execution_ids,
            start_acknowledgements:Vec::new()
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
    /// Source rule: all irrecoverable effects run after a successful SQLite
    /// commit. This function is the single post-commit reconciliation boundary.
    pub fn finalize_after_commit(&mut self,effect:&RuntimeEffect){
        // Only successful authoritative SQLite writes may publish a terminal
        // generation claim, release an owned process or refresh a watchdog.
        if !effect.applied{return;}
        let job_id=field(&effect.job,"id");
        for (task_id,execution_id) in &effect.start_acknowledgements{
            if let Some(active)=self.live.get_mut(task_id){
                if active.job_id==job_id&&active.execution_id==*execution_id{
                    active.worker_started=true;
                }
            }
        }
        for source in &effect.completed_generations{
            claim_terminal_execution(source);
        }
        for execution in &effect.cancel_generations{
            let ids=execution.split('/').collect::<Vec<_>>();
            if ids.len()==6&&ids[0]=="job"&&ids[2]=="task"
                &&ids[4]=="execution"{
                self.cancel_execution_generation(ids[1],ids[3],ids[5]);
                continue;
            }
            // Review, Task and watchdog reducers carry a bare execution UUID;
            // resolve it under this Job, never cancel an unrelated Job/Task.
            let matches=self.live.values().filter(|live|
                live.job_id==job_id && live.execution_id==*execution)
                .map(|live|(live.job_id.clone(),live.task_id.clone(),
                    live.execution_id.clone())).collect::<Vec<_>>();
            for (job_id,task_id,generation) in matches{
                self.cancel_execution_generation(&job_id,&task_id,&generation);
            }
        }
    }
    pub fn close(&mut self){
        self.closed=true;self.live.clear();self.planner_live.clear();
        self.terminal_waiters.clear();
        self.continuation_live.clear();self.host_invocations.close();
    }
    pub fn idle(&self)->bool{
        !self.live.values().any(|run|!run.process_settled)
            &&self.planner_live.is_empty()&&self.continuation_live.is_empty()
    }
}

// Public Node ReconcilerRuntimeBase host contract lives in the SRP module;
// this re-export preserves the original runtime module's API entrypoint.
pub use crate::reconciler_runtime_base::{ReconcilerRuntimeBase,RuntimeBaseStore,RuntimeBaseEventBus};
