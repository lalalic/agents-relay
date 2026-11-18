use agents_relay_rust2::{reconciler::Reconciler,
    reconciler_durable::ReconcileHost};
use serde_json::{json,Value};
use std::path::PathBuf;
struct Host{job:Value,calls:Vec<Value>,reject_write:bool}
impl ReconcileHost for Host{
 fn load(&mut self,id:&str)->Result<Value,String>{
     self.calls.push(json!(["load",id]));Ok(self.job.clone())
 }
 fn load_execution_process(&mut self,_job_id:&str,_task_id:&str,
     _execution_id:&str)->Result<Option<Value>,String>{Ok(None)}
 fn persist(&mut self,id:&str,prior:&Value,next:&Value)->Result<Value,String>{
     self.calls.push(json!(["persist",id]));
     if self.reject_write{return Err("SQLite generation changed".into());}
     if &self.job!=prior{return Err("SQLite CAS conflict".into());}
     self.job=next.clone();Ok(next.clone())
 }
 fn launch(&mut self,action:&Value)->Result<(),String>{
     self.calls.push(json!(["launch",action["action"]]));Ok(())
 }
 fn broadcast(&mut self,event:&Value)->Result<(),String>{
     self.calls.push(json!(["broadcast",event["type"]]));Ok(())
 }
}
pub fn invoke(req:&Value)->Result<String,String>{
 let root=PathBuf::from(req["root"].as_str().unwrap_or("."));
 let mut host=Host{job:req["job"].clone(),calls:Vec::new(),
     reject_write:req["rejectWrite"]==true};
 let mut rec=Reconciler::new(root.join("workflow"),std::env::temp_dir().join(format!("rust2-h2h-reconcile-{}",std::process::id())),
     &root,&root,&root,json!({"owner":"fixture","maxConcurrent":4}));
 let result=rec.reconcile(req["jobId"].as_str().unwrap_or("1"),
     req["head"].as_str(),&root,&json!({}),&[],&[],None,&mut host);
 Ok(json!({"outcome":match result{
     Ok(job)=>json!({"ok":true,"value":job}),
     Err(message)=>json!({"ok":false,"error":message})
 },"job":host.job,"calls":host.calls}).to_string())
}
