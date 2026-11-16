//! Physical Codex Model Worker for the native Rust Relay daemon.
//!
//! This is a worker, not another scheduler: the Rust authority pre-allocates
//! a Task/attempt/execution/route, and the helper supervises our process group.
//! Success is reported only after the real Codex command exits zero and writes
//! its last response; never infer Task success from receipt creation alone.
use serde_json::{json, Value};
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn required<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value[key]
        .as_str()
        .filter(|text| !text.is_empty())
        .ok_or_else(|| format!("immutable Task request requires {key}"))
}

fn file_from_env(name: &str) -> Result<PathBuf, String> {
    let file = PathBuf::from(env::var(name).map_err(|_| format!("missing {name}"))?);
    if !file.is_absolute() {
        return Err(format!("{name} must be absolute"));
    }
    Ok(file)
}

fn read_bounded(path: &Path, limit: u64) -> Result<String, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > limit {
        return Err(format!(
            "unsafe or oversized Model Worker input: {}",
            path.display()
        ));
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|error| error.to_string())?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > limit {
        return Err("Model Worker input exceeds limit".into());
    }
    String::from_utf8(bytes).map_err(|_| "Model Worker input must be UTF-8".into())
}

fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn run() -> Result<(), String> {
    let input = file_from_env("RELAY_TASK_REQUEST_PATH")?;
    let result = file_from_env("RELAY_RESULT_PATH")?;
    let data = read_bounded(&input, 1_048_576)?;
    let request: Value = serde_json::from_str(&data).map_err(|e| e.to_string())?;
    if required(&request, "adapter")? != "codex"
        || required(&request["routing"], "provider")? != "openai"
        || required(&request["workerSelection"], "adapter")? != "codex"
    {
        return Err("Codex Worker requires a pre-authorized OpenAI/Codex route".into());
    }
    let model = required(&request["routing"], "model")?;
    if model.len() > 128
        || !model
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err("invalid immutable Model Router model identity".into());
    }
    let job = required(&request, "jobId")?;
    let task = required(&request, "taskId")?;
    let execution = required(&request, "executionId")?;
    let lease = required(&request, "leaseOwner")?;
    let agent = required(&request, "agentName")?;
    let input_text = required(&request, "input")?;
    if !safe_name(agent)
        || ![job, task]
            .iter()
            .all(|id| id.bytes().all(|b| b.is_ascii_digit()))
        || !safe_name(execution)
        || !safe_name(lease)
    {
        return Err("invalid immutable Job/Task/execution identity".into());
    }
    let attempt = request["attempt"]
        .as_i64()
        .filter(|n| (1..=100).contains(n))
        .ok_or("Model Task attempt must be 1..100")?;
    let project = env::current_dir().map_err(|e| e.to_string())?;
    let instructions_path = project.join("agents").join(format!("{agent}.agent.md"));
    let agent_instructions = if instructions_path.is_file() {
        read_bounded(&instructions_path, 131_072)?
    } else {
        String::new()
    };
    let execution_context =
        serde_json::to_string(&request["executionContext"]).map_err(|e| e.to_string())?;
    if execution_context.len() > 65_536 {
        return Err("Model Worker execution context is oversized".into());
    }
    let mut prompt = format!(
        "You are the `{agent}` agent working on an already authorized Relay Task.\n\
         Job {job}; Task {task}; execution {execution}, attempt {attempt}.\n\
         Follow the repository AGENTS.md and the agent instructions below.\n\
         Do the real work; do not fabricate output, tests, or review approvals.\n\
         If unable to perform the work, clearly report the blocker and exit with failure.\n\
         Agent instructions:\n{agent_instructions}\n\
         Execution context:\n{execution_context}\n\
         Task objective:\n{input_text}\n"
    );
    // Preserve exact Node Prompt Builder semantics, rather than inventing a
    // second worker prompt format. This invokes the original CLI's READ-ONLY
    // prompt Action with an immutable, execution-bound Job snapshot; no Node
    // reconciler, Node backend, or mutable SQLite connection is launched.
    if let Some(action) = request.get("promptAction").filter(|v| !v.is_null()) {
        let node_exec = PathBuf::from(required(action, "nodeExecutable")?);
        let cli = PathBuf::from(required(action, "cli")?);
        let job_file = PathBuf::from(required(action, "jobFile")?);
        let module = PathBuf::from(required(action, "modelRoutingModule")?);
        for path in [&node_exec, &cli, &job_file, &module] {
            if !path.is_absolute() || !path.is_file() {
                return Err(
                    "immutable shared Prompt Action requires existing absolute files".into(),
                );
            }
        }
        if cli.parent() != module.parent()
            || module.file_name().and_then(|n| n.to_str()) != Some("model-routing.js")
            || job_file.parent() != result.parent()
        {
            return Err(
                "shared Prompt Action identity or private Job snapshot path mismatch".into(),
            );
        }
        let generated = result.with_extension("node-production-prompt.txt");
        if generated.exists() {
            return Err("shared Prompt Action output already exists".into());
        }
        let status = Command::new(node_exec)
            .arg(cli)
            .args([
                "prompt",
                "--adapter",
                "codex",
                "--id",
                job,
                "--task-id",
                task,
                "--file",
            ])
            .arg(job_file)
            .arg("--project-path")
            .arg(&project)
            .arg("--output")
            .arg(&generated)
            .current_dir(&project)
            .stdin(Stdio::null())
            .status()
            .map_err(|e| format!("original shared Prompt Action launch failed: {e}"))?;
        if !status.success() {
            return Err(format!("original Node Prompt Builder failed with {status}"));
        }
        prompt = read_bounded(&generated, 262_144)?;
        if prompt.trim().is_empty() {
            return Err("original shared Prompt Action generated an empty prompt".into());
        }
    }
    if matches!(agent, "reviewer" | "job-acceptance-reviewer") {
        let head = required(&request, "reviewHeadSha")?;
        prompt.push_str(&format!(
            "\nFinal Review structured output contract: Reply ONLY with a JSON object, \
            {{\"verdict\":\"approved\"|\"changes_required\",\"head_sha\":\"{head}\",\"findings\":[]}}. \
            A changes_required verdict MUST have at least one actionable finding with id and summary. \
            NEVER infer approval from a task exit or a missing artifact.\n"
        ));
    }
    if prompt.len() > 262_144 {
        return Err("Model Worker prompt exceeds limit".into());
    }
    let executable = PathBuf::from(
        env::var("CODEX_EXECUTABLE").unwrap_or_else(|_| "/Users/chengli/.local/bin/codex".into()),
    );
    if !executable.is_absolute() || !executable.is_file() {
        return Err("trusted absolute CODEX_EXECUTABLE is not an existing file".into());
    }
    let summary_file = result.with_extension("codex-summary.txt");
    if result.exists() || summary_file.exists() {
        return Err(
            "execution evidence already exists; refusing to reuse a prior generation".into(),
        );
    }
    // No shell evaluation; model, output path and identity remain argv data.
    let mut child = Command::new(&executable)
        .args([
            "exec",
            "--ephemeral",
            "--sandbox",
            "workspace-write",
            "--skip-git-repo-check",
            "--model",
            model,
            "--output-last-message",
        ])
        .arg(&summary_file)
        .arg("-")
        .current_dir(&project)
        .stdin(Stdio::piped())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("Codex Worker launch failed: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("Codex stdin unavailable")?;
    stdin
        .write_all(prompt.as_bytes())
        .map_err(|e| format!("Codex prompt delivery failed: {e}"))?;
    drop(stdin);
    let status = child
        .wait()
        .map_err(|e| format!("Codex exit wait failed: {e}"))?;
    if !status.success() {
        return Err(format!("Codex model execution failed with status {status}"));
    }
    let summary = read_bounded(&summary_file, 131_072)?;
    let summary = summary.trim();
    if summary.is_empty() {
        return Err("Codex returned no documented Model response".into());
    }
    let short_summary = summary.chars().take(1800).collect::<String>();
    let mut output = json!({
        "agent":agent,"codexSummaryFile":summary_file.to_string_lossy(),
        "codexExitCode":status.code(),"realProviderExecution":true
    });
    // The real Node Reviewer output contract is a structured verdict, NOT a
    // successful model exit. Never turn free-form text into an approval.
    if matches!(agent, "reviewer" | "job-acceptance-reviewer") {
        let head = required(&request, "reviewHeadSha")?;
        if !matches!(head.len(), 40 | 64)
            || !head
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return Err("Reviewer requires immutable full Git HEAD SHA".into());
        }
        let review: Value = serde_json::from_str(summary)
            .map_err(|_| "Reviewer must return a valid structured JSON verdict")?;
        if !matches!(
            review["verdict"].as_str(),
            Some("approved" | "pass" | "changes_required" | "changes-required")
        ) || review["head_sha"] != head
            || review["findings"].as_array().is_none()
        {
            return Err("Reviewer JSON verdict, immutable head, and findings required".into());
        }
        let findings = review["findings"].as_array().expect("checked");
        if findings.len() > 100
            || (matches!(review["verdict"].as_str(), Some("approved" | "pass"))
                && !findings.is_empty())
            || (matches!(
                review["verdict"].as_str(),
                Some("changes_required" | "changes-required")
            ) && (findings.is_empty()
                || findings.iter().any(|item| {
                    item["id"].as_str().is_none_or(str::is_empty)
                        || item["summary"].as_str().is_none_or(str::is_empty)
                })))
        {
            return Err("Reviewer verdict findings violate original Node Review contract".into());
        }
        output["verdict"] = review["verdict"].clone();
        output["head_sha"] = json!(head);
        output["findings"] = review["findings"].clone();
    }
    let evidence = json!({
        "type":"task.completed","jobId":job,"taskId":task,"executionId":execution,
        "leaseOwner":lease,"attempt":attempt,"adapter":"codex",
        "routing":request["routing"],"workerSelection":request["workerSelection"],
        "status":"COMPLETED","summary":short_summary,
        "output":output
    });
    let evidence_bytes = serde_json::to_vec(&evidence).map_err(|e| e.to_string())?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
        .open(&result)
        .map_err(|e| format!("Model terminal receipt creation: {e}"))?;
    file.write_all(&evidence_bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("relay-native-model-worker: {error}");
        std::process::exit(2);
    }
}
