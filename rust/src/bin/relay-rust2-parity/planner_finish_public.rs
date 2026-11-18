// Direct Node finishPlanner host-effect and durable candidate comparison.
use agents_relay_rust2::planner_runtime::{finish_planner,PlannerFinishPorts};
use serde_json::{json,Value};
use std::path::{Path,PathBuf};
struct Fixture{
    job:Value,calls:Vec<Value>,live:Option<String>,atomic:bool,store:PathBuf,
    registered:Vec<Value>,context:Value,reconcile_error:Option<String>,
    registration:bool,
}
impl PlannerFinishPorts for Fixture{
    fn load(&mut self,id:&str)->Result<Value,String>{
        self.calls.push(json!(["load",id]));Ok(self.job.clone())
    }
    fn atomic_available(&self)->bool{self.atomic}
    fn mutate(&mut self,id:&str,callback:&mut dyn FnMut(Value)->Result<Value,String>)
        ->Result<Value,String>{
        self.calls.push(json!(["mutate",id]));
        let next=callback(self.job.clone())?;
        self.job=next.clone();Ok(next)
    }
    fn save_plan(&mut self,plan:&Value)->Result<(),String>{
        self.calls.push(json!(["savePlan",plan["id"],plan["status"]]));
        if let Some(current)=self.job["plans"].as_array_mut()
            .and_then(|plans|plans.iter_mut().find(|p|p["id"]==plan["id"])){
            *current=plan.clone();
        }
        Ok(())
    }
    fn execution_context(&mut self,_job:&Value,_plan:&Value)->Result<Value,String>{
        self.calls.push(json!(["context"]));Ok(self.context.clone())
    }
    fn registered_workers(&mut self)->Result<Vec<Value>,String>{
        self.calls.push(json!(["workers"]));Ok(self.registered.clone())
    }
    fn emit(&mut self,event:&Value)->Result<(),String>{
        self.calls.push(json!(["emit",event["type"]]));Ok(())
    }
    fn can_register_unblock(&self)->bool{self.registration}
    fn register_unblock(&mut self,_job_id:&str,_unblock:&Value)->Result<(),String>{
        self.calls.push(json!(["register"]));Ok(())
    }
    fn reconcile(&mut self,id:&str,_plan_id:&str,why:&str)->Result<(),String>{
        self.calls.push(json!(["reconcile",id,why]));
        if let Some(error)=&self.reconcile_error{return Err(error.clone())}
        Ok(())
    }
    fn release_live(&mut self,id:&str,execution_id:Option<&str>){
        if self.live.is_some()&&self.live.as_deref()==execution_id{
            self.calls.push(json!(["release",id]));self.live=None;
        }
    }
    fn has_live(&self,_id:&str,execution_id:Option<&str>)->bool{
        self.live.as_deref()==execution_id
    }
    fn store_directory(&self)->&Path{&self.store}
}
pub fn invoke(request:&Value)->Result<String,String>{
    let root=PathBuf::from(request["root"].as_str().unwrap_or("."));
    let store=root.join(".rust2-planner-fixture-id-sequence");
    let id=request["planId"].as_str().unwrap_or("plan-1");
    let mut fixture=Fixture{
        job:request["job"].clone(),calls:vec![],
        live:request["live"].as_str().map(str::to_owned),
        atomic:request["atomic"]!=false,store,
        registered:request["workers"].as_array().cloned().unwrap_or_default(),
        context:request["context"].clone(),
        reconcile_error:request["reconcileError"].as_str().map(str::to_owned),
        registration:request["registration"]==true,
    };
    let outcome=finish_planner(&mut fixture,&root.join("workflow"),
        request["jobId"].as_str().unwrap_or("41"),id,
        request["executionId"].as_str(),request["error"].as_str(),
        request.get("raw"),request["cliApply"]==true);
    Ok(json!({"outcome":match outcome{
        Ok(())=>json!({"ok":true}),
        Err(error)=>json!({"ok":false,"error":error})
    },"job":fixture.job,"calls":fixture.calls,"live":fixture.live}).to_string())
}

/// Call the real native Reconciler public method, not the Planner helper
/// directly. The same host ports record durable effects for differential tests.
pub fn apply_tree(request:&Value)->Result<String,String>{
    use agents_relay_rust2::reconciler::Reconciler;
    let root=PathBuf::from(request["root"].as_str().unwrap_or("."));
    let mut fixture=Fixture{
        job:request["job"].clone(),calls:vec![],
        live:request["live"].as_str().map(str::to_owned),
        atomic:request["atomic"]!=false,
        store:root.join(".rust2-planner-fixture-id-sequence"),
        registered:request["workers"].as_array().cloned().unwrap_or_default(),
        context:request["context"].clone(),reconcile_error:None,
        registration:request["registration"]==true,
    };
    let mut reconciler=Reconciler::new(root.join("workflow"),
        &root,&root,&root,&root,json!({"owner":"relay"}));
    let outcome=reconciler.apply_planner_tree(&mut fixture,
        request["jobId"].as_str().unwrap_or("41"),
        request["planId"].as_str().unwrap_or("plan-1"),
        request["executionId"].as_str().unwrap_or("ex1"),
        &request["proposal"]);
    Ok(json!({"outcome":match outcome{
        Ok(plan)=>json!({"ok":true,"value":plan}),
        Err(error)=>json!({"ok":false,"error":error})
    },"job":fixture.job,"calls":fixture.calls,"live":fixture.live}).to_string())
}
