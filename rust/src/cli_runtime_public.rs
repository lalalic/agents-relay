// Node src/cli.ts public host factories. This module holds no lifecycle
// policy; the native Graph actions and SQLite Store own each effect.
use crate::{cli_core_support::arg,
    job_actions::{apply_job_activate_action,apply_job_cancel_action},
    planner_adapters::{CommandObjectivePlanner,AgentObjectivePlanner}};
use serde_json::Value;
use std::path::Path;

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
