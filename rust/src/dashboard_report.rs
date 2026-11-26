//! Private localhost JEL report bridge. Neo owns report construction and
//! harness-specific parsing. No browser-supplied paths or shell commands.
use crate::dashboard::{DashboardRequest, DashboardResponse};
use crate::owned_process::{OwnedProcessManager, OwnedProcessOptions, TerminationReason};
use serde_json::{json, Value};
use std::{
    io::Read,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use url::Url;

fn response(status: u16, v: Value) -> DashboardResponse {
    DashboardResponse::new(
        status,
        "application/json",
        "no-store",
        v.to_string().into_bytes(),
    )
}
fn error(status: u16, msg: &str) -> DashboardResponse {
    response(status, json!({"error":msg}))
}
pub fn private_request(req: &DashboardRequest<'_>) -> bool {
    // The detailed report contains private trace material. The normal
    // dashboard's remote/proxy access is not proof of trace authorization.
    let Some(host) = req.headers.get("host") else {
        return false;
    };
    let Ok(origin) = Url::parse(&format!("http://{host}")) else {
        return false;
    };
    if !matches!(origin.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
        || !origin.username().is_empty()
        || origin.password().is_some()
        || origin.path() != "/"
        || origin.query().is_some()
        || origin.fragment().is_some()
    {
        return false;
    }
    if req.headers.get("x-relay-report").map(String::as_str) != Some("1") {
        return false;
    }
    if req.headers.keys().any(|k| {
        matches!(
            k.as_str(),
            "forwarded"
                | "x-forwarded-host"
                | "x-forwarded-for"
                | "x-forwarded-proto"
                | "cf-connecting-ip"
                | "cf-ray"
        )
    }) {
        return false;
    }
    if req
        .headers
        .get("sec-fetch-site")
        .is_some_and(|v| !matches!(v.as_str(), "same-origin" | "none"))
    {
        return false;
    }
    if let Some(o) = req.headers.get("origin") {
        if o != &origin.origin().ascii_serialization() {
            return false;
        }
    }
    true
}
fn numeric(v: &str) -> bool {
    !v.is_empty() && v.len() <= 20 && v.bytes().all(|b| b.is_ascii_digit())
}
pub fn handle(req: &DashboardRequest<'_>, job: &Value, task: Option<&str>) -> DashboardResponse {
    if !private_request(req) {
        return error(
            403,
            "Detailed execution reports require the local JEL Viewer",
        );
    }
    if !matches!(req.method, "GET" | "POST") {
        return error(405, "Method not allowed");
    }
    let id = job["id"].as_str().unwrap_or("");
    let repo = job["repository"].as_str().unwrap_or("");
    if !numeric(id) || repo.is_empty() || repo.starts_with('-') || repo.len() > 512 {
        return error(400, "Invalid report scope");
    }
    if let Some(t) = task {
        if !numeric(t)
            || !job["tasks"]
                .as_array()
                .is_some_and(|rows| rows.iter().any(|r| r["id"] == t))
        {
            return error(404, "Task not found in selected Job");
        }
    }
    // Prevent multiple expensive trace scans from piling up. This lock is
    // separate from the daemon's lifecycle locks.
    static GATE: OnceLock<Mutex<()>> = OnceLock::new();
    let Ok(_guard) = GATE.get_or_init(|| Mutex::new(())).try_lock() else {
        return error(409, "Another execution report is being opened or generated");
    };
    let exe = std::env::var_os("NEO_REPORT_EXECUTABLE").unwrap_or_else(|| "neo".into());
    let mode = if req.method == "POST" {
        "generate"
    } else {
        "latest"
    };
    let mut arguments = vec![
        "eval", "report", "--job-id", id, "--repo", repo, "--mode", mode, "--format", "viewer",
    ];
    if let Some(t) = task {
        arguments.extend(["--task-id", t]);
    }
    let mut owned = OwnedProcessManager::default();
    let executable = exe.to_string_lossy();
    let launched = owned.spawn_owned_process_piped(
        &executable,
        &arguments,
        OwnedProcessOptions {
            invocation: "jel-viewer-execution-report".into(),
            timeout_ms: Some(120_000),
            grace_ms: 250,
            ..OwnedProcessOptions::default()
        },
    );
    let Ok(process) = launched else {
        return error(503, "Owned Neo Report CLI unavailable on this host");
    };
    let Some(out) = process.take_stdout() else {
        process.terminate(TerminationReason::Abort, Some(0));
        return error(502, "Report CLI output unavailable");
    };
    let Some(err) = process.take_stderr() else {
        process.terminate(TerminationReason::Abort, Some(0));
        return error(502, "Report CLI stderr unavailable");
    };
    // Drain both pipes concurrently, retaining bounded bytes. The process
    // group remains owned until the captured receipt is validated.
    fn bounded<R: Read>(mut input: R, max: usize) -> std::io::Result<(Vec<u8>, bool)> {
        let mut data = Vec::new();
        let mut overflow = false;
        let mut block = [0u8; 8192];
        loop {
            let count = input.read(&mut block)?;
            if count == 0 {
                break;
            }
            if count > max.saturating_sub(data.len()) {
                overflow = true;
            } else {
                data.extend_from_slice(&block[..count]);
            }
        }
        Ok((data, overflow))
    }
    let stdout = std::thread::spawn(move || bounded(out, 32 * 1024 * 1024));
    let stderr = std::thread::spawn(move || bounded(err, 64 * 1024));
    let started = Instant::now();
    let status = loop {
        match process.exit_status() {
            Ok(Some(code)) => break code,
            Ok(None) if started.elapsed() < Duration::from_secs(120) => {
                std::thread::sleep(Duration::from_millis(50))
            }
            _ => {
                process.terminate(TerminationReason::Timeout, Some(0));
                let _ = stdout.join();
                let _ = stderr.join();
                return error(
                    503,
                    "Owned Neo Report CLI timed out or could not be monitored",
                );
            }
        }
    };
    let Ok(Ok((bytes, overflow))) = stdout.join() else {
        process.terminate(TerminationReason::Abort, Some(0));
        let _ = stderr.join();
        return error(502, "Report CLI read failed");
    };
    let Ok(Ok((_, stderr_large))) = stderr.join() else {
        return error(502, "Report CLI stderr read failed");
    };
    if overflow || stderr_large {
        return error(413, "Report CLI output exceeded safety limit");
    }
    if !status.success() {
        return error(
            if mode == "latest" { 404 } else { 502 },
            if mode == "latest" {
                "No saved report found, or Report CLI unavailable; generate first"
            } else {
                "Report generation failed; inspect local Neo Eval CLI"
            },
        );
    }
    if bytes.len() > 32 * 1024 * 1024 {
        return error(413, "Report exceeds Viewer response limit");
    }
    let Ok(v) = serde_json::from_slice::<Value>(&bytes) else {
        return error(502, "Invalid Report CLI receipt");
    };
    if v["jobId"] != id
        || v["repository"] != repo
        || v["selection"]["taskId"] != json!(task)
        || !v["selection"]["executionId"].is_null()
        || !v["html"].is_string()
    {
        return error(502, "Report receipt scope mismatch");
    }
    response(
        200,
        json!({"jobId":id,"taskId":task,"capturedAt":v["capturedAt"],"html":v["html"]}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_private_origin_only() {
        let mut headers = std::collections::HashMap::from([
            ("host".into(), "127.0.0.1:1234".into()),
            ("x-relay-report".into(), "1".into()),
            ("origin".into(), "http://127.0.0.1:1234".into()),
        ]);
        fn ok(h: &std::collections::HashMap<String, String>) -> bool {
            private_request(&DashboardRequest {
                method: "POST",
                target: "/api/execution-report",
                body: &[],
                headers: h,
            })
        }
        assert!(ok(&headers));
        headers.insert("origin".into(), "https://evil.example".into());
        assert!(!ok(&headers));
        headers.remove("origin");
        headers.insert("x-forwarded-for".into(), "127.0.0.1".into());
        assert!(!ok(&headers));
        headers.remove("x-forwarded-for");
        headers.insert("host".into(), "remote.example".into());
        assert!(!ok(&headers));
    }
}
