// Node src/cli.ts public host factories. This module holds no lifecycle
// policy; the native Graph actions and SQLite Store own each effect.
use crate::{cli_core_support::arg,
    decision::decision_mode,reviewer_thread::runtime_reviewer,
    reconciler::Reconciler,
    job_actions::{apply_job_activate_action,apply_job_cancel_action},
    planner_adapters::{CommandObjectivePlanner,AgentObjectivePlanner}};
use serde_json::{json,Value};
use std::path::{Path,PathBuf};

/// The concrete ObjectivePlanner implementation selected by CLI flags.
/// Neither constructor starts a child process; execution uses owned runner.
#[derive(Debug)]
pub enum RuntimePlanner {
    Command(CommandObjectivePlanner),
    Agent(AgentObjectivePlanner),
}
pub fn runtime_planner(args:&[String])->Result<RuntimePlanner,String>{
    let command=arg(args,"--planner-command","");
    if !command.is_empty(){
        return Ok(RuntimePlanner::Command(CommandObjectivePlanner::new(command)?));
    }
    let model=arg(args,"--codex","codex");
    Ok(RuntimePlanner::Agent(AgentObjectivePlanner::new(Some(model),None)))
}

/// Store and event transport are caller-owned. `runtime` constructs the
/// concrete Planner strategy, provider metadata and one native Reconciler;
/// the host injects the actual SQLite Store and owned provider execution when
/// it processes the Graph-selected effects (never from this constructor).
pub struct RuntimeReconciler {
    pub reconciler:Reconciler,
    pub planner:RuntimePlanner,
    pub configured:Value,
}
#[derive(Clone,Debug)]
pub struct RuntimePaths {
    pub graph:PathBuf,
    pub store:PathBuf,
    pub profile:PathBuf,
    pub policy:PathBuf,
    pub rules:PathBuf,
}
impl RuntimePaths{
    pub fn for_fixture(root:&Path)->Self{
        Self{graph:root.join("workflow"),store:root.join("stores"),
            profile:root.join(".codex"),policy:root.join("policy.json"),
            rules:root.join("rules.md")}
    }
}
pub fn runtime(args:&[String],paths:RuntimePaths)->Result<RuntimeReconciler,String>{
    let planner=runtime_planner(args)?;
    let model=arg(args,"--codex","codex").to_string();
    let policy=arg(args,"--chatgpt-tab-close-policy","");
    let policy=if policy.is_empty(){
        std::env::var("AGENTS_RELAY_CHATGPT_TAB_CLOSE_POLICY")
            .unwrap_or_else(|_|"after-terminal".into())
    }else{policy.into()};
    if !matches!(policy.as_str(),"after-start"|"never"|"after-terminal"){
        return Err("--chatgpt-tab-close-policy must be after-start, never, or after-terminal".into());
    }
    let reviewer=runtime_reviewer(args)?;
    let owner=arg(args,"--owner","");
    let owner=if owner.is_empty(){format!("cli-{}",std::process::id())}else{owner.into()};
    let count=arg(args,"--concurrency","4").parse::<f64>()
        .ok().filter(|n|n.is_finite()).unwrap_or(f64::NAN);
    let lease=arg(args,"--lease-ms","300000").parse::<f64>()
        .ok().filter(|n|n.is_finite()).unwrap_or(f64::NAN);
    let option=|name:&str,env:&str|{
        let requested=arg(args,name,"");
        if !requested.is_empty(){Some(requested.to_owned())}
        else{std::env::var(env).ok().filter(|s|!s.is_empty())}
    };
    let mut roots=json!({});
    if let Some(v)=option("--workspace-root","AGENTS_RELAY_WORKSPACE_ROOT"){
        roots["workspaceRoot"]=json!(v);
    }
    if let Some(v)=option("--shared-root","AGENTS_RELAY_SHARED_ROOT"){
        roots["sharedRoot"]=json!(v);
    }
    if let Some(v)=option("--global-root","AGENTS_HOME"){
        roots["globalRoot"]=json!(v);
    }
    let configured=json!({
        "noGitHub":true,"owner":owner,
        "maxConcurrent":if count.is_nan(){Value::Null}else{json!(count)},
        "leaseMs":if lease.is_nan(){Value::Null}else{json!(lease)},
        "adapters":[
            {"id":"codex","name":"codex","command":model,"capabilities":["model","codex"]},
            {"id":"chatgpt/browser-worker","name":"chatgpt",
                "capabilities":["model","chatgpt","webhelm"],"tabClosePolicy":policy},
            {"id":"z/webhelm","name":"z",
                "capabilities":["model","z","webhelm","coding","filesystem","mcp"],
                "tabClosePolicy":"after-terminal"}
        ],
        "continuations":[
            {"kind":"codex-thread","command":model},
            {"kind":"command"},{"kind":"webhook"}],
        "planner":match &planner{
            RuntimePlanner::Command(_)=>json!({"kind":"CommandObjectivePlanner",
                "command":arg(args,"--planner-command","")}),
            RuntimePlanner::Agent(_)=>json!({"kind":"AgentObjectivePlanner","command":model})},
        "reviewer":reviewer,"chatgptTabClosePolicy":policy,
        "executionContextRoots":roots,"decisionMode":decision_mode(),
        "decisionEngine":{"name":"openrouter-jev"},
    });
    let reconciler=Reconciler::new(paths.graph,paths.store,paths.profile,
        paths.policy,paths.rules,configured.clone());
    Ok(RuntimeReconciler{reconciler,planner,configured})
}

/// All effects are delegated to one caller-owned Store/reconciler, never a
/// separate Dashboard memory copy. The single selected Graph transition is
/// shared with CLI, daemon and server-side Dashboard controls.
pub trait DashboardJobActionPorts {
    fn load_job(&mut self,job_id:&str)->Result<Value,String>;
    fn save_job(&mut self,job:&Value)->Result<(),String>;
    fn mutate_job(&mut self,job_id:&str,
        operation:&mut dyn FnMut(Value)->Result<Value,String>)->Result<Value,String>;
    fn has_atomic_mutate(&self)->bool{true}
    fn save_plan(&mut self,_plan:&Value)->Result<(),String>{
        Err("store.savePlan is not a function".into())
    }
    fn save_task(&mut self,_task:&Value)->Result<(),String>{
        Err("store.saveTask is not a function".into())
    }
    fn wake(&mut self,job_id:&str)->Result<Value,String>;
    fn workflow_directory(&self)->&Path;
}
pub fn dashboard_job_action<P:DashboardJobActionPorts>(
    ports:&mut P,action:&str,job_id:&str,
)->Result<Value,String>{
    let job=ports.load_job(job_id)?;
    match action {
        "start"=>{
            let changed=apply_job_activate_action(ports.workflow_directory(),&job)?;
            ports.save_job(&changed)?;
            ports.wake(job.get("id").and_then(Value::as_str).unwrap_or(job_id))
        },
        "cancel"=>{
            let id=job.get("id").and_then(Value::as_str).unwrap_or(job_id);
            if ports.has_atomic_mutate(){
                let graph=ports.workflow_directory().to_path_buf();
                ports.mutate_job(id,&mut |fresh|{
                    apply_job_cancel_action(&graph,&fresh,None)
                })?;
            }else{
                // Node's non-atomic legacy Store path persists each affected
                // Plan/Task effect before the final Job lifecycle snapshot.
                // A failed subordinate effect must stop the outer save.
                let changed=apply_job_cancel_action(ports.workflow_directory(),&job,None)?;
                // Node Graph first persists the Job lifecycle transition,
                // then executes cancelActiveWork effects one Plan/Task at a
                // time. A non-atomic Store may expose this partial snapshot.
                let mut lifecycle=changed.clone();
                if let Some(plans)=job.get("plans"){
                    lifecycle["plans"]=plans.clone();
                }
                if let Some(tasks)=job.get("tasks"){
                    lifecycle["tasks"]=tasks.clone();
                }
                ports.save_job(&lifecycle)?;
                for plan in changed.get("plans").and_then(Value::as_array)
                    .into_iter().flatten(){
                    if job.get("plans").and_then(Value::as_array)
                        .into_iter().flatten().any(|p|
                            p.get("id")==plan.get("id")
                                &&p.get("status").and_then(Value::as_str)==Some("PLANNING")){
                        ports.save_plan(plan)?;
                    }
                }
                for task in changed.get("tasks").and_then(Value::as_array)
                    .into_iter().flatten(){
                    let original=job.get("tasks").and_then(Value::as_array)
                        .into_iter().flatten().find(|p|p.get("id")==task.get("id"));
                    if original.is_some_and(|before|before.get("state")!=task.get("state")){
                        ports.save_task(task)?;
                    }
                }
            }
            ports.load_job(id)
        },
        _=>ports.wake(job.get("id").and_then(Value::as_str).unwrap_or(job_id)),
    }
}
