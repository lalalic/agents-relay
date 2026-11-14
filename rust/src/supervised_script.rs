//! Parent-death-safe Script execution through relay-worker-helper's NDJSON
//! protocol. The helper owns the worker process group, not the daemon; a
//! killed daemon causes the helper to kill its children. Only after durable
//! PID/Task registration does the daemon acknowledge the helper's launch.
use crate::authority::{RelayAuthority, ScriptClaim};
use crate::graph::Graph;
use crate::lifecycle::{TaskLifecycle, TaskTransition};
use crate::native_script::{exact_process, finish_script_worker, task_input, NativeScriptResult};
use crate::worker::{WorkerResult, WorkerSpec};
use chrono::{DateTime, Duration as ChronoDuration, SecondsFormat, Utc};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use std::time::SystemTime;

pub fn current_time() -> String {
    DateTime::<Utc>::from(SystemTime::now()).to_rfc3339_opts(SecondsFormat::Millis, true)
}
pub fn after_time(previous: &str) -> Result<String, String> {
    let stamp = DateTime::parse_from_rfc3339(previous).map_err(|_| "invalid prior timestamp")?;
    let current = DateTime::<Utc>::from(SystemTime::now());
    let next = std::cmp::max(
        current.fixed_offset(),
        stamp + ChronoDuration::milliseconds(1),
    );
    Ok(next.to_rfc3339_opts(SecondsFormat::Millis, true))
}
fn message<R: BufRead>(reader: &mut R) -> Result<Value, String> {
    let mut line = String::new();
    let bytes = reader
        .read_line(&mut line)
        .map_err(|e| format!("helper protocol read failed: {e}"))?;
    if bytes == 0 || bytes > 1_048_576 {
        return Err("helper protocol closed or oversized".into());
    }
    serde_json::from_str(&line).map_err(|e| format!("invalid worker-helper message: {e}"))
}

pub fn execute_supervised_script(
    authority: &mut RelayAuthority,
    claim: &ScriptClaim,
    spec: &WorkerSpec,
    evidence: &Path,
    helper: &Path,
    stopped: Arc<AtomicBool>,
) -> Result<NativeScriptResult, String> {
    if !helper.is_absolute() || !helper.is_file() {
        return Err("absolute relay-worker-helper executable required".into());
    }
    if evidence.exists() {
        return Err("stale worker evidence must not exist before launch".into());
    }
    let at = after_time(&claim.claimed_at)?;
    authority.begin_script_launch(claim, &at)?;
    let mut child = Command::new(helper)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("helper spawn failed: {e}"))?;
    let input = Arc::new(Mutex::new(
        child.stdin.take().ok_or("missing helper stdin")?,
    ));
    let input_monitor = Arc::clone(&input);
    let finishing = Arc::new(AtomicBool::new(false));
    let monitor_finished = Arc::clone(&finishing);
    let monitor = thread::spawn(move || {
        while !monitor_finished.load(Ordering::SeqCst) {
            if stopped.load(Ordering::SeqCst) {
                if let Ok(mut writer) = input_monitor.lock() {
                    let _ = writeln!(writer, "cancel");
                    let _ = writer.flush();
                }
                break;
            }
            thread::sleep(Duration::from_millis(25));
        }
    });
    let output = child.stdout.take().ok_or("missing helper stdout")?;
    let mut reader = BufReader::new(output);
    let spec_config = json!({
        "parentPid":std::process::id(),"executable":spec.executable,"args":spec.args,
        "cwd":spec.cwd,"env":spec.env,"stdout":spec.stdout,"stderr":spec.stderr,
        "timeoutMs":u64::try_from(spec.timeout.as_millis()).map_err(|_|"Worker timeout overflow")?,
        "terminateGraceMs":u64::try_from(spec.terminate_grace.as_millis()).map_err(|_|"Worker grace overflow")?
    });
    let output_result = (|| -> Result<NativeScriptResult, String> {
        {
            let mut writer = input.lock().map_err(|_| "helper input mutex poisoned")?;
            writeln!(writer, "{spec_config}").map_err(|e| e.to_string())?;
            writer.flush().map_err(|e| e.to_string())?;
        }
        let started = message(&mut reader)?;
        if started["type"] != "started" {
            return Err(format!("worker helper failed before start: {started}"));
        }
        let pid = started["pid"]
            .as_u64()
            .and_then(|v| u32::try_from(v).ok())
            .ok_or("worker-helper started event lacks PID")?;
        let started_at = after_time(&at)?;
        let record = exact_process(pid, claim, &started_at)?;
        authority.record_process(&record)?;
        let graph = Graph::parse(include_str!("../../workflow/task-lifecycle.mmd"))?;
        let lifecycle = TaskLifecycle::new(&graph);
        lifecycle.apply(
            authority,
            TaskTransition {
                job_id: &claim.job_id,
                task_id: &claim.task_id,
                input: task_input(
                    &claim.task_id,
                    &claim.execution_id,
                    &claim.owner,
                    claim.attempt,
                    "task.started",
                ),
                guard_facts: &HashMap::new(),
                at: &started_at,
                events: vec![],
            },
        )?;
        {
            let mut writer = input.lock().map_err(|_| "helper input mutex poisoned")?;
            writeln!(writer, "ack").map_err(|e| e.to_string())?;
            writer.flush().map_err(|e| e.to_string())?;
        }
        let finished = message(&mut reader)?;
        if finished["type"] != "finished" {
            return Err(format!("worker helper error after start: {finished}"));
        }
        let worker: WorkerResult = serde_json::from_value(finished["result"].clone())
            .map_err(|e| format!("bad helper WorkerResult: {e}"))?;
        if worker.pid != pid {
            return Err("helper Worker PID changed during execution".into());
        }
        let finished_at = after_time(&started_at)?;
        let verified_at = after_time(&finished_at)?;
        finish_script_worker(
            authority,
            claim,
            &worker,
            evidence,
            &finished_at,
            &verified_at,
        )
    })();
    finishing.store(true, Ordering::SeqCst);
    let _ = monitor.join();
    if output_result.is_err() {
        if let Ok(mut writer) = input.lock() {
            let _ = writeln!(writer, "cancel");
            let _ = writer.flush();
        }
    }
    drop(input); // EOF also requests cancellation on helper-side input thread
    let wait_result = child.wait().map_err(|e| e.to_string());
    match (output_result, wait_result) {
        (Ok(result), Ok(status)) if status.success() => Ok(result),
        (Ok(_), Ok(status)) => Err(format!("worker-helper exited after receipt with {status}")),
        (Err(error), _) => Err(error),
        (_, Err(error)) => Err(error),
    }
}
