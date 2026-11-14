//! Trusted local executor manifest, private execution request and WorkerSpec.
//! Selection is an explicit caller-supplied port; Graph/Router policy stays
//! outside this adapter. No production provider or implicit shell fallback.
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
    let project = job["projectRoot"]
        .as_str()
        .ok_or("Job projectRoot missing")?;
    let path = Path::new(project)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !path.starts_with(root) {
        return Err("native Script project outside isolated root".into());
    }
    Ok(path)
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
    if adapter.kind == NativeAdapterKind::Model {
        let input = task["input"]
            .as_str()
            .ok_or("Model Task input must be a string")?;
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
        let attempt = task["attempt"]
            .as_i64()
            .ok_or("Model Task attempt missing")?
            .checked_add(1)
            .ok_or("Model Task attempt overflow")?;
        let request = serde_json::json!({
            "jobId":id,"taskId":task_id,"executionId":execution_id,
            "leaseOwner":"rust-native-isolated","adapter":"codex","attempt":attempt,
            "agentName":task["agentName"],"input":input,"routing":routing,
            "workerSelection":task["workerSelection"],
        });
        let bytes = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
        if bytes.len() > 1_048_576 {
            return Err("Model Task request exceeds 1MiB".into());
        }
        let request_path = dir.join("request.json");
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
            .open(&request_path)
            .map_err(|e| format!("private Model Task request: {e}"))?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        env.insert(
            "RELAY_TASK_REQUEST_PATH".into(),
            request_path.to_string_lossy().into_owned(),
        );
    }
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
