//! Native Agents Relay CLI front door. The daemon and SQLite/Graph own state;
//! the CLI only parses arguments and invokes the same control/HTTP routes as
//! Node. Unwired host actions explicitly fail rather than launching Node.
use agents_relay_rust2::{
    cli::{run_cli,CliRuntimePort},
    cli_support::relay_service_status,
};
use serde_json::Value;

struct DaemonClient;
impl CliRuntimePort for DaemonClient {
    fn execute(&mut self,group:&str,action:&str,args:&[String])->Result<Value,String>{
        match (group,action){
            ("status","") => relay_service_status(args),
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
        Ok(result)=>println!("{}",serde_json::to_string_pretty(&result)
            .unwrap_or_else(|_|"null".to_string())),
        Err(error)=>{
            eprintln!("{error}");
            std::process::exit(1);
        },
    }
}
