//! Configured, host-neutral escalation executor. The canonical Escalation
//! Graph selects invocation and result handling; this module supplies only
//! the concrete argv/process and JSON contract effects.
use crate::graph::{Decision, Graph, GraphInput};
use crate::worker::{run_worker_with_activity, WorkerSpec};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::fs::{self, DirBuilder, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::Duration;

const MAX_OUTPUT_BYTES: u64 = 256_000;
const MAX_HANDOFF_BYTES: usize = 256_000;

struct PrivateTempDir(PathBuf);

impl PrivateTempDir {
    fn new() -> Result<Self, String> {
        let path =
            std::env::temp_dir().join(format!("agents-relay-escalation-{}", uuid::Uuid::new_v4()));
        DirBuilder::new()
            .mode(0o700)
            .create(&path)
            .map_err(|error| error.to_string())?;
        Ok(Self(path))
    }
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for PrivateTempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[derive(Clone, Debug)]
pub struct EscalationRequest {
    pub intent: String,
    pub blocked_on: String,
    pub context: Option<String>,
    pub on_needs_user: Option<String>,
    pub cwd: Option<PathBuf>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EscalationResult {
    pub status: String,
    pub summary: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct EscalationOutcome {
    pub state: String,
    pub result: EscalationResult,
}

fn handoff_text(request: &EscalationRequest) -> Result<String, String> {
    if request.intent.trim().is_empty() || request.blocked_on.trim().is_empty() {
        return Err("escalation requires non-empty intent and blocked-on details".into());
    }
    let body = format!(
        "# Intent\n{}\n\n# Blocked on\n{}\n{}\n",
        request.intent.trim(),
        request.blocked_on.trim(),
        request
            .context
            .as_deref()
            .filter(|v| !v.trim().is_empty())
            .map(|v| format!("\n# Context\n{}", v.trim()))
            .unwrap_or_default()
    );
    if body.len() > MAX_HANDOFF_BYTES {
        return Err("escalation handoff exceeds 256 KiB".into());
    }
    Ok(body)
}

fn selected_command(raw: Option<&str>) -> Result<(PathBuf, Vec<String>), String> {
    let raw = raw
        .map(str::trim)
        .filter(|raw| !raw.is_empty())
        .ok_or("Escalation executor not configured: set AGENTS_RELAY_ESCALATION_COMMAND")?;
    let argv: Vec<String> = if raw.starts_with('[') {
        serde_json::from_str(raw).map_err(|_| {
            "AGENTS_RELAY_ESCALATION_COMMAND must be an absolute executable or JSON argv array"
        })?
    } else {
        vec![raw.to_owned()]
    };
    if argv.is_empty()
        || argv.len() > 12
        || argv
            .iter()
            .any(|arg| arg.is_empty() || arg.len() > 4096 || arg.contains(['\r', '\n', '\0']))
    {
        return Err("AGENTS_RELAY_ESCALATION_COMMAND has invalid argv".into());
    }
    let executable = PathBuf::from(&argv[0]);
    if !executable.is_absolute() {
        return Err("AGENTS_RELAY_ESCALATION_COMMAND executable must be absolute".into());
    }
    Ok((executable, argv.into_iter().skip(1).collect()))
}

fn write_private(path: &Path, contents: &str) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| format!("escalation handoff file: {e}"))?;
    file.write_all(contents.as_bytes())
        .map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())
}

fn output_size(path: &Path) -> Result<u64, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.file_type().is_file() {
        return Err("escalation executor output is not a regular file".into());
    }
    Ok(metadata.len())
}

fn read_bounded_output(path: &Path) -> Result<Vec<u8>, String> {
    let size = output_size(path)?;
    if size > MAX_OUTPUT_BYTES {
        return Err("escalation executor output exceeded 256 KiB".into());
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(path)
        .map_err(|error| format!("escalation executor output unavailable: {error}"))?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_OUTPUT_BYTES {
        return Err("escalation executor output exceeded 256 KiB or was not regular".into());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_OUTPUT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_OUTPUT_BYTES {
        return Err("escalation executor output exceeded 256 KiB".into());
    }
    Ok(bytes)
}

fn failed(summary: impl Into<String>) -> EscalationOutcome {
    let summary = summary.into();
    EscalationOutcome {
        state: "technical_failure".into(),
        result: EscalationResult {
            status: "failed".into(),
            summary,
        },
    }
}

/// Run the executor named only by the trusted deployment environment. Task
/// fields are written to private files and never parsed as commands.
pub fn run_configured_escalation(
    request: &EscalationRequest,
    command_env: Option<&str>,
) -> Result<EscalationOutcome, String> {
    let request_text = handoff_text(request)?;
    let graph = Graph::parse(include_str!("../../workflow/escalation.mmd"))?;
    let invoke = graph.decide(
        "suspected_human_blocker",
        GraphInput {
            transport: "event".into(),
            id: "escalation.requested".into(),
            payload: json!({}),
        },
        &HashMap::new(),
    )?;
    let Decision::Accepted {
        target, actions, ..
    } = invoke
    else {
        return Err("Escalation Graph rejected request".into());
    };
    if target != "invoking" || actions.len() != 1 || actions[0].id != "escalation.invoke" {
        return Err("Escalation Graph selected an unsupported invocation effect".into());
    }
    let (executable, prefix) = match selected_command(command_env) {
        Ok(command) => command,
        Err(error) => return finish_graph(&graph, failed(error)),
    };
    let root = match PrivateTempDir::new() {
        Ok(root) => root,
        Err(error) => {
            return finish_graph(
                &graph,
                failed(format!("Escalation handoff unavailable: {error}")),
            )
        }
    };
    let handoff = root.path().join("handoff.md");
    let stdout = root.path().join("result.json");
    let stderr = root.path().join("stderr.log");
    let stderr_check = stderr.clone();
    if let Err(error) = write_private(&handoff, &request_text) {
        return finish_graph(
            &graph,
            failed(format!("Escalation handoff unavailable: {error}")),
        );
    }
    let policy = if let Some(value) = request
        .on_needs_user
        .as_deref()
        .filter(|v| !v.trim().is_empty())
    {
        if value.len() > MAX_HANDOFF_BYTES {
            return finish_graph(&graph, failed("Escalation user policy exceeds 256 KiB"));
        }
        let path = root.path().join("on-needs-user.md");
        if let Err(error) = write_private(&path, value) {
            return finish_graph(
                &graph,
                failed(format!("Escalation user policy unavailable: {error}")),
            );
        }
        Some(path)
    } else {
        None
    };
    let cwd = match request.cwd.as_deref() {
        Some(value) => match fs::canonicalize(value) {
            Ok(path) if path.is_dir() => path,
            _ => return finish_graph(&graph, failed("Escalation executor cwd is unavailable")),
        },
        None => match std::env::current_dir() {
            Ok(path) => path,
            Err(error) => {
                return finish_graph(
                    &graph,
                    failed(format!("Escalation executor cwd is unavailable: {error}")),
                )
            }
        },
    };
    let mut args = prefix;
    args.extend(["--handoff-file".into(), handoff.display().to_string()]);
    if let Some(path) = policy {
        args.extend(["--on-needs-user-file".into(), path.display().to_string()]);
    }
    if request.cwd.is_some() {
        args.extend(["--cwd".into(), cwd.display().to_string()]);
    }
    let env = std::env::vars().collect::<HashMap<_, _>>();
    let spec = WorkerSpec {
        executable,
        args,
        cwd,
        env: env.into_iter().collect(),
        stdout: stdout.clone(),
        stderr,
        timeout: Duration::from_secs(600),
        terminate_grace: Duration::from_secs(2),
    };
    let cancelled = AtomicBool::new(false);
    let process = run_worker_with_activity(
        &spec,
        &cancelled,
        |_| Ok(()),
        || {
            let stdout_size = fs::metadata(&stdout).map(|value| value.len()).unwrap_or(0);
            let stderr_size = fs::metadata(&stderr_check)
                .map(|value| value.len())
                .unwrap_or(0);
            if stdout_size > MAX_OUTPUT_BYTES || stderr_size > MAX_OUTPUT_BYTES {
                return Err("escalation executor output exceeded 256 KiB".into());
            }
            Ok(None)
        },
    );
    let outcome = match process {
        Ok(result) if result.timed_out => failed("Escalation executor timed out"),
        Ok(result) if result.exit_code != Some(0) => failed(format!(
            "Escalation executor failed (exit {})",
            result
                .exit_code
                .map_or_else(|| "signal".into(), |code| code.to_string())
        )),
        Ok(_) => {
            // The worker may finish between activity polls, so enforce the
            // output cap again after exit before reading the result file.
            let stdout_bytes = read_bounded_output(&stdout);
            let stderr_size = output_size(&stderr_check).unwrap_or(MAX_OUTPUT_BYTES + 1);
            if stdout_bytes.is_err() || stderr_size > MAX_OUTPUT_BYTES {
                failed("Escalation executor output exceeded 256 KiB")
            } else {
                match stdout_bytes
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<EscalationResult>(&bytes).ok())
                {
                    Some(result)
                        if matches!(
                            result.status.as_str(),
                            "resolved" | "failed" | "needs_user"
                        ) && !result.summary.trim().is_empty() =>
                    {
                        finish_graph(
                            &graph,
                            EscalationOutcome {
                                state: String::new(),
                                result,
                            },
                        )?
                    }
                    _ => failed("Escalation executor returned invalid result contract"),
                }
            }
        }
        Err(error) => failed(format!("Escalation executor failed: {error}")),
    };
    Ok(if outcome.state.is_empty() {
        finish_graph(&graph, outcome)?
    } else {
        outcome
    })
}

fn finish_graph(
    graph: &Graph,
    mut outcome: EscalationOutcome,
) -> Result<EscalationOutcome, String> {
    let result = graph.decide(
        "invoking",
        GraphInput {
            transport: "event".into(),
            id: "escalation.result".into(),
            payload: json!({}),
        },
        &HashMap::from([
            (
                "escalationResolved".into(),
                outcome.result.status == "resolved",
            ),
            ("escalationFailed".into(), outcome.result.status == "failed"),
            (
                "escalationNeedsUser".into(),
                outcome.result.status == "needs_user",
            ),
        ]),
    )?;
    let Decision::Accepted {
        target, actions, ..
    } = result
    else {
        return Err("Escalation Graph rejected executor result".into());
    };
    let expected = match outcome.result.status.as_str() {
        "resolved" => ("resolved", "escalation.resume_recovery"),
        "failed" => ("technical_failure", "escalation.technical_failure"),
        "needs_user" => ("needs_user", "escalation.block_for_user"),
        _ => return Err("invalid escalation result status".into()),
    };
    if target != expected.0 || actions.len() != 1 || actions[0].id != expected.1 {
        return Err("Escalation Graph selected an unsupported result effect".into());
    }
    outcome.state = target.to_owned();
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> EscalationRequest {
        EscalationRequest {
            intent: "Resolve a verified blocker".into(),
            blocked_on: "owner answer".into(),
            context: Some("Task 8".into()),
            on_needs_user: Some("Ask for the missing approval".into()),
            cwd: None,
        }
    }

    #[test]
    fn configured_executor_result_is_bound_to_escalation_graph() {
        for (status, expected) in [
            ("resolved", "resolved"),
            ("needs_user", "needs_user"),
            ("failed", "technical_failure"),
        ] {
            let command = format!("[\"/bin/sh\",\"-c\",\"printf '{{\\\"status\\\":\\\"{status}\\\",\\\"summary\\\":\\\"executor result\\\"}}'\"]");
            let result = run_configured_escalation(&request(), Some(&command)).unwrap();
            assert_eq!(result.state, expected);
            assert_eq!(result.result.status, status);
        }
    }

    #[test]
    fn missing_invalid_or_nonzero_executor_never_claims_resolution_or_human_blocker() {
        let request = request();
        assert_eq!(
            run_configured_escalation(&request, None).unwrap().state,
            "technical_failure"
        );
        assert_eq!(
            run_configured_escalation(&request, Some("relative/executor"))
                .unwrap()
                .state,
            "technical_failure"
        );
        let malformed =
            run_configured_escalation(&request, Some("[\"/bin/sh\",\"-c\",\"printf not-json\"]"))
                .unwrap();
        assert_eq!(malformed.state, "technical_failure");
        let extra = run_configured_escalation(&request, Some("[\"/bin/sh\",\"-c\",\"printf '{\\\"status\\\":\\\"needs_user\\\",\\\"summary\\\":\\\"ask\\\",\\\"other\\\":true}'\"]")).unwrap();
        assert_eq!(extra.state, "technical_failure");
        let nonzero =
            run_configured_escalation(&request, Some("[\"/bin/sh\",\"-c\",\"exit 7\"]")).unwrap();
        assert_eq!(nonzero.state, "technical_failure");
        assert_ne!(malformed.state, "needs_user");
        let oversized = run_configured_escalation(
            &request,
            Some("[\"/bin/sh\",\"-c\",\"head -c 300000 /dev/zero\"]"),
        )
        .unwrap();
        assert_eq!(oversized.state, "technical_failure");
        let symlink_result = run_configured_escalation(
            &request,
            Some("[\"/bin/sh\",\"-c\",\"ln -sf /dev/zero \\\"$(dirname \\\"$1\\\")/result.json\\\"\"]"),
        )
        .unwrap();
        assert_eq!(symlink_result.state, "technical_failure");
        let fifo_result = run_configured_escalation(
            &request,
            Some("[\"/bin/sh\",\"-c\",\"rm -f \\\"$(dirname \\\"$1\\\")/result.json\\\"; mkfifo \\\"$(dirname \\\"$1\\\")/result.json\\\"\"]"),
        )
        .unwrap();
        assert_eq!(fifo_result.state, "technical_failure");
        let mut invalid_cwd = request;
        invalid_cwd.cwd = Some(
            std::env::temp_dir().join(format!("missing-escalation-cwd-{}", uuid::Uuid::new_v4())),
        );
        assert_eq!(run_configured_escalation(&invalid_cwd,
            Some("[\"/bin/sh\",\"-c\",\"printf '{\\\"status\\\":\\\"resolved\\\",\\\"summary\\\":\\\"wrong\\\"}'\"]"))
            .unwrap().state, "technical_failure");
    }

    #[test]
    fn executor_never_interprets_request_content_as_argv() {
        let root = tempfile::tempdir().unwrap();
        let marker = root.path().join("injected");
        let mut request = request();
        request.intent = format!("$(touch {})", marker.display());
        let result = run_configured_escalation(&request,
            Some("[\"/bin/sh\",\"-c\",\"printf '{\\\"status\\\":\\\"resolved\\\",\\\"summary\\\":\\\"ok\\\"}'\"]")).unwrap();
        assert_eq!(result.state, "resolved");
        assert!(!marker.exists());
    }
}
