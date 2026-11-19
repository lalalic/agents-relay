//! Concrete SQLite + Graph mutations for explicitly isolated native daemon
//! acceptance. Uses the same workspace_control()/SQLiteRelayStore paths as
//! production; provider launch, external events and unported actions fail
//! closed until their real adapters are installed. Never use live credentials.
use crate::{
    dashboard_actions::dashboard_job_set_state,
    git_delivery::source_commit_sha,
    local_merge_delivery::{native_merge_effect,reconcile_local_git_completion},
    local_git_merge::{local_source_head,git as checked_local_git},
    local_merge_projection::reconcile_completed_local_delivery,
    agent_script_discovery::discover_script_agent,
    native_script_execution::run_claimed_script_task,
    native_worker_event_ingress::apply_verified_worker_event,
    native_script_worker::configured_script_interpreter,
    reconciler::Reconciler,
    interactive_request::fail_interactive_review,
    relay_store::SQLiteRelayStore,
    relay_store_discovery::relay_unified_store_path,
    relayd::{inventory_from_local,DaemonConfig,DaemonServices},
    relayd_control::{workspace_control,WorkspaceControlBackend},
};
use serde_json::{json,Value};
use std::{cell::{Ref,RefCell,RefMut},collections::{HashMap,HashSet},future::{ready,Future},path::{Path,PathBuf},pin::pin,sync::mpsc::{self,Receiver,Sender},task::{Context,Poll,Waker}};
fn field<'a>(v:&'a Value,key:&str)->&'a str{v.get(key).and_then(Value::as_str).unwrap_or("")}
fn denied(name:&str)->String{format!("Rust isolated-write daemon {name} not bound; refusing unsafe side effect")}

pub struct IsolatedSQLiteWriteHost {
    config:DaemonConfig,
    subscriptions:Vec<Sender<String>>,
    wake_count:u64,
    reconcile_attempts:u64,
    connections:RefCell<HashMap<String,SQLiteRelayStore>>,
}
impl IsolatedSQLiteWriteHost {
    pub fn new(config:DaemonConfig)->Self{
        Self{config,subscriptions:Vec::new(),wake_count:0,reconcile_attempts:0,connections:RefCell::new(HashMap::new())}
    }
    fn path(&self)->PathBuf{relay_unified_store_path(&self.config.store_directory)}
    /// Isolated writes must be confined to the same disposable caller-owned
    /// workspace as SQLite. A copied Job snapshot pointing at a live source
    /// checkout cannot authorize either a Script Worker or a Git merge/push.
    fn isolated_project(&self,job:&Value)->Result<PathBuf,String>{
        let root=std::fs::canonicalize(field(job,"projectRoot"))
            .map_err(|e|format!("Invalid isolated Job projectRoot: {e}"))?;
        let base=std::fs::canonicalize(
            self.config.store_directory.parent().ok_or("Isolated store has no parent")?)
            .map_err(|e|e.to_string())?;
        if root==base || !root.starts_with(&base)
            || root.file_name().and_then(|v|v.to_str())!=Some(field(job,"repository"))
            ||!root.join(".git").is_dir(){
            return Err("Isolated Rust daemon refuses Job project outside its own independent Git fixture".into());
        }
        Ok(root)
    }
    fn ensure_scoped(&self,id:&str,allow_create:bool)->Result<(),String>{
        if id.is_empty(){return Err("Immutable Job ID required".into());}
        if self.connections.borrow().contains_key(id){return Ok(());}
        if !allow_create&&!self.path().is_file(){
            return Err(format!("SQLite Job {id} not found"));
        }
        let store=SQLiteRelayStore::open_without_claim_reset(&self.path(),Some(id))?;
        self.connections.borrow_mut().insert(id.to_string(),store);
        Ok(())
    }
    fn scoped(&self,id:&str)->Result<Ref<'_,SQLiteRelayStore>,String>{
        self.ensure_scoped(id,false)?;
        Ok(Ref::map(self.connections.borrow(),|stores|stores.get(id).expect("cached scoped DB")))
    }
    fn scoped_create(&self,id:&str)->Result<RefMut<'_,SQLiteRelayStore>,String>{
        self.ensure_scoped(id,true)?;
        Ok(RefMut::map(self.connections.borrow_mut(),|stores|
            stores.get_mut(id).expect("cached scoped DB")))
    }
    fn all(&self)->Result<Vec<Value>,String>{inventory_from_local(&self.config,false)}
    fn persist_exact(&self,id:&str,prior:&Value,next:&Value)->Result<Value,String>{
        if field(prior,"id")!=id||field(next,"id")!=id{
            return Err("Cross-Job SQLite CAS forbidden".into());
        }
        let expected=prior.clone();let candidate=next.clone();
        self.scoped(id)?.mutate_job(id,|current|{
            if current!=expected{
                return Err("Concurrent Job mutation; recompute from SQLite snapshot".into());
            }
            Ok(candidate)
        })
    }
    fn isolated_origin(&self,project:&Path)->Result<(),String>{
        let names=checked_local_git(project,&["remote"])?;
        if !names.lines().any(|name|name=="origin"){return Ok(());}
        let url=checked_local_git(project,&["remote","get-url","--push","origin"])?;
        let raw=Path::new(&url);
        if !raw.is_absolute(){
            return Err("Isolated native daemon refuses network or relative Git origin delivery".into());
        }
        let origin=std::fs::canonicalize(raw)
            .map_err(|e|format!("Invalid isolated Git origin: {e}"))?;
        let parent=std::fs::canonicalize(
            self.config.store_directory.parent().ok_or("Isolated store parent missing")?)
            .map_err(|e|e.to_string())?;
        if !origin.starts_with(parent){
            return Err("Isolated native daemon refuses delivery outside its own Git fixture".into());
        }
        Ok(())
    }
    /// Internal EventBus adapter port. Caller authentication remains the
    /// responsibility of the future provider transport: source correlation
    /// alone is NOT authentication. Never expose this as an open HTTP/CLI
    /// command or treat a submission receipt as Worker completion.
    pub fn accept_model_worker_event(&mut self,job_id:&str,task_id:&str,
        execution_id:&str,event:&Value)->Result<Value,String>{
        let job=self.scoped(job_id)?.load_job(job_id)?
            .ok_or_else(||format!("SQLite Job {job_id} not found"))?;
        self.isolated_project(&job)?;
        let result=apply_verified_worker_event(&self.path(),&self.config.graph_directory,
            job_id,task_id,execution_id,event)?;
        // Notifications and scheduling are post-commit effects. A submitted
        // browser receipt or a speculative provider callback must never
        // notify Dashboard that an uncommitted Task succeeded.
        self.emit(event.clone());
        if matches!(field(event,"type"),"task.completed"|"task.failed"){
            self.wake(job_id,"native-model-worker.terminal")?;
        }
        Ok(result)
    }
    pub fn reconcile_remote_delivery(&self,id:&str,expected_sha:&str)->Result<(),String>{
        let job=self.scoped(id)?.load_job(id)?
            .ok_or_else(||format!("SQLite Job {id} not found"))?;
        if job.pointer("/localMerge/mergedCommitSha").and_then(Value::as_str)
            !=Some(expected_sha) || expected_sha.is_empty(){
            return Err("Remote delivery expected SHA no longer matches SQLite completion".into());
        }
        let project=self.isolated_project(&job)?;
        self.isolated_origin(&project)?;
        let graph=self.config.graph_directory.clone();
        reconcile_completed_local_delivery(&graph,id,&project,
            |job_id|self.scoped(job_id)?.load_job(job_id)?
                .ok_or_else(||format!("SQLite Job {job_id} not found")),
            |job_id,mutate|{
                let mut changed=false;
                let saved=self.scoped(job_id)?.mutate_job(job_id,|mut job|{
                    changed=mutate(&mut job)?;
                    Ok(job)
                })?;
                Ok((saved,changed))
            })
    }
    fn emit(&mut self,value:Value){
        let payload=value.to_string();
        self.subscriptions.retain(|sender|sender.send(payload.clone()).is_ok());
    }
    /// Current Job Graph invokes this effect; the shared local Git module
    /// owns immutable source/target ref checks and completion guard. Each
    /// SQLite snapshot/merge receipt uses an exact CAS, never overwriting
    /// concurrent Task/Review progress.
    pub fn reconcile_git_delivery(&self,id:&str)->Result<bool,String>{
        let mut job=self.scoped(id)?.load_job(id)?
            .ok_or_else(||format!("SQLite Job {id} not found"))?;
        if field(&job,"state")!="ACTIVE"{return Ok(false);}
        let project=self.isolated_project(&job)?;
        let ref_name=job.pointer("/localMerge/sourceRef")
            .and_then(Value::as_str).filter(|s|!s.is_empty());
        let head=ref_name.map(|ref_name|local_source_head(&project,ref_name))
            .transpose()?;
        let timestamp=chrono::Utc::now().timestamp_millis();
        let graph=self.config.graph_directory.clone();
        let prior=RefCell::new(job.clone());
        let save=|candidate:Value,event:Option<Value>|{
            let outcome=(||->Result<Value,String>{
                let expected=prior.borrow().clone();
                let db=self.scoped(id)?;
                let committed=if let Some(event)=event{
                    let key=event.get("event_id").and_then(Value::as_str)
                        .ok_or("Merge result has no durable event identity")?;
                    db.commit_workflow_mutation_and_events(id,|current|{
                        if current!=expected{return Err("Concurrent Job merge receipt CAS conflict".into());}
                        Ok(candidate)
                    },&[json!({"key":key,"event":event})])?
                }else{
                    db.mutate_job(id,|current|{
                        if current!=expected{return Err("Concurrent Job completion CAS conflict".into());}
                        Ok(candidate)
                    })?
                };
                prior.replace(committed.clone());
                Ok(committed)
            })();
            ready(outcome)
        };
        let future=reconcile_local_git_completion(&graph,&mut job,head.as_deref(),
            true,Some(&project),timestamp,save,native_merge_effect);
        // This action's save adapter is entirely synchronous SQLite I/O.
        // A pending Future would be a wiring bug, never a reason to mark
        // a Job complete without committed source/target evidence.
        let mut future=pin!(future);
        let mut ctx=Context::from_waker(Waker::noop());
        match future.as_mut().poll(&mut ctx){
            Poll::Ready(result)=>result,
            Poll::Pending=>Err("Native local Git completion effect unexpectedly suspended".into())
        }
    }
}
impl WorkspaceControlBackend for IsolatedSQLiteWriteHost {
    fn graph_directory(&self)->&Path{&self.config.graph_directory}
    fn store_directory(&self)->&Path{&self.config.store_directory}
    fn repositories(&self)->Vec<String>{self.config.repositories.clone()}
    fn repository_path(&self,repository:&str)->Option<String>{
        self.all().ok()?.into_iter().find(|j|field(j,"repository")==repository)
            .and_then(|j|j.get("projectRoot").and_then(Value::as_str).map(str::to_owned))
    }
    fn known_jobs(&mut self)->Result<Vec<Value>,String>{self.all()}
    fn load_job(&mut self,id:&str)->Result<Value,String>{
        self.scoped(id)?.load_job(id)?.ok_or_else(||format!("SQLite Job {id} not found"))
    }
    fn save_job(&mut self,job:&Value)->Result<Value,String>{
        let id=field(job,"id");
        self.scoped(id)?.save_job(job)?;Ok(job.clone())
    }
    fn create_job_if_absent(&mut self,job:&Value)->Result<Value,String>{
        let id=field(job,"id");
        self.scoped_create(id)?.create_job_if_absent(job)
    }
    fn mutate_job(&mut self,id:&str,reduce:&dyn Fn(&mut Value)->Result<(),String>)
        ->Result<Value,String>{
        self.scoped(id)?.mutate_job(id,|mut job|{reduce(&mut job)?;Ok(job)})
    }
    fn append_task(&mut self,id:&str,task:&Value)->Result<Value,String>{
        if field(task,"jobId")!=id||field(task,"id").is_empty(){
            return Err("Task create requires immutable Job/Task identity".into());
        }
        self.scoped(id)?.mutate_job(id,|mut job|{
            let list=job.get_mut("tasks").and_then(Value::as_array_mut)
                .ok_or("Job Task list unavailable")?;
            if list.iter().any(|row|field(row,"id")==field(task,"id")){
                return Err("Task ID already allocated".into());
            }
            list.push(task.clone());Ok(job)
        })
    }
    fn save_agent(&mut self,id:&str,agent:&Value)->Result<(),String>{
        self.scoped(id)?.upsert_agent(agent)
    }
    fn list_agents(&mut self,id:&str)->Result<Vec<Value>,String>{
        Ok(self.scoped(id)?.load_agents()?.unwrap_or_default())
    }
    fn wake(&mut self,id:&str,reason:&str)->Result<(),String>{
        self.wake_count+=1;
        self.emit(json!({"type":"relay.wake","jobId":id,"reason":reason}));
        Ok(())
    }
    fn refresh_inventory(&mut self)->Result<(),String>{
        // Dashboard reads the authoritative SQLite inventory per request.
        Ok(())
    }
    fn publish(&mut self,event:&Value)->Result<(),String>{
        // SSE is ephemeral observability. A delivery receipt is not a durable
        // execution fact and never advances Task state.
        self.emit(event.clone());Ok(())
    }
    fn manual_plan(&mut self,_:&str,_:Option<&str>,_:bool)->Result<Value,String>{
        Err(denied("manual_plan"))
    }
    fn review_targeted(&mut self,id:&str,request:&Value)->Result<Value,String>{
        // Only the exact reviewer execution and immutable reviewed HEAD can
        // submit a correction. Atomic SQLite mutation allocates one numeric
        // child ID, appends the feedback and enqueues the Revision Graph task.
        let mut input=request.clone();
        if input.get("originalTaskId").is_some()
            &&input["originalTaskId"]!=input["taskId"]{
            return Err("Reviewer original Task identity conflicts with requested Task".into());
        }
        input["originalTaskId"]=input["taskId"].clone();
        let directory=self.config.store_directory.clone();
        let graph=self.config.graph_directory.clone();
        self.scoped(id)?.submit_review_revision(&directory,&graph,id,&input)
    }
    fn blocker_ensure(&mut self,_:&Value)->Result<Value,String>{Err(denied("blocker_ensure"))}
    fn blocker_resolve(&mut self,_:&str,_:&str)->Result<Value,String>{Err(denied("blocker_resolve"))}
    fn local_head(&mut self,job:&Value)->Result<String,String>{source_commit_sha(job)}
    fn fail_interactive(&mut self,id:&str,task:&str,execution:&str,reason:&str)
        ->Result<Value,String>{
        fail_interactive_review(&self.config.graph_directory,&*self.scoped(id)?,id,task,execution,reason)
    }
}
impl DaemonServices for IsolatedSQLiteWriteHost {
    fn control(&mut self,body:&Value)->Result<Value,String>{workspace_control(self,body)}
    fn load(&mut self,id:&str)->Result<Value,String>{WorkspaceControlBackend::load_job(self,id)}
    fn load_execution_process(&mut self,id:&str,task:&str,execution:&str)
        ->Result<Option<Value>,String>{
        self.scoped(id)?.load_execution_process(id,task,execution)
    }
    fn save_exact(&mut self,id:&str,prior:&Value,next:&Value)->Result<Value,String>{
        self.persist_exact(id,prior,next)
    }
    fn job_action(&mut self,_:&str,_:&str)->Result<Value,String>{Err(denied("job_action"))}
    fn task_command(&mut self,_:&Value)->Result<Value,String>{Err(denied("task_command"))}
    fn task_action(&mut self,_:&str,_:&str,_:&str)->Result<Value,String>{Err(denied("task_action"))}
    fn job_set_state(&mut self,id:&str,state:&str,_target:&Value)->Result<Value,String>{
        let original=WorkspaceControlBackend::load_job(self,id)?;
        let (next,remote)=dashboard_job_set_state(&self.config.graph_directory,&original,state)?;
        if remote{return Err(denied("remote job state effect"));}
        self.persist_exact(id,&original,&next)
    }
    fn task_set_state(&mut self,_:&str,_:&str,_:&str,_:&Value)
        ->Result<Value,String>{Err(denied("task_set_state"))}
    fn event_history(&mut self,_:&str,_:Option<&str>,_:i64)->Result<Vec<Value>,String>{
        Err(denied("historical Event query"))
    }
    fn publish_event(&mut self,event:&Value)->Result<(),String>{
        WorkspaceControlBackend::publish(self,event)
    }
    fn subscribe_events(&mut self)->Receiver<String>{
        let (sender,receiver)=mpsc::channel();
        self.subscriptions.push(sender);receiver
    }
    fn router_test(&mut self,_:&str,_:&str)->Result<Value,String>{Err(denied("router_test"))}
    fn decision_audit(&mut self)->Result<Vec<Value>,String>{Err(denied("decision_audit"))}
    fn account_usage(&mut self)->Result<Value,String>{Err(denied("provider account usage"))}
    fn github_usage(&mut self)->Result<Option<Value>,String>{Ok(None)}
    fn status(&mut self)->Value{
        match self.all(){
            Ok(jobs)=>json!({"runtime":"native-rust","mode":"isolated-write",
                "productionReady":false,"jobCount":jobs.len(),"wakeCount":self.wake_count,
                "reconcileAttempts":self.reconcile_attempts,
                "reason":"Worker and external Event providers not yet bound"}),
            Err(error)=>json!({"runtime":"native-rust","mode":"isolated-write",
                "productionReady":false,"error":error}),
        }
    }
    fn reconcile_local_completion(&mut self,id:&str)->Result<bool,String>{
        self.reconcile_git_delivery(id)
    }
    fn registered_agents(&mut self)->Result<Vec<Value>,String>{
        self.reconcile_attempts+=1;
        let mut seen=HashSet::new();let mut agents=Vec::new();
        for job in self.all()?{
            for agent in WorkspaceControlBackend::list_agents(self,field(&job,"id"))?{
                let key=field(&agent,"id").to_owned();
                if seen.insert(key){agents.push(agent)}
            }
        }
        Ok(agents)
    }
    fn effect(&mut self,action:&Value)->Result<(),String>{
        if field(action,"action")=="effect.remoteDelivery"{
            return self.reconcile_remote_delivery(
                field(action,"jobId"),field(action,"expectedMergedCommitSha"));
        }
        if field(action,"action")!="effect.launchTask"{
            return Err(denied("Planner or unsupported Worker effect"));
        }
        let id=field(action,"jobId");
        let task_id=field(action,"taskId");
        let original=WorkspaceControlBackend::load_job(self,id)?;
        let task=original.get("tasks").and_then(Value::as_array).into_iter().flatten()
            .find(|task|field(task,"id")==task_id)
            .ok_or("Unregistered Worker Task")?;
        // Only Script Shortcut Workers are installed in this isolated host.
        // All other adapters remain fail-closed and cannot reserve a lease.
        if field(task,"adapter")!="script"{
            return Err(denied("non-Script Worker adapter"));
        }
        let project=self.isolated_project(&original)?;
        let script=discover_script_agent(field(task,"agentName"),
            field(&original,"projectRoot"),None,
            self.config.workspace_root.to_str(),None)?
            .ok_or("Source Worker has no declared trusted Shortcut")?;
        if !Path::new(&script).is_file(){return Err("Script Agent module is absent".into());}
        let isolated_parent=std::fs::canonicalize(
            self.config.store_directory.parent().ok_or("Isolated store parent missing")?)
            .map_err(|e|e.to_string())?;
        let output=task.pointer("/output/path").and_then(Value::as_str)
            .ok_or("Native Script Worker requires a declared file output")?;
        let output_parent=Path::new(output).parent()
            .ok_or("Native Script Worker output path has no parent")?;
        let output_existing=output_parent.ancestors()
            .find(|path|path.exists())
            .and_then(|path|std::fs::canonicalize(path).ok())
            .ok_or("Native Script Worker output parent cannot be canonicalized")?;
        if task.pointer("/output/kind")!=Some(&json!("file"))
            || !Path::new(output).is_absolute()
            || !output_existing.starts_with(&isolated_parent){
            return Err("Native Script Worker output must remain inside the isolated job root".into());
        }
        let runtime=configured_script_interpreter()?;
        let mut reconciler=Reconciler::new(
            self.config.graph_directory.clone(),self.config.store_directory.clone(),
            self.config.profile_home.clone(),self.config.policy_path.clone(),
            self.config.router_rules_path.clone(),
            json!({"owner":format!("isolated-rust-daemon-{}",std::process::id()),
                "maxConcurrent":self.config.concurrency,"leaseMs":self.config.lease_ms}),
        );
        let claimed=reconciler.claim_task_execution(&original,task_id,
            self.config.lease_ms)?.ok_or("Script Task no longer eligible for launch")?;
        // One immutable generation claim, committed via same transactional CAS.
        self.persist_exact(id,&original,&claimed)?;
        let task=claimed.get("tasks").and_then(Value::as_array).into_iter().flatten()
            .find(|task|field(task,"id")==task_id).cloned()
            .ok_or("Script Task vanished during lease claim")?;
        let path=self.path();
        let graph=self.config.graph_directory.clone();
        let runtime=PathBuf::from(runtime);
        let timeout=task.get("timeoutMs").and_then(Value::as_u64)
            .unwrap_or(900_000).clamp(100,86_400_000);
        let job_id=id.to_string();let task_id=task_id.to_string();
        std::thread::Builder::new().name(format!("rust-script-task-{task_id}"))
            .spawn(move||{
                if let Err(error)=run_claimed_script_task(
                    &path,&graph,&claimed,&task,&runtime,timeout){
                    eprintln!("Rust Script Worker {job_id}/{task_id}: {error}");
                }
            }).map_err(|e|format!("Cannot launch owned Script Worker executor: {e}"))?;
        Ok(())
    }
}
