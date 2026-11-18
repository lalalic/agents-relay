// Node ReconcilerReviewBase: authoritative review Graph/SQLite state changes.
// This is an owned host adapter, not an alternative review policy engine.
use crate::{
    reconciler_review::{self,ReviewSnapshot},
    reconciler_runtime_base::{ReconcilerRuntimeBase,RuntimeBaseStore},
};
use serde_json::{json,Value};
use std::{path::{Path,PathBuf},sync::Arc};

pub trait ReviewBaseHost:RuntimeBaseStore{
    fn current_head_sha(&self,job:&Value)->Result<Option<String>,String>{
        Ok(reconciler_review::review_head(job,None))
    }
    fn registered_agents(&self)->Result<Vec<Value>,String>{Ok(vec![])}
    fn usage_snapshot(&self)->Result<Option<Value>,String>{Ok(None)}
    fn launch(&self,job:&Value,task:&Value)->Result<(),String>;
}
pub struct ReconcilerReviewBase<P:ReviewBaseHost>{
    pub runtime:ReconcilerRuntimeBase,
    pub host:Arc<P>,
    graph:PathBuf,store_directory:PathBuf,
    profile_home:PathBuf,policy_path:PathBuf,rules_path:PathBuf,
    adapters:Vec<Value>,options:Value,
}
impl<P:ReviewBaseHost> ReconcilerReviewBase<P>{
    pub fn new(graph:impl Into<PathBuf>,store_directory:impl Into<PathBuf>,
        profile_home:impl Into<PathBuf>,policy_path:impl Into<PathBuf>,
        rules_path:impl Into<PathBuf>,adapters:Vec<Value>,options:Value,
        host:Arc<P>)->Self{
        let graph=graph.into();
        let owner=options.get("owner").and_then(Value::as_str)
            .unwrap_or("relay");
        let runtime=ReconcilerRuntimeBase::new(&graph,owner,15000,
            Arc::clone(&host) as Arc<dyn RuntimeBaseStore>);
        Self{runtime,host,graph,store_directory:store_directory.into(),
            profile_home:profile_home.into(),policy_path:policy_path.into(),
            rules_path:rules_path.into(),adapters,options}
    }
    pub fn current_head_sha(&self,job:&Value)->Result<Option<String>,String>{
        self.host.current_head_sha(job)
    }
    fn commit_snapshot(&self,id:&str,
        f:impl Fn(&Value)->Result<ReviewSnapshot,String>)->Result<ReviewSnapshot,String>{
        let mut effect:Option<ReviewSnapshot>=None;
        let mut commit=|current:Value|{
            let snapshot=f(&current)?;
            let job=snapshot.job.clone();
            effect=Some(snapshot);
            Ok(job)
        };
        self.host.mutate_job(id,&mut commit)?;
        let result=effect.ok_or("Review Graph SQLite mutation was not executed")?;
        // Emit/release only after durable commit of the exact Graph outcome.
        for event in &result.events{self.host.emit(event)?;}
        let guard=self.runtime.runtime();
        let mut runtime=guard.lock().map_err(|e|e.to_string())?;
        for execution in &result.cancel_execution_ids{
            for task in result.job.get("tasks").and_then(Value::as_array)
                .into_iter().flatten(){
                runtime.cancel_execution_generation(id,
                    task.get("id").and_then(Value::as_str).unwrap_or(""),
                    execution);
            }
        }
        Ok(result)
    }
    pub fn invalidate_stale_review(&self,job_id:&str,
        head:Option<&str>)->Result<ReviewSnapshot,String>{
        self.commit_snapshot(job_id,|job|
            reconciler_review::invalidate_stale_review(&self.graph,job,head))
    }
    pub fn select_reviewer(&self,job:&Value)->Result<Value,String>{
        let registered=self.host.registered_agents()?;
        let usage=self.host.usage_snapshot()?;
        reconciler_review::route_reviewer(&self.graph,job,&self.options,
            &self.adapters,&registered,usage.as_ref(),
            &self.profile_home,&self.policy_path,&self.rules_path)
    }
    pub fn ensure_final_review(&self,job_id:&str,head:Option<&str>,
        explicit_route:Option<&Value>)->Result<ReviewSnapshot,String>{
        let job=self.host.load_job(job_id)?;
        // Worker routing is executed only when native review Graph may
        // create a Task, so no provider availability check for settled jobs.
        let facts=reconciler_review::review_facts(&self.graph,&job,head)?;
        let route=if explicit_route.is_some(){explicit_route.cloned()}
            else if facts.get("reviewEnabled")==Some(&Value::Bool(true))
                &&facts.get("jobActive")==Some(&Value::Bool(true))
                &&facts.get("reviewWorkSettled")==Some(&Value::Bool(true))
                &&facts.get("headAvailable")==Some(&Value::Bool(true))
                &&facts.get("reviewPlanReady")==Some(&Value::Bool(true))
                &&facts.get("noActiveReviewTask")==Some(&Value::Bool(true))
                &&facts.get("noApprovedCurrentReview")==Some(&Value::Bool(true)){
                Some(self.select_reviewer(&job)?)
            }else{None};
        self.commit_snapshot(job_id,|current|
            reconciler_review::ensure_final_review(&self.graph,&self.store_directory,
                current,head,route.as_ref(),
                self.options.get("reviewer").unwrap_or(&json!({}))))
    }
    pub fn route_task_for_execution(&self,job_id:&str,task_id:&str)
        ->Result<ReviewSnapshot,String>{
        let registered=self.host.registered_agents()?;
        let usage=self.host.usage_snapshot()?;
        self.commit_snapshot(job_id,|job|{
            let task=job.get("tasks").and_then(Value::as_array)
                .into_iter().flatten().find(|task|
                    task.get("id").and_then(Value::as_str)==Some(task_id))
                .ok_or_else(||format!("Task {task_id} not found"))?;
            reconciler_review::route_task_for_execution(&self.graph,
                &self.profile_home,&self.policy_path,&self.rules_path,
                job,task,&self.adapters,&registered,usage.as_ref(),&self.options)
        })
    }
    pub fn apply_review_event(&self,event:&Value)->Result<ReviewSnapshot,String>{
        let job_id=event.get("job_id").and_then(Value::as_str)
            .ok_or("Review event missing job_id")?;
        let candidate=self.host.load_job(job_id)?;
        let current_head=self.current_head_sha(&candidate)?;
        self.commit_snapshot(job_id,|job|
            reconciler_review::apply_review_event(&self.graph,job,event,
                current_head.as_deref()))
    }
    pub fn handle_event(&self,event:Value)->Result<(),String>{
        let kind=event.get("type").and_then(Value::as_str).unwrap_or("");
        if matches!(kind,"review.started"|"review.approved"|
            "review.changes_required"){
            let effect=self.apply_review_event(&event)?;
            if effect.wake{
                self.runtime.wake(event.get("job_id").and_then(Value::as_str)
                    .ok_or("Review event missing job_id")?)?;
            }
            return Ok(());
        }
        self.runtime.handle_event(event)
    }
    pub fn launch(&self,job:&Value,task:&Value)->Result<(),String>{
        self.host.launch(job,task)
    }
    pub fn graph(&self)->&Path{&self.graph}
}
