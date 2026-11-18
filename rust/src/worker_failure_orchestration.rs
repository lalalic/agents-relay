// Node provenance: src/worker-failure-recovery.ts handleWorkerLaunchFailure.
// The only lifecycle write comes from a Graph-bound atomic Task transition.
// Owned live execution callbacks can never cancel a different execution ID.
use crate::{
    worker_failure_recovery::{classify_worker_launch_failure,launch_failure_event,
        FailureAdmission},
    events::event_for,
};
use serde_json::{json,Value};
#[derive(Clone,Debug)]
pub struct LiveWorkerState{
    pub execution_id:String,
    pub worker_started:bool,
}
pub trait WorkerFailurePorts{
    fn load_job(&mut self,job_id:&str)->Result<Value,String>;
    fn list_agents(&mut self)->Result<Vec<Value>,String>;
    fn usage_snapshot(&mut self)->Result<Option<Value>,String>;
    fn has_safe_alternative(&mut self,task:Option<&Value>,agents:&[Value],
        usage:Option<&Value>)->Result<bool,String>;
    fn has_codex_no_start_fallback(&mut self,task:&Value,agents:&[Value],
        usage:Option<&Value>)->Result<bool,String>;
    fn live_worker(&mut self,task_id:&str)->Option<LiveWorkerState>;
    fn claim_failure(&mut self,claim:&str)->bool;
    /// Must be one atomic SQLite mutateJob transaction, using Task Graph
    /// and `apply_launch_failure_mutation` under execution-ID fencing.
    /// `None` represents a stale generation; `decision.accepted=false`
    /// represents a Graph rejection that is only observed, never persisted.
    fn apply_transition(&mut self,job_id:&str,task_id:&str,
        execution_id:Option<&str>,admission:&FailureAdmission,
    )->Result<Option<Value>,String>;
    fn record_route_outcome(&mut self,task:&Value,message:&str,
        phase:&str,execution_id:Option<&str>,unknown_outcome:bool);
    fn cancel_and_clear(&mut self,task_id:&str,execution_id:&str)
        ->Result<(),String>;
    fn clear_terminal_waiter(&mut self,task_id:&str,execution_id:&str);
    /// Awaited by the Node API for a stale lifecycle observation.
    fn emit(&mut self,event:&Value)->Result<(),String>;
    /// Submitted to the host's detached event emitter after an accepted
    /// transition; event failures cannot reverse the SQLite commit.
    fn emit_detached(&mut self,event:&Value,job_id:&str,task_id:&str,
        context:&str);
    fn wake(&mut self,job_id:&str,task_id:&str,reason:&str);
}
fn field<'a>(value:&'a Value,key:&str)->&'a str{
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
fn task_in_job<'a>(job:&'a Value,id:&str)->Option<&'a Value>{
    job.get("tasks").and_then(Value::as_array).into_iter().flatten()
        .find(|task|field(task,"id")==id)
}
pub fn handle_worker_launch_failure_impl<P:WorkerFailurePorts>(
    ports:&mut P,job_id:&str,task_id:&str,execution_id:Option<&str>,
    failure:&Value,phase:&str,
)->Result<(),String>{
    let current_job=ports.load_job(job_id)?;
    let current_task=task_in_job(&current_job,task_id);
    let agents=ports.list_agents()?;
    let usage=ports.usage_snapshot()?;
    let alternative=ports.has_safe_alternative(current_task,&agents,usage.as_ref())?;
    let active=ports.live_worker(task_id);
    let no_started=current_task.is_some_and(|task|
        field(task,"state")=="QUEUED"
            &&task.get("executionId").and_then(Value::as_str)==execution_id
            &&task.get("lastProgressEventAt").is_none_or(Value::is_null)
            &&!active.as_ref().is_some_and(|live|live.worker_started));
    let can_retry_no_start=no_started &&current_task.is_some_and(|task|{
        matches!(field(task,"adapter"),"chatgpt"|"z")
            &&!crate::final_review_role::is_final_review_agent(
                task.get("agentName").and_then(Value::as_str))
            &&field(task,"agentName")!="troubleshooter"
            &&field(task,"kind")!="planner"
            &&task.get("noStartFallback").is_none_or(Value::is_null)
            &&task.get("attempt").and_then(Value::as_i64).unwrap_or(0)
                <task.get("maxAttempts").and_then(Value::as_i64).unwrap_or(0)
    });
    let codex=if can_retry_no_start{
        ports.has_codex_no_start_fallback(current_task.expect("known task"),
            &agents,usage.as_ref())?
    }else{false};
    let admission=classify_worker_launch_failure(
        current_task,failure,phase,execution_id,
        active.as_ref().map(|live|live.execution_id.as_str()),
        active.as_ref().is_some_and(|live|live.worker_started),
        alternative,codex,
    );
    let claim=execution_id.map(str::to_owned)
        .unwrap_or_else(||format!("{job_id}:{task_id}"));
    if !ports.claim_failure(&claim){return Ok(());}
    let Some(transition)=ports.apply_transition(job_id,task_id,
        execution_id,&admission)? else{return Ok(());};
    let task=&transition["task"];
    let parent=task.get("parentTaskId").and_then(Value::as_str);
    if transition.pointer("/decision/accepted")!=Some(&Value::Bool(true)){
        ports.emit(&launch_failure_event(job_id,task_id,parent,
            &admission,&transition))?;
        return Ok(());
    }
    let record_task=current_task.unwrap_or(task);
    ports.record_route_outcome(record_task,&admission.message,
        if matches!(phase,"process"|"terminal"){"delivery"}else{phase},
        execution_id,admission.unknown_outcome);
    if let Some(execution)=execution_id{
        let after=ports.live_worker(task_id);
        if after.as_ref().is_some_and(|live|live.execution_id==execution){
            ports.cancel_and_clear(task_id,execution)?;
        }
        ports.clear_terminal_waiter(task_id,execution);
    }
    let event=launch_failure_event(job_id,task_id,parent,&admission,&transition);
    ports.emit_detached(&event,job_id,task_id,"worker failure event");
    ports.wake(job_id,task_id,&format!("worker-{phase}-failure"));
    Ok(())
}
