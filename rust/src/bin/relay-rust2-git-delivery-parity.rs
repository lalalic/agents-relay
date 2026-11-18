// Original Node src/git-delivery.ts and src/cli-task-complete.ts differential
// test adapter; operates only on caller-created, disposable local Git fixtures.
use agents_relay_rust2::{git_delivery,cli_task_complete};
use serde_json::{json,Value};
use std::io::{self,BufRead};
fn get<'a>(value:&'a Value,key:&str)->&'a str{
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
fn args(request:&Value)->Vec<String>{
    request["args"].as_array().into_iter().flatten()
        .filter_map(Value::as_str).map(str::to_owned).collect()
}
fn execute(request:&Value)->Result<Value,String>{
    let job=&request["job"];
    let task=&request["task"];
    let execution=get(request,"executionId");
    match get(request,"op"){
        "sourceCommitRequired"=>Ok(json!(git_delivery::source_commit_required(task))),
        "sourceCommitSha"=>Ok(json!(git_delivery::source_commit_sha(job)?)),
        "startedSourceBaseline"=>Ok(json!(git_delivery::started_source_baseline(job,get(request,"taskId"))?)),
        "bindSourceBaseline"=>{
            let mut task=task.clone();
            git_delivery::bind_source_baseline(&mut task,request["sha"].as_str());
            Ok(task)
        },
        "verifySourceCommit"=>git_delivery::verify_source_commit(
            job,task,execution,get(request,"commitSha")),
        "sourceCompletionVerified"=>Ok(json!(git_delivery::source_completion_verified(
            job,task,request["executionId"].as_str()))),
        "taskCompleteRequest"=>cli_task_complete::task_complete_request(&args(request)),
        "runTaskCompleteCommand"=>cli_task_complete::run_task_complete_command(&args(request)),
        op=>Err(format!("Unknown Git delivery fixture {op}")),
    }
}
fn main(){
    for line in io::stdin().lock().lines(){
        let Ok(line)=line else{break};
        if line.is_empty(){continue;}
        let response=match serde_json::from_str::<Value>(&line){
            Ok(request)=>match execute(&request){
                Ok(value)=>json!({"ok":true,"value":value}),
                Err(error)=>json!({"ok":false,"error":error}),
            },
            Err(error)=>json!({"ok":false,"error":error.to_string()}),
        };
        println!("{response}");
    }
}
