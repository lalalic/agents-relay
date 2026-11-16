//! Provision deterministic trusted Model/Reviewer/Troubleshooter routes for
//! every Neo Project Agent file, without assuming that all Agents are alike.
//! The actual agent instructions remain in their project repo; the native
//! Model Worker reads those at the durable execution-bound Git root.
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

fn option(args: &[String], key: &str) -> Result<String, String> {
    if args.iter().filter(|arg| arg.as_str() == key).count() != 1 {
        return Err(format!("exactly one {key} required"));
    }
    let i = args
        .iter()
        .position(|arg| arg == key)
        .ok_or_else(|| format!("missing {key}"))?;
    args.get(i + 1)
        .filter(|value| !value.starts_with("--") && !value.is_empty())
        .cloned()
        .ok_or_else(|| format!("{key} requires a value"))
}
fn regular_absolute(args: &[String], key: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(option(args, key)?);
    if !path.is_absolute() {
        return Err(format!("{key} must be an absolute path"));
    }
    let file = path
        .canonicalize()
        .map_err(|error| format!("{key}: {error}"))?;
    if !file.is_file() {
        return Err(format!("{key} requires an existing file"));
    }
    Ok(file)
}
fn safe_agent(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}
fn enumerate(neo: &Path) -> Result<BTreeMap<String, String>, String> {
    let mut roles = BTreeMap::new();
    for project in fs::read_dir(neo).map_err(|e| e.to_string())? {
        let project = project.map_err(|e| e.to_string())?;
        let meta = fs::symlink_metadata(project.path()).map_err(|e| e.to_string())?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            continue;
        }
        let agents_dir = project.path().join("agents");
        if !agents_dir.is_dir() {
            continue;
        }
        for agent in fs::read_dir(&agents_dir).map_err(|e| e.to_string())? {
            let agent = agent.map_err(|e| e.to_string())?;
            let path = agent.path();
            let meta = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
            if !meta.is_file() || meta.file_type().is_symlink() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            let Some(agent_name) = name.strip_suffix(".agent.md") else {
                continue;
            };
            if !safe_agent(agent_name) {
                return Err(format!("invalid Neo Agent role file: {name}"));
            }
            let project_name = project.file_name().to_string_lossy().into_owned();
            if let Some(existing) = roles.insert(agent_name.into(), project_name.clone()) {
                return Err(format!(
                    "duplicate Neo Agent role {agent_name} in {existing} and {project_name}: cannot globally route ambiguously"
                ));
            }
        }
    }
    Ok(roles)
}
fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().skip(1).collect();
    let neo = PathBuf::from(option(&args, "--neo-root")?)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !neo.is_dir() {
        return Err("Neo root must be a directory".into());
    }
    let model_worker = regular_absolute(&args, "--model-worker")?;
    let codex = regular_absolute(&args, "--codex")?;
    let prompt_cli = regular_absolute(&args, "--prompt-cli")?;
    if !prompt_cli
        .parent()
        .is_some_and(|parent| parent.join("model-routing.js").is_file())
    {
        return Err("trusted prompt-cli requires adjacent model-routing.js".into());
    }
    let node = regular_absolute(&args, "--prompt-node")?;
    let model = option(&args, "--model")?;
    if model.len() > 128
        || !model
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err("invalid stable model name".into());
    }
    let route_at = option(&args, "--route-at")?;
    chrono::DateTime::parse_from_rfc3339(&route_at)
        .map_err(|_| "route-at must be RFC3339 with an offset")?;
    let out = PathBuf::from(option(&args, "--output")?);
    let parent = out.parent().ok_or("manifest output parent missing")?;
    let meta = fs::symlink_metadata(parent).map_err(|e| e.to_string())?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err("manifest output parent must be a real directory".into());
    }
    let roles = enumerate(&neo)?;
    let home = env::var("HOME").map_err(|_| "HOME required")?;
    let mut agents = serde_json::Map::<String, Value>::new();
    for name in roles.keys().map(String::as_str).chain(
        ["job-acceptance-reviewer", "reviewer", "troubleshooter"]
            .iter()
            .copied()
            .filter(|name| !roles.contains_key(*name)),
    ) {
        agents.insert(name.to_string(), json!({
            "kind":"model","executable":model_worker,"args":[],
            "env":{"HOME":home,"CODEX_HOME":format!("{home}/.codex"),
                   "CODEX_EXECUTABLE":codex},
            "routing":{"provider":"openai","model":model,"decidedBy":"rust-native-agent-manifest",
                       "decidedAt":route_at},
            "workerSelection":{"workerId":"codex-local-cli","adapter":"codex",
                               "selectedBy":"rust-native-agent-manifest","selectedAt":route_at},
            "promptCli":prompt_cli,"promptNode":node
        }));
    }
    if agents.is_empty() {
        return Err("no native Agent routes found".into());
    }
    let document =
        serde_json::to_vec_pretty(&json!({"agents":agents})).map_err(|e| e.to_string())?;
    if document.len() > 65_536 {
        return Err("native manifest exceeds the 64KiB daemon contract".into());
    }
    // Atomic replacement: the live Rust daemon only observes complete manifests.
    let tmp = parent.join(format!(
        ".relay-native-agent-manifest-{}",
        uuid::Uuid::new_v4()
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
        .open(&tmp)
        .map_err(|e| e.to_string())?;
    file.write_all(&document).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    fs::rename(&tmp, &out).map_err(|e| e.to_string())?;
    println!(
        "{}",
        json!({"agentRoles":agents.len(),"projects":roles.len(),"manifest":out})
    );
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("relay-native-agent-manifest: {error}");
        std::process::exit(2);
    }
}
