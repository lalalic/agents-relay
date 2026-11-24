//! Shared DAG file-result pre-completion gate for Script and Model workers.
//! Worker completion runs this BEFORE its terminal event; the Task Graph
//! remains the only authority allowed to commit durable Task success.
use crate::{
    continuation::DeliveryProcessOptions,
    dag_result_contract::dag_completion_error_owned,
    owned_process::OwnedProcessManager,
};
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use std::{fs,io::Read,path::{Path,PathBuf},time::Duration};

fn trusted_paths(job:&Value,task:&Value)->Result<(PathBuf,PathBuf),String>{
    if task.get("dagNode").is_none_or(Value::is_null){
        return Err("DAG pre-completion requires a DAG child Task".into());
    }
    if task.pointer("/output/kind").and_then(Value::as_str)!=Some("file"){
        return Err("DAG pre-completion requires a file result target".into());
    }
    let project=Path::new(job.get("projectRoot").and_then(Value::as_str)
        .ok_or("DAG pre-completion requires a canonical project root")?);
    let project=fs::canonicalize(project).map_err(|e|format!("Invalid DAG project root: {e}"))?;
    let path=Path::new(task.pointer("/output/path").and_then(Value::as_str)
        .ok_or("DAG pre-completion requires a declared result path")?);
    if !path.is_absolute(){return Err("DAG result target must be absolute".into());}
    let output=fs::canonicalize(path)
        .map_err(|e|format!("DAG result file missing or inaccessible: {e}"))?;
    if !output.starts_with(&project)||!output.is_file(){
        return Err("DAG result target escaped its project root or is not a file".into());
    }
    Ok((project,output))
}
fn sha256_file(path:&Path)->Result<String,String>{
    let mut file=fs::File::open(path).map_err(|e|format!("DAG file {} is unavailable: {e}",path.display()))?;
    let mut hasher=Sha256::new();
    let mut bytes=[0u8;131072];
    loop {
        let size=file.read(&mut bytes).map_err(|e|format!("DAG read failed: {e}"))?;
        if size==0{break;}
        hasher.update(&bytes[..size]);
    }
    Ok(format!("{:x}",hasher.finalize()))
}
fn capture_file_receipt(job:&Value,task:&Value)->Result<Value,String>{
    let (project,output)=trusted_paths(job,task)?;
    // Hash and parse the SAME byte snapshot. Reading twice could pair a
    // digest from one version with artifact references from another.
    let result_bytes=fs::read(&output)
        .map_err(|e|format!("DAG result disappeared after validation: {e}"))?;
    let result_sha256=format!("{:x}",Sha256::digest(&result_bytes));
    let payload:Value=serde_json::from_slice(&result_bytes)
        .map_err(|e|format!("Invalid DAG result JSON after validation: {e}"))?;
    let mut artifacts=Vec::new();
    if let Some(paths)=payload["artifacts"].as_array(){
        if paths.len()>512{return Err("DAG result has too many artifact paths".into());}
        let run=output.parent().and_then(Path::parent)
            .ok_or("DAG result has no run directory")?;
        for item in paths {
            let path=Path::new(item.as_str().ok_or("DAG artifacts must be strings")?);
            let candidate=if path.is_absolute(){path.to_path_buf()}else{run.join(path)};
            let canonical=fs::canonicalize(&candidate)
                .map_err(|e|format!("DAG artifact {} is unavailable: {e}",candidate.display()))?;
            if !canonical.starts_with(&project)||!canonical.is_file(){
                return Err(format!("DAG artifact {} is outside project or not a file",candidate.display()));
            }
            artifacts.push(json!({"path":canonical,"sha256":sha256_file(&canonical)?}));
        }
    }
    Ok(json!({"resultPath":output,"resultSha256":result_sha256,"artifacts":artifacts}))
}

/// Validate the structural result, real stage contract, and artifact existence.
/// Returns a content-bound receipt; the caller MUST recheck inside the same
/// SQLite CAS that commits the Graph's successful Task transition.
pub fn validate_dag_precompletion(job:&Value,task:&Value,interpreter:&Path)->Result<Value,String>{
    let (project,_output)=trusted_paths(job,task)?;
    if !interpreter.is_absolute()||!interpreter.is_file(){
        return Err("DAG stage verifier requires an absolute installed interpreter".into());
    }
    // Bind BOTH the result and every string artifact to the bytes that the
    // project Stage verifier is about to inspect. Never accept files first
    // observed only after a Stage validator returned PASS.
    let initial_receipt=capture_file_receipt(job,task)?;
    let mut manager=OwnedProcessManager::default();
    if let Some(reason)=dag_completion_error_owned(task,Some(&project),
        interpreter.to_str().ok_or("Invalid interpreter encoding")?,&mut manager,
        DeliveryProcessOptions{timeout:Some(Duration::from_secs(30)),..Default::default()}){
        return Err(format!("DAG_PRECOMPLETION_INVALID: {reason}"));
    }
    let receipt=capture_file_receipt(job,task)?;
    if receipt!=initial_receipt{
        return Err("DAG result or artifact changed during pre-completion Stage validation".into());
    }
    Ok(receipt)
}

/// Repeat content verification INSIDE the SQLite compare-and-swap, not just
/// at the worker's earlier validation step. A changed/retargeted result or
/// artifact cannot be completed with the stale validation receipt.
pub fn verify_dag_precompletion_receipt(job:&Value,task:&Value,receipt:&Value)->Result<(),String>{
    let fresh=capture_file_receipt(job,task)?;
    if fresh!=*receipt{
        return Err("DAG_PRECOMPLETION_STALE: result or artifact changed after validation; repair and retry in this execution".into());
    }
    Ok(())
}

/// A validation receipt is tied to the exact running Task and its stage
/// contract, not to unrelated Job metadata or other Tasks. Invoke inside
/// the terminal mutation transaction before applying the Graph transition.
pub fn verify_dag_completion_context(
    before_job:&Value,before_task:&Value,fresh_job:&Value,fresh_task:&Value,
    execution_id:&str,receipt:&Value,
)->Result<(),String>{
    if execution_id.is_empty() || fresh_task["state"]!="RUNNING"
        || before_task["executionId"]!=execution_id
        || fresh_task["executionId"]!=execution_id{
        return Err("DAG completion refused: stale or non-running execution".into());
    }
    if fresh_job["id"]!=before_job["id"] || fresh_job["projectRoot"]!=before_job["projectRoot"]
        || ["id","dagNode","agentName","input","output"].iter()
            .any(|key|fresh_task[*key]!=before_task[*key]){
        return Err("DAG validation context changed".into());
    }
    verify_dag_precompletion_receipt(fresh_job,fresh_task,receipt)
}
