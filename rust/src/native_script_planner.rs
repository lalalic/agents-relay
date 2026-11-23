//! Isolated Planner Shortcut: real Rust-owned Script process, canonical
//! PlannerLaunchPorts/finishPlanner, Graph-selected Plan Apply and SQLite CAS.
//! This never substitutes for an unconnected production model Planner.
use crate::{
    events::event_for,
    execution_context::resolve_execution_context,
    reconciler_context::resolve_planner_context,
    local_merge_lock::iso8601_now,
    native_script_worker::invoke_trusted_script_recorded,
    owned_process::{OwnedProcessManager,OwnedProcessOptions,TerminationReason},
    planner_adapters::{AgentObjectivePlanner,PlannerProcessResult},
    planner_launch_public::{launch_plan_execution,PlannerLaunchPorts},
    planner_runtime_public::PlannerFinishPorts,
    process_identity::capture_process_record,
    relay_store::SQLiteRelayStore,
    job_execution_slot::job_has_active_execution,
};
use serde_json::{json,Value};
use std::{
    io::Read,path::{Path,PathBuf},sync::{Arc,Mutex,atomic::AtomicBool},
    thread,time::{Duration,Instant},
};
fn field<'a>(v:&'a Value,key:&str)->&'a str{
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn store(db:&Path,id:&str)->Result<SQLiteRelayStore,String>{
    SQLiteRelayStore::open_without_claim_reset(db,Some(id))
}
/// Register one Planner-proposed cross-Job unblock only after both local
/// repository roots and durable Task identities have been verified. Reuse
/// the existing Graph blocker action and the SQLite two-Job CAS primitive;
/// a partial registration or an unverified foreign Project never succeeds.
pub fn register_isolated_planner_unblock(
    db:&Path,store_directory:&Path,graph:&Path,
    blocker_job_id:&str,request:&Value,
)->Result<(),String>{
    let dependent_id=field(request,"jobId");
    let dependent_task_id=field(request,"taskId");
    let expected_repository=field(request,"repository");
    if blocker_job_id.is_empty()||dependent_id.is_empty()
        ||dependent_task_id.is_empty()||expected_repository.is_empty(){
        return Err("Planner unblock requires exact dependent repository, Job and Task".into());
    }
    let blockers=store(db,blocker_job_id)?;
    let blocker=blockers.load_job(blocker_job_id)?
        .ok_or("Planner blocker Job is absent")?;
    let dependents=store(db,dependent_id)?;
    let dependent=dependents.load_job(dependent_id)?
        .ok_or("Planner dependent Job is absent")?;
    if field(&dependent,"repository")!=expected_repository
        ||dependent.get("prNumber").and_then(Value::as_i64).unwrap_or(0)
            !=request.get("prNumber").and_then(Value::as_i64).unwrap_or(0){
        return Err("Planner unblock dependent repository identity mismatch".into());
    }
    let trusted=std::fs::canonicalize(
        store_directory.parent().ok_or("Planner Store parent missing")?)
        .map_err(|e|e.to_string())?;
    for job in [&blocker,&dependent] {
        let root=std::fs::canonicalize(field(job,"projectRoot"))
            .map_err(|e|format!("Invalid Planner cross-Job project root: {e}"))?;
        if root==trusted||!root.starts_with(&trusted)
            ||root.file_name().and_then(|v|v.to_str())!=Some(field(job,"repository"))
            ||!root.join(".git").exists(){
            return Err("Planner cross-Job unblock requires two independent trusted local Git roots".into());
        }
    }
    if blocker_job_id==dependent_id
        ||field(&blocker,"repository")==field(&dependent,"repository"){
        return Err("Planner unblock must target a different independent Job/repository".into());
    }
    let proposed=crate::blockers::register_blocker_dependency(
        graph,&blocker,&dependent,dependent_task_id,None,
        request.get("resolutionMode").and_then(Value::as_str),None)?;
    if proposed.blocker!=blocker || proposed.dependent!=dependent {
        dependents.commit_blocker_recovery_pair(
            &dependent,&proposed.dependent,Some(&blocker),&proposed.blocker)?;
    }
    Ok(())
}

struct PlannerPorts {
    db:PathBuf,store_directory:PathBuf,graph:PathBuf,
    script:PathBuf,interpreter:PathBuf,codex:Option<PathBuf>,
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
        // Node resolvePlannerContext: selected Agent/Runtime registrations and
        // authoritative shared/project instructions must travel with the
        // Planner Script. A synthetic 3-field project object is insufficient
        // for a Worker/Planner that must select the real Markdown contract.
        let project=job.get("projectRoot").and_then(Value::as_str)
            .filter(|project|!project.is_empty())
            .ok_or("Native Planner Job missing immutable projectRoot")?;
        let base=self.store_directory.parent()
            .ok_or("Native Planner isolated Store has no parent")?;
        let roots=json!({
            "workspaceRoot":base,"globalRoot":base
        });
        let agents=store(&self.db,field(job,"id"))?
            .load_agents()?.unwrap_or_default();
        let adapters=self.registered_workers()?;
        let future=resolve_planner_context(project,&roots,&agents,&adapters,
            |project,role,options|std::future::ready(
                resolve_execution_context(&project,&role,&options)));
        let mut future=std::pin::pin!(future);
        let mut context=std::task::Context::from_waker(std::task::Waker::noop());
        match std::future::Future::poll(future.as_mut(),&mut context){
            std::task::Poll::Ready(result)=>result,
            std::task::Poll::Pending=>Err(
                "Native Planner context resolution unexpectedly suspended".into()),
        }
    }
    fn can_register_unblock(&self)->bool{self.db.is_file()}
    fn register_unblock(&mut self,job_id:&str,request:&Value)
        ->Result<(),String>{
        register_isolated_planner_unblock(
            &self.db,&self.store_directory,&self.graph,job_id,request)
    }
    fn registered_workers(&mut self)->Result<Vec<Value>,String>{
        // A Planner cannot promise a Codex/Z worker while those production
        // adapters remain unconnected. Only an actual explicitly configured
        // isolated WebHelm socket/executable advertises ChatGPT capacity.
        let mut workers=Vec::new();
        if crate::native_browser_execution::IsolatedWebHelmConfig::from_test_store(
            &self.store_directory).is_ok(){
            workers.push(json!({"adapter":"chatgpt",
                "name":"chatgpt/browser-worker","id":"chatgpt/browser-worker",
                "capabilities":["model","chatgpt","webhelm"]}));
        }
        if self.codex.is_some(){
            workers.push(json!({"adapter":"codex","name":"codex","id":"codex",
                "capabilities":["model","codex","local_repo","iterative_tools"]}));
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
    fn has_planner(&self)->bool{
        (self.script.is_file()&&self.interpreter.is_file())
            ||self.codex.as_ref().is_some_and(|p|p.is_file())
    }
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
        let model=self.codex.clone();let store_dir=self.store_directory.clone();
        let context=if model.is_some(){
            let mut current=context;
            let host=std::env::current_exe().map_err(|e|e.to_string())?;
            let sibling=host.with_file_name("agents-relay-rust");
            let native=if sibling.is_file(){sibling}else{
                host.parent().and_then(Path::parent)
                    .ok_or("Native Planner CLI parent unavailable")?
                    .join("agents-relay-rust")
            };
            let native=std::fs::canonicalize(native)
                .map_err(|e|format!("Native Planner CLI unavailable: {e}"))?;
            current["nativeRustCli"]=json!(native.to_string_lossy().to_string());
            current
        }else{context};
        Ok(Box::new(move||{
            if let Some(executable)=model{
                let repository_root=Path::new(env!("CARGO_MANIFEST_DIR"))
                    .parent().ok_or("Native Planner repository root missing")?;
                let command=executable.to_str().ok_or("Codex executable path is not UTF-8")?;
                let adapter=AgentObjectivePlanner::new(Some(command),None);
                return adapter.plan(&context,repository_root,&store_dir,None,
                    |program,args,cwd|{
                        let cwd=cwd.ok_or("Native Model Planner missing resolved project cwd")?;
                        let mut owner_process=OwnedProcessManager::default();
                        let refs=args.iter().map(String::as_str).collect::<Vec<_>>();
                        let child=owner_process.spawn_owned_process_piped(program,&refs,
                            OwnedProcessOptions{
                                invocation:format!("rust-model-planner:{job_id}/{plan_id}"),
                                cwd:Some(cwd.to_path_buf()),timeout_ms:None,
                                grace_ms:500,supervisor_path:None,
                            })?;
                        let tracked=store(&db,&job_id)?;
                        let latest=tracked.load_job(&job_id)?
                            .ok_or("Model Planner Job missing at launch")?;
                        let matching=latest.get("plans").and_then(Value::as_array)
                            .into_iter().flatten().any(|p|field(p,"id")==plan_id
                                &&field(p,"executionId")==execution
                                &&field(p,"status")=="PLANNING");
                        if !matching{
                            child.terminate(TerminationReason::Abort,Some(100));
                            return Err("Model Planner process belongs to stale execution".into());
                        }
                        let record=capture_process_record(&job_id,&plan_id,&execution,
                            child.pid() as i64)
                            .ok_or("Cannot prove Model Planner process identity")?;
                        if let Err(error)=tracked.record_execution_process(&record){
                            child.terminate(TerminationReason::Abort,Some(100));
                            return Err(error);
                        }
                        let stdout=child.take_stdout().ok_or("Model Planner stdout missing")?;
                        let stderr=child.take_stderr().ok_or("Model Planner stderr missing")?;
                        let reader=thread::spawn(move||{
                            let mut bytes=Vec::new();
                            stdout.take(8*1024*1024+1).read_to_end(&mut bytes)
                                .map_err(|e|e.to_string())?;
                            String::from_utf8(bytes).map_err(|e|e.to_string())
                        });
                        let errors=thread::spawn(move||{
                            let mut bytes=Vec::new();
                            stderr.take(128*1024+1).read_to_end(&mut bytes)
                                .map_err(|e|e.to_string())?;
                            String::from_utf8(bytes).map_err(|e|e.to_string())
                        });
                        let status=loop{
                            if let Some(status)=child.exit_status()?{break status;}
                            thread::sleep(Duration::from_millis(100));
                        };
                        let _=store(&db,&job_id).and_then(|store|
                            store.finish_execution_process(&job_id,&plan_id,&execution,None));
                        let stdout=reader.join().map_err(|_|"Model Planner reader panicked")??;
                        let stderr=errors.join().map_err(|_|"Model Planner stderr reader panicked")??;
                        // Observe a real Codex JSONL thread even if the
                        // Planner's CLI apply or model response failed. The
                        // exact execution ID fences the durable Plan record.
                        if let Some(thread_id)=stdout.lines().find_map(
                            crate::native_codex_thread::parse_thread_started){
                            store(&db,&job_id)?.mutate_job(&job_id,|mut latest|{
                                let current=latest.get_mut("plans").and_then(Value::as_array_mut)
                                    .and_then(|plans|plans.iter_mut().find(|p|field(p,"id")==plan_id))
                                    .ok_or("Planner Thread target Plan missing")?;
                                let authorized=(field(current,"status")=="PLANNING"
                                    &&field(current,"executionId")==execution)
                                    ||(field(current,"status")=="SUCCEEDED"
                                        &&field(current,"appliedExecutionId")==execution);
                                if !authorized{return Err("Stale Planner execution cannot attach Codex Thread".into());}
                                let previous=field(current,"threadId");
                                if !previous.is_empty()&&previous!=thread_id{
                                    return Err("Codex Planner resumed a different Thread ID".into());
                                }
                                current["threadId"]=json!(thread_id);
                                Ok(latest)
                            })?;
                        }
                        if stdout.len()>8*1024*1024||stderr.len()>128*1024{
                            return Err("Model Planner provider output exceeded size limit".into());
                        }
                        Ok(PlannerProcessResult{exit_code:status.code().unwrap_or(-1),stdout,stderr})
                    });
            }
            let run=invoke_trusted_script_recorded(&interpreter,&script,&context,
                &AtomicBool::new(false),|pid|{
                    let tracked=store(&db,&job_id)?;
                    let latest=tracked.load_job(&job_id)?
                        .ok_or("Planner Job missing")?;
                    let matching=latest.get("plans").and_then(Value::as_array)
                        .into_iter().flatten().any(|plan|field(plan,"id")==plan_id
                            &&field(plan,"executionId")==execution
                            &&field(plan,"status")=="PLANNING");
                    if !matching{return Err("Planner process belongs to stale execution".into());}
                    let record=capture_process_record(&job_id,&plan_id,&execution,
                        pid as i64)
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
/// Apply an explicitly supplied Planner proposal through exactly the SAME
/// canonical PlannerFinishPorts/Graph/SQLite path used by an isolated Script
/// Planner, but without spawning a model, Script or second daemon. The caller
/// must independently prove that the Job's project root is in its isolated
/// workspace before invoking this effect. This is not a public event writer.
pub fn apply_isolated_planner_proposal(
    db:&Path,store_directory:&Path,graph:&Path,
    job_id:&str,plan_id:&str,execution_id:&str,proposal:&Value,
)->Result<Value,String>{
    if job_id.is_empty()||plan_id.is_empty()||execution_id.is_empty(){
        return Err("Planner apply requires exact Job/Plan/execution identities".into());
    }
    let current=store(db,job_id)?.load_job(job_id)?
        .ok_or("Planner apply Job missing from SQLite")?;
    let plan=current.get("plans").and_then(Value::as_array)
        .into_iter().flatten().find(|plan|field(plan,"id")==plan_id)
        .ok_or("Planner apply Plan not registered")?;
    if field(plan,"status")!="PLANNING"
        &&!(field(plan,"status")=="SUCCEEDED"
            &&field(plan,"appliedExecutionId")==execution_id){
        return Err("Planner apply is not an active generation or exact replay".into());
    }
    if field(plan,"status")=="PLANNING"
        &&(field(plan,"executionId")!=execution_id
            ||field(plan,"executionId").is_empty()){
        return Err("Planner apply requires exact currently leased generation".into());
    }
    let mut ports=PlannerPorts{
        db:db.to_path_buf(),store_directory:store_directory.to_path_buf(),
        graph:graph.to_path_buf(),
        // No worker launch can occur on this CLI application path.
        script:PathBuf::new(),interpreter:PathBuf::new(),codex:None,
        owner:"isolated-cli-plan-apply".into(),timeout_ms:0,
        live:Some(execution_id.to_string()),
    };
    let root=store_directory.parent()
        .ok_or("Planner apply isolated store has no parent")?;
    let mut reconciler=crate::reconciler::Reconciler::new(
        graph,store_directory,root,root,root,
        json!({"owner":"isolated-cli-plan-apply"}));
    reconciler.apply_planner_tree(
        &mut ports,job_id,plan_id,execution_id,proposal)
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
        graph:graph.to_path_buf(),
        script:script.to_path_buf(),interpreter:interpreter.to_path_buf(),codex:None,
        owner:format!("isolated-rust-planner-{}",std::process::id()),
        timeout_ms,live:None,
    }));
    launch_plan_execution(ports,graph,&initial,&plan,true)?;
    store(db,job_id)?.load_job(job_id)?.ok_or("Planner result Job missing".into())
}

/// Native model-backed Planner for Graph-selected automatic review repair.
/// Unlike an isolated Script shortcut, this uses the explicit live Codex
/// executable and the same canonical Plan lease, CLI apply, and Graph fence.
pub fn run_native_codex_planner(
    db:&Path,store_directory:&Path,graph:&Path,
    job_id:&str,plan_id:&str,executable:&Path,timeout_ms:u64,
)->Result<Value,String>{
    if !executable.is_absolute()||!executable.is_file(){
        return Err("Native Model Planner requires an explicit absolute Codex executable".into());
    }
    let initial=store(db,job_id)?.load_job(job_id)?
        .ok_or("Native Model Planner Job missing")?;
    let plan=initial.get("plans").and_then(Value::as_array)
        .into_iter().flatten().find(|p|field(p,"id")==plan_id)
        .ok_or("Native Model Planner round missing")?.clone();
    let ports=Arc::new(Mutex::new(PlannerPorts{
        db:db.to_path_buf(),store_directory:store_directory.to_path_buf(),
        graph:graph.to_path_buf(),script:PathBuf::new(),interpreter:PathBuf::new(),
        codex:Some(executable.to_path_buf()),
        owner:format!("live-rust-model-planner-{}",std::process::id()),
        timeout_ms,live:None,
    }));
    launch_plan_execution(ports,graph,&initial,&plan,true)?;
    store(db,job_id)?.load_job(job_id)?.ok_or("Native Model Planner result Job missing".into())
}
