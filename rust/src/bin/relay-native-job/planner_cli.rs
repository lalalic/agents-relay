//! Native Planner CLI bindings. SQLite is the only lifecycle authority; this
//! module parses arguments and delegates mutations to Graph-selected effects.
use agents_relay_rust::authority::RelayAuthority;
use agents_relay_rust::native_daemon::{isolated_store_root, NativeDaemonOptions};
use agents_relay_rust::single_node::SingleNodeDaemon;
use agents_relay_rust::supervised_script::after_time;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

fn options(args: &[String], allowed: &[&str]) -> Result<HashMap<String, String>, String> {
    let mut out = HashMap::new();
    let mut i = 0;
    while i < args.len() {
        let key = args[i].as_str();
        if !allowed.contains(&key) {
            return Err(format!("unsupported native CLI option {key}"));
        }
        if out.contains_key(key) {
            return Err(format!("duplicate option {key}"));
        }
        let value = args
            .get(i + 1)
            .filter(|v| !v.starts_with("--") && !v.is_empty())
            .ok_or_else(|| format!("{key} requires a value"))?;
        out.insert(key.into(), value.clone());
        i += 2;
    }
    Ok(out)
}
fn identity(o: &HashMap<String, String>) -> Result<(PathBuf, String, Option<String>), String> {
    let db = PathBuf::from(
        o.get("--db")
            .ok_or("missing --db (explicit isolated DB required)")?,
    );
    if !db.is_absolute() {
        return Err("absolute DB path required".into());
    }
    isolated_store_root(&db)?;
    if std::env::var("RELAY_RUST_LIVE_MODE").ok().as_deref() == Some("pilot-live") {
        return Err("native Planner direct SQLite access is disabled while the production daemon may own the store".into());
    }
    let id = o
        .get("--id")
        .or_else(|| o.get("--job-id"))
        .ok_or("--id is required")?
        .clone();
    if o.get("--id")
        .is_some_and(|v| o.get("--job-id").is_some_and(|j| j != v))
    {
        return Err("--id and --job-id mismatch".into());
    }
    Ok((db, id, o.get("--repo").cloned()))
}
fn verify_repo(job: &Value, repo: Option<&String>) -> Result<(), String> {
    if repo.is_some_and(|r| job["repository"].as_str() != Some(r.as_str())) {
        Err("Local Job/PR binding mismatch".into())
    } else {
        Ok(())
    }
}
fn plan_context(args: &[String]) -> Result<Value, String> {
    let o = options(
        args,
        &[
            "--db",
            "--id",
            "--job-id",
            "--repo",
            "--plan-id",
            "--execution-id",
        ],
    )?;
    let plan_id = o
        .get("--plan-id")
        .ok_or("plan context requires --plan-id")?;
    let execution_id = o
        .get("--execution-id")
        .ok_or("plan context requires --execution-id")?;
    let (db, id, repo) = identity(&o)?;
    let authority = RelayAuthority::open_existing(&db)?;
    let job = authority
        .read_job(&id)?
        .ok_or_else(|| format!("Unknown Job {id}"))?;
    verify_repo(&job, repo.as_ref())?;
    let plan = job["plans"]
        .as_array()
        .and_then(|p| p.iter().find(|p| p["id"].as_str() == Some(plan_id)))
        .ok_or_else(|| format!("Plan {plan_id} not found in Job {id}"))?;
    if plan["status"] != "PLANNING" || plan["executionId"].as_str() != Some(execution_id) {
        return Err(format!(
            "stale Plan execution {plan_id}/{execution_id}; current state {}/{}",
            plan["status"], plan["executionId"]
        ));
    }
    // Return only the durable snapshot read in this invocation. No Task or Plan
    // state is synthesized from a projection or a later execution.
    Ok(
        json!({"jobId":id,"planId":plan_id,"executionId":execution_id,"objective":job.get("objective").or(job.get("description")).unwrap_or(&job["title"]),"previousPlanId":plan["previousPlanId"],"trigger":plan["trigger"],"guidance":plan.get("guidance"),"retryFeedback":plan.get("retryFeedback"),"forceRestate":plan.get("forceRestate").unwrap_or(&Value::Bool(false)),"restateTaskIds":plan.get("restateTaskIds").unwrap_or(&Value::Null),"job":job,"plan":plan}),
    )
}
fn read_candidate(path: &str, db: &Path) -> Result<Value, String> {
    let mut bytes = Vec::new();
    if path == "-" {
        std::io::stdin()
            .take(1_048_577)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
    } else {
        let root = isolated_store_root(db)?;
        let file = PathBuf::from(path)
            .canonicalize()
            .map_err(|e| format!("plan file: {e}"))?;
        if !file.is_file() || !file.starts_with(root) {
            return Err("plan file must be inside isolated store root".into());
        }
        std::fs::File::open(file)
            .map_err(|e| e.to_string())?
            .take(1_048_577)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
    }
    if bytes.len() > 1_048_576 {
        return Err("plan candidate exceeds 1 MiB".into());
    }
    serde_json::from_slice(&bytes).map_err(|e| format!("invalid Planner JSON: {e}"))
}
fn plan_apply(args: &[String]) -> Result<Value, String> {
    let o = options(
        args,
        &[
            "--db",
            "--id",
            "--job-id",
            "--repo",
            "--plan-id",
            "--execution-id",
            "--file",
        ],
    )?;
    let plan = o.get("--plan-id").ok_or("plan apply requires --plan-id")?;
    let execution = o
        .get("--execution-id")
        .ok_or("plan apply requires --execution-id")?;
    let file = o.get("--file").ok_or("plan apply requires --file")?;
    let (db, id, repo) = identity(&o)?;
    let proposal = read_candidate(file, &db)?;
    let mut authority = RelayAuthority::open_existing(&db)?;
    let job = authority
        .read_job(&id)?
        .ok_or_else(|| format!("Unknown Job {id}"))?;
    verify_repo(&job, repo.as_ref())?;
    let at = after_time(job["updatedAt"].as_str().ok_or("Job timestamp missing")?)?;
    let result = authority.apply_native_satisfied_plan(&id, plan, execution, &proposal, &at)?;
    serde_json::to_value(result).map_err(|e| e.to_string())
}
fn reconcile(args: &[String]) -> Result<Value, String> {
    let opts = options(args, &["--db", "--manifest", "--helper", "--max-tasks"])?;
    let required = |key: &str| {
        opts.get(key)
            .map(String::as_str)
            .ok_or_else(|| format!("reconcile requires {key}"))
    };
    let db = PathBuf::from(required("--db")?);
    if !db.is_absolute() {
        return Err("--db must be absolute".into());
    }
    isolated_store_root(&db)?;
    let max_tasks = opts.get("--max-tasks").map_or(Ok(20usize), |v| {
        v.parse::<usize>().map_err(|_| "--max-tasks must be 1..100")
    })?;
    if !(1..=100).contains(&max_tasks) {
        return Err("--max-tasks must be 1..100".into());
    }
    let daemon = SingleNodeDaemon::acquire(NativeDaemonOptions {
        db,
        manifest: PathBuf::from(required("--manifest")?),
        helper: PathBuf::from(required("--helper")?),
        max_tasks,
    })?;
    let report = daemon.tick(Arc::new(AtomicBool::new(false)))?;
    serde_json::to_value(report).map_err(|e| e.to_string())
}
pub fn dispatch(command: &str, action: Option<&str>, args: &[String]) -> Result<Value, String> {
    match(command,action){
    ("reconcile",_)=>reconcile(args), ("plan",Some("context"))=>plan_context(args), ("plan",Some("apply"))=>plan_apply(args),
    ("plan",None)=>Err("native plan invocation is unavailable: no configured native Planner provider or durable Planner lease adapter; use plan context and plan apply with a matching active execution".into()),
    ("record",_)=>Err("native record backfill is unavailable: no evidence-verification and ownership action is implemented; no history was changed".into()),
    ("serve",_)=>Err("serve is not ported: use the separately supervised relay-native-daemon with an isolated store".into()),
    _=>Err("unsupported native Planner/lifecycle command".into())}
}
