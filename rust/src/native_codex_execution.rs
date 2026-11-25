//! Rust-owned non-browser Codex Model Worker; Node CodexAdapter parity.
//! Provider process exit is NOT a Graph task.started/completed receipt.
use crate::{
    execution_process_tracker::monitor_execution_process,
    native_codex_thread::{build_codex_turn_args,persist_task_thread,compatible_thread,recovery_prompt,
        CodexTurnFacts},
    owned_process::{OwnedProcessManager,OwnedProcessOptions,TerminationReason},
    relay_store::SQLiteRelayStore,
    terminal_event_recovery::{terminal_recovery_eligible,terminal_recovery_prompt,TerminalRecoveryFacts},
    reconciler_context::{worker_managed_prompt,WorkerContextRoots},
};
use serde_json::{json,Value};
use std::{io::{Read,BufRead,BufReader},path::Path,thread,time::Duration};
fn field<'a>(v:&'a Value,k:&str)->&'a str{
    v.get(k).and_then(Value::as_str).unwrap_or("")
}
/// Reuse the same native execution-context and managed prompt contract as
/// Browser Workers. The source Task input stays immutable in canonical SQLite.
pub fn native_codex_managed_prompt(
    db:&Path,job:&Value,task:&Value,project:&Path,roots:&WorkerContextRoots,
)->Result<String,String>{
    let adapters=vec![json!({"name":"codex","id":"codex",
        "capabilities":["model","codex","local_repo","iterative_tools"]})];
    worker_managed_prompt(db,job,task,project,roots,&adapters)
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
    db:&Path,job:&Value,task:&Value,executable:&Path,project:&Path,roots:&WorkerContextRoots,
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
    let prompt=native_codex_managed_prompt(db,job,task,project,roots)?;
    let cwd=project.to_str().ok_or("Codex project path is not UTF-8")?;
    // The operator explicitly authorizes native Codex Workers to run with
    // unrestricted filesystem/network access and without approval prompts.
    // Unlike workspace-write, this permits macOS toolchains to write their
    // normal SwiftPM/Xcode caches outside the checked-out repository.
    // The owned process, Task execution identity, and Graph completion gates
    // remain mandatory; unrestricted shell access is not Task success.
    let prior_thread=task.get("threadId").and_then(Value::as_str)
        .filter(|id|!id.is_empty());
    let resume_thread=compatible_thread(task,route);
    let mut turn_prompt=recovery_prompt(task,route,&crate::model_routing::default_codex_home(),&prompt);
    let mut recovery_attempts=0.0;
    let mut resume=resume_thread.map(str::to_owned);
    let mut prior=prior_thread.map(str::to_owned);
    let original_prompt=prompt;
    loop{
        let (status,output,errors)=match run_codex_turn(db,job_id,task_id,execution_id,
            executable,project,cwd,route,&turn_prompt,prior.as_deref(),resume.as_deref(),
            recovery_attempts>0.0){
            Ok(result)=>result,
            Err(error)=>{
                // A terminal event can settle during the gap before a
                // corrective launch. Do not convert that receipt to failure.
                if recovery_attempts>0.0 && current_task(db,job_id,task_id)
                    .is_ok_and(|task|verified_outcome(&task,execution_id)){
                    return Ok(());
                }
                return Err(error);
            },
        };
        let stderr=String::from_utf8_lossy(&errors);
        let structured=output.terminal_failure().map(str::to_owned);
        if !status.success() || structured.is_some(){
            // Check the persisted thread and current execution fence before
            // permitting continuation after already completed tool effects.
            let current=SQLiteRelayStore::open_without_claim_reset(db,Some(job_id))?
                .load_job(job_id)?.and_then(|j|j["tasks"].as_array()?.iter()
                    .find(|t|field(t,"id")==task_id).cloned());
            if let Some(thread)=current.as_ref().filter(|t|field(t,"executionId")==execution_id)
                .map(|t|field(t,"threadId")).filter(|id|!id.is_empty()){
                if let Some((kind,reason))=output.resumable_provider_failure(thread){
                    if kind!="resume_context_incompatible" || resume.is_some(){
                        return Err(format!("codex_provider_continuation_{kind}: {reason}"));
                    }
                }
            }
            // A corrective turn may follow real effects from the first
            // turn. Its local no-effects proof is not execution-wide proof.
            if recovery_attempts==0.0{
                if let Some(reason)=output.quota_failure_without_effects(){
                    return Err(format!("codex_quota_no_side_effects: {reason}"));
                }
            }
            return Err(structured.unwrap_or_else(||{
                if stderr.trim().is_empty(){format!("Codex exited {status}")}
                else{stderr.chars().rev().take(1500).collect::<String>()
                    .chars().rev().collect()}
            }));
        }

        // Allow bounded ingestion time for asynchronous worker events. SQLite,
        // not provider output or a bus receipt alone, is authoritative.
        let mut durable=current_task(db,job_id,task_id)?;
        for _ in 0..10{
            if !active_execution(&durable,execution_id){break;}
            thread::sleep(Duration::from_millis(100));
            durable=current_task(db,job_id,task_id)?;
        }
        if verified_outcome(&durable,execution_id){return Ok(());}
        if matches!(field(&durable,"state"),"FAILED"|"CANCELLED"){
            return Err("Codex Task canonical Graph outcome is not successful".into());
        }
        let compatible=compatible_thread(&durable,route);
        let safe=compatible.is_some_and(|id|output.safe_terminal_continuation(id));
        if !active_execution(&durable,execution_id)||!terminal_recovery_eligible(&TerminalRecoveryFacts{
            has_session:safe,has_thread:compatible.is_some(),terminal_observed:false,
            recovery_attempts,outcome_uncertain:!safe,cancelled:false,
        }){
            return Err("Codex process exited without verified Task terminal event".into());
        }
        recovery_attempts+=1.0;
        resume=compatible.map(str::to_owned);
        prior=resume.clone();
        turn_prompt=format!("{}\n\n{}",original_prompt,terminal_recovery_prompt(execution_id));
        eprintln!("Native Codex Worker {job_id}/{task_id}: corrective terminal turn {recovery_attempts}");
    }
}

fn current_task(db:&Path,job_id:&str,task_id:&str)->Result<Value,String>{
    SQLiteRelayStore::open_without_claim_reset(db,Some(job_id))?.load_job(job_id)?
        .and_then(|j|j["tasks"].as_array()?.iter().find(|t|field(t,"id")==task_id).cloned())
        .ok_or_else(||"Codex Task disappeared".into())
}
fn verified_outcome(task:&Value,execution_id:&str)->bool{
    (field(task,"state")=="SUCCEEDED"
        &&task.get("executionHistory").and_then(Value::as_array)
            .and_then(|history|history.last()).is_some_and(|v|field(v,"id")==execution_id))
        ||valid_codex_review_handoff(task,execution_id)
}
fn active_execution(task:&Value,execution_id:&str)->bool{
    field(task,"executionId")==execution_id&&matches!(field(task,"state"),"QUEUED"|"RUNNING")
}

/// One owned subprocess, including exact-generation process and thread registration.
/// Corrective turns are sequential within the existing daemon ExecutionGuard.
#[allow(clippy::too_many_arguments)]
fn run_codex_turn(db:&Path,job_id:&str,task_id:&str,execution_id:&str,
    executable:&Path,project:&Path,cwd:&str,route:&Value,prompt:&str,
    prior_thread:Option<&str>,resume_thread:Option<&str>,corrective:bool,
)->Result<(std::process::ExitStatus,CodexTurnFacts,Vec<u8>),String>{
    if corrective{
        let task=current_task(db,job_id,task_id)?;
        if !active_execution(&task,execution_id)||compatible_thread(&task,route)!=resume_thread{
            return Err("Corrective Codex turn lost its execution or thread fence".into());
        }
    }
    let args=build_codex_turn_args(route,cwd,prompt,resume_thread)?;
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
        |record|std::future::ready(if corrective{
            store.replace_ended_execution_process(&record)
        }else{store.record_execution_process(&record)}));
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
    if corrective && !current_task(db,job_id,task_id).is_ok_and(|t|active_execution(&t,execution_id)){
        child.terminate(TerminationReason::Abort,Some(100));
        let _=SQLiteRelayStore::open_without_claim_reset(db,Some(job_id))
            .and_then(|store|store.finish_execution_process(job_id,task_id,execution_id,None));
        return Err("Corrective Codex turn lost its execution fence".into());
    }
    let stdout=child.take_stdout().ok_or("Codex JSONL stdout not owned")?;
    let stderr=child.take_stderr().ok_or("Codex stderr not owned")?;
    let db_for_thread=db.to_path_buf();
    let jid=job_id.to_owned();let tid=task_id.to_owned();
    let xid=execution_id.to_owned();
    let prior=prior_thread.map(str::to_owned);
    let resume=resume_thread.map(str::to_owned);
    let launched_route=route.clone();
    let output_thread=thread::spawn(move||{
        let mut facts=CodexTurnFacts::new();
        let mut recorded=resume;
        let mut read_error:Option<String>=None;
        // Drain stdout for the entire owned process. Keep only parsed facts
        // and one event at a time, never an accumulated transcript.
        let mut reader=BufReader::new(stdout);
        let mut bytes=Vec::new();
        loop{
            bytes.clear();
            if reader.read_until(b'\n',&mut bytes).map_err(|e|e.to_string())?==0{break;}
            if read_error.is_some(){continue;}
            let line=match std::str::from_utf8(&bytes){
                Ok(line)=>line,
                Err(error)=>{read_error=Some(error.to_string());continue;}
            };
            if let Some(id)=facts.observe(line){
                match recorded.as_deref(){
                    None=>match persist_task_thread(&db_for_thread,&jid,&tid,&xid,&id,prior.as_deref(),&launched_route){
                        Ok(())=>recorded=Some(id),
                        Err(error)=>{read_error=Some(error);continue;}
                    },
                    Some(previous) if previous!=id=>{
                        read_error=Some("Codex resumed a different thread".into());
                        continue;
                    },
                    _=>{},
                }
            }
            // Release an unusually large event allocation rather than
            // retaining its tool output capacity for the rest of the turn.
            if bytes.capacity()>64*1024{bytes=Vec::new();}
        }
        if let Some(error)=read_error{return Err(error);}
        Ok::<CodexTurnFacts,String>(facts)
    });
    let error_thread=thread::spawn(move||{
        // Keep a bounded diagnostic tail but always drain stderr to EOF.
        let mut stderr=stderr;
        let mut chunk=[0u8;8192];
        let mut tail=Vec::new();
        loop{
            let n=stderr.read(&mut chunk).map_err(|e|e.to_string())?;
            if n==0{break;}
            tail.extend_from_slice(&chunk[..n]);
            if tail.len()>64*1024{
                tail.drain(..tail.len()-64*1024);
            }
        }
        Ok::<Vec<u8>,String>(tail)
    });
    let status=loop{
        if let Some(status)=child.exit_status()?{break status;}
        thread::sleep(Duration::from_millis(70));
    };
    SQLiteRelayStore::open_without_claim_reset(db,Some(job_id))?
        .finish_execution_process(job_id,task_id,execution_id,None)?;
    let output=output_thread.join().map_err(|_|"Codex stdout reader panicked")??;
    let errors=error_thread.join().map_err(|_|"Codex stderr reader panicked")??;
    Ok((status,output,errors))
}
