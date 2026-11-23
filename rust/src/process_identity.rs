// Direct port of Node src/process-identity.ts: ps-based generation identity, local lease detection and guarded orphan-group termination.
use crate::local_merge_lock::{hostname, iso8601_now};
use regex::Regex;
use serde_json::{json, Value};
use std::{
    io::Read,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

/// Return the result of a bounded `ps` query; an unresponsive or malformed
/// process inspection must fail closed instead of inventing an identity.
fn ps_stdout(args: &[&str], max_buffer: usize) -> Option<String> {
    let mut child = Command::new("ps")
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if started.elapsed() >= Duration::from_millis(1500) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    if !status.success() {
        return None;
    }
    let mut output = Vec::new();
    child.stdout.take()?.read_to_end(&mut output).ok()?;
    if output.len() > max_buffer {
        return None;
    }
    Some(String::from_utf8_lossy(&output).into_owned())
}

pub fn observe_process(pid: i64) -> Option<Value> {
    if pid < 2 || pid > i32::MAX as i64 {
        return None;
    }
    let id = pid.to_string();
    let stdout = ps_stdout(&["-p", &id, "-o", "pgid=", "-o", "lstart="], 2048)?;
    let cleaned = stdout.trim();
    let expression = Regex::new(r"^(\d+)\s+(.+)$").expect("constant ps regex");
    let captures = expression.captures(cleaned)?;
    let pgid = captures.get(1)?.as_str().parse::<i64>().ok()?;
    if pgid <= 0 {
        return None;
    }
    Some(json!({"pgid":pgid,"startToken":captures.get(2)?.as_str().trim()}))
}

pub fn capture_process_record(
    job_id: &str,
    task_id: &str,
    execution_id: &str,
    pid: i64,
) -> Option<Value> {
    let observed = observe_process(pid)?;
    if observed["pgid"].as_i64() != Some(pid) {
        return None;
    }
    Some(
        json!({"jobId":job_id,"taskId":task_id,"executionId":execution_id,
        "host":hostname().ok()?,"pid":pid,"pgid":pid,
        "startToken":observed["startToken"],"observedAt":iso8601_now()}),
    )
}

fn process_probe_fallback(pid: i64) -> &'static str {
    // Node process.kill(pid, 0) observes without sending a signal.
    // Out-of-range input is unknown, never an ESRCH/gone generation.
    if i32::try_from(pid).is_err() {
        return "unknown";
    }
    let outcome = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if outcome == 0 {
        return "unknown";
    }
    if std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
        "gone"
    } else {
        "unknown"
    }
}

pub fn probe_process_record(record: &Value) -> &'static str {
    let Ok(local_host) = hostname() else {
        return "unknown";
    };
    let Some(pid) = record["pid"].as_i64() else {
        return "unknown";
    };
    if record["host"].as_str() != Some(&local_host)
        || record["startToken"].as_str().is_none_or(str::is_empty)
        || record["pgid"].as_i64() != Some(pid)
    {
        return "unknown";
    }
    if let Some(current) = observe_process(pid) {
        if current["pgid"] == record["pgid"] && current["startToken"] == record["startToken"] {
            "alive"
        } else {
            "reused"
        }
    } else {
        process_probe_fallback(pid)
    }
}

/// A native daemon's PID must be confirmed absent before recovering its
/// unexpired Script leases. PID reuse and unknown OS responses fail closed.
/// This never marks an arbitrary provider or browser session as safe to retry.
pub fn dead_native_relay_owner(owner: &str) -> bool {
    let Some(pid_text) = owner.strip_prefix("isolated-rust-daemon-")
        .or_else(|| owner.strip_prefix("live-rust-daemon-")) else { return false; };
    let Ok(pid) = pid_text.parse::<i32>() else { return false; };
    if pid < 2 { return false; }
    if unsafe { libc::kill(pid, 0) } == 0 { return false; }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

pub fn active_relay_lease_owner(owner: &str) -> bool {
    let re = Regex::new(r"^relayd-(\d+)$").expect("constant lease regex");
    let Some(captures) = re.captures(owner) else {
        return false;
    };
    let Some(pid) = captures.get(1).and_then(|m| m.as_str().parse::<u64>().ok()) else {
        return false;
    };
    if pid <= 1 {
        return false;
    }
    let Some(stdout) = ps_stdout(&["-p", &pid.to_string(), "-o", "command="], 4096) else {
        return false;
    };
    let relay_name = Regex::new(r"\bagents-relayd\b|(?:^|/)relayd(?:-main)?\.js(?:\s|$)")
        .expect("constant relay name regex");
    relay_name.is_match(&stdout)
}

pub fn stop_orphaned_process_group(record: &Value, grace: Duration) -> bool {
    let mut state = probe_process_record(record);
    if state == "gone" || state == "reused" {
        return true;
    }
    if state != "alive" {
        return false;
    }
    let Some(pgid) = record["pgid"]
        .as_i64()
        .filter(|pid| *pid >= 2 && *pid <= i32::MAX as i64)
    else {
        return false;
    };
    if !signal_group(pgid, libc::SIGTERM) {
        return false;
    }
    std::thread::sleep(grace);
    state = probe_process_record(record);
    if state == "gone" || state == "reused" {
        return true;
    }
    if state != "alive" {
        return false;
    }
    if !signal_group(pgid, libc::SIGKILL) {
        return false;
    }
    std::thread::sleep(Duration::from_millis(100));
    state = probe_process_record(record);
    state == "gone" || state == "reused"
}

fn signal_group(pgid: i64, signal: libc::c_int) -> bool {
    // Negative PID signals are only reached after host, generation token,
    // and PID==PGID validation by probe_process_record above.
    let result = unsafe { libc::kill(-(pgid as libc::pid_t), signal) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}
