//! Original Dashboard event-history source separation.
//! Legacy Jobs use the Events Bus history HTTP API; Rust-native Jobs only
//! expose their own durable inbox/outbox and verified process ledger. Job IDs
//! overlap across those two stores, so a global merged event feed is unsafe.
use agents_relay_rust::store::RelayReader;
use rusqlite::{params, Connection, OpenFlags};
use serde_json::{json, Value};
use std::path::Path;
use std::process::Command;

fn local_events_bus_base() -> Result<String, String> {
    let raw = if let Ok(url) = std::env::var("EVENTS_BUS_API_URL") {
        url
    } else {
        let config = std::env::var("EVENTS_BUS_CONFIG")
            .ok()
            .map(std::path::PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME").map(|home| {
                    std::path::PathBuf::from(home)
                        .join("Library/Application Support/EventsBus/runtime.json")
                })
            })
            .ok_or("Events Bus runtime config is unavailable")?;
        let bytes =
            std::fs::read(&config).map_err(|e| format!("Events Bus runtime config: {e}"))?;
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|e| format!("Events Bus config JSON: {e}"))?;
        value["apiUrl"]
            .as_str()
            .ok_or("Events Bus config is missing apiUrl")?
            .to_string()
    };
    // The Dashboard does not proxy arbitrary URLs supplied by the browser or
    // any remote destination: the history API is a local service only.
    validate_local_events_bus(&raw)
}

fn validate_local_events_bus(raw: &str) -> Result<String, String> {
    let authority = raw
        .strip_prefix("http://127.0.0.1:")
        .or_else(|| raw.strip_prefix("http://localhost:"))
        .ok_or("Events Bus API must use loopback HTTP")?;
    let port: u16 = authority
        .parse()
        .map_err(|_| "Events Bus port is invalid")?;
    if port == 0 {
        return Err("Events Bus port must be nonzero".into());
    }
    Ok(format!("http://127.0.0.1:{port}"))
}

pub fn historical(job_id: &str, task_id: Option<&str>, limit: usize) -> Result<Value, String> {
    let url = format!("{}/events", local_events_bus_base()?);
    let mut cmd = Command::new("/usr/bin/curl");
    cmd.args([
        "--silent",
        "--show-error",
        "--fail",
        "--max-time",
        "3",
        "--get",
        "--data-urlencode",
    ])
    .arg(format!("job={job_id}"))
    .args(["--data-urlencode", "order=desc", "--data-urlencode"])
    .arg(format!("limit={limit}"));
    if let Some(task_id) = task_id {
        cmd.arg("--data-urlencode").arg(format!("task={task_id}"));
    }
    let result = cmd
        .arg(url)
        .output()
        .map_err(|e| format!("Events Bus request: {e}"))?;
    if !result.status.success() {
        return Err(format!(
            "Events Bus history unavailable (curl exit {:?})",
            result.status.code()
        ));
    }
    if result.stdout.len() > 2_000_000 {
        return Err("Events Bus response exceeds limit".into());
    }
    let page: Value =
        serde_json::from_slice(&result.stdout).map_err(|e| format!("Events Bus JSON: {e}"))?;
    if page["job_id"].as_str() != Some(job_id) || page["order"].as_str() != Some("desc") {
        return Err("Events Bus response has incorrect Job identity or order".into());
    }
    let rows = page["events"]
        .as_array()
        .ok_or("Events Bus response has no event list")?;
    if rows.len() > limit {
        return Err("Events Bus event limit exceeded".into());
    }
    let mut events = Vec::with_capacity(rows.len());
    let mut previous_cursor = i64::MAX;
    for row in rows {
        let cursor = row["cursor"]
            .as_i64()
            .filter(|cursor| *cursor > 0)
            .ok_or("Events Bus event cursor is invalid")?;
        let event = row
            .get("event")
            .filter(|event| event.is_object())
            .ok_or("Events Bus record is invalid")?;
        if cursor >= previous_cursor
            || event["job_id"].as_str() != Some(job_id)
            || task_id.is_some_and(|id| event["task_id"].as_str() != Some(id))
        {
            return Err("Events Bus response contains mixed or out-of-order events".into());
        }
        previous_cursor = cursor;
        events.push(event.clone());
    }
    Ok(Value::Array(events))
}

pub fn native(
    db: &Path,
    reader: &RelayReader,
    job_id: &str,
    task_id: Option<&str>,
    limit: usize,
) -> Result<Value, String> {
    let mut events = reader
        .task_events(job_id, task_id, limit, "desc", 0)?
        .events;
    let conn = Connection::open_with_flags(
        db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("Rust execution ledger: {e}"))?;
    let exists: i64 = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='execution_process')",
        [], |row| row.get(0)).map_err(|e| e.to_string())?;
    if exists != 0 {
        let mut stmt = conn
            .prepare(
                "SELECT task_id,execution_id,observed_at,ended_at FROM execution_process \
             WHERE job_id=?1 AND (?2 IS NULL OR task_id=?2) ORDER BY observed_at DESC LIMIT ?3",
            )
            .map_err(|e| e.to_string())?;
        let records = stmt
            .query_map(params![job_id, task_id, limit as i64], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for record in records {
            let (task, execution, observed, ended) = record.map_err(|e| e.to_string())?;
            // Ledger facts are intentionally identified as derived observations,
            // never misrepresented as published task.started / task.progress.
            for (suffix, time, label) in [
                (
                    "observed",
                    Some(observed.as_str()),
                    "Native worker process observed",
                ),
                (
                    "ended",
                    ended.as_deref(),
                    "Native worker process exit observed",
                ),
            ] {
                if let Some(timestamp) = time {
                    events.push(json!({
                        "version":1,"event_id":format!("rust-ledger:{job_id}:{task}:{execution}:{suffix}"),
                        "job_id":job_id,"task_id":task,
                        "type":format!("task.process.{suffix}"),"timestamp":timestamp,
                        "visibility":"orchestrator","level":"info","message":label,
                        "source":{"agent":"rust-native","component":"verified-execution-ledger"}
                    }));
                }
            }
        }
    }
    events.sort_by(|a, b| {
        b["timestamp"]
            .as_str()
            .cmp(&a["timestamp"].as_str())
            .then_with(|| b["event_id"].as_str().cmp(&a["event_id"].as_str()))
    });
    events.truncate(limit);
    Ok(Value::Array(events))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_non_loopback_history_destinations() {
        for address in [
            "https://example.com",
            "http://192.168.1.3:4223",
            "http://127.0.0.1:4223/more",
            "http://127.0.0.1:0",
        ] {
            assert!(validate_local_events_bus(address).is_err(), "{address}");
        }
        assert_eq!(
            validate_local_events_bus("http://localhost:4223").unwrap(),
            "http://127.0.0.1:4223"
        );
    }
}
