//! Isolated Planner Shortcut: real Rust-owned Script process, canonical
//! PlannerLaunchPorts/finishPlanner, Graph-selected Plan Apply and SQLite CAS.
//! This never substitutes for an unconnected production model Planner.
use crate::{
    events::event_for,
    local_merge_lock::iso8601_now,
    native_script_worker::invoke_trusted_script_recorded,
    planner_launch_public::{launch_plan_execution,PlannerLaunchPorts},
    planner_runtime_public::PlannerFinishPorts,
    process_identity::capture_process_record,
    relay_store::SQLiteRelayStore,
    job_execution_slot::job_has_active_execution,
};
use serde_json::{json,Value};
use std::{
    path::{Path,PathBuf},sync::{Arc,Mutex,atomic::AtomicBool},
};
fn field<'a>(v:&'a Value,key:&str)->&'a str{
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn store(db:&Path,id:&str)->Result<SQLiteRelayStore,String>{
    SQLiteRelayStore::open_without_claim_reset(db,Some(id))
}
struct PlannerPorts {
    db:PathBuf,store_directory:PathBuf,
    script:PathBuf,interpreter:PathBuf,
    owner:String,timeout_ms:u64,
    live:Option<String>,
}
impl PlannerFinishPorts for PlannerPorts {
    fn load(&mut self,id:&str)->Result<Value,String>{
        store(&self.db,id)?.load_job(id)?.ok_or("Planner Job not found".into())
    }
    fn mutate(&mut self,id:&str,callback:&mut dyn FnMut(Value)->Result<Value,String>)
        ->Result<Value,String>{
        store(&self.db,id)?.mutate_job(id,callback)
    }
    fn execution_context(&mut self,job:&Value,_plan:&Value)->Result<Value,String>{
        Ok(json!({"project":{"path":job.get("projectRoot"),
            "gitRoot":job.get("projectRoot"),
            "repository":job.get("repository")}}))
    }
    fn registered_workers(&mut self)->Result<Vec<Value>,String>{
        // A Planner cannot promise a Codex/Z worker while those production
        // adapters remain unconnected. Only an actual explicitly configured
        // isolated WebHelm socket/executable advertises ChatGPT capacity.
        let mut workers=Vec::new();
        if crate::native_browser_execution::IsolatedWebHelmConfig::from_test_store(
            &self.store_directory).is_ok(){
            workers.push(json!({"adapter":"chatgpt","id":"chatgpt/browser-worker",
                "capabilities":["model","chatgpt","webhelm"]}));
        }
        Ok(workers)
    }
    fn emit(&mut self,event:&Value)->Result<(),String>{
        let id=field(event,"job_id");let event_id=field(event,"event_id");
        if id.is_empty()||event_id.is_empty(){
            return Err("Planner event missing immutable identity".into());
        }
        let durable=json!({"key":format!("isolated-planner/{id}/{}/{event_id}",field(event,"type")),
            "event":event});
        store(&self.db,id)?.commit_workflow_mutation_and_events(id,Ok,&[durable])?;
        Ok(())
    }
    fn reconcile(&mut self,_:&str,_:&str,_:&str)->Result<(),String>{
        // The same authoritative Rust daemon already polls durable Jobs.
        Ok(())
    }
    fn release_live(&mut self,_:&str,execution:Option<&str>){
        if self.live.as_deref()==execution{self.live=None;}
    }
    fn has_live(&self,_:&str,execution:Option<&str>)->bool{
        self.live.as_deref()==execution
    }
    fn store_directory(&self)->&Path{&self.store_directory}
}
impl PlannerLaunchPorts for PlannerPorts {
    fn has_planner(&self)->bool{self.script.is_file()&&self.interpreter.is_file()}
    fn owner(&self)->&str{&self.owner}
    fn timeout_ms(&self)->u64{self.timeout_ms}
    fn now(&self)->String{iso8601_now()}
    fn save_claimed_plan(&mut self,job_id:&str,claimed:&Value)->Result<(),String>{
        let plan_id=field(claimed,"id");
        store(&self.db,job_id)?.mutate_job(job_id,|mut current|{
            let snapshot=current.clone();
            let is_busy=job_has_active_execution(&snapshot,None,Some(plan_id));
            let existing=current.get_mut("plans").and_then(Value::as_array_mut)
                .into_iter().flatten().find(|plan|field(plan,"id")==plan_id)
                .ok_or("Planner round vanished during claim")?;
            if is_busy||field(existing,"status")!="PLANNING"
                ||!field(existing,"executionId").is_empty(){
                return Err("Concurrent Planner or Worker generation already claimed the Job".into());
            }
            *existing=claimed.clone();
            Ok(current)
        })?;
        Ok(())
    }
    fn register_live(&mut self,_:&str,execution:&str,_:u64)->Result<(),String>{
        self.live=Some(execution.into());Ok(())
    }
    fn begin_planner(&mut self,context:Value,timeout:u64)
        ->Result<Box<dyn FnOnce()->Result<Value,String>+Send>,String>{
        let job=context.get("job").ok_or("Planner context missing Job")?;
        let job_id=field(job,"id").to_owned();
        let plan_id=field(&context["planExecution"],"planId").to_owned();
        let execution=field(&context["planExecution"],"executionId").to_owned();
        if job_id.is_empty()||plan_id.is_empty()||execution.is_empty(){
            return Err("Planner context missing immutable execution identity".into());
        }
        let db=self.db.clone();let script=self.script.clone();
        let interpreter=self.interpreter.clone();let owner=self.owner.clone();
        Ok(Box::new(move||{
            let run=invoke_trusted_script_recorded(&interpreter,&script,&context,
                &AtomicBool::new(false),timeout,|pid|{
                    let tracked=store(&db,&job_id)?;
                    let latest=tracked.load_job(&job_id)?
                        .ok_or("Planner Job missing")?;
                    let matching=latest.get("plans").and_then(Value::as_array)
                        .into_iter().flatten().any(|plan|field(plan,"id")==plan_id
                            &&field(plan,"executionId")==execution
                            &&field(plan,"leaseOwner")==owner
                            &&field(plan,"status")=="PLANNING");
                    if !matching{return Err("Planner process belongs to stale execution".into());}
                    let record=capture_process_record(&job_id,&plan_id,&execution,
                        &owner,pid as i64)
                        .ok_or("Cannot prove isolated Planner process identity")?;
                    tracked.record_execution_process(&record)
                });
            if let Ok(tracked)=store(&db,&job_id){
                let _=tracked.finish_execution_process(&job_id,&plan_id,&execution,None);
            }
            let raw=run?;
            let proposal=if field(&raw,"status")=="COMPLETED"{
                raw.get("output").cloned().ok_or(
                    "Completed Planner Script did not include a Plan output")?
            }else{raw};
            // A malformed worker payload is a failed provider invocation,
            // not a proposed Graph transition. The canonical finishPlanner
            // error branch records the failure without creating Tasks.
            crate::planner::parse_planner_result(&proposal)?;
            Ok(proposal)
        }))
    }
    fn detached_failure(&mut self,job_id:&str,plan_id:&str,error:&str){
        eprintln!("Isolated Planner {job_id}/{plan_id}: {error}");
    }
}
/// Execute the already-created Plan through canonical PlannerLaunchPorts,
/// including exact Job execution slot, lease and finishPlanner validations.
pub fn run_isolated_script_planner(
    db:&Path,store_directory:&Path,graph:&Path,
    job_id:&str,plan_id:&str,script:&Path,interpreter:&Path,
    timeout_ms:u64,
)->Result<Value,String>{
    if !script.is_absolute()||!script.is_file()||!interpreter.is_absolute()
        ||!interpreter.is_file(){
        return Err("Native Planner requires a trusted absolute Script/JS executable".into());
    }
    let initial=store(db,job_id)?.load_job(job_id)?
        .ok_or("Planner Job missing")?;
    let plan=initial.get("plans").and_then(Value::as_array)
        .into_iter().flatten().find(|plan|field(plan,"id")==plan_id)
        .ok_or("Planner round not registered")?.clone();
    let ports=Arc::new(Mutex::new(PlannerPorts{
        db:db.to_path_buf(),store_directory:store_directory.to_path_buf(),
        script:script.to_path_buf(),interpreter:interpreter.to_path_buf(),
        owner:format!("isolated-rust-planner-{}",std::process::id()),
        timeout_ms,live:None,
    }));
    launch_plan_execution(ports,graph,&initial,&plan,true)?;
    store(db,job_id)?.load_job(job_id)?.ok_or("Planner result Job missing".into())
}
