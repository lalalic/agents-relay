// Direct src/cli-support.ts public options and real local daemon HTTP
// contract. The native CLI uses the same callable functions as production,
// not a mock HTTP serializer. All file/HTTP fixtures are caller-owned.
use agents_relay_rust2::cli_support as cli;
use serde_json::{json,Value};
use std::{fs,path::Path};
pub fn invoke(request:&Value)->Result<Option<String>,String>{
    if request["op"]!="cliSupportMore"{return Ok(None);}
    let args=request["args"].as_array().map(|items|items.iter()
        .filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>())
        .unwrap_or_default();
    let method=request["method"].as_str().unwrap_or("");
    let output:Result<Value,String>=match method{
        "textOption"=>cli::text_option(&args,
            request["inlineFlag"].as_str().unwrap_or("--text"),
            request["fileFlag"].as_str().unwrap_or("--text-file"),
            request["stdin"].as_str()).map(Value::String),
        "saveLocal"=>{
            let file=request["file"].as_str().map(Path::new);
            let before=file.and_then(|f|fs::read(f).ok());
            cli::save_local(file,&request["job"]).map(|_|{
                json!({"beforeChanged":before!=file.and_then(|f|fs::read(f).ok()),
                    "contents":file.and_then(|f|fs::read_to_string(f).ok())})
            })
        },
        "relayControlJob"=>cli::relay_control_job(&args,request["jobId"].as_str().unwrap_or("42")),
        "relayControlCommand"=>cli::relay_control_command(&args,&request["body"]),
        "relayJobList"=>cli::relay_job_list(&args).map(|jobs|json!(jobs)),
        "relayJobStateCommand"=>cli::relay_job_state_command(
            &args,request["jobId"].as_str().unwrap_or("42"),
            request["state"].as_str().unwrap_or("CANCELLED")),
        "relayTaskCommand"=>cli::relay_task_command(&args,&request["body"]),
        "relayServiceStatus"=>cli::relay_service_status(&args),
        other=>Err(format!("Unknown CLI support API method {other}"))
    };
    Ok(Some(match output{
        Ok(value)=>json!({"ok":true,"value":value}),
        Err(error)=>json!({"ok":false,"error":error})
    }.to_string()))
}
