// Native Node launchPlanExecution. Claim and persistence are serialized by
// job execution slot. The planner runs in a separately owned invocation:
// no detached thread holds the authoritative SQLite Store mutex while a
// model is working. Successful/failed completion returns through finishPlanner.
use crate::{
    events::{event_for,random_uuid},
    job_execution_slot::job_has_active_execution,
    planner_runtime_public::{finish_planner,PlannerFinishPorts},
    types::{story_size_timeout_ms,StorySize},
};
use chrono::{DateTime,Duration,SecondsFormat,Utc};
use serde_json::{json,Value};
use std::{collections::HashMap,path::{Path,PathBuf},sync::{Arc,Mutex,OnceLock},thread};

fn field<'a>(value:&'a Value,name:&str)->&'a str{
    value.get(name).and_then(Value::as_str).unwrap_or("")
}
fn plan<'a>(job:&'a Value,id:&str)->Option<&'a Value>{
    job.get("plans").and_then(Value::as_array)
        .into_iter().flatten().find(|candidate|field(candidate,"id")==id)
}
fn execution_slots()->&'static Mutex<HashMap<String,Arc<Mutex<()>>>>{
    static OWNERS:OnceLock<Mutex<HashMap<String,Arc<Mutex<()>>>>> = OnceLock::new();
    OWNERS.get_or_init(||Mutex::new(HashMap::new()))
}
fn job_slot(id:&str)->Result<Arc<Mutex<()>>,String>{
    let mut slots=execution_slots().lock().map_err(|e|e.to_string())?;
    Ok(Arc::clone(slots.entry(id.to_owned())
        .or_insert_with(||Arc::new(Mutex::new(())))))
}
/// Owned adapter contract. begin_planner transfers the invocation process
/// handle and its lifetime/timeout to the execution thread. Implementations
/// must terminate only their owned process group on timeout/cancellation.
/// No untracked PID, process-name scan, Relay Job or background work outside
/// this invocation is permitted.
pub trait PlannerLaunchPorts:PlannerFinishPorts+Send+'static{
    fn has_planner(&self)->bool;
    fn owner(&self)->&str;
    fn timeout_ms(&self)->u64{story_size_timeout_ms(StorySize::M)}
    fn now(&self)->String{Utc::now().to_rfc3339_opts(SecondsFormat::Millis,true)}
    fn head_sha(&mut self)->Result<Option<String>,String>{Ok(None)}
    fn save_claimed_plan(&mut self,job_id:&str,plan:&Value)->Result<(),String>;
    fn register_live(&mut self,plan_id:&str,execution_id:&str,
        timeout_ms:u64)->Result<(),String>;
    fn begin_planner(&mut self,context:Value,timeout_ms:u64)
        ->Result<Box<dyn FnOnce()->Result<Value,String>+Send>,String>;
    fn detached_failure(&mut self,job_id:&str,plan_id:&str,error:&str);
    fn detached_started(&mut self,_job_id:&str,_plan_id:&str){}
}
fn emit_started<P:PlannerLaunchPorts>(ports:&mut P,job_id:&str,plan_id:&str)
    ->Result<(),String>{
    ports.emit(&event_for(job_id,plan_id,None,"planner.started","running",
        &format!("Plan {plan_id} started"),Some("orchestrator"),None,None))
}
fn finish<P:PlannerLaunchPorts>(ports:Arc<Mutex<P>>,graph:PathBuf,
    job_id:String,plan_id:String,execution_id:String,
    run:Box<dyn FnOnce()->Result<Value,String>+Send>,detached:bool)
    ->Result<(),String>{
    let outcome=run();
    let mut ports=ports.lock().map_err(|e|e.to_string())?;
    let result=match outcome{
        Ok(result)=>finish_planner(&mut *ports,&graph,&job_id,&plan_id,
            Some(&execution_id),None,Some(&result),false),
        Err(error)=>finish_planner(&mut *ports,&graph,&job_id,&plan_id,
            Some(&execution_id),Some(&error),None,false),
    };
    if detached{
        if let Err(error)=&result{
            ports.detached_failure(&job_id,&plan_id,error);
        }
    }
    result
}
/// Claim Planner generation, dispatch owned process and settle through the
/// same authoritative finishPlanner path. wait=false detaches an owned thread
/// while preserving its SQLite host until completion; wait=true propagates
/// Planner completion or validation errors to caller.
pub fn launch_plan_execution<P:PlannerLaunchPorts>(
    ports:Arc<Mutex<P>>,graph:&Path,job:&Value,original_plan:&Value,
    wait_for_completion:bool,
)->Result<(),String>{
    let job_id=field(job,"id").to_owned();
    let plan_id=field(original_plan,"id").to_owned();
    if job_id.is_empty()||plan_id.is_empty(){
        return Err("Planner requires a concrete Job ID and Plan ID".into());
    }
    {
        let mut host=ports.lock().map_err(|e|e.to_string())?;
        if !host.has_planner(){
            let execution=original_plan.get("executionId");
            let failed_at=host.now();
            let mut failed=false;
            let mut mutation=|mut current:Value|{
                if let Some(fresh)=current.get_mut("plans")
                    .and_then(Value::as_array_mut).into_iter().flatten()
                    .find(|candidate|field(candidate,"id")==plan_id){
                    if field(fresh,"status")=="PLANNING"
                        &&fresh.get("executionId")==execution{
                        fresh["status"]=json!("FAILED");
                        fresh["error"]=json!("Planner unavailable");
                        fresh["assessment"]=json!("Planning failed: Planner unavailable");
                        fresh["executionId"]=Value::Null;
                        fresh["updatedAt"]=json!(failed_at);
                        failed=true;
                    }
                }
                Ok(current)
            };
            if host.atomic_available(){host.mutate(&job_id,&mut mutation)?;}
            else{
                let current=host.load(&job_id)?;
                let after=mutation(current)?;
                if failed{
                    let fresh=plan(&after,&plan_id).ok_or("Plan missing")?;
                    host.save_plan(fresh)?;
                }
            }
            if failed{
                host.emit(&event_for(&job_id,&plan_id,None,
                    "planner.failed","failed",
                    &format!("Planner {plan_id}: Planner unavailable"),
                    Some("user"),None,None))?;
            }
            return Ok(())
        }
    }
    // Node withExecutionBoundary(job.id, '__job_execution_slot__'): other
    // Planner/Worker launches of this Job cannot interleave claim and save.
    let slot=job_slot(&job_id)?;
    let (claimed,run)={
        let _guard=slot.lock().map_err(|e|e.to_string())?;
        let mut host=ports.lock().map_err(|e|e.to_string())?;
        let current=host.load(&job_id)?;
        if current.get("pause").is_some_and(|pause|!pause.is_null()){
            return Ok(());
        }
        let Some(plan)=plan(&current,&plan_id).cloned()else{return Ok(());};
        if field(&plan,"status")!="PLANNING"{
            return Ok(());
        }
        if job_has_active_execution(&current,None,Some(&plan_id)){
            return Ok(());
        }
        if !field(&plan,"executionId").is_empty()
            &&host.has_live(&plan_id,Some(field(&plan,"executionId"))){
            return Ok(());
        }
        let now=host.now();
        let at=DateTime::parse_from_rfc3339(&now)
            .map_err(|error|format!("Invalid Planner start time: {error}"))?;
        let timeout=plan.get("timeoutMs").and_then(Value::as_u64)
            .unwrap_or_else(||host.timeout_ms());
        let execution_id=random_uuid();
        let head=host.head_sha()?;
        let mut claimed=plan.clone();
        if let Some(head)=head.filter(|h|!h.is_empty()){
            claimed["headSha"]=json!(head);
        }
        if !field(&claimed,"headSha").is_empty(){
            if claimed.get("trigger").is_none_or(Value::is_null){
                claimed["trigger"]=json!({});
            }
            claimed["trigger"]["currentHeadSha"]=claimed["headSha"].clone();
        }
        claimed["attempt"]=json!(plan.get("attempt").and_then(Value::as_u64)
            .unwrap_or(0)+1);
        if claimed.get("maxAttempts").is_none_or(Value::is_null){
            claimed["maxAttempts"]=json!(if claimed["manualPlanning"]==true{1}else{3});
        }
        if claimed.get("timeoutMs").is_none_or(Value::is_null){
            claimed["timeoutMs"]=json!(timeout);
        }
        claimed["executionId"]=json!(execution_id);
        claimed["updatedAt"]=json!(at.to_rfc3339_opts(SecondsFormat::Millis,true));
        host.save_claimed_plan(&job_id,&claimed)?;
        emit_started(&mut *host,&job_id,&plan_id)?;
        host.register_live(&plan_id,&execution_id,timeout)?;
        // Node plannerContext() can fail independently before planner.plan;
        // both failures settle the already-owned execution via finishPlanner.
        let context=host.execution_context(job,&claimed);
        let invocation=context.and_then(|execution_context|{
            let ctx=json!({
                "planExecution":{"planId":plan_id,"executionId":execution_id},
                "forceRestate":claimed.get("forceRestate"),
                "restateTaskIds":claimed.get("restateTaskIds"),
                "job":job,"tasks":job.get("tasks"),
                "objective":job.get("objective").or_else(||job.get("description"))
                    .or_else(||job.get("title")),
                "previousPlannerTaskId":claimed.get("previousPlanId"),
                "trigger":claimed.get("trigger"),
                "executionContext":execution_context,
                "retryFeedback":claimed.get("retryFeedback"),
                "guidance":claimed.get("guidance")});
            host.begin_planner(ctx,timeout)
        });
        (claimed,invocation)
    };
    let exec=field(&claimed,"executionId").to_owned();
    let run=match run {
        Ok(run)=>run,
        Err(error)=>{
            let mut host=ports.lock().map_err(|e|e.to_string())?;
            return finish_planner(&mut *host,graph,&job_id,&plan_id,
                Some(&exec),Some(&error),None,false);
        }
    };
    let path=graph.to_path_buf();
    if wait_for_completion{
        finish(ports,path,job_id,plan_id,exec,run,false)
    }else{
        {
            let mut host=ports.lock().map_err(|e|e.to_string())?;
            host.detached_started(&job_id,&plan_id);
        }
        let id=job_id.clone();let pid=plan_id.clone();
        thread::Builder::new().name(format!("planner-{pid}"))
            .spawn(move||{
                if let Err(error)=finish(ports,path,job_id,plan_id,exec,run,true){
                    eprintln!("Owned Planner {id} {pid} failed: {error}");
                }
            }).map_err(|error|format!("Unable to spawn owned Planner thread: {error}"))?;
        Ok(())
    }
}
