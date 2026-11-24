//! Actual SQLite-backed read-only daemon host, not a fixture that fabricates
//! Job state. This is the isolated first stage of the native daemon entrypoint:
//! operational mutations and Worker launch remain fail-closed until their
//! concrete Graph+SQLite services are bound and independently verified.
use crate::{
    relayd::{inventory_from_local,exact_job,managed_view,DaemonConfig,DaemonServices},
    relay_store_discovery::discover_unified_job_by_id,
};
use serde_json::{json,Value};
use std::sync::mpsc::{self,Receiver};

pub struct ReadOnlySQLiteHost {
    config:DaemonConfig,
    shadow_live:bool,
}
impl ReadOnlySQLiteHost {
    pub fn new(config:DaemonConfig)->Self {Self{config,shadow_live:false}}
    /// Explicit production-store shadow: never owns a Worker/Graph mutation,
    /// even if the underlying SQLite happens to be the active Node store.
    pub fn new_live_shadow(config:DaemonConfig)->Self {
        Self{config,shadow_live:true}
    }
    fn rejected(operation:&str)->Result<Value,String>{
        Err(format!("Rust Relay {operation} denied: isolated read-only host has no mutation or Worker execution binding"))
    }
}
impl DaemonServices for ReadOnlySQLiteHost {
    fn is_read_only_shadow(&self)->bool{self.shadow_live}
    fn control(&mut self,_body:&Value)->Result<Value,String>{Self::rejected("control")}
    fn load(&mut self,id:&str)->Result<Value,String>{
        if self.shadow_live{
            let snapshot=discover_unified_job_by_id(&self.config.store_directory,id)?
                .ok_or_else(||format!("SQLite Job {id} not found"))?;
            let job=snapshot.jobs.first().ok_or("Indexed Job snapshot is empty")?;
            if !self.config.repositories.is_empty()
                &&!self.config.repositories.iter().any(|repo|repo==job["repository"].as_str().unwrap_or("")){
                return Err(format!("SQLite Job {id} not found"));
            }
            return Ok(managed_view(&snapshot,job));
        }
        exact_job(&inventory_from_local(&self.config,false)?,id,None)?
            .ok_or_else(||format!("SQLite Job {id} not found"))
    }
    fn save_exact(&mut self,_id:&str,_prior:&Value,_next:&Value)->Result<Value,String>{
        Self::rejected("save_exact")
    }
    fn job_action(&mut self,_id:&str,_action:&str)->Result<Value,String>{Self::rejected("job_action")}
    fn task_command(&mut self,_body:&Value)->Result<Value,String>{Self::rejected("task_command")}
    fn task_action(&mut self,_id:&str,_task_id:&str,_action:&str)->Result<Value,String>{
        Self::rejected("task_action")
    }
    fn job_set_state(&mut self,_id:&str,_state:&str,_target:&Value)->Result<Value,String>{
        Self::rejected("job_set_state")
    }
    fn task_set_state(&mut self,_id:&str,_task_id:&str,_state:&str,_target:&Value)->Result<Value,String>{
        Self::rejected("task_set_state")
    }
    fn event_history(&mut self,_id:&str,_task_id:Option<&str>,_limit:i64)
        ->Result<Vec<Value>,String>{Err("Read-only daemon event history port unavailable".into())}
    fn publish_event(&mut self,_event:&Value)->Result<(),String>{
        Err("Read-only daemon event bus publish disabled".into())
    }
    fn subscribe_events(&mut self)->Receiver<String>{mpsc::channel().1}
    fn router_test(&mut self,_id:&str,_task_id:&str)->Result<Value,String>{
        Self::rejected("router_test")
    }
    fn decision_audit(&mut self)->Result<Vec<Value>,String>{
        crate::decision_audit::dashboard_records(&self.config.store_directory)
    }
    fn account_usage(&mut self)->Result<Value,String>{Self::rejected("account_usage")}
    fn github_usage(&mut self)->Result<Option<Value>,String>{Ok(None)}
    fn status(&mut self)->Value{
        match inventory_from_local(&self.config,false){
            Ok(jobs)=>json!({
                "runtime":"native-rust",
                "mode":if self.shadow_live{"shadow-live-read-only"}else{"read-only"},
                "productionReady":false,"jobCount":jobs.len(),
                "reason":"No Worker effect, Graph mutation or event transport bound",
            }),
            Err(error)=>json!({
                "runtime":"native-rust",
                "mode":if self.shadow_live{"shadow-live-read-only"}else{"read-only"},
                "productionReady":false,"error":error,
            }),
        }
    }
    fn registered_agents(&mut self)->Result<Vec<Value>,String>{
        Err("Read-only daemon agent registry unavailable".into())
    }
    fn effect(&mut self,_action:&Value)->Result<(),String>{
        Err("Read-only daemon cannot launch or complete Workers".into())
    }
}
