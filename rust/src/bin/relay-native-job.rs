//! Test-gated native Job intake; never races production TS Relay.
use agents_relay_rust::authority::NativeTaskSpec;
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
fn task_create(args: &[String]) -> Result<Value, String> {
    if std::env::var("RELAY_RUST_LIVE_MODE").ok().as_deref() == Some("pilot-live") {
        return Err("native Task creation is isolated-test only".into());
    }
    let allowed = [
        "--db",
        "--job-id",
        "--input",
        "--input-file",
        "--output",
        "--output-path",
        "--title",
        "--priority",
        "--story-size",
        "--parent",
        "--deps",
        "--dependency-validity",
    ];
    let mut options = std::collections::HashMap::<String, String>::new();
    let mut draft = false;
    let mut index = 2;
    while index < args.len() {
        let name = args[index].as_str();
        if name == "--draft" {
            if draft {
                return Err("duplicate option --draft".into());
            }
            draft = true;
            index += 1;
            continue;
        }
        if !allowed.contains(&name) {
            return Err(format!("unrecognized task create option {name}"));
        }
        if options.contains_key(name) {
            return Err(format!("duplicate option {name}"));
        }
        let value = args
            .get(index + 1)
            .filter(|value| !value.starts_with("--"))
            .ok_or_else(|| format!("missing value for {name}"))?;
        options.insert(name.to_owned(), value.clone());
        index += 2;
    }
    let get = |name: &str| options.get(name).map(String::as_str);
    let db = PathBuf::from(get("--db").ok_or("missing --db")?);
    if !db.is_absolute() {
        return Err("absolute DB path required".into());
    }
    let root = isolated_store_root(&db)?;
    let job_id = get("--job-id").ok_or("missing --job-id")?;
    let input_inline = get("--input");
    let input_file = get("--input-file");
    if input_inline.is_some() == input_file.is_some() {
        return Err("task create requires exactly one of --input or --input-file".into());
    }
    let input = if let Some(inline) = input_inline {
        inline.to_owned()
    } else {
        let path = PathBuf::from(input_file.ok_or("missing --input-file")?);
        let canonical = path
            .canonicalize()
            .map_err(|error| format!("input file: {error}"))?;
        if !canonical.is_file() || !canonical.starts_with(&root) {
            return Err("Task input file must be inside isolated store root".into());
        }
        std::fs::read_to_string(canonical).map_err(|error| format!("Task input file: {error}"))?
    };
    let deps = get("--deps")
        .unwrap_or("")
        .split(',')
        .filter(|item| !item.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let dependency_validity = get("--dependency-validity")
        .map(serde_json::from_str::<Value>)
        .transpose()
        .map_err(|error| format!("--dependency-validity: {error}"))?;
    let story_size = get("--story-size").unwrap_or("M").to_ascii_uppercase();
    let mut authority = RelayAuthority::open_existing(&db)?;
    let current = authority.read_job(job_id)?.ok_or("unknown Job")?;
    let at = after_time(
        current["updatedAt"]
            .as_str()
            .ok_or("Job timestamp missing")?,
    )?;
    let created = authority.create_native_task(NativeTaskSpec {
        job_id,
        title: get("--title"),
        input: &input,
        output_kind: get("--output").ok_or("missing --output")?,
        output_path: get("--output-path"),
        priority: get("--priority").unwrap_or("P2"),
        story_size: &story_size,
        parent_task_id: get("--parent").filter(|value| !value.is_empty()),
        dependencies: &deps,
        dependency_validity: dependency_validity.as_ref(),
        draft,
        at: &at,
    })?;
    Ok(
        serde_json::json!({"jobId":job_id,"taskId":created.task_id,"created":created.created,"task":created.task}),
    )
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
            "usage: relay-native-job init|create|activate|show|update|task create --db PATH ..."
                .into(),
        );
    };
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
        "task" if args.get(1).is_some_and(|action| action == "create") => task_create(&args)?,
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
