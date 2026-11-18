// Direct port of Node src/cli-task-complete.ts: CLI builds a fenced
// task.complete control request; only the daemon may validate Git/SQLite/Graph.
use crate::cli_support::{arg,relay_control_command};
use serde_json::{json,Value};

pub fn task_complete_request(args:&[String])->Result<Value,String>{
    let job_id=arg(args,"--id","");
    let task_id=arg(args,"--task-id","");
    let execution_id=arg(args,"--execution-id","");
    let commit_sha=arg(args,"--commit-sha","");
    let repository=arg(args,"--repo","");
    if job_id.is_empty()||task_id.is_empty()||execution_id.is_empty()
        ||commit_sha.is_empty()||repository.is_empty(){
        return Err("task complete requires --repo, --id, --task-id, --execution-id and --commit-sha".into());
    }
    let summary=arg(args,"--summary","");
    Ok(json!({"command":"task.complete","jobId":job_id,"taskId":task_id,
        "executionId":execution_id,"commitSha":commit_sha,"repository":repository,
        "summary":if summary.is_empty(){format!("Source Task {task_id} committed {commit_sha}")}else{summary.to_string()}}))
}
/// Production CLI transport; returns the daemon's JSON response unmodified.
pub fn run_task_complete_command(args:&[String])->Result<Value,String>{
    relay_control_command(args,&task_complete_request(args)?)
}
