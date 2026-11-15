//! Test-gated native Job intake; never races production TS Relay.
use agents_relay_rust::authority::RelayAuthority;
use agents_relay_rust::native_daemon::isolated_store_root;
use agents_relay_rust::native_job::{
    activate_job, create_dag_job, init_isolated_store, DagJobRequest,
};
use agents_relay_rust::store::RelayReader;
use agents_relay_rust::supervised_script::after_time;
use serde_json::json;
use serde_json::Value;
use std::path::{Path, PathBuf};

#[path = "relay-native-job/agent_cli.rs"]
mod agent_cli;
#[path = "relay-native-job/context_cli.rs"]
mod context_cli;
#[path = "relay-native-job/foreground.rs"]
mod foreground;
#[path = "relay-native-job/job_cli.rs"]
mod job_cli;
#[path = "relay-native-job/node_compat.rs"]
mod node_compat;
#[path = "relay-native-job/planner_cli.rs"]
mod planner_cli;
#[path = "relay-native-job/platform_cli.rs"]
mod platform_cli;
#[path = "relay-native-job/review_cli.rs"]
mod review_cli;
#[path = "relay-native-job/status.rs"]
mod status;
#[path = "relay-native-job/task_cli.rs"]
mod task_cli;
#[path = "relay-native-job/workflow.rs"]
mod workflow;

fn value(args: &[String], name: &str) -> Result<String, String> {
    if args.iter().filter(|a| a.as_str() == name).count() > 1 {
        return Err(format!("duplicate option {name}"));
    }
    let i = args
        .iter()
        .position(|a| a == name)
        .ok_or_else(|| format!("missing {name}"))?;
    args.get(i + 1)
        .filter(|s| !s.starts_with("--"))
        .cloned()
        .ok_or_else(|| format!("missing value for {name}"))
}
fn db(args: &[String]) -> Result<PathBuf, String> {
    let path = PathBuf::from(value(args, "--db")?);
    if !path.is_absolute() {
        return Err("absolute DB path required".into());
    }
    Ok(path)
}
fn job_update(args: &[String]) -> Result<Value, String> {
    if std::env::var("RELAY_RUST_LIVE_MODE").ok().as_deref() == Some("pilot-live") {
        return Err("native Job metadata updates are isolated-test only".into());
    }
    let allowed = ["--db", "--job-id", "--title", "--priority"];
    let mut options = std::collections::HashMap::<String, String>::new();
    let mut index = 0;
    while index < args.len() {
        let name = args[index].as_str();
        if !allowed.contains(&name) {
            return Err(format!("unrecognized job update option {name}"));
        }
        if options.contains_key(name) {
            return Err(format!("duplicate option {name}"));
        }
        let option_value = args
            .get(index + 1)
            .filter(|value| !value.starts_with("--"))
            .ok_or_else(|| format!("missing value for {name}"))?;
        options.insert(name.to_owned(), option_value.clone());
        index += 2;
    }
    let get = |name: &str| options.get(name).map(String::as_str);
    let db = PathBuf::from(get("--db").ok_or("missing --db")?);
    if !db.is_absolute() {
        return Err("absolute DB path required".into());
    }
    let job_id = get("--job-id").ok_or("missing --job-id")?;
    let title = get("--title");
    let priority = get("--priority");
    if title.is_none() && priority.is_none() {
        return Err("job update requires --title and/or --priority".into());
    }
    if let Some(title) = title {
        if title.trim().is_empty() || title.len() > 200 {
            return Err("--title must be nonempty and at most 200 bytes".into());
        }
    }
    if let Some(priority) = priority {
        if !matches!(priority, "P0" | "P1" | "P2" | "P3") {
            return Err("--priority must be P0, P1, P2, or P3".into());
        }
    }
    isolated_store_root(&db)?;
    let mut authority = RelayAuthority::open_existing(&db)?;
    let current = authority.read_job(job_id)?.ok_or("unknown Job")?;
    let at = after_time(
        current["updatedAt"]
            .as_str()
            .ok_or("Job timestamp missing")?,
    )?;
    let updated = authority.commit_job(job_id, &at, |original| {
        let mut next = original.clone();
        if let Some(title) = title {
            next["title"] = json!(title);
        }
        if let Some(priority) = priority {
            next["priority"] = json!(priority);
        }
        next["updatedAt"] = json!(at);
        Ok((next, vec![]))
    })?;
    Ok(json!({"jobId":job_id,"job":updated.job}))
}
fn run() -> Result<(), String> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let Some(command) = args.first().map(String::as_str) else {
        return Err(
            "usage: relay-native-job init|create|activate|show|update|task create|task cancel|task retry --db PATH ..."
                .into(),
        );
    };
    if std::env::var("RELAY_RUST_LIVE_MODE").ok().as_deref() == Some("pilot-live")
        && !(command == "job" && args.get(1).is_some_and(|action| action == "create"))
    {
        return Err(
            "native live mode currently permits only job create through the daemon control socket"
                .into(),
        );
    }
    if command == "job" && args.get(1).is_some_and(|action| action == "merge") {
        return Err("job merge is retired: local Git merge is a Graph-owned effect; do not request GitHub PR merge via CLI".into());
    }
    if command == "job" && args.get(1).is_some_and(|action| action == "run") {
        if args[2..].iter().any(|a| a == "--help" || a == "-h") {
            return node_compat::dispatch(&[]);
        }
        return foreground::run(&args[2..]);
    }
    if command == "job"
        && args.get(1).is_some_and(|action| {
            matches!(
                action.as_str(),
                "create" | "update" | "pause" | "resume" | "cancel" | "unblock"
            )
        })
    {
        if args[2..].iter().any(|arg| arg == "--help" || arg == "-h") {
            return node_compat::dispatch(&[]);
        }
        let value = job_cli::run(args[1].as_str(), &args[2..])?;
        println!(
            "{}",
            serde_json::to_string(&value).map_err(|e| e.to_string())?
        );
        return Ok(());
    }
    if args.iter().any(|a| a == "--help" || a == "-h") {
        return node_compat::dispatch(&[]);
    }
    if matches!(
        (command, args.get(1).map(String::as_str)),
        ("job", Some("list" | "show")) | ("task", Some("list" | "show" | "events"))
    ) {
        return node_compat::dispatch(&args);
    }
    if command == "status" {
        return status::run(&args[1..]);
    }
    if matches!(command, "plan" | "record" | "reconcile" | "serve") {
        let action = args
            .get(1)
            .filter(|value| !value.starts_with("--"))
            .map(String::as_str);
        let start = if action.is_some() { 2 } else { 1 };
        let result = planner_cli::dispatch(command, action, &args[start..])?;
        println!(
            "{}",
            serde_json::to_string(&result).map_err(|e| e.to_string())?
        );
        return Ok(());
    }
    if let Some(result) = review_cli::dispatch(&args)? {
        println!(
            "{}",
            serde_json::to_string(&result).map_err(|e| e.to_string())?
        );
        return Ok(());
    }
    if matches!(command, "agent-register" | "agent-discover") {
        return agent_cli::dispatch(&args);
    }
    if matches!(
        command,
        "artifact" | "context" | "prompt" | "migrate-local-repositories"
    ) {
        if matches!(command, "context" | "prompt") {
            return context_cli::dispatch(&args);
        }
        return platform_cli::dispatch(&args);
    }
    if command == "workflow" {
        return workflow::run(&args[1..]);
    }
    let path = db(&args)?;
    let result = match command {
        "init" => {
            init_isolated_store(&path)?;
            json!({"initialized":true,"db":path})
        }
        "create" => {
            let project = value(&args, "--project-root")?;
            let graph = value(&args, "--graph-file")?;
            let input = value(&args, "--input-file")?;
            let output = value(&args, "--output-path")?;
            let title = value(&args, "--title")?;
            let repository = value(&args, "--repository")?;
            let request_key = value(&args, "--request-key")?;
            create_dag_job(DagJobRequest {
                db: &path,
                project: Path::new(&project),
                graph_file: Path::new(&graph),
                input_file: Path::new(&input),
                output_file: Path::new(&output),
                title: &title,
                repository: &repository,
                request_key: &request_key,
            })?
        }
        "task" => task_cli::run(&args)?,
        "update" => job_update(&args[1..])?,
        "activate" => activate_job(&path, &value(&args, "--job-id")?)?,
        "show" => {
            isolated_store_root(&path)?;
            let reader = RelayReader::open(&path)?;
            let job_id = value(&args, "--job-id")?;
            let job = reader.get_job(&job_id)?.ok_or("unknown Job")?;
            serde_json::to_value(job).map_err(|e| e.to_string())?
        }
        "complete" => {
            isolated_store_root(&path)?;
            let mut authority = RelayAuthority::open_existing(&path)?;
            let job_id = value(&args, "--job-id")?;
            let completed =
                agents_relay_rust::native_job::complete_no_review_job(&mut authority, &job_id)?;
            json!({"jobId":job_id,"completed":completed})
        }
        _ => return Err("unknown native Job command".into()),
    };
    println!(
        "{}",
        serde_json::to_string(&result).map_err(|e| e.to_string())?
    );
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("relay-native-job: {error}");
        std::process::exit(2);
    }
}
