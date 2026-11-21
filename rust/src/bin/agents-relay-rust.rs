//! Native Agents Relay CLI front door. The daemon and SQLite/Graph own state;
//! the CLI only parses arguments and invokes the same control/HTTP routes as
//! Node. Unwired host actions explicitly fail rather than launching Node.
use agents_relay_rust2::{
    cli::{run_cli,CliRuntimePort},
    cli_core_support::{arg,has_arg,text_option},
    cli_coordinator::validate_coordinator_args,
    cli_foreground::attach_foreground_daemon,
    cli_escalation::run_escalation_command,
    cli_prompt::{run_prompt_command,run_plan_context_command,
        run_task_context_command,run_task_events_command,run_task_read_command},
    planner::planner_input,
    events_bus_runtime::events_bus_history_page,
    execution_context::resolve_execution_context,
    managed_worker_input::managed_worker_input_resolved,
    planner_adapters::build_planner_execution_prompt,
    cli_support::{relay_control_command,relay_control_job,relay_service_status,
        relay_job_events},
};
use serde_json::{json,Value};
use std::{
    path::Path,
    sync::atomic::{AtomicI32,Ordering},
    time::Duration,
};

static FOREGROUND_SIGNAL:AtomicI32=AtomicI32::new(0);
extern "C" fn foreground_interrupt_signal(signal:libc::c_int){
    FOREGROUND_SIGNAL.store(signal,Ordering::SeqCst);
}
struct ForegroundSignalGuard{
    sigint:libc::sighandler_t,
    sigterm:libc::sighandler_t,
}
impl ForegroundSignalGuard{
    fn install()->Result<Self,String>{
        FOREGROUND_SIGNAL.store(0,Ordering::SeqCst);
        // Signal handlers only update one atomic. No allocations, locks,
        // subprocess kills or async HTTP requests execute in signal context.
        let old_int=unsafe{
            libc::signal(libc::SIGINT,foreground_interrupt_signal as *const () as libc::sighandler_t)
        };
        if old_int==libc::SIG_ERR{return Err("Cannot install foreground SIGINT handler".into());}
        let old_term=unsafe{
            libc::signal(libc::SIGTERM,foreground_interrupt_signal as *const () as libc::sighandler_t)
        };
        if old_term==libc::SIG_ERR{
            unsafe{libc::signal(libc::SIGINT,old_int);}
            return Err("Cannot install foreground SIGTERM handler".into());
        }
        Ok(Self{sigint:old_int,sigterm:old_term})
    }
}
impl Drop for ForegroundSignalGuard{
    fn drop(&mut self){
        unsafe{
            libc::signal(libc::SIGINT,self.sigint);
            libc::signal(libc::SIGTERM,self.sigterm);
        }
    }
}

struct DaemonClient;
impl CliRuntimePort for DaemonClient {
    fn execute(&mut self,group:&str,action:&str,args:&[String])->Result<Value,String>{
        match (group,action){
            ("status","") => relay_service_status(args),
            ("prompt","")=>{
                let package_root=Path::new(env!("CARGO_MANIFEST_DIR"))
                    .parent().ok_or("Rust repo root missing")?;
                let graph=package_root.join("workflow");
                let binding=arg(args,"--id","");
                let job=if binding.is_empty(){None}
                    else{Some(relay_control_job(args,binding)?)};
                let rendered=run_prompt_command(&graph,args,job.as_ref(),
                    |project,role|resolve_execution_context(project,role,&json!({})),
                    |job,task,context,mode|managed_worker_input_resolved(
                        job,task,Some(context),mode,package_root,None),
                    |context,_resolved,adapter|build_planner_execution_prompt(
                        context,package_root,None,adapter,None))?;
                Ok(Value::String(rendered))
            },
            ("plan","context")=>{
                let binding=arg(args,"--id","");
                if binding.is_empty(){return Err("plan context requires --id".into());}
                let job=relay_control_job(args,binding)?;
                let rendered=run_plan_context_command(args,&job,
                    |project,role|resolve_execution_context(project,role,&json!({})),
                    |input|Ok(planner_input(input)))?;
                Ok(Value::String(rendered))
            },
            ("task","context")=>{
                let binding=arg(args,"--id","");
                if binding.is_empty(){return Err("task context requires --id".into());}
                let job=relay_control_job(args,binding)?;
                Ok(Value::String(run_task_context_command(args,&job)?))
            },
            ("task",action @ ("show"|"comments"))=>{
                let binding=arg(args,"--id","");
                if binding.is_empty(){return Err(format!("task {action} requires --id"));}
                let job=relay_control_job(args,binding)?;
                Ok(Value::String(run_task_read_command(action,args,&job)?))
            },
            ("task","events")=>{
                let binding=arg(args,"--id","");
                if binding.is_empty(){return Err("task events requires --id".into());}
                let job=relay_control_job(args,binding)?;
                let environment=json!(std::env::vars().collect::<std::collections::HashMap<_,_>>());
                let rendered=run_task_events_command(args,&job,
                    |job_id,task_id,limit,order,after|{
                        events_bus_history_page(job_id,Some(task_id),&json!(limit),
                            &json!({"order":order,"after":after}),&environment)
                    })?;
                Ok(Value::String(rendered))
            },
            ("escalation","") => {
                // The operator-selected executable is the ONLY effect
                // provider. The canonical escalation Graph owns the result
                // and no Neo/default shell fallback is ever permitted.
                let env=std::env::vars().collect::<std::collections::HashMap<_,_>>();
                let graph=std::env::current_dir().map_err(|e|e.to_string())?
                    .join("workflow");
                run_escalation_command(args,&env,&graph)
            },
            ("job",action @ ("pause"|"resume")) => {
                let id=arg(args,"--id","");
                if id.is_empty(){return Err("job requires --id".into());}
                relay_control_command(args,&json!({
                    "command":if action=="resume"{"job.resume"}else{"job.pause"},
                    "jobId":id,
                }))
            },
            ("job","run") => {
                // Original Node CLI Coordinator contract. The daemon owns
                // the Graph decision and authoritative SQLite transaction.
                let foreground=has_arg(args,"--foreground");
                validate_coordinator_args(args,true)?;
                let id=arg(args,"--id","");
                if id.is_empty(){return Err("job requires --id".into());}
                let task_id=arg(args,"--task-id","");
                if task_id.is_empty(){return Err("job run requires --task-id".into());}
                let override_graph=if has_arg(args,"--agent-graph-file"){
                    let source=text_option(args,"--agent-graph",
                        "--agent-graph-file",None)?;
                    if source.is_empty(){None}else{Some(source)}
                }else{None};
                if has_arg(args,"--project-path"){
                    return Err("Job --project-path is removed; use the independent Git repository root".into());
                }
                let workspace=arg(args,"--workspace-root","");
                let global=arg(args,"--global-root","");
                let was_terminal=if foreground{
                    let current=relay_control_job(args,id)?;
                    matches!(current.get("state").and_then(Value::as_str),
                        Some("COMPLETED"|"CANCELLED"))
                }else{false};
                let receipt=if was_terminal{Value::Null}else{
                    relay_control_command(args,&json!({
                        "command":"job.run","jobId":id,"taskId":task_id,
                        "graphOverride":override_graph,
                        "workspaceRoot":if workspace.is_empty(){None}else{Some(workspace)},
                        "globalRoot":if global.is_empty(){
                            std::env::var("AGENTS_HOME").ok()
                        }else{Some(global.into())}
                    }))?
                };
                if !foreground{return Ok(receipt);}
                // Attach to the same daemon/Graph/SQLite ownership as
                // background job.run; NEVER launch a second local scheduler.
                let _signals=ForegroundSignalGuard::install()?;
                let attached=attach_foreground_daemon(
                    id,task_id,
                    ||relay_control_job(args,id),
                    ||relay_control_command(args,&json!({
                        "command":"job.reconcile","jobId":id
                    })).map(|_|()),
                    ||relay_job_events(args,id,128),
                    |message|println!("{message}"),
                    Duration::from_millis(1000),&FOREGROUND_SIGNAL,
                )?;
                Ok(attached.job)
            },
            // --foreground, background worker scheduling, local job
            // migrations and human escalation need the actual host ports,
            // not a fabricated success response or Node.js subprocess.
            _=>Err(format!(
                "Native Relay CLI action {group} {action} is not yet bound to the daemon; refusing to mutate state"
            )),
        }
    }
}
fn main(){
    let arguments=std::env::args().skip(1).collect::<Vec<_>>();
    if arguments.first().is_some_and(|arg|arg=="--version"){
        println!("agents-relay-rust {} (native preview)",env!("CARGO_PKG_VERSION"));
        return;
    }
    let mut port=DaemonClient;
    match run_cli(&mut port,&arguments,None){
        Ok(Value::String(help)) if arguments.is_empty()
            || arguments.first().is_some_and(|a|matches!(a.as_str(),"--help"|"-h"))
            || arguments.iter().any(|a|matches!(a.as_str(),"--help"|"-h"))=>{
            println!("{help}");
        },
        Ok(result)=>{
            let raw=arguments.first().is_some_and(|command|command=="prompt")
                ||matches!(arguments.first().map(String::as_str),Some("plan"|"task"))
                    &&arguments.get(1).is_some_and(|action|
                        matches!(action.as_str(),"context"|"events"));
            if raw {
                if let Some(message)=result.as_str().filter(|message|!message.is_empty()){
                    println!("{message}");
                }
            }else{
                println!("{}",serde_json::to_string_pretty(&result)
                    .unwrap_or_else(|_|"null".to_string()));
            }
            let foreground_signal=FOREGROUND_SIGNAL.load(Ordering::SeqCst);
            if foreground_signal==libc::SIGINT{std::process::exit(130);}
            if foreground_signal==libc::SIGTERM{std::process::exit(143);}
            if arguments.first().is_some_and(|cmd|cmd=="job")
                &&arguments.get(1).is_some_and(|action|action=="run")
                &&arguments.iter().any(|argument|argument=="--foreground")
                &&result.get("state").and_then(Value::as_str)==Some("CANCELLED"){
                std::process::exit(1);
            }
            if arguments.first().is_some_and(|cmd|cmd=="escalation")
                &&result.get("state").and_then(Value::as_str)==Some("technical_failure"){
                std::process::exit(2);
            }
        },
        Err(error)=>{
            eprintln!("{error}");
            std::process::exit(1);
        },
    }
}
