//! Rust-owned non-browser Codex Model Worker; Node CodexAdapter parity.
//! Provider process exit is NOT a Graph task.started/completed receipt.
use crate::{
    execution_process_tracker::monitor_execution_process,
    codex_permissions::exec_args,
    owned_process::{OwnedProcessManager,OwnedProcessOptions,TerminationReason},
    relay_store::SQLiteRelayStore,
    execution_context::resolve_execution_context,
    final_review_role::is_final_review_agent,
    managed_worker_input::managed_worker_input_resolved,
    reconciler_context::resolve_task_context,
};
use serde_json::{json,Value};
use std::{io::Read,path::Path,thread,time::Duration};
fn field<'a>(v:&'a Value,k:&str)->&'a str{
    v.get(k).and_then(Value::as_str).unwrap_or("")
}
/// Reuse the same native execution-context and managed prompt contract as
/// Browser Workers. The source Task input stays immutable in canonical SQLite.
pub fn native_codex_managed_prompt(
    db:&Path,job:&Value,task:&Value,project:&Path,
)->Result<String,String>{
    let cwd=project.to_str().ok_or("Codex project path is not UTF-8")?;
    let task_id=field(task,"id");
    let name=field(task,"agentName");
    let role=if is_final_review_agent(Some(name)){"reviewer"}
        else if name=="troubleshooter"{"troubleshooter"}
        else{"worker"};
    let store=SQLiteRelayStore::open_without_claim_reset(db,Some(field(job,"id")))?;
    let agents=store.load_agents()?.unwrap_or_default();
    let adapters=vec![json!({"name":"codex","id":"codex",
        "capabilities":["model","codex","local_repo","iterative_tools"]})];
    let options=json!({"workspaceRoot":project.parent(),
        "globalRoot":std::env::var("HOME").ok().map(|h|format!("{h}/.agents"))});
    let future=resolve_task_context(cwd,role,&options,&agents,&adapters,
        |project,role,options|std::future::ready(
            resolve_execution_context(&project,&role,&options)));
    let mut future=std::pin::pin!(future);
    let mut context=std::task::Context::from_waker(std::task::Waker::noop());
    let context=match std::future::Future::poll(future.as_mut(),&mut context){
        std::task::Poll::Ready(result)=>result?,
        std::task::Poll::Pending=>return Err(
            "Native Codex context resolution unexpectedly suspended".into()),
    };
    let package_root=Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent().ok_or("Native Rust package root missing")?;
    let prompt=managed_worker_input_resolved(job,task,Some(&context),
        "production",package_root,None)?;
    if !prompt.contains(&format!("job/{}/task/{task_id}/execution/{}",
        field(job,"id"),field(task,"executionId"))){
        return Err("Native Codex prompt lacks exact execution event binding".into());
    }
    Ok(prompt)
}
/// A Codex Model can ask the independent Host for real human review and
/// legitimately exit while the Graph persists the waiting invocation.
/// This is not Task success: the Job remains ACTIVE/WAITING, and only the
/// future authenticated Host decision can release the same Task.
pub fn valid_codex_review_handoff(task:&Value,execution_id:&str)->bool{
    let binding=task.get("interactiveInvocation").unwrap_or(&Value::Null);
    field(task,"state")=="AWAITING_DECISION"
        &&field(binding,"status")=="awaiting_decision"
        &&field(binding,"executionId")==execution_id
        &&field(binding,"invocationId")==execution_id
        &&field(binding,"revision")==execution_id
}

/// Exactly one leased generation and an explicitly configured absolute
/// Codex binary. Never claim Task success merely from process exit code 0.
pub fn execute_claimed_codex(
    db:&Path,job:&Value,task:&Value,executable:&Path,project:&Path,
)->Result<(),String>{
    let job_id=field(job,"id");let task_id=field(task,"id");
    let execution_id=field(task,"executionId");
    if job_id.is_empty()||task_id.is_empty()||execution_id.is_empty()
        ||field(task,"adapter")!="codex"
        ||field(task,"state")!="QUEUED"{
        return Err("Codex Worker requires exactly one committed Task lease".into());
    }
    if !executable.is_absolute()||!executable.is_file(){
        return Err("Native Codex executable must be an absolute file".into());
    }
    if !project.is_absolute()||!project.is_dir(){
        return Err("Native Codex Worker requires canonical projectRoot".into());
    }
    let route=task.get("routing").filter(|v|v.is_object())
        .ok_or("Codex Worker requires persisted Model Router selection")?;
    let model=field(route,"model");
    if model.is_empty(){return Err("Codex Worker route requires model".into());}
    // The canonical execution context and immutable Agent/Events contracts
    // must be assembled BEFORE provider launch. Raw task.input alone loses
    // start/progress/terminal event instructions, making real Codex exit an
    // unverified lease even when the implementation is correct.
    let prompt=native_codex_managed_prompt(db,job,task,project)?;
    let cwd=project.to_str().ok_or("Codex project path is not UTF-8")?;
    // The operator explicitly authorizes native Codex Workers to run with
    // unrestricted filesystem/network access and without approval prompts.
    // Unlike workspace-write, this permits macOS toolchains to write their
    // normal SwiftPM/Xcode caches outside the checked-out repository.
    // The owned process, Task execution identity, and Graph completion gates
    // remain mandatory; unrestricted shell access is not Task success.
    let mut args=exec_args(true);
    let profile=field(route,"profile");
    if !profile.is_empty(){args.extend(["-p".into(),profile.into()]);}
    args.extend(["-m".into(),model.into()]);
    let reasoning=field(route,"reasoning");
    if !reasoning.is_empty(){
        args.extend(["-c".into(),format!("model_reasoning_effort={reasoning}")]);
    }
    args.extend(["-C".into(),cwd.into(),"--".into(),prompt]);
    let refs=args.iter().map(String::as_str).collect::<Vec<_>>();
    let mut manager=OwnedProcessManager::default();
    let child=manager.spawn_owned_process_piped(
        executable.to_str().ok_or("Codex binary path is not UTF-8")?,
        &refs,OwnedProcessOptions{
            invocation:format!("rust-codex-task:{job_id}/{task_id}"),
            cwd:Some(project.to_path_buf()),timeout_ms:None,
            grace_ms:500,supervisor_path:None,
        })?;
    {
    let store=SQLiteRelayStore::open_without_claim_reset(db,Some(job_id))?;
    let monitor=monitor_execution_process(
        job_id,task_id,execution_id,Some(i64::from(child.pid())),
        |record|std::future::ready(store.record_execution_process(&record)));
    let mut monitor=std::pin::pin!(monitor);
    let mut cx=std::task::Context::from_waker(std::task::Waker::noop());
    match std::future::Future::poll(monitor.as_mut(),&mut cx){
        std::task::Poll::Ready(Ok(Some(_)))=>{},
        std::task::Poll::Ready(Ok(None))=>{
            child.terminate(TerminationReason::Abort,Some(100));
            return Err("Owned Codex process identity not captured".into());
        },
        std::task::Poll::Ready(Err(e))=>{
            child.terminate(TerminationReason::Abort,Some(100));
            return Err(e);
        },
        std::task::Poll::Pending=>{
            child.terminate(TerminationReason::Abort,Some(100));
            return Err("Codex process registration unexpectedly suspended".into());
        }
    }
    }
    let stdout=child.take_stdout().ok_or("Codex JSONL stdout not owned")?;
    let stderr=child.take_stderr().ok_or("Codex stderr not owned")?;
    let output_thread=thread::spawn(move||{
        let mut data=Vec::new();
        stdout.take(2*1024*1024+1).read_to_end(&mut data)
            .map(|_|data).map_err(|e|e.to_string())
    });
    let error_thread=thread::spawn(move||{
        let mut data=Vec::new();
        stderr.take(64*1024+1).read_to_end(&mut data)
            .map(|_|data).map_err(|e|e.to_string())
    });
    let status=loop{
        if let Some(status)=child.exit_status()?{break status;}
        thread::sleep(Duration::from_millis(70));
    };
    let _=SQLiteRelayStore::open_without_claim_reset(db,Some(job_id))
        .and_then(|store|store.finish_execution_process(job_id,task_id,execution_id,None));
    let output=output_thread.join().map_err(|_|"Codex stdout reader panicked")??;
    let errors=error_thread.join().map_err(|_|"Codex stderr reader panicked")??;
    let stdout=String::from_utf8_lossy(&output);
    let stderr=String::from_utf8_lossy(&errors);
    let structured=stdout.lines().filter_map(|line|{
        let event=serde_json::from_str::<Value>(line).ok()?;
        (field(&event,"type")=="turn.failed").then(||event.pointer("/error/message")
            .and_then(Value::as_str).unwrap_or("Codex turn failed").to_owned())
    }).last();
    if !status.success(){
        return Err(structured.unwrap_or_else(||{
            if stderr.trim().is_empty(){format!("Codex exited {status}")}
            else{stderr.chars().rev().take(1500).collect::<String>()
                .chars().rev().collect()}
        }));
    }
    // Only the execution-correlated Graph result is successful. A process
    // exiting without a terminal event is recovered by the daemon process
    // monitor, not by a countdown or guessed success.
    let store=SQLiteRelayStore::open_without_claim_reset(db,Some(job_id))?;
    let latest=store.load_job(job_id)?.ok_or("Codex Job disappeared")?;
    let durable=latest.get("tasks").and_then(Value::as_array)
        .into_iter().flatten().find(|v|field(v,"id")==task_id)
        .ok_or("Codex Task disappeared")?;
    if field(durable,"state")=="SUCCEEDED"
        &&durable.get("executionHistory").and_then(Value::as_array)
            .into_iter().flatten().any(|v|field(v,"id")==execution_id){
        return Ok(());
    }
    if valid_codex_review_handoff(durable,execution_id){return Ok(());}
    if matches!(field(durable,"state"),"FAILED"|"CANCELLED"){
        return Err("Codex Task canonical Graph outcome is not successful".into());
    }
    Err("Codex process exited without verified Task terminal event".into())
}
