// Node ReconcilerRuntimeBase: serialized EventBus ingress, atomic native
// Graph/SQLite event transitions, Reconciler wake, and interactive binding.
// Store/worker effects are owned by the host, not a parallel Job scheduler.
use crate::{
    events::{MemoryEventBus,NatsEventBus,Wake},
    interactive_invocation::{
        bind_interactive_invocation_snapshot,HostInteractiveInvocationCoordinator,
        InteractiveDecisionWaiter,
    },
    reconcile_coordinator::ReconcileCoordinator,
    reconciler_runtime::{ReconcilerRuntime,RuntimeEffect},
};
use serde_json::{json,Value};
use std::{path::PathBuf,sync::{Arc,Mutex}};

pub trait RuntimeBaseStore:Send+Sync+'static{
    fn load_job(&self,job_id:&str)->Result<Value,String>;
    /// Execute the callback inside SQLite's BEGIN IMMEDIATE transaction.
    fn mutate_job(&self,job_id:&str,
        mutation:&mut dyn FnMut(Value)->Result<Value,String>)->Result<Value,String>;
    /// The same Reconciler instance owns DAG scheduling and Graph effects.
    fn reconcile(&self,job_id:&str)->Result<Value,String>;
    fn emit(&self,_event:&Value)->Result<(),String>{Ok(())}
    /// Interactive human decisions are never an ordinary task lifecycle
    /// mutation. They require the authoritative HostInvocation SQLite
    /// identity/receipt ledger and Graph-controlled resume after commit.
    /// An unbound runtime refuses the input rather than reporting accepted.
    fn apply_host_invocation_event(
        &self,_graph:&std::path::Path,_event:&Value,
        _coordinator:&mut HostInteractiveInvocationCoordinator,
    )->Result<RuntimeEffect,String>{
        Err("Native Reconciler interactive HostInvocation SQLite port is not bound".into())
    }
    fn report_transport_failure(&self,_message:&str){}
}
pub trait RuntimeBaseEventBus{
    fn subscribe_job(&self,job_id:&str,wake:Wake)
        ->Result<Box<dyn FnOnce()+Send>,String>;
}
impl RuntimeBaseEventBus for MemoryEventBus {
    fn subscribe_job(&self,job_id:&str,wake:Wake)
        ->Result<Box<dyn FnOnce()+Send>,String>{
        Ok(Box::new(self.subscribe(job_id,wake)))
    }
}
impl RuntimeBaseEventBus for NatsEventBus {
    fn subscribe_job(&self,job_id:&str,wake:Wake)
        ->Result<Box<dyn FnOnce()+Send>,String>{
        let subscription=self.subscribe(job_id,wake)?;
        Ok(Box::new(move||subscription.unsubscribe()))
    }
}
// A single canonical Graph candidate is committed before any volatile effect.
// The coordinator and direct applyEvent API share this exact path.
fn apply_durable_event(
    host:&Arc<dyn RuntimeBaseStore>,runtime:&Arc<Mutex<ReconcilerRuntime>>,
    directory:&std::path::Path,event:&Value,
)->Result<RuntimeEffect,String>{
    let kind=event.get("type").and_then(Value::as_str).unwrap_or("");
    if kind=="job.wake"{
        return Ok(RuntimeEffect::recognized(&Value::Null,"job.wake",true));
    }
    if kind=="github.webhook"{
        return Ok(RuntimeEffect::recognized(&Value::Null,"github.audit_only",false));
    }
    if kind=="task.interactive_decision"{
        // Node delegates to hostInvocations.applyEvent, NOT a speculative
        // Graph-only ReconcilerRuntime.apply_event. Its actual SQLite receipt
        // must commit before any accepted event or task unblocking.
        let mut current=runtime.lock().map_err(|error|error.to_string())?;
        return host.apply_host_invocation_event(directory,event,
            &mut current.host_invocations);
    }
    if !matches!(kind,"task.started"|"task.progress"|
        "task.completed"|"task.failed"|"task.blocked"|
        "task.cancelled"|"task.interactive_waiting"|
        "task.interactive_decision"|"review.started"|
        "review.approved"|"review.changes_required"|"review.blocked"){
        return Ok(RuntimeEffect::ignored(&Value::Null,kind));
    }
    let job=event.get("job_id").and_then(Value::as_str).unwrap_or("undefined");
    let mut effect:Option<RuntimeEffect>=None;
    let mut callback=|current:Value|{
        let next=runtime.lock().map_err(|e|e.to_string())?
            .apply_event(directory,&current,event,None)?;
        let candidate=next.job.clone();
        effect=Some(next);
        Ok(candidate)
    };
    host.mutate_job(job,&mut callback)?;
    let Some(done)=effect else{
        return Err("Runtime SQLite callback was not executed".into());
    };
    runtime.lock().map_err(|e|e.to_string())?
        .finalize_after_commit(&done);
    for event in &done.events{host.emit(event)?;}
    Ok(done)
}
pub struct ReconcilerRuntimeBase {
    host:Arc<dyn RuntimeBaseStore>,
    runtime:Arc<Mutex<ReconcilerRuntime>>,
    coordinator:ReconcileCoordinator,
    directory:PathBuf,
}
impl ReconcilerRuntimeBase {
    pub fn new(graph_directory:impl Into<PathBuf>,owner:impl Into<String>,
        grace_ms:i64,host:Arc<dyn RuntimeBaseStore>)->Self{
        let directory=graph_directory.into();
        let runtime=Arc::new(Mutex::new(ReconcilerRuntime::new(owner)));
        let consuming_host=Arc::clone(&host);
        let consuming_runtime=Arc::clone(&runtime);
        let graph=directory.clone();
        let reporting_host=Arc::clone(&host);
        let coordinator=ReconcileCoordinator::new(move |job_id,signals|{
            let mut should_reconcile=false;
            let mut detached=false;
            for signal in signals{
                let Some(event)=signal.get("event").filter(|v|!v.is_null())else{
                    should_reconcile=true;continue;
                };
                let done=apply_durable_event(&consuming_host,&consuming_runtime,
                    &graph,event)?;
                should_reconcile|=done.reconcile;
                detached|=done.reconcile&&done.reconcile_detached;
            }
            if should_reconcile{
                if detached{
                    // Node detaches long Reconciler work only after durable
                    // completion of the event transition. The per-Job
                    // coordinator remains the sole transport serializer.
                    let h=Arc::clone(&consuming_host);
                    let id=job_id.to_owned();
                    std::thread::spawn(move||{
                        if let Err(error)=h.reconcile(&id){
                            h.report_transport_failure(&error);
                        }
                    });
                }else{
                    consuming_host.reconcile(job_id)?;
                }
            }
            Ok(())
        },Some(Arc::new(move |error,_signal|{
            reporting_host.report_transport_failure(error);
        })));
        Self{host,runtime,coordinator,directory}
    }
    /// Node ReconcilerRuntimeBase.reconcile is an abstract host callback;
    /// wake synchronously delegates to the same owned Reconciler.
    pub fn reconcile(&self,job_id:&str)->Result<Value,String>{
        self.host.reconcile(job_id)
    }
    pub fn wake(&self,job_id:&str)->Result<Value,String>{self.reconcile(job_id)}
    /// Node ReconcilerRuntimeBase.applyEvent executes exactly one Graph
    /// decision against fresh SQLite and returns its direct handling facts.
    /// It does NOT independently call Reconciler; callers may enqueue a wake.
    pub fn apply_event(&self,event:&Value)->Result<RuntimeEffect,String>{
        apply_durable_event(&self.host,&self.runtime,&self.directory,event)
    }
    pub fn handle_event(&self,event:Value)->Result<(),String>{
        let job=event.get("job_id").and_then(Value::as_str)
            .unwrap_or("undefined");
        let signal=json!({"jobId":job,
            "reason":format!("event.{}",event.get("type").and_then(Value::as_str)
                .unwrap_or("undefined")),"event":event});
        self.coordinator.accept(signal).recv()
            .map_err(|e|e.to_string())??;
        Ok(())
    }
    pub fn watch(&self,bus:Option<&dyn RuntimeBaseEventBus>,job_id:&str)
        ->Box<dyn FnOnce()+Send>{
        let Some(bus)=bus else{return Box::new(||{});};
        let coordinator=self.coordinator.clone();
        let subscribed_job=job_id.to_owned();
        let subscription=bus.subscribe_job(job_id,Arc::new(move |event|{
            // A broker subscription filter alone is not authentication.
            // If a payload is placed on Job A's NATS subject with a
            // purported Job B identity, never dispatch into Job B's
            // Graph/SQLite store. Reject before enqueue, rather than
            // letting the ReconcileCoordinator route the forged jobId.
            if event.get("job_id").and_then(Value::as_str)
                !=Some(subscribed_job.as_str()){
                return Err(format!(
                    "Reconciler EventBus subject/body Job mismatch: subscribed {subscribed_job}"
                ));
            }
            let signal=json!({"jobId":subscribed_job,
                "reason":format!("event.{}",event.get("type")
                    .and_then(Value::as_str).unwrap_or("undefined")),"event":event});
            drop(coordinator.accept_observed(signal));
            Ok(())
        }));
        match subscription{
            Ok(unsubscribe)=>unsubscribe,
            Err(error)=>{
                self.host.report_transport_failure(&error);
                Box::new(||{})
            }
        }
    }
    /// Bind through one authoritative SQLite mutation, then register the
    /// invocation waiter. Never accept a stale Task execution generation.
    pub fn bind_interactive_invocation(&self,job_id:&str,task:&Value,
        execution_id:&str)->Result<Value,String>{
        let task_id=task.get("id").and_then(Value::as_str).unwrap_or("");
        if task.get("state").and_then(Value::as_str)!=Some("RUNNING"){
            return Err(format!("Task {task_id} must be RUNNING to bind an interactive invocation"));
        }
        if task.get("executionId").and_then(Value::as_str)!=Some(execution_id){
            return Err(format!("Task {task_id} does not own execution {execution_id}"));
        }
        let effective=task.get("jobId").and_then(Value::as_str)
            .filter(|id|!id.is_empty()).unwrap_or(job_id);
        if effective.is_empty(){
            return Err(format!("Task {task_id} cannot bind an interactive invocation without a Job ID"));
        }
        let now=chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true);
        let mut callback=|current:Value|{
            let active=current.get("tasks").and_then(Value::as_array)
                .into_iter().flatten().find(|item|
                    item.get("id").and_then(Value::as_str)==Some(task_id));
            if !active.is_some_and(|item|item.get("state").and_then(Value::as_str)==Some("RUNNING")
                &&item.get("executionId").and_then(Value::as_str)==Some(execution_id)){
                return Ok(current);
            }
            bind_interactive_invocation_snapshot(&current,task_id,execution_id,&now)
        };
        let committed=self.host.mutate_job(effective,&mut callback)?;
        let _=self.runtime.lock().map_err(|e|e.to_string())?
            .host_invocations.bind(effective,task_id,execution_id,&now,&committed)?;
        Ok(committed)
    }
    /// Native equivalent of the public Node bind(...).decision Promise:
    /// reserve the exact Job/Task/Execution generation in SQLite FIRST,
    /// then register a one-shot receiver. The receiver can wait for 60s
    /// (Node's default timeout) and only resolves on a durable acceptance.
    pub fn bind_interactive_invocation_with_waiter(
        &self,job_id:&str,task:&Value,execution_id:&str,
    )->Result<(Value,InteractiveDecisionWaiter),String>{
        let committed=self.bind_interactive_invocation(job_id,task,execution_id)?;
        let effective=task.get("jobId").and_then(Value::as_str)
            .filter(|value|!value.is_empty()).unwrap_or(job_id);
        let task_id=task.get("id").and_then(Value::as_str)
            .ok_or("Task identity missing for Host waiter")?;
        let now=chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true);
        let (_candidate,receiver)=self.runtime.lock()
            .map_err(|error|error.to_string())?.host_invocations.bind_with_waiter(
                effective,task_id,execution_id,&now,&committed)?;
        Ok((committed,receiver))
    }
    pub fn idle(&self){self.coordinator.settle();}
    pub fn close(&self)->Result<(),String>{
        self.coordinator.settle();
        self.runtime.lock().map_err(|e|e.to_string())?.close();
        Ok(())
    }
    pub fn runtime(&self)->Arc<Mutex<ReconcilerRuntime>>{
        Arc::clone(&self.runtime)
    }
    pub fn graph_directory(&self)->&std::path::Path{&self.directory}
}
