//! Host-selected JavaScript Script Agent invocation through a Rust-owned
//! supervised process group. The JS module contains application logic; the
//! Rust daemon/Graph alone decides Task state. No Node Relay subprocess.
use crate::owned_process::{OwnedProcessManager,OwnedProcessOptions,TerminationReason};
use serde_json::{json,Value};
use std::{io::{Read,Write},path::Path,sync::atomic::{AtomicBool,Ordering},thread,time::Duration};

/// An explicit absolute script interpreter is required. PATH lookup or an
/// implicit Node daemon fallback would make deployments nondeterministic.
pub fn configured_script_interpreter()->Result<String,String>{
    let configured=std::env::var("AGENTS_RELAY_SCRIPT_NODE")
        .map_err(|_|"AGENTS_RELAY_SCRIPT_NODE must name an absolute trusted JS runtime")?;
    if !Path::new(&configured).is_absolute() || !Path::new(&configured).is_file(){
        return Err("AGENTS_RELAY_SCRIPT_NODE must be an absolute executable file".into());
    }
    Ok(configured)
}
/// The caller must supply a source-resolved trusted .shortcut Agent module.
/// Job/task/execution IDs are fed into that module by launch_script_task.
pub fn invoke_trusted_script(
    interpreter:&Path,script:&Path,input:&Value,
    cancelled:&AtomicBool,
)->Result<Value,String>{
    invoke_trusted_script_recorded(interpreter,script,input,cancelled,|_|Ok(()))
}
/// The exact owned PID must be durably recorded by the caller before any
/// untrusted Shortcut JS begins. A failed identity record terminates this
/// original process group and rejects its eventual stdout as completion.
pub fn invoke_trusted_script_recorded<Record>(
    interpreter:&Path,script:&Path,input:&Value,
    cancelled:&AtomicBool,mut record:Record,
)->Result<Value,String>
where Record:FnMut(u32)->Result<(),String>{
    if !interpreter.is_absolute()||!interpreter.is_file(){
        return Err("Native Script runtime requires an absolute interpreter".into());
    }
    if !script.is_absolute()||!script.is_file(){
        return Err("Native Script runtime requires a resolved Script module".into());
    }
    if !input.is_object(){return Err("Script Worker input must be an object".into());}
    if cancelled.load(Ordering::Acquire){return Err("Script Task cancelled".into());}
    // Embed the trusted runner at compile time; a deployed native binary
    // must not depend on its original build directory or writable source.
    const RUNNER:&str=include_str!("../runtime/script-worker-runner.mjs");
    let interpreter=interpreter.to_str().ok_or("Invalid Script runtime path")?;
    let project=script.parent().and_then(|p|p.parent())
        .ok_or("Script Agent module has no trusted source directory")?;
    let payload=json!({"script":script,"input":input}).to_string()+"\n";
    let mut owned=OwnedProcessManager::default();
    let worker=owned.spawn_owned_process_stdio(interpreter,
        &["--input-type=module","--eval",RUNNER],OwnedProcessOptions{
        invocation:"rust-relay-script-worker".into(),cwd:Some(project.to_path_buf()),
        timeout_ms:None,grace_ms:250,supervisor_path:None,
    })?;
    record(worker.pid())?;
    let mut stdin=worker.take_stdin().ok_or("Script runner stdin not owned")?;
    stdin.write_all(payload.as_bytes()).map_err(|e|e.to_string())?;
    drop(stdin);
    let stdout=worker.take_stdout().ok_or("Script runner stdout not owned")?;
    let reader=thread::spawn(move||{
        let mut output=Vec::new();
        stdout.take(8*1024*1024+1).read_to_end(&mut output)
            .map(|_|output).map_err(|e|e.to_string())
    });
    loop{
        if cancelled.load(Ordering::Acquire){
            worker.terminate(TerminationReason::Cancel,Some(100));
            return Err("Script Task cancelled".into());
        }
        if worker.exit_status()?.is_some(){break;}
        thread::sleep(Duration::from_millis(15));
    }
    let output=reader.join().map_err(|_|"Script runner pipe reader panicked")??;
    if output.len()>8*1024*1024{return Err("Script result exceeded 8MB".into());}
    let text=String::from_utf8(output).map_err(|_|"Script result was not UTF-8")?;
    let frames=text.lines().filter(|line|!line.trim().is_empty()).collect::<Vec<_>>();
    if frames.len()!=1{return Err("Script Worker must emit exactly one JSON result".into());}
    let reply:Value=serde_json::from_str(frames[0]).map_err(|e|
        format!("Script Worker returned invalid JSON: {e}"))?;
    if reply.get("ok")==Some(&Value::Bool(true)){
        return reply.get("result").cloned().ok_or("Script result missing".into());
    }
    Err(reply.get("error").and_then(Value::as_str).unwrap_or("Script Worker failed").into())
}
