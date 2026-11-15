//! Native review, blocker and projection command surface.
//!
//! Mutations here delegate to the canonical SQLite authority. Commands that
//! need an unavailable authenticated host adapter or Graph-selected action fail
//! closed instead of approximating those semantics in the CLI.
use agents_relay_rust::authority::RelayAuthority;
use agents_relay_rust::native_daemon::isolated_store_root;
use agents_relay_rust::store::RelayReader;
use agents_relay_rust::supervised_script::after_time;
use serde_json::{json, Value};
use std::path::PathBuf;

fn value(args: &[String], name: &str) -> Result<String, String> {
    let matches = args.iter().filter(|item| item.as_str() == name).count();
    if matches > 1 {
        return Err(format!("duplicate option {name}"));
    }
    let index = args
        .iter()
        .position(|item| item == name)
        .ok_or_else(|| format!("missing {name}"))?;
    args.get(index + 1)
        .filter(|item| !item.starts_with("--"))
        .cloned()
        .ok_or_else(|| format!("missing value for {name}"))
}
fn db(args: &[String]) -> Result<PathBuf, String> {
    let path = PathBuf::from(value(args, "--db")?);
    if !path.is_absolute() {
        return Err("absolute DB path required".into());
    }
    isolated_store_root(&path)?;
    Ok(path)
}
fn check_options(args: &[String], allowed: &[&str]) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    let mut index = 0;
    while index < args.len() {
        let flag = args[index].as_str();
        if !allowed.contains(&flag) {
            return Err(format!("unrecognized option {flag}"));
        }
        if !seen.insert(flag) {
            return Err(format!("duplicate option {flag}"));
        }
        if args
            .get(index + 1)
            .is_none_or(|item| item.starts_with("--"))
        {
            return Err(format!("missing value for {flag}"));
        }
        index += 2;
    }
    Ok(())
}

fn review(args: &[String]) -> Result<Value, String> {
    let action = args.first().map(String::as_str).unwrap_or("");
    match action {
        "job" => {
            check_options(&args[1..], &["--db", "--id"])?;
            let path = db(&args[1..])?;
            let id = value(&args[1..], "--id")?;
            let snapshot = RelayReader::open(&path)?.get_job(&id)?.ok_or("unknown Job")?;
            Ok(json!({"jobId":id,"review":snapshot.job["review"],"reviewEnabled":snapshot.job["reviewEnabled"],"status":"observed"}))
        }
        "run" => Err("UNSUPPORTED: review run requires the native Graph-selected Reviewer execution adapter; no provider is invoked by this CLI".into()),
        "interactive" => interactive(&args[1..]),
        _ => Err("review supports: job | run | interactive".into()),
    }
}

fn interactive(args: &[String]) -> Result<Value, String> {
    let action = args.first().map(String::as_str).unwrap_or("");
    let flags = &args[1..];
    match action {
        "begin" => {
            check_options(
                flags,
                &["--db", "--id", "--task-id", "--execution-id", "--revision"],
            )?;
            let _ = (
                value(flags, "--db")?,
                value(flags, "--id")?,
                value(flags, "--task-id")?,
                value(flags, "--execution-id")?,
            );
            Err("UNSUPPORTED: begin requires an authenticated host invocation; the native CLI has no host authentication verifier and will not create an untrusted invocation".into())
        }
        "wait" => {
            check_options(flags, &["--db", "--id", "--task-id", "--execution-id"])?;
            let path = db(flags)?;
            let id = value(flags, "--id")?;
            let task_id = value(flags, "--task-id")?;
            let execution_id = value(flags, "--execution-id")?;
            let snapshot = RelayReader::open(&path)?
                .get_job(&id)?
                .ok_or("unknown Job")?;
            let task = snapshot.job["tasks"]
                .as_array()
                .and_then(|tasks| tasks.iter().find(|task| task["id"] == task_id))
                .ok_or("Review Task missing")?;
            if task["state"] == "AWAITING_DECISION"
                && task["interactiveInvocation"]["executionId"] == execution_id
            {
                return Ok(
                    json!({"waiting":true,"taskState":"AWAITING_DECISION","jobId":id,"taskId":task_id,"executionId":execution_id}),
                );
            }
            Err("UNSUPPORTED: wait transition must be selected through the canonical Task Graph event ingress; this native CLI has no authenticated event adapter".into())
        }
        "ready" => {
            check_options(flags, &["--db", "--id", "--task-id", "--execution-id"])?;
            let _ = (
                value(flags, "--db")?,
                value(flags, "--id")?,
                value(flags, "--task-id")?,
                value(flags, "--execution-id")?,
            );
            Err("UNSUPPORTED: ready requires a verified, authenticated host decision receipt bound to the current invocation, execution and Task; no receipt verifier is available, so approval was not recorded".into())
        }
        "fail" => {
            if std::env::var("RELAY_RUST_LIVE_MODE").ok().as_deref() == Some("pilot-live") {
                return Err("interactive fail requires daemon-authorized ingress in Rust live mode".into());
            }
            check_options(
                flags,
                &["--db", "--id", "--task-id", "--execution-id", "--reason"],
            )?;
            let path = db(flags)?;
            let id = value(flags, "--id")?;
            let task_id = value(flags, "--task-id")?;
            let execution_id = value(flags, "--execution-id")?;
            let reason = value(flags, "--reason")?;
            let mut authority = RelayAuthority::open_existing(&path)?;
            let snapshot = authority.read_job(&id)?.ok_or("unknown Job")?;
            let at = after_time(
                snapshot["updatedAt"]
                    .as_str()
                    .ok_or("Job timestamp missing")?,
            )?;
            let failed =
                authority.fail_interactive_review(&id, &task_id, &execution_id, &reason, &at)?;
            Ok(serde_json::to_value(failed).map_err(|e| e.to_string())?)
        }
        "abort" => {
            if std::env::var("RELAY_RUST_LIVE_MODE").ok().as_deref() == Some("pilot-live") {
                return Err("interactive abort requires daemon-authorized ingress in Rust live mode".into());
            }
            check_options(flags, &["--db", "--id", "--task-id", "--execution-id"])?;
            let path = db(flags)?;
            let id = value(flags, "--id")?;
            let task_id = value(flags, "--task-id")?;
            let execution_id = value(flags, "--execution-id")?;
            let mut authority = RelayAuthority::open_existing(&path)?;
            let snapshot = authority.read_job(&id)?.ok_or("unknown Job")?;
            let at = after_time(
                snapshot["updatedAt"]
                    .as_str()
                    .ok_or("Job timestamp missing")?,
            )?;
            let aborted = authority.abort_interactive_review(&id, &task_id, &execution_id, &at)?;
            Ok(json!({"aborted":aborted,"jobId":id,"taskId":task_id,"executionId":execution_id}))
        }
        _ => Err("review interactive supports: begin | wait | ready | fail | abort".into()),
    }
}

fn blocker(args: &[String]) -> Result<Value, String> {
    let action = args.first().map(String::as_str).unwrap_or("");
    let flags = &args[1..];
    match action {
        "show" => {
            check_options(flags, &["--db", "--id"])?;
            let path = db(flags)?;
            let id = value(flags, "--id")?;
            let job = RelayReader::open(&path)?.get_job(&id)?.ok_or("unknown blocker Job")?;
            Ok(serde_json::to_value(job).map_err(|e| e.to_string())?)
        }
        "ensure" => Err("UNSUPPORTED: blocker ensure requires the canonical blocker-recovery Graph, cross-repository registry, and approved authorization context; the native CLI cannot safely create or adopt a blocker".into()),
        "add" => Err("UNSUPPORTED: blocker add requires cross-Job dependency registration and reconciliation through the authoritative Graph action".into()),
        "resolve" => Err("UNSUPPORTED: blocker resolve requires canonical resolution-condition checks and Graph-selected release effects".into()),
        _ => Err("blocker supports: ensure | show | add | resolve".into()),
    }
}

fn projection(args: &[String]) -> Result<Value, String> {
    match args.first().map(String::as_str).unwrap_or("") {
        "conflicts" => Err("UNSUPPORTED: projection conflict inventory is available only through the scoped canonical Relay store adapter".into()),
        "resolve" => Err("UNSUPPORTED: projection conflict resolution requires a scoped, classified canonical conflict and its authoritative resolver".into()),
        _ => Err("projection supports: conflicts | resolve".into()),
    }
}

pub fn dispatch(args: &[String]) -> Result<Option<Value>, String> {
    match args.first().map(String::as_str) {
        Some("review") => review(&args[1..]).map(Some),
        Some("blocker") => blocker(&args[1..]).map(Some),
        Some("projection") => projection(&args[1..]).map(Some),
        _ => Ok(None),
    }
}
