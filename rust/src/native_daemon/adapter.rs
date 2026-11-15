//! Trusted local executor manifest, private execution request and WorkerSpec.
//! Graph owns eligibility. This adapter binds the durable provider decision to
//! trusted executor configuration and resolves project context references.
use super::NativeDaemonOptions;
use crate::worker::WorkerSpec;
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NativeAdapterKind {
    #[default]
    Script,
    Model,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeScriptAdapter {
    #[serde(default)]
    pub kind: NativeAdapterKind,
    pub executable: PathBuf,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    // Explicit native-pilot Model Router decision for DAG children only.
    pub routing: Option<Value>,
    pub worker_selection: Option<Value>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScriptManifest {
    pub agents: BTreeMap<String, NativeScriptAdapter>,
}
fn stable_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
pub(super) fn manifest(opt: &NativeDaemonOptions, root: &Path) -> Result<ScriptManifest, String> {
    let file = opt
        .manifest
        .canonicalize()
        .map_err(|e| format!("Script manifest missing: {e}"))?;
    if file.parent() != Some(root) {
        return Err("native Script manifest must be in isolated DB root".into());
    }
    let info = fs::metadata(&file).map_err(|e| e.to_string())?;
    if !info.is_file() || info.len() > 65_536 {
        return Err("Script manifest must be a small file".into());
    }
    let contents = fs::read(&file).map_err(|e| e.to_string())?;
    let parsed: ScriptManifest = serde_json::from_slice(&contents).map_err(|e| e.to_string())?;
    for (name, agent) in &parsed.agents {
        if !stable_id(name) || !agent.executable.is_absolute() || !agent.executable.is_file() {
            return Err("native Script manifest contains invalid role/executable".into());
        }
        if agent
            .env
            .keys()
            .any(|key| key.starts_with("RELAY_") || key.is_empty())
        {
            return Err("native Script adapter cannot override Relay execution variables".into());
        }
        if agent.kind == NativeAdapterKind::Script
            && (agent.routing.is_some() || agent.worker_selection.is_some())
        {
            return Err("Script adapter cannot supply Model routing".into());
        }
        if agent.routing.is_some() != agent.worker_selection.is_some() {
            return Err("Model route and Worker selection must be supplied together".into());
        }
        if let (Some(route), Some(selection)) = (&agent.routing, &agent.worker_selection) {
            if agent.kind != NativeAdapterKind::Model
                || ["provider", "model", "decidedBy", "decidedAt"]
                    .iter()
                    .any(|key| route[*key].as_str().is_none_or(str::is_empty))
                || selection["adapter"] != "codex"
                || selection["workerId"].as_str().is_none_or(str::is_empty)
            {
                return Err("Model manifest requires validated durable Router fields".into());
            }
        }
    }
    Ok(parsed)
}
fn private_dir(root: &Path, path: &Path) -> Result<(), String> {
    // Reject pre-planted symlinks *before* creating any descendant. The
    // disposable root is mkdtemp-private, so no unrelated user can swap a
    // component while this test-only daemon works on it.
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "Script output escaped isolated root")?;
    let mut cursor = root.to_path_buf();
    for component in relative.components() {
        let std::path::Component::Normal(name) = component else {
            return Err("invalid Script output path component".into());
        };
        cursor.push(name);
        match fs::symlink_metadata(&cursor) {
            Ok(meta) => {
                if meta.file_type().is_symlink() || !meta.is_dir() {
                    return Err("unsafe symlink or file in Script output directory".into());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                use std::os::unix::fs::DirBuilderExt;
                fs::DirBuilder::new()
                    .mode(0o700)
                    .create(&cursor)
                    .map_err(|e| format!("private Script directory creation: {e}"))?;
            }
            Err(error) => return Err(format!("private Script output directory: {error}")),
        }
    }
    Ok(())
}
fn project_root(job: &Value, root: &Path) -> Result<PathBuf, String> {
    let git_root = job["projectRoot"]
        .as_str()
        .ok_or("Job projectRoot missing")?;
    let git_root = Path::new(git_root)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !git_root.starts_with(root) {
        return Err("native Script project outside isolated root".into());
    }
    let Some(relative) = job["projectPath"].as_str() else {
        return Ok(git_root);
    };
    let relative = Path::new(relative);
    if relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        return Err("Job projectPath must be a safe repository-relative directory".into());
    }
    let project = git_root
        .join(relative)
        .canonicalize()
        .map_err(|e| format!("Job projectPath missing: {e}"))?;
    if !project.starts_with(&git_root) || !project.is_dir() {
        return Err("Job projectPath escapes canonical Git root".into());
    }
    Ok(project)
}
pub(super) fn script_spec(
    root: &Path,
    job: &Value,
    task: &Value,
    execution_id: &str,
    adapter: &NativeScriptAdapter,
) -> Result<(WorkerSpec, PathBuf), String> {
    let id = job["id"].as_str().ok_or("Job id missing")?;
    let task_id = task["id"].as_str().ok_or("Task id missing")?;
    if ![id, task_id, execution_id]
        .iter()
        .all(|value| stable_id(value))
    {
        return Err("unsafe native Script output path identity".into());
    }
    let dir = root
        .join(".relay-rust-native-executions")
        .join(id)
        .join(task_id)
        .join(execution_id);
    private_dir(root, &dir)?;
    let evidence = dir.join("result.json");
    let adapter_name = task["adapter"]
        .as_str()
        .ok_or("Task Worker adapter missing")?;
    if !matches!(
        (adapter_name, adapter.kind),
        ("script", NativeAdapterKind::Script) | ("codex", NativeAdapterKind::Model)
    ) {
        return Err("trusted executor kind does not match durable Task adapter".into());
    }
    let project = project_root(job, root)?;
    let timeout = task["timeoutMs"]
        .as_u64()
        .filter(|value| *value >= 10 && *value <= 3_600_000)
        .ok_or("Task timeout missing or out of bounds for native Worker")?;
    let mut env = adapter.env.clone();
    env.insert("PATH".into(), "/usr/bin:/bin".into());
    env.insert("RELAY_JOB_ID".into(), id.into());
    env.insert("RELAY_TASK_ID".into(), task_id.into());
    env.insert("RELAY_EXECUTION_ID".into(), execution_id.into());
    env.insert("RELAY_WORKER_ADAPTER".into(), adapter_name.into());
    // Script and Model both consume the immutable execution-bound input.
    // Never require a Worker to reconstruct its Task from a mutable Job JSON
    // snapshot, and never put unbounded inputs in argv or environment strings.
    let input = task["input"]
        .as_str()
        .ok_or("native Worker Task input must be a string")?;
    let agent_name = task["agentName"]
        .as_str()
        .ok_or("native Worker Agent missing")?;
    let git_root = Path::new(job["projectRoot"].as_str().ok_or("Job Git root missing")?)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let context = crate::native_context::resolve(&project, &git_root, "worker", agent_name)?;
    let attempt = task["attempt"]
        .as_i64()
        .ok_or("native Worker Task attempt missing")?
        .checked_add(1)
        .ok_or("native Worker Task attempt overflow")?;
    let mut request = serde_json::json!({
        "jobId":id,"taskId":task_id,"executionId":execution_id,
        "leaseOwner":"rust-native-isolated","adapter":adapter_name,"attempt":attempt,
        "agentName":agent_name,"input":input,"executionContext":context,
    });
    if adapter.kind == NativeAdapterKind::Model {
        let routing = task.get("routing").ok_or("Model Task missing routing")?;
        if routing["provider"]
            .as_str()
            .is_none_or(|v| v.trim().is_empty())
            || routing["model"]
                .as_str()
                .is_none_or(|v| v.trim().is_empty())
        {
            return Err("Model requires existing provider/model route".into());
        }
        request["routing"] = routing.clone();
        let selection = task
            .get("workerSelection")
            .ok_or("Model Task missing durable Worker selection")?;
        if selection["adapter"] != "codex"
            || selection["workerId"]
                .as_str()
                .is_none_or(|value| value.trim().is_empty())
            || adapter
                .worker_selection
                .as_ref()
                .is_some_and(|configured| configured != selection)
            || adapter
                .routing
                .as_ref()
                .is_some_and(|configured| configured != &request["routing"])
        {
            return Err(
                "Model route or Worker selection does not match trusted executor configuration"
                    .into(),
            );
        }
        request["workerSelection"] = selection.clone();
    }
    let bytes = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
    if bytes.len() > 1_048_576 {
        return Err("native Worker Task request exceeds 1MiB".into());
    }
    let request_path = dir.join("request.json");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
        .open(&request_path)
        .map_err(|e| format!("private native Worker Task request: {e}"))?;
    file.write_all(&bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    env.insert(
        "RELAY_TASK_REQUEST_PATH".into(),
        request_path.to_string_lossy().into_owned(),
    );
    env.insert(
        "RELAY_RESULT_PATH".into(),
        evidence.to_string_lossy().into_owned(),
    );
    Ok((
        WorkerSpec {
            executable: adapter.executable.clone(),
            args: adapter.args.clone(),
            cwd: project,
            env,
            stdout: dir.join("stdout.log"),
            stderr: dir.join("stderr.log"),
            timeout: Duration::from_millis(timeout),
            terminate_grace: Duration::from_millis(250),
        },
        evidence,
    ))
}
