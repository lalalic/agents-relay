// Launch Plan Node/Rust deterministic host with native owned invocation.
use agents_relay_rust2::{
    planner_runtime::{PlannerFinishPorts,PlannerLaunchPorts,launch_plan_execution},
};
use serde_json::{json,Value};
use std::{path::{Path,PathBuf},sync::{Arc,Mutex},time::{Duration,Instant}};
struct Fixture{
    job:Value,calls:Vec<Value>,live:Option<String>,store:PathBuf,
    has_planner:bool,atomic:bool,result:Value,error:Option<String>,context_error:Option<String>,
    now:String,run_ms:u64,
}
impl PlannerFinishPorts for Fixture{
    fn atomic_available(&self)->bool{self.atomic}
    fn load(&mut self,id:&str)->Result<Value,String>{
        self.calls.push(json!(["load",id]));Ok(self.job.clone())
    }
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
        }Ok(())
    }
    fn execution_context(&mut self,_job:&Value,_plan:&Value)->Result<Value,String>{
        self.calls.push(json!(["context"]));
        if let Some(error)=&self.context_error{return Err(error.clone());}
        Ok(json!({}))
    }
    fn registered_workers(&mut self)->Result<Vec<Value>,String>{
        self.calls.push(json!(["workers"]));Ok(vec![])
    }
    fn emit(&mut self,event:&Value)->Result<(),String>{
        self.calls.push(json!(["emit",event["type"]]));Ok(())
    }
    fn reconcile(&mut self,id:&str,_pid:&str,context:&str)->Result<(),String>{
        self.calls.push(json!(["reconcile",id,context]));Ok(())
    }
    fn detached_reconcile(&mut self,id:&str,pid:&str,_why:&str){
        self.calls.push(json!(["detach",id,pid]));
    }
    fn release_live(&mut self,id:&str,execution:Option<&str>){
        if self.live.is_some()&&self.live.as_deref()==execution{
            self.calls.push(json!(["release",id]));self.live=None;
        }
    }
    fn has_live(&self,_id:&str,execution:Option<&str>)->bool{
        self.live.is_some()&&self.live.as_deref()==execution
    }
    fn store_directory(&self)->&Path{&self.store}
}
impl PlannerLaunchPorts for Fixture{
    fn has_planner(&self)->bool{self.has_planner}
    fn owner(&self)->&str{"relay"}
    fn now(&self)->String{self.now.clone()}
    fn timeout_ms(&self)->u64{120_000}
    fn head_sha(&mut self)->Result<Option<String>,String>{
        self.calls.push(json!(["headSha"]));Ok(None)
    }
    fn save_claimed_plan(&mut self,id:&str,plan:&Value)->Result<(),String>{
        self.calls.push(json!(["savePlan",plan["id"],plan["status"]]));
        self.save_plan_without_log(id,plan)
    }
    fn register_live(&mut self,id:&str,execution:&str,timeout:u64)->Result<(),String>{
        self.calls.push(json!(["live",id,timeout]));
        self.live=Some(execution.to_owned());Ok(())
    }
    fn begin_planner(&mut self,_context:Value,_timeout_ms:u64)
        ->Result<Box<dyn FnOnce()->Result<Value,String>+Send>,String>{
        self.calls.push(json!(["plan"]));
        let result=self.result.clone();let error=self.error.clone();
        let delay=self.run_ms;
        Ok(Box::new(move||{
            if delay>0{std::thread::sleep(Duration::from_millis(delay));}
            if let Some(error)=error{return Err(error);}
            Ok(result)
        }))
    }
    fn detached_failure(&mut self,_job:&str,_plan:&str,error:&str){
        self.calls.push(json!(["detached_failure",error]));
    }
    fn detached_started(&mut self,id:&str,pid:&str){
        self.calls.push(json!(["detach",id,pid]));
    }
}
impl Fixture{
    fn save_plan_without_log(&mut self,_id:&str,plan:&Value)->Result<(),String>{
        if let Some(current)=self.job["plans"].as_array_mut()
            .and_then(|plans|plans.iter_mut().find(|p|p["id"]==plan["id"])){
            *current=plan.clone();
        }Ok(())
    }
}
pub fn invoke(request:&Value)->Result<String,String>{
    let root=PathBuf::from(request["root"].as_str().unwrap_or("."));
    let f=Fixture{job:request["job"].clone(),calls:vec![],
        live:request["live"].as_str().map(str::to_owned),
        store:root.join(".rust2-planner-fixture-id-sequence"),
        has_planner:request["planner"]!=false,
        atomic:request["atomic"]!=false,
        result:request.get("raw").cloned().unwrap_or(Value::Null),
        error:request["error"].as_str().map(str::to_owned),
        context_error:request["contextError"].as_str().map(str::to_owned),
        now:request["now"].as_str().unwrap_or("2026-11-18T09:00:00.000Z").into(),
        run_ms:request["delayMs"].as_u64().unwrap_or(0)};
    let host=Arc::new(Mutex::new(f));
    let job=request["job"].clone();
    let plan=request.get("plan").filter(|p|!p.is_null()).cloned()
        .or_else(||request["job"].get("plans").and_then(Value::as_array)
            .into_iter().flatten().find(|p|p["id"]==request["planId"])
            .cloned()).unwrap_or(Value::Null);
    let wait=request["wait"]!=false;
    let outcome=launch_plan_execution(Arc::clone(&host),&root.join("workflow"),
        &job,&plan,wait);
    if !wait&&request["settle"]==true{
        let start=Instant::now();
        loop{
            let finished={
                let state=host.lock().map_err(|e|e.to_string())?;
                state.live.is_none()&&state.calls.iter().any(|c|
                    c[0]=="emit"&&(c[1]=="planner.retry"||c[1]=="planner.completed"))
            };
            if finished||start.elapsed()>Duration::from_secs(5){break;}
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    let state=host.lock().map_err(|e|e.to_string())?;
    Ok(json!({"outcome":match outcome{
        Ok(())=>json!({"ok":true}),Err(error)=>json!({"ok":false,"error":error})},
        "job":state.job,"calls":state.calls,"live":state.live,
        "planner":state.has_planner}).to_string())
}
