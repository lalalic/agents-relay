//! Test-only external Review Host. Never install as production CLI and never
//! accept a production/linked SQLite database. Decisions use the SAME public
//! HostInvocation Graph+SQLite CAS and restart-safe resume as production.
use agents_relay_rust2::{
    interactive_invocation::{HostInteractiveInvocationCoordinator,host_interactive_decision_event},
    interactive_invocation_ports::host_invocation_ports,
    interactive_resume::recover_interactive_decisions,
    relay_store::SQLiteRelayStore,
};
use serde_json::{json,Value};
use std::{env,path::{Path,PathBuf},time::{SystemTime,UNIX_EPOCH}};
fn value<'a>(v:&'a Value,key:&str)->&'a str{v.get(key).and_then(Value::as_str).unwrap_or("")}
fn run()->Result<Value,String>{
    let args=env::args().skip(1).collect::<Vec<_>>();
    if args.len()!=5{return Err("usage: l3_review_host_fixture DB JOB TASK EXECUTION approved|changes_requested".into());}
    let (db,job_id,task_id,execution,decision)=(&args[0],&args[1],&args[2],&args[3],&args[4]);
    if !matches!(decision.as_str(),"approved"|"changes_requested"){
        return Err("Only test-approved/changes_requested decisions permitted".into());
    }
    // A subprocess can only write to a non-symlink fixture owned by this test.
    // Never infer or accept the user's production Relay store path.
    let path=PathBuf::from(db);
    let canonical=std::fs::canonicalize(&path).map_err(|e|e.to_string())?;
    let temp=std::fs::canonicalize(env::temp_dir()).map_err(|e|e.to_string())?;
    let rel=canonical.strip_prefix(&temp).map_err(|_|"Review Host requires a temporary test-owned fixture")?;
    let first=rel.components().next().and_then(|c|c.as_os_str().to_str()).unwrap_or("");
    if !first.starts_with("agents-relay-rust-l3-") || first.contains("..")
        ||canonical.file_name().and_then(|s|s.to_str())!=Some("relay.sqlite"){
        return Err("Refusing non-L3 fixture SQLite or production Relay database".into());
    }
    if path.symlink_metadata().map_err(|e|e.to_string())?.file_type().is_symlink(){
        return Err("Refusing symlinked fixture SQLite".into());
    }
    let mut store=SQLiteRelayStore::open_without_claim_reset(&canonical,Some(job_id))?;
    let snapshot=store.load_job(job_id)?.ok_or("Test-owned Job absent")?;
    let task=snapshot["tasks"].as_array().into_iter().flatten()
        .find(|t|value(t,"id")==task_id).ok_or("Test Task absent")?;
    if value(task,"state")!="AWAITING_DECISION"
        ||task.pointer("/interactiveInvocation/executionId")
            .and_then(Value::as_str)!=Some(execution)
        ||task.pointer("/interactiveInvocation/status")
            .and_then(Value::as_str)!=Some("awaiting_decision"){
        return Err("Task is not awaiting an exact bound Review execution".into());
    }
    let context=json!({"jobId":job_id,"taskId":task_id,"executionId":execution});
    let millis=SystemTime::now().duration_since(UNIX_EPOCH)
        .map_err(|e|e.to_string())?.as_millis();
    let feedback=json!({"eventId":format!("l3-host-{task_id}-{execution}-{millis}"),
        "decision":decision,"feedback":"change the hook","comments":[]});
    let now=chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true);
    let event=host_interactive_decision_event(&context,&feedback,&now)?;
    let graph=Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow");
    let mut coordinator=HostInteractiveInvocationCoordinator::default();
    let result={
        let mut ports=host_invocation_ports(&mut store);
        coordinator.apply_event(&mut ports,&graph,&event,|_,_|Ok(()),|_|Ok(()))?
    };
    if result["outcome"]!="accepted"{
        return Err(format!("Host did not accept exact execution-bounded Review: {result}"));
    }
    let resumed=recover_interactive_decisions(&graph,&store,job_id)?;
    if !resumed {return Err("Accepted decision did not resume through canonical Graph".into());}
    let after=store.load_job(job_id)?.ok_or("Review Job disappeared")?;
    let original=after["tasks"].as_array().into_iter().flatten()
        .find(|t|value(t,"id")==task_id).ok_or("Original Task disappeared")?;
    if value(original,"state")!="QUEUED" || original["interactiveInvocation"]["status"]!=*decision{
        return Err(format!("Host review was not durably requeued on same Task: {original}"));
    }
    Ok(json!({"outcome":"accepted","decision":decision,"jobId":job_id,
        "taskId":task_id,"state":"QUEUED","revision":execution}))
}
fn main(){match run(){Ok(v)=>println!("{v}"),Err(err)=>{eprintln!("{err}");std::process::exit(1)}}}
