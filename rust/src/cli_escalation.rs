// Node provenance: src/cli-escalation.ts. Parse only operator-controlled
// escalation executors; Task text never becomes a shell command.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EscalationCommand {
    pub executable: String,
    pub prefix_args: Vec<String>,
}
const CONFIG_ERROR: &str =
    "AGENTS_RELAY_ESCALATION_COMMAND must be an absolute executable or JSON argv array";

pub fn escalation_command(env: &HashMap<String, String>) -> Result<Option<EscalationCommand>, String> {
    let Some(raw) = env.get("AGENTS_RELAY_ESCALATION_COMMAND")
        .map(String::as_str).map(str::trim).filter(|raw| !raw.is_empty())
    else { return Ok(None); };
    let args: Vec<String> = if raw.starts_with('[') {
        let parsed: Value = serde_json::from_str(raw).map_err(|_| CONFIG_ERROR)?;
        let array = parsed.as_array().ok_or(CONFIG_ERROR)?;
        array.iter().map(|value| value.as_str().map(str::to_owned)
            .ok_or(CONFIG_ERROR.to_string())).collect::<Result<Vec<_>,_>>()?
    } else { vec![raw.to_string()] };
    if args.is_empty() || args.len() > 12 || !Path::new(&args[0]).is_absolute()
        || args.iter().any(|arg| arg.is_empty() || arg.len() > 4096
            || arg.bytes().any(|byte| matches!(byte, b'\n' | b'\r' | 0)))
    { return Err(CONFIG_ERROR.into()); }
    Ok(Some(EscalationCommand {
        executable: args[0].clone(), prefix_args: args[1..].to_vec(),
    }))
}
pub fn escalation_executor_args(
    handoff_path: &str, policy_path: Option<&str>, cwd: Option<&str>,
) -> Vec<String> {
    let mut args = vec!["--handoff-file".into(), handoff_path.into()];
    if let Some(path) = policy_path.filter(|path| !path.is_empty()) {
        args.extend(["--on-needs-user-file".into(), path.into()]);
    }
    if let Some(cwd) = cwd.filter(|cwd| !cwd.is_empty()) {
        args.extend(["--cwd".into(), cwd.into()]);
    }
    args
}
pub fn handoff_text(request: &Value) -> String {
    let field = |name: &str| request.get(name).and_then(Value::as_str)
        .unwrap_or("").trim().to_owned();
    let mut content = format!("# Intent\n{}\n\n# Blocked on\n{}\n",
        field("intent"), field("blockedOn"));
    let context = field("context");
    if !context.is_empty() { content.push_str(&format!("\n# Context\n{context}\n")); }
    content
}
pub fn failed_escalation(summary: &str) -> Value {
    json!({"status": "failed", "summary": summary, "reason": summary})
}
/// Valid output must be a single unambiguous structured result, not a
/// success inferred from exit code or printed diagnostic text.
pub fn parse_escalation_output(exit_code: Option<i32>, stdout: &str, exceeded: bool) -> Value {
    if exceeded { return failed_escalation("Escalation executor output exceeded limit"); }
    if exit_code != Some(0) {
        return failed_escalation(&format!("Escalation executor failed (exit {})",
            exit_code.map(|code| code.to_string()).unwrap_or_else(|| "signal".into())));
    }
    let Ok(result) = serde_json::from_str::<Value>(stdout.trim()) else {
        return failed_escalation("Escalation executor returned invalid JSON");
    };
    let status = result.get("status").and_then(Value::as_str);
    let summary = result.get("summary").and_then(Value::as_str);
    if !matches!(status, Some("resolved" | "failed" | "needs_user"))
        || !summary.is_some_and(|summary| !summary.trim().is_empty())
    { return failed_escalation("Escalation executor returned invalid result contract"); }
    result
}

// Node runConfiguredEscalation: the selected executable is trusted deployment
// configuration; only literal argv, never Task-provided shell expressions.
use crate::owned_process::{
    OwnedProcessManager, OwnedProcessOptions, TerminationReason,
};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct PrivateHandoffDirectory(PathBuf);
impl PrivateHandoffDirectory {
    fn new() -> Result<Self, String> {
        for _ in 0..32 {
            let stamp = SystemTime::now().duration_since(UNIX_EPOCH)
                .map_err(|error| error.to_string())?.as_nanos();
            let next = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "agents-relay-escalation-{}-{stamp}-{next}", std::process::id()
            ));
            #[cfg(unix)]
            let create = {
                use std::os::unix::fs::DirBuilderExt;
                let mut builder = fs::DirBuilder::new();
                builder.mode(0o700);
                builder.create(&path)
            };
            #[cfg(not(unix))]
            let create = fs::create_dir(&path);
            match create {
                Ok(()) => {
                    return Ok(Self(path));
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.to_string()),
            }
        }
        Err("Unable to allocate private escalation handoff directory".into())
    }
    fn write_private(&self, name: &str, content: &str) -> Result<String, String> {
        let path = self.0.join(name);
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)] {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&path).map_err(|error| error.to_string())?;
        file.write_all(content.as_bytes()).map_err(|error| error.to_string())?;
        Ok(path.to_string_lossy().into_owned())
    }
}
impl Drop for PrivateHandoffDirectory {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
}

/// Actual owned-process invocation, including private handoff, time limit,
/// output contract verification and cleanup. Kept separate from Graph policy.
pub fn run_configured_escalation(
    request: &Value, env: &HashMap<String, String>,
) -> Value {
    run_configured_escalation_with_timeout(request, env, Duration::from_secs(600))
}

pub fn run_configured_escalation_with_timeout(
    request: &Value, env: &HashMap<String, String>, timeout: Duration,
) -> Value {
    let selected = match escalation_command(env) {
        Ok(Some(command)) => command,
        Ok(None) => return failed_escalation(
            "Escalation executor not configured: set AGENTS_RELAY_ESCALATION_COMMAND"),
        Err(error) => return failed_escalation(&error),
    };
    let execute = || -> Result<Value, String> {
        let private = PrivateHandoffDirectory::new()?;
        let handoff = private.write_private("handoff.md", &handoff_text(request))?;
        let policy = request.get("onNeedsUser").and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(|value| private.write_private("on-needs-user.md", value))
            .transpose()?;
        let cwd = request.get("cwd").and_then(Value::as_str)
            .map(PathBuf::from).or_else(|| std::env::current_dir().ok());
        let cwd_arg = request.get("cwd").and_then(Value::as_str);
        let mut args = selected.prefix_args.clone();
        args.extend(escalation_executor_args(&handoff, policy.as_deref(), cwd_arg));
        let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
        let mut manager = OwnedProcessManager::default();
        let process = match manager.spawn_owned_process_piped(
            &selected.executable, &refs,
            OwnedProcessOptions {
                invocation: "escalation.configured".into(),
                cwd, timeout_ms: Some(timeout.as_millis().min(u64::MAX as u128) as u64),
                ..Default::default()
            },
        ) {
            Ok(process) => process,
            Err(error) => return Ok(failed_escalation(
                &format!("Escalation executor could not start: {error}"))),
        };
        let mut stdout = process.take_stdout()
            .ok_or("Escalation executor stdout unavailable")?;
        let mut stderr = process.take_stderr()
            .ok_or("Escalation executor stderr unavailable")?;
        // Drain stderr but never log it: it may contain provider credentials.
        let stderr_drain = thread::spawn(move || {
            let mut buffer = [0u8; 4096];
            while let Ok(length) = stderr.read(&mut buffer) {
                if length == 0 { break; }
            }
        });
        let over_limit = Arc::new(AtomicBool::new(false));
        let exceeded = Arc::clone(&over_limit);
        let stdout_reader = thread::spawn(move || {
            let mut output = Vec::new();
            let mut buffer = [0u8; 4096];
            loop {
                match stdout.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(length) if output.len() + length > 256_000 => {
                        exceeded.store(true, Ordering::Release);
                        break;
                    }
                    Ok(length) => output.extend_from_slice(&buffer[..length]),
                }
            }
            String::from_utf8_lossy(&output).into_owned()
        });
        let start = std::time::Instant::now();
        while !process.finished() && !over_limit.load(Ordering::Acquire)
            && start.elapsed() < timeout + Duration::from_millis(200) {
            thread::sleep(Duration::from_millis(10));
        }
        if over_limit.load(Ordering::Acquire) {
            process.terminate(TerminationReason::Abort, None);
        } else if !process.finished() {
            process.terminate(TerminationReason::Timeout, None);
        }
        process.wait_for_leader(Duration::from_secs(3));
        let status = process.exit_status().ok().flatten()
            .and_then(|status| status.code());
        // A descendant may still hold the pipe. Terminate the owned group
        // before joining readers; child-grandchild processes must not survive.
        process.terminate(TerminationReason::Cancel, None);
        let stdout = stdout_reader.join().unwrap_or_default();
        let _ = stderr_drain.join();
        Ok(parse_escalation_output(
            status, &stdout, over_limit.load(Ordering::Acquire),
        ))
    };
    execute().unwrap_or_else(|error| failed_escalation(&error))
}

/// Node runEscalationCommand: CLI parsing followed by the canonical
/// escalation Graph, never a second decision policy in CLI.
pub fn run_escalation_command(
    args: &[String], env: &HashMap<String, String>, graph_directory: &Path,
) -> Result<Value, String> {
    use crate::cli_core_support::{arg, text_option};
    let intent = text_option(args, "--intent", "--intent-file", None)?;
    let blocked_on = text_option(args, "--blocked-on", "--blocked-on-file", None)?;
    if intent.trim().is_empty() {
        return Err("escalation requires --intent or --intent-file".into());
    }
    if blocked_on.trim().is_empty() {
        return Err("escalation requires --blocked-on or --blocked-on-file".into());
    }
    let context = text_option(args, "--context", "--context-file", None)?;
    let policy = text_option(args, "--on-needs-user", "--on-needs-user-file", None)?;
    let mut request = json!({"intent":intent,"blockedOn":blocked_on});
    if !context.trim().is_empty() { request["context"] = json!(context); }
    if !policy.trim().is_empty() { request["onNeedsUser"] = json!(policy); }
    let cwd = arg(args, "--cwd", "");
    if !cwd.is_empty() { request["cwd"] = json!(cwd); }
    let future = crate::workflow::escalation::run_escalation_graph(
        graph_directory, &request,
        |request| Ok(run_configured_escalation(request, env)),
        |_| Ok(()), |_| Ok(()), |_| Ok(()),
    );
    use std::{future::Future, pin::pin, task::{Context, Poll, Waker}};
    let mut future = pin!(future);
    let outcome = loop {
        let mut context = Context::from_waker(Waker::noop());
        if let Poll::Ready(value) = future.as_mut().poll(&mut context) { break value?; }
        thread::yield_now();
    };
    let mut output = json!({"state":outcome["state"]});
    if let Some(fields) = outcome["result"].as_object() {
        for (key, value) in fields { output[key] = value.clone(); }
    }
    Ok(output)
}
