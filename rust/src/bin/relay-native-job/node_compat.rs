//! Node-shaped read-only CLI entrypoints, without a Node subprocess or store mutation.
use agents_relay_rust::native_daemon::isolated_store_root;
use agents_relay_rust::store::RelayReader;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;

const HELP: &str = "Rust Relay native CLI (Node-compatible commands, partial parity)\n\
Usage: relay-native-job <command> [options]\n\
  job list [--repo REPO] [--db SQLITE]\n\
  job show --id JOB [--repo REPO] [--db SQLITE]\n\
  job run --id JOB --task-id COORDINATOR [--foreground] [--db SQLITE]\n\
  task list --id JOB [--repo REPO] [--db SQLITE]\n\
  task show --id JOB --task-id TASK [--repo REPO] [--db SQLITE]\n\
  task comment --db SQLITE --id JOB --repo REPO --task-id TASK (--message TEXT | --message-file FILE|-)\n\
  task comments --id JOB --task-id TASK [--repo REPO] [--db SQLITE]\n\
  task context --id JOB --task-id TASK --execution-id EXEC [--repo REPO] [--db SQLITE]\n\
  task events --id JOB --task-id TASK [--limit 1..60] [--order asc|desc] [--after CURSOR] [--db SQLITE]\n\
  status [--host 127.0.0.1|localhost] [--port 8787]\n\
Other Node CLI commands are not yet fully ported. docs/rust-cli-head-to-head.md\n";

pub fn default_db() -> Result<PathBuf, String> {
    if std::env::var("RELAY_RUST_LIVE_MODE").ok().as_deref() == Some("pilot-live") {
        let home = std::env::var("HOME").map_err(|_| "HOME is required")?;
        return Ok(PathBuf::from(home).join(".local/state/agents-relay/rust-live/relay.sqlite"));
    }
    Err("missing --db; only marked Rust live namespace may use implicit store".into())
}
fn parse(args: &[String], allowed: &[&str]) -> Result<HashMap<String, String>, String> {
    let mut options = HashMap::new();
    let mut i = 0;
    while i < args.len() {
        let key = args[i].as_str();
        if key == "--no-github" {
            if options.insert(key.to_owned(), "true".into()).is_some() {
                return Err("duplicate --no-github".into());
            }
            i += 1;
            continue;
        }
        if !allowed.contains(&key) {
            return Err(format!("unsupported CLI option {key}: no Rust parity yet"));
        }
        if options.contains_key(key) {
            return Err(format!("duplicate option {key}"));
        }
        let v = args
            .get(i + 1)
            .filter(|v| !v.is_empty() && !v.starts_with("--"))
            .ok_or_else(|| format!("{key} requires a value"))?;
        options.insert(key.to_owned(), v.clone());
        i += 2;
    }
    Ok(options)
}
fn path_from(opts: &HashMap<String, String>) -> Result<PathBuf, String> {
    let path = opts
        .get("--db")
        .map(PathBuf::from)
        .map_or_else(default_db, Ok)?;
    if !path.is_absolute() {
        return Err("--db must be absolute".into());
    }
    isolated_store_root(&path)?;
    Ok(path)
}
fn job(reader: &RelayReader, opts: &HashMap<String, String>) -> Result<Value, String> {
    let id = opts.get("--id").ok_or("--id JOB required")?;
    let j = reader
        .get_job(id)?
        .ok_or_else(|| format!("Job {id} not found"))?
        .job;
    if opts
        .get("--repo")
        .is_some_and(|repo| j["repository"].as_str() != Some(repo.as_str()))
    {
        return Err("repository identity mismatch".into());
    }
    Ok(j)
}
fn read(args: &[String]) -> Result<Value, String> {
    let a = args.first().ok_or("missing command")?.as_str();
    let b = args.get(1).ok_or("missing action")?.as_str();
    let opts = match (a, b) {
        ("job", "list") => parse(&args[2..], &["--db", "--repo"])?,
        ("job", "show") => parse(&args[2..], &["--db", "--id", "--repo"])?,
        ("task", "list") => parse(&args[2..], &["--db", "--id", "--repo"])?,
        ("task", "show") => parse(&args[2..], &["--db", "--id", "--repo", "--task-id"])?,
        ("task", "comments") => parse(&args[2..], &["--db", "--id", "--repo", "--task-id"])?,
        ("task", "context") => parse(
            &args[2..],
            &["--db", "--id", "--repo", "--task-id", "--execution-id"],
        )?,
        ("task", "events") => parse(
            &args[2..],
            &[
                "--db",
                "--id",
                "--repo",
                "--task-id",
                "--limit",
                "--order",
                "--after",
            ],
        )?,
        _ => return Err("unsupported native inspection action".into()),
    };
    let path = path_from(&opts)?;
    let reader = RelayReader::open(&path)?;
    if a == "job" && b == "list" {
        let mut jobs = Vec::new();
        let mut offset = 0u32;
        loop {
            let batch = reader.list_jobs(1000, offset)?;
            let n = batch.len() as u32;
            for snap in batch {
                if opts
                    .get("--repo")
                    .is_some_and(|repo| snap.job["repository"].as_str() != Some(repo.as_str()))
                {
                    continue;
                }
                jobs.push(snap.job);
            }
            if n < 1000 {
                break;
            }
            offset = offset
                .checked_add(n)
                .ok_or("job list pagination overflow")?;
        }
        jobs.sort_by(|x, y| {
            y["updatedAt"]
                .as_str()
                .unwrap_or("")
                .cmp(x["updatedAt"].as_str().unwrap_or(""))
                .then_with(|| {
                    x["repository"]
                        .as_str()
                        .unwrap_or("")
                        .cmp(y["repository"].as_str().unwrap_or(""))
                })
                .then_with(|| {
                    x["id"]
                        .as_str()
                        .unwrap_or("")
                        .cmp(y["id"].as_str().unwrap_or(""))
                })
        });
        return Ok(json!(jobs));
    }
    let j = job(&reader, &opts)?;
    if a == "job" && b == "show" {
        return Ok(j);
    }
    if b == "list" {
        return Ok(j["tasks"].clone());
    }
    let id = opts.get("--task-id").ok_or("--task-id TASK required")?;
    let t = j["tasks"]
        .as_array()
        .and_then(|tasks| tasks.iter().find(|t| t["id"].as_str() == Some(id.as_str())))
        .ok_or_else(|| format!("Task {id} not found"))?;
    if b == "show" {
        return Ok(t.clone());
    }
    if b == "comments" {
        return Ok(t["comments"]
            .as_array()
            .map(|_| t["comments"].clone())
            .unwrap_or_else(|| json!([])));
    }
    if b == "context" {
        let execution_id = opts
            .get("--execution-id")
            .filter(|x| !x.trim().is_empty())
            .ok_or("task context requires --execution-id")?;
        if t["executionId"].as_str() != Some(execution_id.as_str())
            || !matches!(t["state"].as_str(), Some("QUEUED" | "RUNNING"))
        {
            return Err(format!(
                "Stale Task execution {id}/{execution_id}; current state {}",
                t["state"]
            ));
        }
        let empty = vec![];
        let all = j["tasks"].as_array().unwrap_or(&empty);
        let deps = t["dependencies"].as_array().cloned().unwrap_or_default();
        let final_review = matches!(
            t["agentName"].as_str(),
            Some("reviewer" | "job-acceptance-reviewer")
        );
        let related = if t["agentName"] == "troubleshooter" {
            all.iter()
                .filter(|item| item["id"] == t["parentTaskId"])
                .collect::<Vec<_>>()
        } else if final_review {
            deps.iter()
                .filter_map(|v| all.iter().find(|item| item["id"] == *v))
                .collect::<Vec<_>>()
        } else {
            vec![]
        };
        let related = related
            .into_iter()
            .map(|item| {
                let mut m = serde_json::Map::new();
                for k in [
                    "id",
                    "title",
                    "state",
                    "attempt",
                    "executionId",
                    "result",
                    "error",
                    "failureReason",
                ] {
                    if let Some(v) = item.get(k) {
                        m.insert(k.into(), v.clone());
                    }
                }
                for k in ["resolution", "escalation"] {
                    m.insert(k.into(), item.get(k).cloned().unwrap_or(Value::Null));
                }
                m.insert(
                    "comments".into(),
                    item.get("comments")
                        .filter(|v| v.is_array())
                        .cloned()
                        .unwrap_or_else(|| json!([])),
                );
                Value::Object(m)
            })
            .collect::<Vec<_>>();
        let dependencies = deps
            .iter()
            .map(|d| {
                all.iter()
                    .find(|item| item["id"] == *d)
                    .cloned()
                    .unwrap_or_else(|| json!({"id":d,"missing":true}))
            })
            .collect::<Vec<_>>();
        let plan = j["plans"]
            .as_array()
            .and_then(|plans| plans.iter().find(|p| p["id"] == t["planningDecisionId"]))
            .cloned()
            .unwrap_or(Value::Null);
        let mut brief = serde_json::Map::new();
        for k in [
            "id",
            "repository",
            "title",
            "objective",
            "projectPath",
            "state",
        ] {
            if let Some(v) = j.get(k) {
                brief.insert(k.to_owned(), v.clone());
            }
        }
        return Ok(json!({"job":brief,"task":t,"currentState":t["state"],
            "resolution":t.get("resolution").unwrap_or(&Value::Null),
            "escalation":t.get("escalation").unwrap_or(&Value::Null),
            "comments":t.get("comments").filter(|v|v.is_array()).cloned().unwrap_or_else(||json!([])),
            "relevantTasks":related,"dependencies":dependencies,"plan":plan}));
    }
    let limit = opts
        .get("--limit")
        .map(|x| {
            x.parse::<usize>()
                .map_err(|_| "--limit must be integer 1..60".to_string())
        })
        .transpose()?
        .unwrap_or(60);
    let order = opts.get("--order").map(String::as_str).unwrap_or("desc");
    let after = opts
        .get("--after")
        .map(|x| {
            x.parse::<i64>()
                .map_err(|_| "--after must be nonnegative integer".to_string())
        })
        .transpose()?
        .unwrap_or(0);
    if opts.contains_key("--after") && order != "asc" {
        return Err("--after requires --order asc".into());
    }
    if !(1..=60).contains(&limit) {
        return Err("--limit must be 1..60".into());
    }
    let page = reader.task_events(
        j["id"].as_str().ok_or("Job ID missing")?,
        Some(id),
        limit,
        order,
        after,
    )?;
    serde_json::to_value(page).map_err(|e| e.to_string())
}
pub fn dispatch(args: &[String]) -> Result<(), String> {
    if args.is_empty() || args.iter().any(|a| a == "--help" || a == "-h") {
        println!("{HELP}");
        return Ok(());
    }
    let value = read(args)?;
    println!(
        "{}",
        serde_json::to_string(&value).map_err(|e| e.to_string())?
    );
    Ok(())
}
