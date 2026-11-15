//! Native Planner/lifecycle CLI bindings. Workflow policy remains in Graph;
//! this module only parses Node-shaped arguments and invokes native effects.
use agents_relay_rust::native_daemon::{isolated_store_root, NativeDaemonOptions};
use agents_relay_rust::single_node::SingleNodeDaemon;
use serde_json::to_value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

fn options(args: &[String], allowed: &[&str]) -> Result<HashMap<String, String>, String> {
    let mut values = HashMap::new();
    let mut i = 0;
    while i < args.len() {
        let key = args[i].as_str();
        if !allowed.contains(&key) {
            return Err(format!("unsupported native CLI option {key}"));
        }
        if values.contains_key(key) {
            return Err(format!("duplicate option {key}"));
        }
        let value = args
            .get(i + 1)
            .filter(|v| !v.starts_with("--") && !v.is_empty())
            .ok_or_else(|| format!("{key} requires a value"))?;
        values.insert(key.to_owned(), value.clone());
        i += 2;
    }
    Ok(values)
}

fn reconcile(args: &[String]) -> Result<serde_json::Value, String> {
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
    to_value(report).map_err(|e| e.to_string())
}

pub fn dispatch(
    command: &str,
    action: Option<&str>,
    args: &[String],
) -> Result<serde_json::Value, String> {
    match (command, action) {
        ("reconcile", _) => reconcile(args),
        ("plan", Some("context")) => Err("plan context is not ported: native Planner execution-context resolution is unavailable".into()),
        ("plan", Some("apply")) => Err("plan apply is not ported: native Planner lease, validation, and atomic apply action are unavailable".into()),
        ("plan", None) => Err("plan is not ported: native Planner executor and durable Planner lease are unavailable".into()),
        ("record", _) => Err("record is not ported: native completed-work backfill action is unavailable".into()),
        ("serve", _) => Err("serve is not ported: use the separately supervised relay-native-daemon with an isolated store".into()),
        _ => Err("unsupported native Planner/lifecycle command".into()),
    }
}
