// Head-to-head Phase1 port: src/pool.ts
// Repository-local Worker Pool. All Job and Task changes go through the
// native Reconciler/Store and canonical Graphs; GitHub webhooks are
// observational, not triggers for mutable execution.
use crate::{
    dag_task_runtime::unified_dag,
    events::event_for,
    final_review_role::is_final_review_agent,
    job_execution_slot::job_has_active_execution,
    planner::pending_plan,
    review_replan::{review_plan_ready,review_work_settled},
    troubleshooter::{
        pending_troubleshooter_reopens,pending_troubleshooter_retries,
        pending_troubleshooter_tasks,
    },
    workflow::{
        planner_orchestration_v2::{
            decide_planner_orchestration,planner_orchestration_facts,
        },
        review_v2::decide_review_lifecycle,
    },
};
use chrono::{DateTime,Utc};
use serde_json::{json,Value};
use std::{
    collections::{HashMap,HashSet},path::Path,sync::{Arc,Mutex},
};
fn field<'a>(v:&'a Value,key:&str)->&'a str{
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn rows<'a>(v:&'a Value,key:&str)->&'a [Value]{
    v.get(key).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}
fn priority(job:&Value)->u8{
    match field(job,"priority"){"P0"=>0,"P1"=>1,"P3"=>3,_=>2}
}
pub fn compare_job_priority(a:&Value,b:&Value)->std::cmp::Ordering{
    priority(a).cmp(&priority(b))
        .then_with(||crate::dashboard_data::locale_compare(field(a,"createdAt"),field(b,"createdAt")))
        .then_with(||crate::dashboard_data::locale_compare(field(a,"id"),field(b,"id")))
}
pub fn runnable_managed_jobs(items:&[Value])->Vec<Value>{
    let mut jobs=items.iter().filter_map(|item|item.get("job"))
        .filter(|job|field(job,"state")=="ACTIVE").cloned().collect::<Vec<_>>();
    jobs.sort_by(compare_job_priority);
    jobs
}
pub fn terminal_managed_jobs(_items:&[Value])->Vec<Value>{Vec::new()}
/// Node aggregateManagedGitHubJobs: query each distinct repository through the
/// real GitHub Store reader, then sort projections by newest update and PR.
/// GitHub metadata is only a projection; local SQLite owns lifecycle.
pub fn aggregate_managed_github_jobs<C:crate::store_github::GitHubApi>(
    client:&mut C,repositories:&[String],trusted_authors:&HashSet<String>,
)->Result<Vec<Value>,String>{
    let mut seen=HashSet::<&str>::new();
    let mut rows=Vec::new();
    let mut first_error=None;
    // Promise.all in Node starts every distinct query even when one rejects.
    for repository in repositories{
        if !seen.insert(repository.as_str()){continue;}
        match crate::store::list_managed_github_jobs(client,repository,trusted_authors){
            Ok(mut group)=>rows.append(&mut group),
            Err(error)=>{if first_error.is_none(){first_error=Some(error);}}
        }
    }
    if let Some(error)=first_error{return Err(error);}
    rows.sort_by(|a,b|{
        crate::dashboard_data::locale_compare(
            field(&b["job"],"updatedAt"),field(&a["job"],"updatedAt"))
        .then_with(||{
            let left=a.pointer("/job/prNumber").and_then(Value::as_i64).unwrap_or(0);
            let right=b.pointer("/job/prNumber").and_then(Value::as_i64).unwrap_or(0);
            right.cmp(&left)
        })
    });
    Ok(rows)
}
fn millis(value:&str)->Option<i64>{
    DateTime::parse_from_rfc3339(value).ok().map(|time|time.timestamp_millis())
}
pub fn needs_lifecycle_reconciliation(
    directory:&Path,job:&Value,now:i64,
)->Result<bool,String>{
    let tasks=rows(job,"tasks");
    let plans=rows(job,"plans");
    if job.get("pause").is_some_and(|v|!v.is_null()){
        return Ok(tasks.iter().any(|t|t.get("pausedExecution")
            .is_some_and(|v|!v.is_null()))
            ||plans.iter().any(|p|p.get("pausedExecutionId")
                .is_some_and(|v|!v.is_null())));
    }
    // A DRAFT Job created without Tasks must not schedule itself.
    if tasks.is_empty(){return Ok(false);}
    if field(job,"state")=="ACTIVE"
        &&job.pointer("/localMerge/status").and_then(Value::as_str)==Some("failed")
        &&job.pointer("/localMerge/nextAttemptAt").and_then(Value::as_str)
            .and_then(millis).is_none_or(|until|until<=now){
        return Ok(true);
    }
    let planning=decide_planner_orchestration(directory,
        &planner_orchestration_facts(job,pending_plan(job).is_some()))?;
    if planning.get("accepted")==Some(&Value::Bool(true))
        &&planning.get("actions").and_then(Value::as_array)
            .is_some_and(|actions|!actions.is_empty()){
        return Ok(true);
    }
    if !pending_troubleshooter_tasks(directory,directory,job)?.is_empty()
        ||!pending_troubleshooter_reopens(job).is_empty()
        ||!pending_troubleshooter_retries(job).is_empty(){
        return Ok(true);
    }
    if field(job,"state")=="ACTIVE" &&field(job,"headSha").is_empty()
        &&!field(job,"projectRoot").is_empty()
        &&job.get("reviewEnabled")!=Some(&Value::Bool(false))
        &&review_work_settled(directory,job)?{
        return Ok(true);
    }
    if field(job,"state")=="ACTIVE"&&!field(job,"headSha").is_empty()
        &&job.get("reviewEnabled")!=Some(&Value::Bool(false)){
        let head=field(job,"headSha");
        let review_tasks=tasks.iter().filter(|t|
            is_final_review_agent(t.get("agentName").and_then(Value::as_str))
                &&field(t,"reviewHeadSha")==head).collect::<Vec<_>>();
        let current=tasks.iter().find(|task|
            task.get("id")==job.pointer("/review/taskId"));
        let facts=json!({
            "reviewEnabled":true,"jobActive":true,"headAvailable":true,
            "reviewWorkSettled":review_work_settled(directory,job)?,
            "reviewPlanReady":review_plan_ready(job),
            "noActiveReviewTask":!review_tasks.iter().any(|task|
                matches!(field(task,"state"),"DRAFT"|"QUEUED"|"RUNNING")),
            "noApprovedCurrentReview":!review_tasks.iter().any(|task|
                field(task,"state")=="SUCCEEDED"
                &&job.pointer("/review/headSha").and_then(Value::as_str)==Some(head)
                &&job.pointer("/review/outcome").and_then(Value::as_str)==Some("approved")),
            "currentReviewCancelled":current.is_some_and(|task|
                field(task,"reviewHeadSha")==head&&field(task,"state")=="CANCELLED")
        });
        let decision=decide_review_lifecycle(directory,
            job.pointer("/review/outcome").and_then(Value::as_str),
            "reconcile",&facts)?;
        if decision.get("accepted")==Some(&Value::Bool(true))
            &&decision.get("actions").and_then(Value::as_array).is_some_and(
                |actions|actions.iter().any(|a|
                    a.get("id").and_then(Value::as_str)==Some("review.create"))){
            return Ok(true);
        }
    }
    if tasks.iter().any(|t|unified_dag(job,t)&&field(t,"state")=="RUNNING"){
        return Ok(true);
    }
    if tasks.iter().any(|t|(
        field(t,"state")=="QUEUED"&&t.get("executionId").is_none_or(Value::is_null))
        ||(field(t,"state")=="RUNNING" &&field(t,"adapter")=="orchestrator"
            &&t.get("executionId").is_none_or(Value::is_null))
        ||(field(t,"state")=="DRAFT"&&!rows(t,"dependencies").is_empty())){
        return Ok(true);
    }
    Ok(tasks.iter().any(|t|{
        matches!(field(t,"state"),"RUNNING"|"QUEUED")
        &&t.get("executionId").is_some_and(|v|!v.is_null())
        &&t.get("leaseExpiresAt").and_then(Value::as_str)
            .and_then(millis).is_some_and(|expires|expires<=now)
    }))
}
pub fn active_worker_slots(job:&Value)->usize{
    let tasks=rows(job,"tasks");
    if !tasks.iter().any(|t|t.get("dagNode").is_some_and(|v|!v.is_null())){
        return usize::from(job_has_active_execution(job,None,None));
    }
    let leased=tasks.iter().filter(|task|{
        task.get("executionId").is_some_and(|v|!v.is_null())
            &&!field(task,"leaseOwner").is_empty()
            &&matches!(field(task,"state"),"RUNNING"|"QUEUED")
            &&!unified_dag(job,task)
    }).count();
    let planning=rows(job,"plans").iter().filter(|p|
        p.get("executionId").is_some_and(|v|!v.is_null())
            &&field(p,"status")=="PLANNING").count();
    leased+planning
}
pub fn remaining_worker_slots(concurrency:usize,jobs:&[Value])->usize{
    let mut unique=HashMap::new();
    for job in jobs{unique.insert(field(job,"id"),job);}
    let in_use=unique.values().filter(|job|field(job,"state")=="ACTIVE")
        .map(|job|active_worker_slots(job)).sum::<usize>();
    concurrency.saturating_sub(in_use)
}
fn signal_reason(event:&Value)->String{
    if field(event,"type")=="github.webhook"{
        let webhook=event.pointer("/data/event").and_then(Value::as_str)
            .unwrap_or("unknown");
        let action=event.pointer("/data/action").and_then(Value::as_str)
            .map(|s|format!(":{s}")).unwrap_or_default();
        return format!("github.webhook:{webhook}{action}");
    }
    format!("event.{}",field(event,"type"))
}
pub fn is_lifecycle_event(event:&Value)->bool{
    matches!(field(event,"type"),
        "task.started"|"task.progress"|"task.completed"|"task.failed"|
        "task.blocked"|"task.unblocked"|"task.cancelled"|
        "review.started"|"review.approved"|"review.changes_required"|
        "review.blocked"|"task.interactive_decision")
}
pub fn event_wake_signal(event:&Value)->Option<Value>{
    if field(event,"type")=="github.webhook"{return None;}
    let event_type=field(event,"type");
    let lifecycle=is_lifecycle_event(event);
    let wake=matches!(event_type,"job.wake"|"review.created"|"planner.completed");
    if !wake && !lifecycle{return None;}
    let mut signal=json!({"jobId":event.get("job_id"),
        "reason":signal_reason(event)});
    if lifecycle{signal["event"]=event.clone();}
    Some(signal)
}
/// The sync native Pool accepts authoritative Store and Reconciler ports.
/// Caller supplies an already-verified local Job inventory. No IO or
/// concurrent Job execution is launched while source migration runs.
pub struct RepositoryWorkerPool {
    pub concurrency:usize,
    pub graph_directory:std::path::PathBuf,
    running:bool,
    pending:bool,
    in_reconcile:HashSet<String>,
    published:HashSet<String>,
}
impl RepositoryWorkerPool{
    pub fn new(concurrency:usize,graph_directory:impl Into<std::path::PathBuf>)->Self{
        Self{concurrency,graph_directory:graph_directory.into(),
            running:false,pending:false,in_reconcile:HashSet::new(),
            published:HashSet::new()}
    }
    /// Node RepositoryWorkerPool.reconcileKnown: startup recovery runs for
    /// ACTIVE Jobs before ordinary capacity scheduling. The injected ports
    /// correspond to the local Store hydration and Reconciler recovery.
    pub fn reconcile_known<Lookup,Hydrate,Recover,Execute>(
        &mut self,discovered:&[Value],
        mut lookup:Lookup,mut hydrate:Hydrate,mut recover:Recover,
        mut execute:Execute,
    )->Result<(),String>
    where
        Lookup:FnMut(&str)->Result<Option<Value>,String>,
        Hydrate:FnMut(&str,&Value)->Result<(),String>,
        Recover:FnMut(&str)->Result<Option<Value>,String>,
        Execute:FnMut(&str,usize)->Result<Value,String>,
    {
        let mut recovered=Vec::with_capacity(discovered.len());
        for item in discovered{
            let job=&item["job"];
            if field(job,"state")!="ACTIVE"{
                recovered.push(item.clone());
                continue;
            }
            let id=field(job,"id");
            if lookup(id)?.is_none(){
                return Err(format!("Authoritative SQLite Job is not registered: {id}"));
            }
            hydrate(id,job)?;
            if !self.in_reconcile.insert(id.to_owned()){
                return Err(format!("Duplicate concurrent Reconcile for {id}"));
            }
            let restore=recover(id);
            self.in_reconcile.remove(id);
            let next=restore?.unwrap_or_else(||job.clone());
            let mut updated=item.clone();
            updated["job"]=next;
            recovered.push(updated);
        }
        // Node reconcileDiscovered hydrates each ACTIVE projection a second
        // time, only after a local Store was resolved and while capacity is
        // available. Keep that ordering inside the resolver used by the
        // existing capacity scheduler, not in an unconditional pre-pass.
        let snapshots=recovered.iter().filter_map(|item|{
            item.get("job").and_then(|job|job.get("id").and_then(Value::as_str)
                .map(|id|(id.to_owned(),job.clone())))
        }).collect::<HashMap<_,_>>();
        self.reconcile_discovered(&recovered,
            |id|{
                let current=lookup(id)?;
                if current.is_some(){
                    if let Some(snapshot)=snapshots.get(id){hydrate(id,snapshot)?;}
                }
                Ok(current)
            },&mut execute)?;
        Ok(())
    }
    pub fn reconcile_job<Lookup,Reconcile>(
        &mut self,job_id:&str,mut lookup:Lookup,
        mut reconcile:Reconcile,
    )->Result<Value,String>
    where
        Lookup:FnMut(&str)->Result<Option<Value>,String>,
        Reconcile:FnMut(&str,usize)->Result<Value,String>,
    {
        if !self.in_reconcile.insert(job_id.into()){
            return Err(format!("Duplicate concurrent Reconcile for {job_id}"));
        }
        let result=(||{
            let job=lookup(job_id)?.ok_or_else(||
                format!("Local job not found: {job_id}"))?;
            let has_dag=field(&job,"state")=="ACTIVE"
                &&rows(&job,"tasks").iter().any(|t|unified_dag(&job,t));
            let slots=if has_dag{self.concurrency.saturating_sub(
                active_worker_slots(&job))}else{0};
            reconcile(job_id,slots)
        })();
        self.in_reconcile.remove(job_id);
        result
    }
    pub fn reconcile_discovered<Resolve,Recover>(
        &mut self,discovered:&[Value],
        mut resolve:Resolve,mut reconcile:Recover,
    )->Result<Vec<Value>,String>
    where
        Resolve:FnMut(&str)->Result<Option<Value>,String>,
        Recover:FnMut(&str,usize)->Result<Value,String>,
    {
        let jobs=runnable_managed_jobs(discovered);
        let mut capacity=remaining_worker_slots(self.concurrency,&jobs);
        let mut updated=Vec::new();
        for job in jobs{
            if capacity==0{break;}
            let id=field(&job,"id").to_owned();
            if !self.in_reconcile.insert(id.clone()){continue;}
            let run:Result<Option<(Option<Value>,usize)>,String>=(||{
                let local=resolve(&id)?.ok_or_else(||
                    format!("Authoritative SQLite Job is not registered: {id}"))?;
                if !needs_lifecycle_reconciliation(&self.graph_directory,
                    &local,Utc::now().timestamp_millis())?{
                    return Ok(None);
                }
                let ready=rows(&local,"tasks").iter().filter(|task|
                    (field(task,"state")=="QUEUED"
                        &&task.get("executionId").is_none_or(Value::is_null))
                    ||(field(task,"state")=="DRAFT"
                        &&!rows(task,"dependencies").is_empty())).count();
                let expired=rows(&local,"tasks").iter().any(|t|
                    matches!(field(t,"state"),"RUNNING"|"QUEUED")
                    &&t.get("executionId").is_some_and(|v|!v.is_null())
                    &&t.get("leaseExpiresAt").and_then(Value::as_str)
                        .and_then(millis).is_some_and(
                            |time|time<=Utc::now().timestamp_millis()));
                let allowance=if ready>0||expired{
                    capacity.min(ready.max(1)).max(1)
                }else{0};
                // Node catches only the per-Job Reconciler effect error.
                // Local SQLite lookup, Graph eligibility and hydration errors
                // remain fail-closed and propagate to the caller.
                let result=match reconcile(&id,allowance){
                    Ok(value)=>Some(value),
                    Err(error)=>{
                        // Preserve reconciliation failures in the daemon log:
                        // the pool intentionally keeps serving other Jobs,
                        // but the originating Job must not fail silently.
                        eprintln!("warning: Rust Relay Job {id} reconcile failed: {error}");
                        crate::observability::observability().record(&json!({
                            "stage":"reconcile","event":"reconcile.job_failed",
                            "level":"error","outcome":"failed",
                            "message":format!("Reconcile failed for {id}: {error}"),
                            "correlation":{"jobId":id,"repository":field(&job,"repository"),
                                "prNumber":job.get("prNumber")},
                            "data":{"classification":"job-isolated"}
                        }));
                        None
                    }
                };
                Ok(Some((result,allowance)))
            })();
            self.in_reconcile.remove(&id);
            if let Some((value,used))=run?{
                capacity=capacity.saturating_sub(used);
                if let Some(value)=value{updated.push(value);}
            }
        }
        Ok(updated)
    }
    pub fn reconcile<Inventory,Resolve,Execute>(
        &mut self,mut inventory:Inventory,mut resolve:Resolve,
        mut execute:Execute,
    )->Result<(),String>
    where
        Inventory:FnMut()->Result<Vec<Value>,String>,
        Resolve:FnMut(&str)->Result<Option<Value>,String>,
        Execute:FnMut(&str,usize)->Result<Value,String>,
    {
        if self.running{self.pending=true;return Ok(());}
        self.running=true;
        let result=(||{
            loop{
                self.pending=false;
                let jobs=inventory()?;
                self.reconcile_discovered(&jobs,&mut resolve,&mut execute)?;
                if !self.pending{break;}
            }
            Ok(())
        })();
        self.running=false;
        result
    }
    pub fn consume_signals<Lookup,Apply,Reconcile>(
        &mut self,job_id:&str,signals:&[Value],
        mut lookup:Lookup,mut apply:Apply,
        mut reconcile:Reconcile,
    )->Result<(),String>
    where
        Lookup:FnMut(&str)->Result<Option<Value>,String>,
        Apply:FnMut(&Value)->Result<Value,String>,
        Reconcile:FnMut(&str,usize)->Result<Value,String>,
    {
        if lookup(job_id)?.is_none(){return Ok(());}
        let mut should=false;
        for signal in signals{
            let Some(event)=signal.get("event").filter(|v|!v.is_null())
                else{should=true;continue;};
            if field(event,"type")=="github.webhook"{continue;}
            let outcome=apply(event)?;
            should|=outcome.get("reconcile")==Some(&Value::Bool(true));
        }
        if should{self.reconcile_job(job_id,lookup,reconcile)?;}
        Ok(())
    }
    pub fn reconcile_target(&self,job_id:&str,reason:&str)->Option<Value>{
        if reason.starts_with("github.webhook:"){return None;}
        Some(json!({"jobId":job_id,"reason":reason}))
    }
    /// Node webhookWake: publish the observation events in order and stop on
    /// the first EventBus error. No bus means no side effect or execution wake.
    pub fn webhook_wake(
        &self,job:&Value,wake:&Value,
        mut publish:Option<&mut dyn FnMut(&Value)->Result<(),String>>,
    )->Result<(),String>{
        let Some(ref mut send)=publish else{return Ok(());};
        for event in self.webhook_wake_events(job,wake){send(&event)?;}
        Ok(())
    }
    pub fn webhook_wake_events(&self,job:&Value,wake:&Value)->Vec<Value>{
        let job_id=field(job,"id");
        let delivery=field(wake,"deliveryId");
        let repo=field(job,"repository");
        let source=json!({"id":format!("github/{repo}/delivery/{delivery}"),
            "component":"github-webhook"});
        let mut emitted=Vec::new();
        if let Some(published)=wake.get("publication").filter(|v|!v.is_null()){
            let package=field(published,"package");
            let version=field(published,"version");
            let mut data=json!({"deliveryId":delivery,"repository":repo,
                "package":package,"version":version});
            if let Some(number)=job.get("prNumber"){data["prNumber"]=number.clone();}
            for key in ["registry","sha"]{
                if let Some(value)=published.get(key){data[key]=value.clone();}
            }
            let mut event=event_for(job_id,"release",None,
                "package.published","succeeded",
                &format!("Published {package}@{version}"),
                Some("orchestrator"),Some(data),Some(source.clone()));
            event["event_id"]=json!(format!(
                "github:{job_id}:{delivery}:package.published"));
            emitted.push(event);
        }
        if let Some(failed)=wake.get("publishFailure").filter(|v|!v.is_null()){
            let mut data=failed.clone();
            if !data.is_object(){data=json!({});}
            data["repository"]=json!(repo);
            if let Some(number)=job.get("prNumber"){data["prNumber"]=number.clone();}
            data["deliveryId"]=json!(delivery);
            let mut event=event_for(job_id,"release",None,
                "package.publish_failed","failed",
                &format!("Publish workflow {} failed: {}",
                    field(failed,"runId"),field(failed,"stage")),
                Some("user"),Some(data),Some(source.clone()));
            event["event_id"]=json!(format!(
                "github:{job_id}:{delivery}:package.publish_failed"));
            emitted.push(event);
        }
        let mut data=json!({"deliveryId":delivery,"repository":repo});
        for key in ["event","action"]{
            if let Some(value)=wake.get(key){data[key]=value.clone();}
        }
        if let Some(number)=job.get("prNumber"){data["prNumber"]=number.clone();}
        emitted.push(event_for(job_id,"github",None,
            "github.webhook","queued",
            &format!("GitHub webhook {}{}",
                field(wake,"event"),
                if field(wake,"action").is_empty(){String::new()}
                else{format!(":{}",field(wake,"action"))}),
            Some("orchestrator"),Some(data),Some(source)));
        emitted
    }
}


#[path="pool_public_ports.rs"]
mod pool_public_ports;
pub use pool_public_ports::PoolEventBus;
impl RepositoryWorkerPool {
    /// Node reconcileLocalJob: local SQLite lookup, direct DAG continuation,
    /// then capacity scheduling. No GitHub discovery or independent policy.
    pub fn reconcile_local_job<Resolve,Load,Inventory,Execute>(
        &mut self,job_id:&str,resolve:Resolve,load:Load,
        inventory:Inventory,execute:Execute,
    )->Result<(),String>
    where
        Resolve:FnMut(&str)->Result<Option<Value>,String>,
        Load:FnMut(&str)->Result<Value,String>,
        Inventory:FnMut()->Result<Vec<Value>,String>,
        Execute:FnMut(&str,usize)->Result<Value,String>,
    {
        pool_public_ports::reconcile_local_job(self,job_id,resolve,load,inventory,execute)
    }
    /// Node watch: subscribe and release exactly one EventBus handler.
    pub fn watch(&self,bus:&dyn PoolEventBus,
        coordinator:&crate::reconcile_coordinator::ReconcileCoordinator)
        ->Result<Box<dyn FnOnce()+Send>,String>{
        pool_public_ports::watch(bus,coordinator)
    }
    /// Node webhookSignal rejects unresolved delivery by doing nothing.
    pub fn webhook_signal(&self,_bus:Option<&dyn PoolEventBus>,_wake:&Value)
        ->Result<(),String>{Ok(())}
}
