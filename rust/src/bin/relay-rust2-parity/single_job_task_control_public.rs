// Original single-job-task-control.ts public API differential: the admission
// gate (JS String coercion), the bound-Job fence and the real canonical
// workspace control path over a fixture backend seeded with the request Job.
use agents_relay_rust2::relayd_control::{
    create_workspace_control,WorkspaceControlBackend,
};
use agents_relay_rust2::single_job_task_control::{
    create_single_job_task_control,validate_single_job_control,
};
use serde_json::{json,Value};
use std::future::Future;
use std::path::{Path,PathBuf};
use std::pin::pin;
use std::task::{Context,Poll,Waker};

fn drive<T>(future:impl Future<Output=T>)->T{
    let mut context=Context::from_waker(Waker::noop());
    let mut pinned=pin!(future);
    match pinned.as_mut().poll(&mut context){
        Poll::Ready(value)=>value,
        Poll::Pending=>panic!("control differential future must be immediately ready"),
    }
}
/// Fixture backend: one seeded Job, no external effects. Graph validation
/// happens on the real workflow graphs from the repository.
struct SeededBackend{
    graph_directory:PathBuf,
    job:Value,
}
impl WorkspaceControlBackend for SeededBackend{
    fn graph_directory(&self)->&Path{&self.graph_directory}
    fn store_directory(&self)->&Path{Path::new("/tmp")}
    fn repositories(&self)->Vec<String>{Vec::new()}
    fn repository_path(&self,_:&str)->Option<String>{None}
    fn known_jobs(&mut self)->Result<Vec<Value>,String>{Ok(vec![self.job.clone()])}
    fn load_job(&mut self,_:&str)->Result<Value,String>{Ok(self.job.clone())}
    fn save_job(&mut self,job:&Value)->Result<Value,String>{self.job=job.clone();Ok(job.clone())}
    fn create_job_if_absent(&mut self,job:&Value)->Result<Value,String>{
        self.job=job.clone();Ok(job.clone())}
    fn mutate_job(&mut self,_:&str,reducer:&dyn Fn(&mut Value)->Result<(),String>)
        ->Result<Value,String>{
        let mut job=self.job.clone();
        reducer(&mut job)?;
        self.job=job.clone();
        Ok(job)
    }
    fn append_task(&mut self,_:&str,_:&Value)->Result<Value,String>{
        Err("append_task is not part of the six admitted commands".into())}
    fn save_agent(&mut self,_:&str,_:&Value)->Result<(),String>{Ok(())}
    fn list_agents(&mut self,_:&str)->Result<Vec<Value>,String>{Ok(Vec::new())}
    fn wake(&mut self,_:&str,_:&str)->Result<(),String>{Ok(())}
    fn refresh_inventory(&mut self)->Result<(),String>{Ok(())}
    fn publish(&mut self,_:&Value)->Result<(),String>{Ok(())}
    fn manual_plan(&mut self,_:&str,_:Option<&str>,_:bool)
        ->Result<Value,String>{Err("unexpected manual_plan".into())}
    fn review_targeted(&mut self,_:&str,_:&Value)->Result<Value,String>{
        Err("unexpected review_targeted".into())}
    fn blocker_ensure(&mut self,_:&Value)->Result<Value,String>{
        Err("unexpected blocker_ensure".into())}
    fn blocker_resolve(&mut self,_:&str,_:&str)->Result<Value,String>{
        Err("unexpected blocker_resolve".into())}
    fn local_head(&mut self,_:&Value)->Result<String,String>{
        Err("unexpected local_head".into())}
    fn fail_interactive(&mut self,_:&str,_:&str,_:&str,_:&str)
        ->Result<Value,String>{Err("unexpected fail_interactive".into())}
}
pub fn invoke(request:&Value)->Option<Result<String,String>>{
    if request["op"]!="certSingleJobTaskControl"{return None;}
    Some((||{
        let job_id=request["jobId"].as_str().unwrap_or("17").to_string();
        let graph_dir=PathBuf::from(request["graphDir"].as_str()
            .ok_or("graphDir required")?);
        match request["method"].as_str().unwrap_or(""){
            "validate"=>match validate_single_job_control(&job_id,&request["body"]){
                Ok(())=>Ok(json!({"ok":true}).to_string()),
                Err(message)=>Ok(json!({"ok":false,"error":message}).to_string()),
            },
            "control"=>{
                let mut backend=SeededBackend{
                    graph_directory:graph_dir,
                    job:request["job"].clone(),
                };
                let future=create_single_job_task_control(&job_id,
                    &request["body"],move |body|async move{
                        let mut control=create_workspace_control(&mut backend);
                        control(&body)
                    });
                match drive(future){
                    Ok(value)=>Ok(json!({"ok":true,"value":value}).to_string()),
                    Err(message)=>Ok(json!({"ok":false,"error":message}).to_string()),
                }
            },
            value=>Err(format!("Unknown single-job-task-control method {value}")),
        }
    })())
}
