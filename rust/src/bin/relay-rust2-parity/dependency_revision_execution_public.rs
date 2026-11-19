// Original dependency-revision-execution.ts public API, using the actual
// canonical semantic Dependency Revision Graph at workflow/, never a mock.
use agents_relay_rust2::dependency_revision_execution::{
    dependency_revision_still_current,reconcile_dependency_revision_facts,
};
use serde_json::{json,Value};
use std::path::Path;
pub fn invoke(request:&Value)->Option<Result<String,String>>{
    if request["op"]!="certDependencyRevisionExecution"{return None;}
    Some((||{
        let job=&request["job"];
        let result=match request["method"].as_str().unwrap_or(""){
            "stillCurrent"=>json!(dependency_revision_still_current(job,&request["task"])),
            "reconcileFacts"=>{
                let mut job=job.clone();
                let ids=request["reservedIds"].as_array().into_iter().flatten()
                    .filter_map(Value::as_str).map(str::to_string).collect::<Vec<_>>();
                let graph=Path::new(env!("CARGO_MANIFEST_DIR"))
                    .parent().ok_or("Rust repository root missing")?.join("workflow");
                let created=reconcile_dependency_revision_facts(&graph,&mut job,&ids)?;
                json!({"created":created,"job":job})
            },
            value=>return Err(format!("Unknown dependency-revision-execution public method {value}")),
        };
        Ok(result.to_string())
    })())
}
