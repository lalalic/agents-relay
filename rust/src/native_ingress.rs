//! Configured Core NATS ingress for correlated native Worker terminal events.
//! SQLite plus the canonical Task Graph remain the only lifecycle authority.
use crate::authority::{ActionOutcome, RelayAuthority, ScriptClaim, WorkflowEvent};
use crate::graph::{Graph, GraphInput};
use crate::lifecycle::{TaskLifecycle, TaskTransition};
use crate::supervised_script::current_time;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

const MAX_EVENT_BYTES: usize = 65_536;

/// Parse and apply one Events Bus envelope at the concrete native ingress.
/// Rejections leave both the Task snapshot and durable inbox unchanged.
pub fn ingest_worker_terminal_event(
    authority: &mut RelayAuthority,
    bytes: &[u8],
    at: &str,
) -> Result<bool, String> {
    if bytes.is_empty() || bytes.len() > MAX_EVENT_BYTES {
        return Err("native ingress event must be 1..65536 bytes".into());
    }
    let event: Value =
        serde_json::from_slice(bytes).map_err(|e| format!("invalid event JSON: {e}"))?;
    let kind = event["type"].as_str().ok_or("event type missing")?;
    if !matches!(kind, "task.completed" | "task.failed") {
        return Ok(false);
    }
    let job_id = event["job_id"].as_str().ok_or("event Job ID missing")?;
    let task_id = event["task_id"].as_str().ok_or("event Task ID missing")?;
    let execution_id = event
        .pointer("/source/id")
        .and_then(Value::as_str)
        .ok_or("event execution source missing")?;
    let expected_source = format!(
        "job/{job_id}/task/{task_id}/execution/{}",
        event
            .pointer("/data/executionId")
            .and_then(Value::as_str)
            .ok_or("event execution ID missing")?
    );
    if execution_id != expected_source || !event_id(job_id) || !event_id(task_id) {
        return Err("event source does not match its Job, Task and execution identity".into());
    }
    let data = event
        .get("data")
        .filter(|v| v.is_object())
        .ok_or("terminal event data missing")?;
    let execution_id = data["executionId"]
        .as_str()
        .ok_or("terminal event execution ID missing")?;
    let owner = data["leaseOwner"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("terminal event lease owner missing")?;
    let attempt = data["attempt"]
        .as_i64()
        .filter(|n| *n > 0)
        .ok_or("terminal event attempt missing")?;
    if event
        .get("event_id")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty)
    {
        return Err("terminal event ID missing".into());
    }
    let timestamp =
        chrono::DateTime::parse_from_rfc3339(at).map_err(|_| "invalid ingress timestamp")?;
    let job = authority
        .read_job(job_id)?
        .ok_or("terminal event Job is unknown")?;
    let task = job["tasks"]
        .as_array()
        .and_then(|tasks| tasks.iter().find(|t| t["id"] == task_id))
        .ok_or("terminal event Task is unknown")?;
    let expiry = task["leaseExpiresAt"]
        .as_str()
        .ok_or("current Task lease missing")?;
    let expiry =
        chrono::DateTime::parse_from_rfc3339(expiry).map_err(|_| "invalid current Task lease")?;
    // These are identity and lease facts only. Task state and Job transition
    // eligibility are selected by TaskLifecycle's canonical Graph below.
    if task["executionId"] != execution_id
        || task["leaseOwner"] != owner
        || task["attempt"] != attempt
        || expiry <= timestamp
        || !task["executionHistory"].as_array().is_some_and(|h| {
            h.iter()
                .any(|v| v["id"] == execution_id && v["attempt"] == attempt)
        })
    {
        return Err("terminal event is stale or does not match the current active lease".into());
    }
    let adapter = task["adapter"]
        .as_str()
        .filter(|v| matches!(*v, "script" | "codex"))
        .ok_or("unsupported current Worker adapter")?;
    if data
        .get("adapter")
        .and_then(Value::as_str)
        .is_some_and(|v| v != adapter)
    {
        return Err("terminal event Worker adapter mismatch".into());
    }
    if kind == "task.completed" {
        if data["status"] != "COMPLETED" || !data["output"].is_object() {
            return Err("task.completed requires verified structured COMPLETED output".into());
        }
        let summary = data["summary"].as_str().map(str::trim).unwrap_or("");
        if summary.is_empty() || summary.len() > 2048 {
            return Err("terminal completion summary missing or invalid".into());
        }
        if adapter == "codex"
            && (data.get("routing") != task.get("routing")
                || data.get("workerSelection") != task.get("workerSelection"))
        {
            return Err("Model terminal event does not match the durable route".into());
        }
    } else {
        let reason = data["reason"].as_str().map(str::trim).unwrap_or("");
        let phase = data["phase"].as_str().map(str::trim).unwrap_or("");
        let evidence = data["evidence"].as_str().map(str::trim).unwrap_or("");
        if reason.is_empty()
            || reason.len() > 2048
            || phase.is_empty()
            || phase.len() > 128
            || evidence.is_empty()
            || evidence.len() > 4096
        {
            return Err("task.failed requires phase, reason and evidence".into());
        }
    }
    let attempt_key = format!("{job_id}/{task_id}/{execution_id}/launch");
    let trace = authority
        .action_trace(&attempt_key)?
        .ok_or("current launch Action trace missing")?;
    if trace.execution_id != execution_id
        || trace.generation != attempt
        || trace.graph != "task-lifecycle.mmd"
        || trace.action_id != "effect.launchTask"
        || trace.outcome != ActionOutcome::Unknown
        || trace.observed_at.as_str() >= at
    {
        return Err("terminal event has no fresh matching Graph-selected launch Action".into());
    }
    let claim = ScriptClaim {
        job_id: job_id.into(),
        task_id: task_id.into(),
        execution_id: execution_id.into(),
        owner: owner.into(),
        adapter: adapter.into(),
        routing: task.get("routing").cloned(),
        worker_selection: task.get("workerSelection").cloned(),
        attempt,
        attempt_key,
        claimed_at: task["executionHistory"]
            .as_array()
            .and_then(|h| h.iter().find(|v| v["id"] == execution_id))
            .and_then(|v| v["startedAt"].as_str())
            .unwrap_or(&trace.observed_at)
            .into(),
        lease_expires_at: task["leaseExpiresAt"].as_str().unwrap_or_default().into(),
    };
    let receipt_key = format!("{job_id}/{task_id}/{execution_id}/terminal");
    let reason = if kind == "task.failed" {
        data["reason"].as_str()
    } else {
        Some("verified structured Worker output")
    }
    .unwrap_or("");
    let receipt = WorkflowEvent {
        key: receipt_key.clone(),
        event_id: kind.into(),
        payload: json!({
            "event_id":receipt_key,"type":kind,"jobId":job_id,"taskId":task_id,"executionId":execution_id,
            "leaseOwner":owner,"attempt":attempt,"reason":reason,
            "phase":data.get("phase"),"evidence":data.get("evidence")
        }),
    };
    let result = (kind == "task.completed").then(|| {
        json!({
            "summary":data["summary"],"data":{"status":"COMPLETED","output":data["output"]}
        })
    });
    let graph = Graph::parse(include_str!("../../workflow/task-lifecycle.mmd"))?;
    let lifecycle = TaskLifecycle::new(&graph);
    lifecycle.apply_with_inbound_launch_receipt(authority, TaskTransition {
        job_id, task_id, input: GraphInput { transport:"event".into(), id:kind.into(), payload:json!({
            "jobId":job_id,"taskId":task_id,"executionId":execution_id,"leaseOwner":owner,"attempt":attempt
        })}, guard_facts:&HashMap::new(), at, events:vec![receipt]
    }, result, &claim)?;
    Ok(true)
}

pub fn ingest_nats_worker_terminal_event(
    authority: &mut RelayAuthority,
    subject: &str,
    bytes: &[u8],
    at: &str,
) -> Result<bool, String> {
    if bytes.is_empty() || bytes.len() > MAX_EVENT_BYTES {
        return Err("native ingress event must be 1..65536 bytes".into());
    }
    let event: Value =
        serde_json::from_slice(bytes).map_err(|e| format!("invalid event JSON: {e}"))?;
    let job = event["job_id"].as_str().ok_or("event Job ID missing")?;
    let kind = event["type"].as_str().ok_or("event type missing")?;
    let expected = format!("relay.events.job.{job}.{kind}");
    if subject != expected {
        return Err("NATS subject does not match event Job and type".into());
    }
    ingest_worker_terminal_event(authority, bytes, at)
}

fn event_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && s.bytes().all(|b| b.is_ascii_digit())
}

/// Keep one Core NATS subscription alive while the native daemon is running.
/// The subscription is only an ingress transport; every message is revalidated
/// against the current SQLite lease and canonical Task Graph.
pub fn run_nats_ingress(db: PathBuf, port: u16, stopped: Arc<AtomicBool>) {
    while !stopped.load(Ordering::SeqCst) {
        if let Err(error) = subscribe_once(&db, port, &stopped) {
            if stopped.load(Ordering::SeqCst) {
                break;
            }
            eprintln!("warning: native NATS ingress reconnecting: {error}");
            for _ in 0..10 {
                if stopped.load(Ordering::SeqCst) {
                    break;
                }
                thread::sleep(Duration::from_millis(100));
            }
        }
    }
}

fn subscribe_once(db: &Path, port: u16, stopped: &AtomicBool) -> Result<(), String> {
    if port == 0 {
        return Err("NATS ingress port must be nonzero".into());
    }
    let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    let mut tcp = TcpStream::connect_timeout(&addr.into(), Duration::from_secs(2))
        .map_err(|e| format!("NATS ingress connect: {e}"))?;
    tcp.set_read_timeout(Some(Duration::from_millis(500)))
        .map_err(|e| e.to_string())?;
    tcp.set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(tcp.try_clone().map_err(|e| e.to_string())?);
    let info = read_line(&mut reader, stopped)?;
    let info = info
        .trim()
        .strip_prefix("INFO ")
        .ok_or("NATS ingress INFO missing")?;
    let info: Value =
        serde_json::from_str(info).map_err(|e| format!("NATS ingress INFO invalid: {e}"))?;
    if info["auth_required"] == true || info["tls_required"] == true {
        return Err("NATS ingress requires a configured authenticated transport provider".into());
    }
    tcp.write_all(b"CONNECT {\"verbose\":false,\"pedantic\":true,\"name\":\"relay-rust-native-ingress\"}\r\nSUB relay.events.job.*.task.* 1\r\nPING\r\n").map_err(|e| e.to_string())?;
    tcp.flush().map_err(|e| e.to_string())?;
    loop {
        if stopped.load(Ordering::SeqCst) {
            return Ok(());
        }
        let command = match read_line(&mut reader, stopped) {
            Ok(line) => line,
            Err(e) => return Err(e),
        };
        let command = command.trim_end();
        if command == "PING" {
            tcp.write_all(b"PONG\r\n").map_err(|e| e.to_string())?;
            continue;
        }
        if command == "PONG" || command == "+OK" {
            continue;
        }
        if command.starts_with("-ERR") {
            return Err("NATS rejected ingress subscription".into());
        }
        if command.starts_with("INFO ") {
            continue;
        }
        if !command.starts_with("MSG ") {
            return Err("unexpected NATS ingress protocol frame".into());
        }
        let fields = command.split_ascii_whitespace().collect::<Vec<_>>();
        let subject = *fields.get(1).ok_or("NATS message subject missing")?;
        let size = fields
            .last()
            .ok_or("NATS message size missing")?
            .parse::<usize>()
            .map_err(|_| "invalid NATS message size")?;
        if size == 0 || size > MAX_EVENT_BYTES {
            return Err("NATS worker event exceeds ingress limit".into());
        }
        let mut bytes = vec![0u8; size];
        read_exact(&mut reader, &mut bytes, stopped)
            .map_err(|e| format!("NATS message body: {e}"))?;
        let mut crlf = [0u8; 2];
        read_exact(&mut reader, &mut crlf, stopped)
            .map_err(|e| format!("NATS message terminator: {e}"))?;
        if crlf != *b"\r\n" {
            return Err("invalid NATS message terminator".into());
        }
        match RelayAuthority::open_existing(db).and_then(|mut authority| {
            ingest_nats_worker_terminal_event(&mut authority, subject, &bytes, &current_time())
        }) {
            Ok(true) => {}
            Ok(false) => {}
            Err(error) => eprintln!("warning: native terminal event rejected: {error}"),
        }
    }
}

fn timed_out(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
    )
}

fn read_line(reader: &mut BufReader<TcpStream>, stopped: &AtomicBool) -> Result<String, String> {
    let mut line = String::new();
    let mut limited = reader.take(8193);
    loop {
        match limited.read_line(&mut line) {
            Ok(0) => return Err("NATS ingress closed".into()),
            Ok(_) if line.len() > 8192 => return Err("NATS ingress oversized line".into()),
            Ok(_) => return Ok(line),
            Err(error) if timed_out(&error) && !stopped.load(Ordering::SeqCst) => continue,
            Err(error) if timed_out(&error) => return Err("NATS ingress stopped".into()),
            Err(error) => return Err(format!("NATS ingress read: {error}")),
        }
    }
}

fn read_exact(
    reader: &mut BufReader<TcpStream>,
    bytes: &mut [u8],
    stopped: &AtomicBool,
) -> Result<(), String> {
    let mut offset = 0;
    while offset < bytes.len() {
        match reader.read(&mut bytes[offset..]) {
            Ok(0) => return Err("NATS message ended early".into()),
            Ok(size) => offset += size,
            Err(error) if timed_out(&error) && !stopped.load(Ordering::SeqCst) => continue,
            Err(error) if timed_out(&error) => return Err("NATS ingress stopped".into()),
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authority::{tests::setup, ScriptClaimRequest};

    fn running() -> (tempfile::TempDir, PathBuf, RelayAuthority) {
        let (dir, path) = setup();
        let mut store = RelayAuthority::open_existing(&path).unwrap();
        store
            .commit_job("91", "2026-11-13T20:00:01.000Z", |old| {
                let mut job = old.clone();
                job["updatedAt"] = json!("2026-11-13T20:00:01.000Z");
                let task = &mut job["tasks"][0];
                task["adapter"] = json!("script");
                task["dependencies"] = json!([]);
                task["attempt"] = json!(0);
                task["maxAttempts"] = json!(3);
                task["executionId"] = Value::Null;
                task["leaseOwner"] = Value::Null;
                Ok((job, vec![]))
            })
            .unwrap();
        let claim = store
            .claim_queued_script(&ScriptClaimRequest {
                job_id: "91",
                task_id: "101",
                execution_id: "ingress-exec",
                owner: "isolated",
                at: "2026-11-13T20:00:02.000Z",
                lease_expires_at: "2099-01-01T00:00:00.000Z",
            })
            .unwrap()
            .unwrap();
        store
            .begin_script_launch(&claim, "2026-11-13T20:00:02.500Z")
            .unwrap();
        let graph = Graph::parse(include_str!("../../workflow/task-lifecycle.mmd")).unwrap();
        TaskLifecycle::new(&graph).apply(&mut store, TaskTransition {
            job_id:"91", task_id:"101", input:GraphInput { transport:"event".into(), id:"task.started".into(), payload:json!({"jobId":"91","taskId":"101","executionId":"ingress-exec","leaseOwner":"isolated","attempt":1}) },
            guard_facts:&HashMap::new(), at:"2026-11-13T20:00:03.000Z", events:vec![]
        }).unwrap();
        (dir, path, store)
    }
    fn completed_event() -> Value {
        json!({
            "event_id":"bus-event-1","type":"task.completed","job_id":"91","task_id":"101",
            "source":{"id":"job/91/task/101/execution/ingress-exec"},
            "data":{"executionId":"ingress-exec","leaseOwner":"isolated","attempt":1,"adapter":"script","status":"COMPLETED","summary":"verified result","output":{"artifact":"ok"}}
        })
    }
    fn inbox_count(path: &Path) -> i64 {
        rusqlite::Connection::open(path).unwrap().query_row("SELECT COUNT(*) FROM workflow_event_inbox WHERE consumer_id='rust-worker-terminal'", [], |r| r.get(0)).unwrap()
    }
    fn submit(store: &mut RelayAuthority, event: &Value, at: &str) -> Result<bool, String> {
        ingest_nats_worker_terminal_event(
            store,
            &format!(
                "relay.events.job.{}.{}",
                event["job_id"].as_str().unwrap_or(""),
                event["type"].as_str().unwrap_or("")
            ),
            event.to_string().as_bytes(),
            at,
        )
    }

    #[test]
    fn concrete_ingress_rejects_bad_identity_stale_lease_and_unverified_output_without_mutation() {
        let (_dir, path, mut store) = running();
        let original = store.read_job("91").unwrap().unwrap();
        assert!(ingest_nats_worker_terminal_event(
            &mut store,
            "relay.events.job.92.task.completed",
            &completed_event().to_string().into_bytes(),
            "2026-11-13T20:00:04.000Z"
        )
        .is_err());
        let mut malformed = completed_event();
        malformed["source"]["id"] = json!("bad");
        assert!(submit(&mut store, &malformed, "2026-11-13T20:00:04.000Z").is_err());
        for (field, value) in [("job_id", json!("92")), ("task_id", json!("102"))] {
            let mut bad = completed_event();
            bad[field] = value;
            let job = bad["job_id"].as_str().unwrap();
            let task = bad["task_id"].as_str().unwrap();
            bad["source"]["id"] = json!(format!("job/{job}/task/{task}/execution/ingress-exec"));
            assert!(submit(&mut store, &bad, "2026-11-13T20:00:04.000Z").is_err());
        }
        for (field, value) in [
            ("executionId", json!("old-exec")),
            ("leaseOwner", json!("stale-owner")),
            ("attempt", json!(2)),
        ] {
            let mut bad = completed_event();
            bad["data"][field] = value;
            assert!(submit(&mut store, &bad, "2026-11-13T20:00:04.000Z").is_err());
        }
        let mut missing = completed_event();
        missing["data"].as_object_mut().unwrap().remove("output");
        assert!(submit(&mut store, &missing, "2026-11-13T20:00:04.000Z").is_err());
        assert!(submit(&mut store, &completed_event(), "2100-01-01T00:00:00.000Z").is_err());
        assert_eq!(store.read_job("91").unwrap().unwrap(), original);
        assert_eq!(inbox_count(&path), 0);
    }

    #[test]
    fn concrete_ingress_applies_completion_atomically_and_deduplicates_after_reopen() {
        let (_dir, path, mut store) = running();
        let mut before = store.read_job("91").unwrap().unwrap();
        before["tasks"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"102","state":"QUEUED"}));
        store
            .commit_job("91", "2026-11-13T20:00:03.500Z", |old| {
                let mut job = old.clone();
                job["tasks"] = before["tasks"].clone();
                job["updatedAt"] = json!("2026-11-13T20:00:03.500Z");
                Ok((job, vec![]))
            })
            .unwrap();
        assert!(submit(&mut store, &completed_event(), "2026-11-13T20:00:04.000Z").unwrap());
        let job = store.read_job("91").unwrap().unwrap();
        assert_eq!(job["tasks"][0]["state"], "SUCCEEDED");
        assert_eq!(
            job["tasks"][0]["result"]["data"]["output"]["artifact"],
            "ok"
        );
        assert_eq!(job["tasks"][1], json!({"id":"102","state":"QUEUED"}));
        assert_eq!(inbox_count(&path), 1);
        assert!(
            store.pending_events().unwrap().is_empty(),
            "an inbound event must not echo into the outbound queue"
        );
        drop(store);
        let mut reopened = RelayAuthority::open_existing(&path).unwrap();
        assert!(submit(
            &mut reopened,
            &completed_event(),
            "2026-11-13T20:00:05.000Z"
        )
        .is_err());
        assert_eq!(
            reopened.read_job("91").unwrap().unwrap()["tasks"][0]["state"],
            "SUCCEEDED"
        );
        assert_eq!(inbox_count(&path), 1);
    }

    #[test]
    fn concrete_ingress_applies_correlated_failure_through_the_graph() {
        let (_dir, _path, mut store) = running();
        let mut event = completed_event();
        event["type"] = json!("task.failed");
        event["data"] = json!({"executionId":"ingress-exec","leaseOwner":"isolated","attempt":1,"adapter":"script","phase":"worker","reason":"worker reported failure","evidence":"correlated worker failure event"});
        assert!(submit(&mut store, &event, "2026-11-13T20:00:04.000Z").unwrap());
        let task = &store.read_job("91").unwrap().unwrap()["tasks"][0];
        assert_eq!(task["state"], "FAILED");
        assert_eq!(task["error"], "worker reported failure");
    }

    #[test]
    fn configured_nats_subscriber_routes_wire_message_to_durable_ingress() {
        use std::net::TcpListener;
        use std::thread;
        use std::time::Instant;

        let (_dir, path, store) = running();
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .write_all(b"INFO {\"auth_required\":false,\"tls_required\":false}\r\n")
                .unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line.trim() == "PING" {
                    stream.write_all(b"PONG\r\n").unwrap();
                    break;
                }
            }
            let bytes = completed_event().to_string().into_bytes();
            write!(
                stream,
                "MSG relay.events.job.91.task.completed 1 {}\r\n",
                bytes.len()
            )
            .unwrap();
            stream.write_all(&bytes).unwrap();
            stream.write_all(b"\r\n").unwrap();
            thread::sleep(Duration::from_millis(800));
        });
        let stopped = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stopped);
        let worker_db = path.clone();
        let worker = thread::spawn(move || run_nats_ingress(worker_db, port, worker_stop));
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let state = store.read_job("91").unwrap().unwrap()["tasks"][0]["state"]
                .as_str()
                .unwrap()
                .to_owned();
            if state == "SUCCEEDED" {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "NATS ingress did not commit the terminal event"
            );
            thread::sleep(Duration::from_millis(10));
        }
        stopped.store(true, Ordering::SeqCst);
        worker.join().unwrap();
        server.join().unwrap();
        assert_eq!(inbox_count(&path), 1);
        assert!(store.pending_events().unwrap().is_empty());
    }
}
