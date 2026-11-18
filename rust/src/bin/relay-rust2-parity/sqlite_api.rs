// Native executable parity adapter: real SQLite-backed public API operations,
// using disposable in-memory stores and canonical workflow Graph definitions.
// This is test-only fixture wiring, never a second lifecycle policy.
use agents_relay_rust2::{
    interactive_request::fail_interactive_review,
    relay_store::SQLiteRelayStore,
    task_actions::dispatch_task_action,
    task_update::apply_managed_task_update,
    unblock::unblock_task,
};
use serde_json::{json,Value};
use std::path::{Path,PathBuf};
fn graph()->PathBuf{PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../workflow")}
pub fn invoke(request:&Value)->Result<Option<String>,String>{
    let Some(op)=request.get("op").and_then(Value::as_str)else{return Ok(None)};
    if op=="apiCliSupportStoreFor"{
        let args=request["args"].as_array().into_iter().flatten()
            .filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>();
        let directory=Path::new(request["directory"].as_str().unwrap_or("."));
        let binding=agents_relay_rust2::cli_support::store_for(
            &args,directory,request["allowIdOnly"].as_bool().unwrap_or(false),
            request["optionalRepo"].as_bool().unwrap_or(false))?;
        return Ok(Some(json!({"job":binding.job,
            "localFile":binding.local_file.map(|path|path.to_string_lossy().to_string())}).to_string()));
    }
    if op=="apiCliSupportEventBus"{
        let args=request["args"].as_array().into_iter().flatten()
            .filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>();
        let reachable=request["reachable"].as_bool().unwrap_or(false);
        let resolution=agents_relay_rust2::cli_support::resolve_event_bus(
            &args,&request["env"],reachable)?;
        let bus=agents_relay_rust2::cli_support::event_bus(
            &args,&request["env"],Some(&|_|reachable))?;
        let has_bus=bus.is_some();
        if let Some(bus)=bus{bus.close()?;}
        return Ok(Some(json!({"hasBus":has_bus,
            "transport":resolution["transport"],"source":resolution["source"],
            "natsUrl":resolution["natsUrl"]}).to_string()));
    }
    if !matches!(op,"apiTaskUpdateSqlite"|"apiFailInteractiveSqlite"
        |"apiTaskActionSqlite"|"apiUnblockSqlite"){return Ok(None);}
    let job=request.get("job").ok_or("job required")?;
    let job_id=job.get("id").and_then(Value::as_str).ok_or("job.id required")?;
    let store=SQLiteRelayStore::open(Path::new(":memory:"),None)?;
    store.save_job(job)?;
    let task_id=request["taskId"].as_str().unwrap_or("11");
    let result=match op{
        "apiTaskUpdateSqlite"=> {
            let updated=apply_managed_task_update(
                &graph(),&store,job_id,task_id,
                &request["proposed"],request["expectedUpdatedAt"].as_str().unwrap_or(""),
            )?;
            json!({"task":updated["tasks"].as_array().into_iter().flatten()
                .find(|task|task["id"]==task_id).cloned()})
        },
        "apiFailInteractiveSqlite"=>{
            let outcome=fail_interactive_review(
                &graph(),&store,job_id,task_id,
                request["executionId"].as_str().unwrap_or(""),request["reason"].as_str().unwrap_or(""),
            )?;
            let latest=store.load_job(job_id)?.ok_or("job not found")?;
            json!({"requeued":outcome["requeued"],
                "task":latest["tasks"].as_array().into_iter().flatten()
                    .find(|task|task["id"]==task_id).cloned()})
        },
        "apiTaskActionSqlite"=>{
            let outcome=dispatch_task_action(&graph(),&store,&request["action"])?;
            json!({"task":outcome["task"]})
        },
        "apiUnblockSqlite"=>{
            let outcome=unblock_task(&graph(),&store,job_id,task_id,
                "cli",request["reason"].as_str().unwrap_or(""),None,None,None)?;
            let latest=store.load_job(job_id)?.ok_or("job not found")?;
            json!({"replanning":outcome["replanning"],
                "task":latest["tasks"].as_array().into_iter().flatten()
                    .find(|task|task["id"]==task_id).cloned()})
        },
        _=>unreachable!(),
    };
    Ok(Some(result.to_string()))
}
