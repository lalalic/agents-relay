//! Integration-test executable, not a production CLI or worker. Hard fences:
//! explicit isolated temporary dir, marker file and opt-in environment.
use agents_relay_rust::authority::{
    EntityKind, ProjectionItem, ProjectionRequest, RelayAuthority, WorkflowEvent,
};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::PathBuf;

fn main() {
    if let Err(error) = run() {
        eprintln!("interop_fixture: {error}");
        std::process::exit(2);
    }
}
fn run() -> Result<(), String> {
    if std::env::var("RELAY_RUST_EXPERIMENTAL_TEST_ONLY")
        .ok()
        .as_deref()
        != Some("isolated-test")
    {
        return Err("not an isolated Rust authority fixture".into());
    }
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 5 {
        return Err("usage: interop_fixture OP DB JOB_ID TIMESTAMP KEY".into());
    }
    let path = PathBuf::from(&args[1])
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let parent = path.parent().ok_or("bad DB path")?;
    let temp_root = std::env::temp_dir()
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !parent.join(".relay-rust-authority-isolated-test").is_file()
        || !parent
            .file_name()
            .is_some_and(|n| n.to_string_lossy().starts_with("relay-rust-authority-"))
        || !parent.starts_with(temp_root)
    {
        return Err("refusing non-isolated SQLite write".into());
    }
    let mut authority = RelayAuthority::open_existing(&path)?;
    match args[0].as_str() {
        "commit" => {
            let result=authority.commit_job(&args[2],&args[3],|prior|{
                let mut next=prior.clone();
                next["tasks"][0]["state"]=json!("RUNNING");
                next["updatedAt"]=json!(args[3]);
                let key=&args[4];
                Ok((next,vec![WorkflowEvent{key:key.clone(),event_id:"task.started".into(),
                    payload:json!({"event_id":key,"type":"task.started","taskId":"101","executionId":"ex-rust"})}]))
            })?;
            println!(
                "{}",
                serde_json::to_string(&result).map_err(|e| e.to_string())?
            );
        }
        "ids" => {
            let first = authority.allocate_entity_id(
                "myrepo",
                EntityKind::Task,
                Some(&args[4]),
                &HashSet::new(),
            )?;
            println!(
                "{}",
                serde_json::to_string(&json!({"taskId":first})).unwrap()
            );
        }
        "inbox" => {
            let key = &args[4];
            let event = WorkflowEvent {
                key: key.clone(),
                event_id: "task.started".into(),
                payload: json!({"event_id":key,"type":"task.started"}),
            };
            let applied = authority.consume("node-interop-test", &event, &args[3], |_| Ok(()))?;
            println!(
                "{}",
                serde_json::to_string(&json!({"applied":applied})).unwrap()
            );
        }
        "projection-claim" => {
            let records = authority.claim_projections(Some(&args[2]), 4, &args[3])?;
            println!(
                "{}",
                serde_json::to_string(&records).map_err(|e| e.to_string())?
            );
        }
        "projection-enqueue" => {
            let request = ProjectionRequest {
                idempotency_key: args[4].clone(),
                coalesce_key: None,
                operation: "merge_pull_request".into(),
                payload: json!({"operation":"merge_pull_request","jobId":args[2]}),
                priority: 50,
            };
            let coalesced = authority.enqueue_projection(Some(&args[2]), &request, &args[3])?;
            println!(
                "{}",
                serde_json::to_string(&json!({"coalesced":coalesced})).unwrap()
            );
        }
        "projection-complete" => {
            let claimed: ProjectionItem =
                serde_json::from_str(&args[4]).map_err(|e| e.to_string())?;
            authority.complete_projection_with_receipt(
                Some(&args[2]),
                &claimed,
                true,
                claimed.attempts,
                &json!({"status":"committed"}),
                &args[3],
            )?;
            println!("{}", json!({"completed":claimed.id}));
        }
        "pending" => {
            let result: Vec<WorkflowEvent> = authority.pending_events()?;
            println!("{}", serde_json::to_string(&result).unwrap());
        }
        other => return Err(format!("unsupported fixture action '{other}'")),
    }
    let _: Option<Value> = None;
    Ok(())
}
