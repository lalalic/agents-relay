// Node provenance: src/cli-review.ts. Validate review CLI admission and
// produce the exact Graph/host-bound control arguments, not review decisions.
use crate::cli_core_support::arg;
use serde_json::{json, Value};
use std::path::Path;

pub fn interactive_review_request(argv: &[String]) -> Result<Value, String> {
    let Some(action) = argv.first().map(String::as_str) else {
        return Err("review interactive requires --path or begin|wait|fail|abort".into());
    };
    let flags = if action == "request" { &argv[1..] } else { argv };
    if action == "request" || action == "--path" {
        let path = arg(flags, "--path", "");
        let job_id = arg(flags, "--id", "");
        let task_id = arg(flags, "--task-id", "");
        let execution_id = arg(flags, "--execution-id", "");
        if path.is_empty() || !Path::new(path).is_absolute()
            || job_id.is_empty() || task_id.is_empty() || execution_id.is_empty() {
            return Err("review interactive requires --path ABS --id JOB --task-id TASK --execution-id EXEC".into());
        }
        return Ok(json!({
            "path": path,
            "relay": {"jobId":job_id,"taskId":task_id,"executionId":execution_id},
        }));
    }
    if !matches!(action, "begin" | "wait" | "fail" | "abort") {
        return Err("review interactive requires --path or begin|wait|fail|abort".into());
    }
    let args = &argv[1..];
    let job_id = arg(args, "--id", "");
    let task_id = arg(args, "--task-id", "");
    let execution_id = arg(args, "--execution-id", "");
    if job_id.is_empty() || task_id.is_empty() || execution_id.is_empty() {
        return Err("review interactive requires --id --task-id --execution-id".into());
    }
    let reason = arg(args, "--reason", "");
    if action == "fail" && reason.trim().is_empty() {
        return Err("review interactive fail requires --reason".into());
    }
    let mut body = json!({
        "command":format!("review.interactive.{action}"),
        "jobId":job_id, "taskId":task_id, "executionId":execution_id,
    });
    if action == "fail" { body["reason"] = json!(reason); }
    Ok(body)
}
pub fn review_job_request(args: &[String]) -> Result<Value, String> {
    if args.iter().any(|arg| arg == "--thread-id" || arg.starts_with("--thread-id=")) {
        return Err("--thread-id is not supported for review job".into());
    }
    let job_id = arg(args, "--id", "");
    if arg(args, "--repo", "").is_empty() || job_id.is_empty() {
        return Err("review job requires --repo and --id".into());
    }
    Ok(json!({"command":"review.request","jobId":job_id}))
}
pub fn review_job_response(job: &Value) -> Value {
    json!({
        "jobId":job.get("id"),
        "pr":job.get("prNumber").filter(|value| !value.is_null()).cloned().unwrap_or(json!(0)),
        "status":"requested",
        "note":"Relay graph will create the review Task once eligible; this is not a delivery receipt."
    })
}

// The CLI owns its private review request file; an injected host port owns
// the actual Neo call. No review receipt is equated with approval.
use std::{
    fs::{self,OpenOptions},io::Write,path::PathBuf,
    sync::atomic::{AtomicU64,Ordering},
    time::{SystemTime,UNIX_EPOCH},
};
static REVIEW_TMP_SEQ:AtomicU64=AtomicU64::new(0);
struct ReviewRequestDir(PathBuf);
impl ReviewRequestDir {
    fn allocate()->Result<Self,String>{
        for _ in 0..32 {
            let stamp=SystemTime::now().duration_since(UNIX_EPOCH)
                .map_err(|e|e.to_string())?.as_nanos();
            let seq=REVIEW_TMP_SEQ.fetch_add(1,Ordering::Relaxed);
            let path=std::env::temp_dir().join(format!(
                "relay-review-{}-{stamp}-{seq}",std::process::id()));
            #[cfg(unix)]
            let result={
                use std::os::unix::fs::DirBuilderExt;
                let mut builder=fs::DirBuilder::new();
                builder.mode(0o700);
                builder.create(&path)
            };
            #[cfg(not(unix))]
            let result=fs::create_dir(&path);
            match result {
                Ok(())=>return Ok(Self(path)),
                Err(err) if err.kind()==std::io::ErrorKind::AlreadyExists=>continue,
                Err(err)=>return Err(err.to_string()),
            }
        }
        Err("Unable to allocate private review request directory".into())
    }
    fn write(&self,request:&Value)->Result<PathBuf,String>{
        let path=self.0.join("request.json");
        let mut options=OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]{
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(&path).and_then(|mut file|
            file.write_all(request.to_string().as_bytes()))
            .map_err(|error|error.to_string())?;
        Ok(path)
    }
}
impl Drop for ReviewRequestDir {
    fn drop(&mut self){let _=fs::remove_dir_all(&self.0);}
}

/// Interactive review request passes only a private JSON handoff to the
/// review.preview host tool. The host executor is a trusted, explicit port,
/// not a new autonomous Relay Worker or a fabricated review result.
pub fn run_interactive_review_command<Preview,Control>(
    argv:&[String],mut preview:Preview,mut control:Control,
)->Result<Value,String>
where
    Preview:FnMut(&Path)->Result<String,String>,
    Control:FnMut(&[String],&Value)->Result<Value,String>,
{
    let request=interactive_review_request(argv)?;
    if matches!(argv.first().map(String::as_str),Some("request"|"--path")){
        let relay=&request["relay"];
        let admission=control(argv,&json!({"command":"review.interactive.check","jobId":relay["jobId"],"taskId":relay["taskId"],"executionId":relay["executionId"]}))?;
        if admission["enabled"]!=true{return Err("INTERACTIVE_REVIEW_DISABLED".into());}
        let private=ReviewRequestDir::allocate()?;
        let file=private.write(&request)?;
        let stdout=preview(&file)?;
        let receipt:Value=serde_json::from_str(&stdout)
            .map_err(|error|error.to_string())?;
        if receipt.get("isError")==Some(&Value::Bool(true))
            ||receipt.pointer("/result/isError")==Some(&Value::Bool(true)){
            let summary=receipt.to_string();
            return Err(format!("Neo review.preview rejected: {}",
                summary.chars().take(600).collect::<String>()));
        }
        return Ok(receipt);
    }
    control(&argv[1..],&request)
}

/// Review CLI dispatch retains the original Node order: validation, host
/// invocation, response formatting. An outcome-review effect is injected by
/// the runtime that owns the Graph/SQLite durable review lifecycle.
pub fn run_review_command<Preview,Control,Outcome>(
    action:&str,args:&[String],mut preview:Preview,
    mut control:Control,mut outcome_review:Outcome,
)->Result<Value,String>
where
    Preview:FnMut(&Path)->Result<String,String>,
    Control:FnMut(&[String],&Value)->Result<Value,String>,
    Outcome:FnMut(&[String])->Result<Value,String>,
{
    match action {
        "run"=>outcome_review(args),
        "interactive"=>run_interactive_review_command(
            args,|path|preview(path),|flags,body|control(flags,body)),
        "job"=>{
            let request=review_job_request(args)?;
            let job=control(args,&request)?;
            Ok(review_job_response(&job))
        },
        _=>Err("review supports: job | run | interactive".into())
    }
}
