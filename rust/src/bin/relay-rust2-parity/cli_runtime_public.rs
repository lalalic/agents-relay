// Public CLI planner and Dashboard Job effect bridge for direct Node tests.
use agents_relay_rust2::{
    cli::{dashboard_job_action,runtime_planner},
    cli_runtime_public::{DashboardJobActionPorts,RuntimePlanner},
};
use serde_json::{json,Value};
use std::path::{Path,PathBuf};
struct Fixture { job:Value,calls:Vec<Value>,atomic:bool,graph:PathBuf }
impl DashboardJobActionPorts for Fixture {
    fn load_job(&mut self,id:&str)->Result<Value,String>{
        self.calls.push(json!(["load",id]));
        if self.job.is_null(){return Err(format!("Job {id} missing"));}
        Ok(self.job.clone())
    }
    fn save_job(&mut self,job:&Value)->Result<(),String>{
        self.calls.push(json!(["save",job["state"]]));
        self.job=job.clone();Ok(())
    }
    fn mutate_job(&mut self,id:&str,callback:&mut dyn FnMut(Value)->Result<Value,String>)
        ->Result<Value,String>{
        self.calls.push(json!(["mutate",id]));
        let next=callback(self.job.clone())?;
        self.job=next.clone();Ok(next)
    }
    fn has_atomic_mutate(&self)->bool{self.atomic}
    fn save_plan(&mut self,plan:&Value)->Result<(),String>{
        self.calls.push(json!(["savePlan",plan["id"],plan["status"]]));Ok(())
    }
    fn save_task(&mut self,task:&Value)->Result<(),String>{
        self.calls.push(json!(["saveTask",task["id"],task["state"]]));Ok(())
    }
    fn wake(&mut self,id:&str)->Result<Value,String>{
        self.calls.push(json!(["wake",id]));
        Ok(self.job.clone())
    }
    fn workflow_directory(&self)->&Path{&self.graph}
}
pub fn invoke(request:&Value)->Result<String,String>{
    if request["kind"]=="planner"{
        let args=request["args"].as_array().into_iter().flatten()
            .filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>();
        let result=runtime_planner(&args)?;
        return Ok(match result {
            RuntimePlanner::Agent(_)=>json!({"kind":"AgentObjectivePlanner"}),
            RuntimePlanner::Command(_)=>json!({"kind":"CommandObjectivePlanner"}),
        }.to_string());
    }
    let mut fixture=Fixture{
        job:request["job"].clone(),calls:vec![],atomic:request["atomic"]!=false,
        graph:PathBuf::from(request["root"].as_str().unwrap_or("."))
            .join("workflow")
    };
    let action=request["action"].as_str().unwrap_or("reconcile");
    let id=request["jobId"].as_str().unwrap_or("job1");
    let outcome=dashboard_job_action(&mut fixture,action,id);
    Ok(json!({"outcome":match outcome{
        Ok(value)=>json!({"ok":true,"value":value}),
        Err(error)=>json!({"ok":false,"error":error}),
    },"calls":fixture.calls,"job":fixture.job}).to_string())
}

/// The actual native CLI runtime factory constructs typed Planner and
/// Reconciler. Differential fixtures inspect its public configuration only.
pub fn factory(request:&Value)->Result<String,String>{
    use agents_relay_rust2::cli_runtime_public::RuntimePaths;
    let args=request["args"].as_array().into_iter().flatten()
        .filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>();
    let root=PathBuf::from(request["root"].as_str().unwrap_or("."));
    let result=agents_relay_rust2::cli_runtime_public::runtime(&args,
        RuntimePaths::for_fixture(&root));
    Ok(match result{
        Ok(runtime)=>{
            let mut selected=runtime.configured.clone();
            selected["plannerName"]=json!(match runtime.planner{
                RuntimePlanner::Agent(_)=>"AgentObjectivePlanner",
                RuntimePlanner::Command(_)=>"CommandObjectivePlanner",
            });
            selected["usageSnapshotProvider"]=json!("fn");
            selected["cwdForJob"]=json!("fn");
            selected["emit"]=json!("fn");
            json!({"ok":true,"value":selected}).to_string()
        },
        Err(error)=>json!({"ok":false,"error":error}).to_string()
    })
}
