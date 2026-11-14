//! Test-gated native Job intake; never races production TS Relay.
use agents_relay_rust::authority::RelayAuthority;
use agents_relay_rust::native_daemon::isolated_store_root;
use agents_relay_rust::native_job::{
    activate_job, create_dag_job, init_isolated_store, DagJobRequest,
};
use agents_relay_rust::store::RelayReader;
use serde_json::json;
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
fn run() -> Result<(), String> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let Some(command) = args.first().map(String::as_str) else {
        return Err("usage: relay-native-job init|create|activate|show --db PATH ...".into());
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
