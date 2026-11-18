//! Concrete SQLite + Graph mutations for explicitly isolated native daemon
//! acceptance. Uses the same workspace_control()/SQLiteRelayStore paths as
//! production; provider launch, external events and unported actions fail
//! closed until their real adapters are installed. Never use live credentials.
use crate::{
    dashboard_actions::dashboard_job_set_state,
    git_delivery::source_commit_sha,
    interactive_request::fail_interactive_review,
    relay_store::SQLiteRelayStore,
    relay_store_discovery::relay_unified_store_path,
    relayd::{inventory_from_local,DaemonConfig,DaemonServices},
    relayd_control::{workspace_control,WorkspaceControlBackend},
};
use serde_json::{json,Value};
use std::{cell::{Ref,RefCell,RefMut},collections::{HashMap,HashSet},path::{Path,PathBuf},sync::mpsc::{self,Receiver,Sender}};
fn field<'a>(v:&'a Value,key:&str)->&'a str{v.get(key).and_then(Value::as_str).unwrap_or("")}
fn denied(name:&str)->String{format!("Rust isolated-write daemon {name} not bound; refusing unsafe side effect")}

pub struct IsolatedSQLiteWriteHost {
    config:DaemonConfig,
    subscriptions:Vec<Sender<String>>,
    wake_count:u64,
    connections:RefCell<HashMap<String,SQLiteRelayStore>>,
}
impl IsolatedSQLiteWriteHost {
    pub fn new(config:DaemonConfig)->Self{
        Self{config,subscriptions:Vec::new(),wake_count:0,connections:RefCell::new(HashMap::new())}
    }
    fn path(&self)->PathBuf{relay_unified_store_path(&self.config.store_directory)}
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
    fn emit(&mut self,value:Value){
        let payload=value.to_string();
        self.subscriptions.retain(|sender|sender.send(payload.clone()).is_ok());
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
    fn review_targeted(&mut self,_:&str,_:&Value)->Result<Value,String>{
        Err(denied("review_targeted"))
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
                "reason":"Worker and external Event providers not yet bound"}),
            Err(error)=>json!({"runtime":"native-rust","mode":"isolated-write",
                "productionReady":false,"error":error}),
        }
    }
    fn registered_agents(&mut self)->Result<Vec<Value>,String>{
        let mut seen=HashSet::new();let mut agents=Vec::new();
        for job in self.all()?{
            for agent in WorkspaceControlBackend::list_agents(self,field(&job,"id"))?{
                let key=field(&agent,"id").to_owned();
                if seen.insert(key){agents.push(agent)}
            }
        }
        Ok(agents)
    }
    fn effect(&mut self,_:&Value)->Result<(),String>{
        Err(denied("Worker or remote delivery effect"))
    }
}
