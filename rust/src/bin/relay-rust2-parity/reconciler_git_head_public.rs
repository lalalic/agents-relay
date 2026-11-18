use agents_relay_rust2::reconciler_git_head::verified_local_head;
use serde_json::{json,Value};
use std::path::Path;

pub fn invoke(request:&Value)->Result<String,String>{
    let job=&request["job"];
    let project=Path::new(request["project"].as_str().unwrap_or("."));
    let with_git=request["useGit"]!=false;
    Ok(json!({"head":verified_local_head(job,project,with_git)}).to_string())
}
