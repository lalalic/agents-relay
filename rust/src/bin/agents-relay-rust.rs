//! Native Agents Relay CLI front door. The daemon and SQLite/Graph own state;
//! the CLI only parses arguments and invokes the same control/HTTP routes as
//! Node. Unwired host actions explicitly fail rather than launching Node.
use agents_relay_rust2::{
    cli::{run_cli,CliRuntimePort},
    cli_core_support::{arg,has_arg,text_option},
    cli_coordinator::validate_coordinator_args,
    cli_escalation::run_escalation_command,
    cli_support::{relay_control_command,relay_service_status},
};
use serde_json::{json,Value};

struct DaemonClient;
impl CliRuntimePort for DaemonClient {
    fn execute(&mut self,group:&str,action:&str,args:&[String])->Result<Value,String>{
        match (group,action){
            ("status","") => relay_service_status(args),
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
                validate_coordinator_args(args,false)?;
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
                let shared=arg(args,"--shared-root","");
                relay_control_command(args,&json!({
                    "command":"job.run","jobId":id,"taskId":task_id,
                    "graphOverride":override_graph,
                    "workspaceRoot":if workspace.is_empty(){None}else{Some(workspace)},
                    "globalRoot":if global.is_empty(){
                        std::env::var("AGENTS_HOME").ok()
                    }else{Some(global.into())},
                    "sharedRoot":if shared.is_empty(){
                        std::env::var("AGENTS_RELAY_SHARED_ROOT").ok()
                    }else{Some(shared.into())}
                }))
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
            println!("{}",serde_json::to_string_pretty(&result)
                .unwrap_or_else(|_|"null".to_string()));
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
