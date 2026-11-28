//! Execution report bridge. Gateway owns remote authentication. Neo owns report construction and
//! harness-specific parsing. No browser-supplied paths or shell commands.
use crate::dashboard::{DashboardRequest, DashboardResponse};
use crate::owned_process::{OwnedProcessManager, OwnedProcessOptions, TerminationReason};
use serde_json::{json, Value};
use std::{
    io::Read,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

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
// A request-intent header prevents ordinary cross-site forms from generating
// reports. Remote authentication belongs to the Gateway, not this handler.
pub fn report_request(req: &DashboardRequest<'_>) -> bool {
    req.headers.get("x-relay-report").map(String::as_str) == Some("1")
        && !req
            .headers
            .get("sec-fetch-site")
            .is_some_and(|v| !matches!(v.as_str(), "same-origin" | "none"))
}
fn numeric(v: &str) -> bool {
    !v.is_empty() && v.len() <= 20 && v.bytes().all(|b| b.is_ascii_digit())
}
pub fn handle(req: &DashboardRequest<'_>, job: &Value, task: Option<&str>) -> DashboardResponse {
    if !report_request(req) {
        return error(403, "Report request intent required");
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
    let now = chrono::Utc::now();
    let updated_at = cacheable_updated_at(job, task);
    let result = open_report(req.method, updated_at, now, |mode| {
        run_report(id, repo, task, mode)
    });
    match result {
        Ok((v, cached)) => response(
            200,
            json!({"jobId":id,"taskId":task,"capturedAt":v["capturedAt"],"html":v["html"],"cached":cached}),
        ),
        Err(e) => e,
    }
}

const REPORT_REUSE_DAYS: i64 = 7;

// Running work can append trace records without a durable state update.
// Reuse only settled Job/Task scopes; active reports are always current.
fn cacheable_updated_at<'a>(job: &'a Value, task: Option<&str>) -> Option<&'a str> {
    let (scope, terminal) = match task {
        Some(id) => {
            let row = job["tasks"]
                .as_array()?
                .iter()
                .find(|row| row["id"] == id)?;
            (
                row,
                matches!(
                    row["state"].as_str(),
                    Some("SUCCEEDED" | "FAILED" | "CANCELLED" | "SKIPPED")
                ),
            )
        }
        None => (
            job,
            matches!(
                job["state"].as_str(),
                Some("COMPLETED" | "FAILED" | "CANCELLED")
            ),
        ),
    };
    if terminal {
        scope["updatedAt"].as_str()
    } else {
        None
    }
}

fn reusable_report(
    report: &Value,
    updated_at: Option<&str>,
    now: chrono::DateTime<chrono::Utc>,
) -> bool {
    let Some(captured) = report["capturedAt"]
        .as_str()
        .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
    else {
        return false;
    };
    let Some(updated) = updated_at.and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
    else {
        return false;
    };
    let age = now.signed_duration_since(captured);
    age >= chrono::Duration::zero()
        && age < chrono::Duration::days(REPORT_REUSE_DAYS)
        && captured >= updated
}

// The durable Neo Eval report store remains the sole report cache. GET retains
// its existing latest-only semantics; POST reuses fresh snapshots or generates.
fn open_report(
    method: &str,
    updated_at: Option<&str>,
    now: chrono::DateTime<chrono::Utc>,
    mut run: impl FnMut(&str) -> Result<Value, DashboardResponse>,
) -> Result<(Value, bool), DashboardResponse> {
    if method == "POST" && updated_at.is_none() {
        return run("generate").map(|v| (v, false));
    }
    match run("latest") {
        Ok(v) if method == "GET" || reusable_report(&v, updated_at, now) => return Ok((v, true)),
        Err(e) if method == "GET" || e.status != 404 => return Err(e),
        _ => {}
    }
    run("generate").map(|v| (v, false))
}

fn run_report(
    id: &str,
    repo: &str,
    task: Option<&str>,
    mode: &str,
) -> Result<Value, DashboardResponse> {
    let exe = std::env::var_os("NEO_REPORT_EXECUTABLE").unwrap_or_else(|| "neo".into());
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
        return Err(error(503, "Owned Neo Report CLI unavailable on this host"));
    };
    let Some(out) = process.take_stdout() else {
        process.terminate(TerminationReason::Abort, Some(0));
        return Err(error(502, "Report CLI output unavailable"));
    };
    let Some(err) = process.take_stderr() else {
        process.terminate(TerminationReason::Abort, Some(0));
        return Err(error(502, "Report CLI stderr unavailable"));
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
                return Err(error(
                    503,
                    "Owned Neo Report CLI timed out or could not be monitored",
                ));
            }
        }
    };
    let Ok(Ok((bytes, overflow))) = stdout.join() else {
        process.terminate(TerminationReason::Abort, Some(0));
        let _ = stderr.join();
        return Err(error(502, "Report CLI read failed"));
    };
    let Ok(Ok((_, stderr_large))) = stderr.join() else {
        return Err(error(502, "Report CLI stderr read failed"));
    };
    if overflow || stderr_large {
        return Err(error(413, "Report CLI output exceeded safety limit"));
    }
    if !status.success() {
        return Err(error(
            if mode == "latest" { 404 } else { 502 },
            if mode == "latest" {
                "No saved report found, or Report CLI unavailable; generate first"
            } else {
                "Report generation failed; inspect local Neo Eval CLI"
            },
        ));
    }
    if bytes.len() > 32 * 1024 * 1024 {
        return Err(error(413, "Report exceeds Viewer response limit"));
    }
    let Ok(v) = serde_json::from_slice::<Value>(&bytes) else {
        return Err(error(502, "Invalid Report CLI receipt"));
    };
    if v["jobId"] != id
        || v["repository"] != repo
        || v["selection"]["taskId"] != json!(task)
        || !v["selection"]["executionId"].is_null()
        || !v["html"].is_string()
    {
        return Err(error(502, "Report receipt scope mismatch"));
    }
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn report_reuse_checks_capture_age_and_scope_update() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-11-27T12:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        let fresh = json!({"capturedAt":"2026-11-26T12:00:00Z"});
        assert!(reusable_report(&fresh, Some("2026-11-26T11:00:00Z"), now));
        assert!(!reusable_report(&fresh, Some("2026-11-26T13:00:00Z"), now));
        assert!(!reusable_report(&fresh, None, now));
        assert!(!reusable_report(&fresh, Some("invalid"), now));
        for captured in ["2026-11-20T12:00:00Z", "2026-11-28T12:00:00Z", "invalid"] {
            assert!(!reusable_report(
                &json!({"capturedAt":captured}),
                Some("2026-11-19T12:00:00Z"),
                now
            ));
        }
        assert!(!reusable_report(
            &json!({}),
            Some("2026-11-19T12:00:00Z"),
            now
        ));
    }

    #[test]
    fn report_cache_respects_job_and_task_lifecycle() {
        let mut job = json!({"state":"ACTIVE","updatedAt":"job-update","tasks":[
            {"id":"1","state":"SUCCEEDED","updatedAt":"task-update"},
            {"id":"2","state":"RUNNING","updatedAt":"running-update"}
        ]});
        assert_eq!(cacheable_updated_at(&job, None), None);
        assert_eq!(cacheable_updated_at(&job, Some("1")), Some("task-update"));
        assert_eq!(cacheable_updated_at(&job, Some("2")), None);
        assert_eq!(cacheable_updated_at(&job, Some("unknown")), None);
        job["state"] = json!("COMPLETED");
        assert_eq!(cacheable_updated_at(&job, None), Some("job-update"));
        job["tasks"][0]["state"] = json!("QUEUED");
        assert_eq!(cacheable_updated_at(&job, Some("1")), None);
    }

    #[test]
    fn open_report_reuses_only_fresh_saved_receipt() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-11-27T12:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        let updated = Some("2026-11-25T12:00:00Z");
        let fresh = json!({"capturedAt":"2026-11-26T12:00:00Z"});
        let old = json!({"capturedAt":"2026-11-19T12:00:00Z"});
        for (method, update, saved, modes, cached) in [
            ("POST", updated, Some(fresh.clone()), vec!["latest"], true),
            (
                "POST",
                updated,
                Some(old.clone()),
                vec!["latest", "generate"],
                false,
            ),
            ("POST", updated, None, vec!["latest", "generate"], false),
            ("POST", None, Some(fresh.clone()), vec!["generate"], false),
            ("GET", updated, Some(old), vec!["latest"], true),
        ] {
            let mut calls = vec![];
            let result = open_report(method, update, now, |mode| {
                calls.push(mode.to_owned());
                if mode == "generate" {
                    Ok(json!({"capturedAt":"2026-11-27T12:00:00Z"}))
                } else {
                    saved.clone().ok_or_else(|| error(404, "missing"))
                }
            });
            assert_eq!(calls, modes);
            assert_eq!(result.ok().map(|(_, cached)| cached), Some(cached));
        }
        let mut calls = vec![];
        let result = open_report("POST", updated, now, |mode| {
            calls.push(mode.to_owned());
            Err(error(502, "scope mismatch"))
        });
        assert_eq!(calls, vec!["latest"]);
        assert_eq!(result.err().map(|e| e.status), Some(502));
    }

    #[test]
    fn report_intent_is_independent_of_host() {
        let mut headers = std::collections::HashMap::from([
            ("host".into(), "remote.example".into()),
            ("x-relay-report".into(), "1".into()),
            ("x-forwarded-proto".into(), "https".into()),
            ("sec-fetch-site".into(), "same-origin".into()),
        ]);
        fn ok(h: &std::collections::HashMap<String, String>) -> bool {
            report_request(&DashboardRequest {
                method: "POST",
                target: "/api/execution-report",
                body: &[],
                headers: h,
            })
        }
        assert!(ok(&headers));
        headers.insert("host".into(), "127.0.0.1:1234".into());
        assert!(ok(&headers));
        headers.insert("sec-fetch-site".into(), "cross-site".into());
        assert!(!ok(&headers));
        headers.remove("sec-fetch-site");
        headers.remove("x-relay-report");
        assert!(!ok(&headers));
    }
}
