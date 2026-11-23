//! Correlated Script Worker lifecycle: one leased Task, one source-declared
//! Shortcut JS module, one native owned process group and Graph/SQLite events.
//! A Worker's stdout or exit code is never sufficient to complete a Task;
//! only the exact source-execution Event enters the canonical Graph.
use crate::{
    native_script_worker::invoke_trusted_script_recorded,
    execution_process_tracker::monitor_execution_process,
    task_transitions::try_transition_task_event,
    worker_failure_recovery::{classify_worker_launch_failure,apply_launch_failure_mutation},
    local_merge_lock::iso8601_now,
    reconciler_runtime::ReconcilerRuntime,
    relay_store::SQLiteRelayStore,
    script_task_adapter::launch_script_task,
    events::event_for,
    execution_event_identity::execution_event_source,
};
use serde_json::{json,Value};
use std::{path::Path,sync::atomic::AtomicBool};
fn field<'a>(v:&'a Value,key:&str)->&'a str{
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

/// All events are applied to the current, execution-correlated SQLite Job by
/// the exact shared Task Graph. No direct Task.state writes exist here.
pub fn persist_native_script_event(
    db_path:&Path,graph_directory:&Path,
    job_id:&str,task_id:&str,execution_id:&str,event:&Value,
)->Result<Value,String>{
    let scope=SQLiteRelayStore::open_without_claim_reset(db_path,Some(job_id))?;
    let before=scope.load_job(job_id)?.ok_or("Script Task's Job disappeared")?;
    let current=before.get("tasks").and_then(Value::as_array)
        .into_iter().flatten().find(|task|field(task,"id")==task_id)
        .ok_or("Script Task generation disappeared")?;
    if field(current,"executionId")!=execution_id
        ||field(event,"job_id")!=job_id
        ||field(event,"task_id")!=task_id{
        return Err("Script Task event belongs to a stale or different execution".into());
    }
    let expected=execution_event_source(job_id,task_id,execution_id);
    if event.pointer("/source/id").and_then(Value::as_str)!=Some(expected.as_str()){
        return Err("Script Task event source identity mismatch".into());
    }
    let dag_proof=if field(event,"type")=="task.completed"
        &&current.get("dagNode").is_some_and(|v|!v.is_null()){
        let interpreter=crate::native_script_worker::configured_script_interpreter()?;
        Some(crate::dag_precompletion::validate_dag_precompletion(
            &before,current,Path::new(&interpreter))?)
    }else{None};
    let mut validated_event=event.clone();
    if let Some(proof)=&dag_proof{
        validated_event["data"]["validated_dag_result"]=json!(true);
        validated_event["data"]["dag_result_proof"]=proof.clone();
    }
    let event=&validated_event;
    let candidate=if field(current,"state")=="QUEUED"
        && field(event,"type")=="task.failed"{
        // The original ScriptTaskAdapter reports an asynchronous failure
        // even when the Shortcut is missing and task.started never happened.
        // Task Graph intentionally rejects task.failed from QUEUED: map only
        // this execution-verified pre-start observation to its canonical
        // worker.delivery_failed edge, with the same durable Event receipt.
        // Never fabricate task.started to make that failure look like an
        // execution that ran. The Graph and SQLite CAS remain authoritative.
        let admission=classify_worker_launch_failure(Some(current),
            &event.get("message").cloned().unwrap_or(Value::Null),
            "launch",Some(execution_id),None,false,false,false);
        let mut candidate=before.clone();
        let index=candidate["tasks"].as_array().ok_or("Script Job Tasks missing")?
            .iter().position(|item|field(item,"id")==task_id)
            .ok_or("Script Task missing from durable candidate")?;
        let task=&mut candidate["tasks"][index];
        let decision=try_transition_task_event(graph_directory,task,
            &admission.event,&admission.facts,&iso8601_now())?;
        if decision.get("accepted")!=Some(&Value::Bool(true)){
            return Err(format!("Script Task Graph rejected canonical pre-start {}",
                admission.event));
        }
        apply_launch_failure_mutation(task,Some(current),&admission,&decision);
        candidate
    }else{
        let mut runtime=ReconcilerRuntime::new("native-script-worker");
        let output=runtime.apply_event(graph_directory,&before,event,None)?;
        if !output.applied{
            return Err(format!("Script Task Graph rejected {}: {}",
                field(event,"type"),output.reason));
        }
        output.job
    };
    let expected=before.clone();
    let durable_event=json!({
        "key":format!("script-event/{job_id}/{task_id}/{execution_id}/{}",field(event,"type")),
        "event":event,
    });
    let recorded=scope.commit_workflow_mutation_and_events(job_id,move |fresh|{
        if fresh!=expected{return Err("Script Task generation changed during SQLite CAS".into());}
        if let Some(proof)=&dag_proof{
            let original=expected["tasks"].as_array().into_iter().flatten()
                .find(|task|field(task,"id")==task_id)
                .ok_or("Script DAG Task vanished during pre-completion CAS")?;
            crate::dag_precompletion::verify_dag_precompletion_receipt(
                &expected,original,proof)?;
        }
        Ok(candidate)
    },&[durable_event])?;
    Ok(recorded)
}
/// Exactly one isolated asynchronous Worker invocation. The daemon grants
/// execution only after committing its unique lease to SQLite; this runner
/// never claims a Task or overrides a replacement generation.
pub fn run_claimed_script_task(
    db_path:&Path,graph_directory:&Path,job:&Value,task:&Value,
    interpreter:&Path,timeout_ms:u64,
)->Result<Value,String>{
    let job_id=field(job,"id");
    let task_id=field(task,"id");
    let execution_id=field(task,"executionId");
    if job_id.is_empty()||task_id.is_empty()||execution_id.is_empty()
        ||field(task,"state")!="QUEUED"{
        return Err("Native Script requires a committed queued execution lease".into());
    }
    let project=Path::new(field(job,"projectRoot"));
    if !project.is_absolute()||!project.is_dir(){
        return Err("Native Script requires the Job's canonical projectRoot".into());
    }
    let roots=json!({"workspaceRoot":project.parent().unwrap_or(project)});
    let context=json!({"executionContext":{"project":{"path":project,"gitRoot":project}}});
    let cancelled=AtomicBool::new(false);
    let mut publish=|event:&Value|{
        persist_native_script_event(db_path,graph_directory,
            job_id,task_id,execution_id,event).map(|_|())
    };
    let mut invoke=|script:&Path,input:&Value,signal:&AtomicBool|{
        let run=invoke_trusted_script_recorded(interpreter,script,input,signal,
            |pid|{
                let store=SQLiteRelayStore::open_without_claim_reset(db_path,Some(job_id))?;
                let fresh=store.load_job(job_id)?.ok_or("Script execution Job not found")?;
                let current=fresh.get("tasks").and_then(Value::as_array).into_iter().flatten()
                    .find(|task|field(task,"id")==task_id)
                    .ok_or("Script execution Task not found")?;
                if field(current,"executionId")!=execution_id
                    ||field(current,"state")!="RUNNING"{
                    return Err("Script process belongs to stale Task lease".into());
                }
                // Original execution-process-tracker public monitor port:
                // exact owned PID identity first, authoritative SQLite
                // registration second, before accepting any worker receipt.
                let future=monitor_execution_process(
                    job_id,task_id,execution_id,Some(pid as i64),
                    |record|std::future::ready(store.record_execution_process(&record)));
                let mut future=std::pin::pin!(future);
                let mut context=std::task::Context::from_waker(std::task::Waker::noop());
                match std::future::Future::poll(future.as_mut(),&mut context){
                    std::task::Poll::Ready(result)=>{
                        result?.ok_or("Cannot prove fresh owned Script Worker process identity")?;
                        Ok(())
                    },
                    std::task::Poll::Pending=>Err(
                        "Native Script process registration unexpectedly suspended".into()),
                }
            });
        if let Ok(store)=SQLiteRelayStore::open_without_claim_reset(db_path,Some(job_id)){
            let _=store.finish_execution_process(job_id,task_id,execution_id,None);
        }
        run
    };
    let result=launch_script_task(task,&context,&roots,&cancelled,&mut invoke,&mut publish);
    match result{
        Ok(launch) if launch.result["status"]=="WAITING_REVIEW"=>{
            // The independently host-bound review.begin + review.wait must
            // already have committed AWAITING_DECISION through Graph/SQLite.
            // Never convert an unbound Script return value into approval (or
            // another lease). This also permits genuine Script Agent Review
            // while keeping the prior fail-closed behavior for fake receipts.
            let bound=SQLiteRelayStore::open_without_claim_reset(db_path,Some(job_id))?
                .load_job(job_id)?.and_then(|job|job.get("tasks")
                    .and_then(Value::as_array).and_then(|tasks|tasks.iter()
                        .find(|row|field(row,"id")==task_id)).cloned())
                .is_some_and(|row|field(&row,"state")=="AWAITING_DECISION"
                    &&row.pointer("/interactiveInvocation/status")
                        .and_then(Value::as_str)==Some("awaiting_decision")
                    &&row.pointer("/interactiveInvocation/executionId")
                        .and_then(Value::as_str)==Some(execution_id)
                    &&row.pointer("/interactiveInvocation/invocationId")
                        .and_then(Value::as_str)==Some(execution_id)
                    &&row.pointer("/interactiveInvocation/revision")
                        .and_then(Value::as_str)==Some(execution_id));
            if bound{return Ok(launch.result);}
            let error="Native Script WAITING_REVIEW requires a verified human review invocation";
            let failure=event_for(job_id,task_id,
                task.get("parentTaskId").and_then(Value::as_str),
                "task.failed","failed",error,Some("orchestrator"),
                Some(json!({"reason":"interactive_review_not_bound"})),
                Some(json!({"id":execution_event_source(job_id,task_id,execution_id),
                    "agent":field(task,"agentName"),"component":"agents-relay"})));
            let _=persist_native_script_event(db_path,graph_directory,
                job_id,task_id,execution_id,&failure);
            Err(error.into())
        },
        Ok(launch)=>Ok(launch.result),
        Err(error)=>{
            // Source discovery or early JS bridge failures may happen before
            // launch_script_task emits task.failed. Emit exactly one correlated
            // failure only if this original generation is still leased.
            let store=SQLiteRelayStore::open_without_claim_reset(db_path,Some(job_id))?;
            let original=store.load_job(job_id)?.ok_or("Job vanished during script failure")?;
            if original.get("tasks").and_then(Value::as_array).into_iter().flatten()
                .any(|current|field(current,"id")==task_id
                    &&field(current,"executionId")==execution_id
                    &&matches!(field(current,"state"),"QUEUED"|"RUNNING")){
                let failure=event_for(job_id,task_id,
                    task.get("parentTaskId").and_then(Value::as_str),
                    "task.failed","failed",&error,Some("orchestrator"),
                    Some(json!({"reason":"script_execution_failed"})),
                    Some(json!({"id":execution_event_source(job_id,task_id,execution_id),
                        "agent":field(task,"agentName"),"component":"agents-relay"})));
                let _=persist_native_script_event(db_path,graph_directory,
                    job_id,task_id,execution_id,&failure);
            }
            Err(error)
        }
    }
}
