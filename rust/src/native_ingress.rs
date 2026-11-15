//! Configured Core NATS ingress for correlated native Worker lifecycle events.
//! SQLite plus the canonical Task Graph remain the only lifecycle authority.
use crate::authority::{ActionOutcome, RelayAuthority, ReviewDelivery, ScriptClaim, WorkflowEvent};
use crate::graph::{Decision, Graph, GraphInput};
use crate::lifecycle::{TaskLifecycle, TaskTransition};
use crate::supervised_script::current_time;
use rusqlite::OptionalExtension;
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

/// Accept a host Review decision delivered on the configured Events Bus.
/// Transport authentication remains the deployment's responsibility; this
/// adapter additionally binds the event subject/source/payload to the current
/// durable invocation before the canonical interactive Graph can accept it.
pub fn ingest_nats_review_decision(
    authority: &mut RelayAuthority,
    subject: &str,
    bytes: &[u8],
) -> Result<Option<crate::authority::ReviewReceipt>, String> {
    if bytes.is_empty() || bytes.len() > MAX_EVENT_BYTES {
        return Err("native ingress event must be 1..65536 bytes".into());
    }
    let event: Value =
        serde_json::from_slice(bytes).map_err(|error| format!("invalid event JSON: {error}"))?;
    if event["type"] != "task.interactive_decision" {
        return Ok(None);
    }
    let job_id = event["job_id"].as_str().ok_or("Review Job ID missing")?;
    let task_id = event["task_id"].as_str().ok_or("Review Task ID missing")?;
    let expected_subject = format!("relay.events.job.{job_id}.task.interactive_decision");
    if subject != expected_subject {
        return Err("NATS subject does not match Review Job and type".into());
    }
    let interactive = event
        .pointer("/data/interactive")
        .filter(|value| value.is_object())
        .ok_or("interactive Review payload missing")?;
    if interactive["jobId"] != job_id || interactive["taskId"] != task_id {
        return Err("Review payload Job or Task identity mismatch".into());
    }
    let execution_id = interactive["executionId"]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .ok_or("Review execution ID missing")?;
    let expected_source = format!("job/{job_id}/task/{task_id}/execution/{execution_id}");
    if event.pointer("/source/id").and_then(Value::as_str) != Some(expected_source.as_str()) {
        return Err("Review event source does not match its execution identity".into());
    }
    let event_id = event["event_id"]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .ok_or("Review event ID missing")?;
    let delivered_at = event["timestamp"]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .ok_or("Review event timestamp missing")?;
    let mut delivery = interactive.clone();
    delivery["eventId"] = json!(event_id);
    delivery["deliveredAt"] = json!(delivered_at);
    let delivery: ReviewDelivery = serde_json::from_value(delivery)
        .map_err(|error| format!("invalid Review payload: {error}"))?;
    authority.accept_review_decision(&delivery).map(Some)
}

/// Persist the host-neutral interactive wait and release the exact current
/// Worker generation. The invocation must already be durably bound by the
/// host request action; this event cannot create or approve an invocation.
pub fn ingest_nats_interactive_waiting(
    authority: &mut RelayAuthority,
    subject: &str,
    bytes: &[u8],
    received_at: &str,
) -> Result<bool, String> {
    if bytes.is_empty() || bytes.len() > MAX_EVENT_BYTES {
        return Err("native ingress event must be 1..65536 bytes".into());
    }
    let event: Value =
        serde_json::from_slice(bytes).map_err(|error| format!("invalid event JSON: {error}"))?;
    if event["type"] != "task.interactive_waiting" {
        return Ok(false);
    }
    let job_id = event["job_id"].as_str().ok_or("Review Job ID missing")?;
    let task_id = event["task_id"].as_str().ok_or("Review Task ID missing")?;
    if subject != format!("relay.events.job.{job_id}.task.interactive_waiting")
        || event.pointer("/source/component").and_then(Value::as_str) != Some("interactive-review")
    {
        return Err("interactive wait subject or source component mismatch".into());
    }
    let source = event
        .pointer("/source/id")
        .and_then(Value::as_str)
        .ok_or("interactive wait execution source missing")?;
    let prefix = format!("job/{job_id}/task/{task_id}/execution/");
    let execution_id = source
        .strip_prefix(&prefix)
        .filter(|value| !value.is_empty())
        .ok_or("interactive wait source Job or Task mismatch")?;
    let event_id = event["event_id"]
        .as_str()
        .filter(|value| !value.trim().is_empty() && value.len() <= 128)
        .ok_or("interactive wait event ID missing or invalid")?;
    let event_at = event["timestamp"]
        .as_str()
        .ok_or("interactive wait timestamp missing")?;
    let event_time = chrono::DateTime::parse_from_rfc3339(event_at)
        .map_err(|_| "invalid interactive wait timestamp")?;
    let received = chrono::DateTime::parse_from_rfc3339(received_at)
        .map_err(|_| "invalid ingress timestamp")?;
    if event_time > received {
        return Err("interactive wait timestamp is in the future".into());
    }
    let receipt = WorkflowEvent {
        key: format!("{job_id}/{task_id}/{execution_id}/interactive-wait/{event_id}"),
        event_id: "task.interactive_waiting".into(),
        payload: json!({"eventId":event_id,"executionId":execution_id,"timestamp":event_at}),
    };
    let graph = Graph::parse(include_str!("../../workflow/task-lifecycle.mmd"))?;
    let mut changed = false;
    let result = authority.commit_job_with_tx(job_id, received_at, |tx, current| {
        if current["state"] != "ACTIVE" || current.get("pause").is_some_and(|value| !value.is_null()) {
            return Err("interactive wait requires an ACTIVE, unpaused Job".into());
        }
        let mut next = current.clone();
        let task = next["tasks"].as_array_mut()
            .and_then(|tasks| tasks.iter_mut().find(|task| task["id"] == task_id))
            .ok_or("interactive wait Task missing")?;
        let previous: Option<(String, String)> = tx.query_row(
            "SELECT event_id,payload_json FROM workflow_event_inbox WHERE consumer_id='rust-interactive-review' AND event_key=?1",
            [&receipt.key], |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional().map_err(|error| error.to_string())?;
        if let Some((previous_id, previous_payload)) = previous {
            if previous_id != receipt.event_id || serde_json::from_str::<Value>(&previous_payload).map_err(|error| error.to_string())? != receipt.payload {
                return Err("interactive wait receipt key collision".into());
            }
            return Err("duplicate interactive wait event".into());
        }
        let attempt = task["attempt"].as_i64().ok_or("interactive wait attempt missing")?;
        let invocation = task.get("interactiveInvocation").ok_or("interactive invocation not bound")?;
        let lease_expiry = task["leaseExpiresAt"].as_str().ok_or("interactive wait lease missing")?;
        let lease_expiry = chrono::DateTime::parse_from_rfc3339(lease_expiry)
            .map_err(|_| "invalid interactive wait lease")?;
        if task["state"] != "RUNNING"
            || task["executionId"] != execution_id
            || task["leaseOwner"].as_str().is_none_or(str::is_empty)
            || invocation["executionId"] != execution_id
            || invocation["status"] != "awaiting_decision"
            || lease_expiry <= received
            || !task["executionHistory"].as_array().is_some_and(|history| {
                history.iter().any(|row| row["id"] == execution_id && row["attempt"] == attempt)
            })
        {
            return Err("interactive wait is stale or not bound to the current Worker generation".into());
        }
        let decision = graph.decide("RUNNING", GraphInput {
            transport:"event".into(), id:"task.interactive_waiting".into(),
            payload:json!({"jobId":job_id,"taskId":task_id,"executionId":execution_id}),
        }, &HashMap::from([("awaitingInteractiveDecision".into(), true)]))?;
        let Decision::Accepted { target, actions, .. } = decision else {
            return Err("Task Graph rejected interactive wait".into());
        };
        if target != "AWAITING_DECISION" {
            return Err("Task Graph selected unexpected interactive wait state".into());
        }
        crate::lifecycle::apply_pure_task_actions(task, &actions)?;
        task["state"] = json!(target);
        task["updatedAt"] = json!(received_at);
        next["updatedAt"] = json!(received_at);
        tx.execute(
            "INSERT INTO workflow_event_inbox(consumer_id,event_key,event_id,payload_json,consumed_at) VALUES('rust-interactive-review',?1,?2,?3,?4)",
            rusqlite::params![receipt.key, receipt.event_id, serde_json::to_string(&receipt.payload).map_err(|error| error.to_string())?, received_at],
        ).map_err(|error| error.to_string())?;
        changed = true;
        Ok((next, vec![]))
    });
    match result {
        Ok(_) => Ok(changed),
        Err(error) if error == "duplicate interactive wait event" => Ok(false),
        Err(error) => Err(error),
    }
}

/// Apply a correlated Worker start/progress event. These events only pass
/// Graph-selected nonterminal transitions and durable idempotency receipts;
/// accepted activity renews only the matching Worker inactivity deadline.
pub fn ingest_worker_lifecycle_event(
    authority: &mut RelayAuthority,
    subject: &str,
    bytes: &[u8],
    at: &str,
) -> Result<bool, String> {
    if bytes.is_empty() || bytes.len() > MAX_EVENT_BYTES {
        return Err("native ingress event must be 1..65536 bytes".into());
    }
    let event: Value =
        serde_json::from_slice(bytes).map_err(|error| format!("invalid event JSON: {error}"))?;
    let kind = event["type"].as_str().ok_or("event type missing")?;
    if !matches!(kind, "task.started" | "task.progress") {
        return Ok(false);
    }
    let job_id = event["job_id"].as_str().ok_or("event Job ID missing")?;
    let task_id = event["task_id"].as_str().ok_or("event Task ID missing")?;
    if !event_id(job_id) || !event_id(task_id) {
        return Err("event Job or Task ID invalid".into());
    }
    let source = event
        .pointer("/source/id")
        .and_then(Value::as_str)
        .ok_or("event execution source missing")?;
    let data = event
        .get("data")
        .filter(|value| value.is_object())
        .ok_or("Worker lifecycle event data missing")?;
    let execution_id = data["executionId"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or("Worker execution ID missing")?;
    let owner = data["leaseOwner"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or("Worker lease owner missing")?;
    let attempt = data["attempt"]
        .as_i64()
        .filter(|value| *value > 0)
        .ok_or("Worker attempt missing")?;
    if source != format!("job/{job_id}/task/{task_id}/execution/{execution_id}") {
        return Err("event source does not match its Job, Task and execution identity".into());
    }
    let event_id = event["event_id"]
        .as_str()
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .ok_or("event ID missing or invalid")?;
    let event_at = event["timestamp"]
        .as_str()
        .ok_or("event timestamp missing")?;
    let event_time = chrono::DateTime::parse_from_rfc3339(event_at)
        .map_err(|_| "invalid Worker event timestamp")?;
    let received =
        chrono::DateTime::parse_from_rfc3339(at).map_err(|_| "invalid ingress timestamp")?;
    if event_time > received {
        return Err("Worker event timestamp is in the future".into());
    }
    if subject != format!("relay.events.job.{job_id}.{kind}") {
        return Err("NATS subject does not match event Job and type".into());
    }
    let receipt_key = format!("{job_id}/{task_id}/{execution_id}/event/{event_id}");
    let receipt = WorkflowEvent {
        key: receipt_key.clone(),
        event_id: kind.into(),
        payload: json!({"eventId":event_id,"type":kind,"jobId":job_id,"taskId":task_id,"executionId":execution_id,"leaseOwner":owner,"attempt":attempt,"timestamp":event_at}),
    };
    if authority.has_consumed_event("rust-worker-lifecycle", &receipt)? {
        return Ok(false);
    }
    let job = authority
        .read_job(job_id)?
        .ok_or("Worker event Job is unknown")?;
    let task = job["tasks"]
        .as_array()
        .and_then(|tasks| tasks.iter().find(|task| task["id"] == task_id))
        .ok_or("Worker event Task is unknown")?;
    let expiry = task["leaseExpiresAt"]
        .as_str()
        .ok_or("current Task lease missing")?;
    let expiry =
        chrono::DateTime::parse_from_rfc3339(expiry).map_err(|_| "invalid current Task lease")?;
    if task["executionId"] != execution_id
        || task["leaseOwner"] != owner
        || task["attempt"] != attempt
        || expiry <= received
        || !task["executionHistory"].as_array().is_some_and(|history| {
            history
                .iter()
                .any(|row| row["id"] == execution_id && row["attempt"] == attempt)
        })
    {
        return Err("Worker event is stale or does not match the current active lease".into());
    }
    let adapter = task["adapter"]
        .as_str()
        .filter(|value| matches!(*value, "script" | "codex"))
        .ok_or("unsupported current Worker adapter")?;
    if data
        .get("adapter")
        .and_then(Value::as_str)
        .is_some_and(|value| value != adapter)
    {
        return Err("Worker event adapter mismatch".into());
    }
    let attempt_key = format!("{job_id}/{task_id}/{execution_id}/launch");
    let trace = authority
        .action_trace(&attempt_key)?
        .ok_or("current launch Action trace missing")?;
    let trace_time = chrono::DateTime::parse_from_rfc3339(&trace.observed_at)
        .map_err(|_| "invalid launch Action timestamp")?;
    if trace.execution_id != execution_id
        || trace.generation != attempt
        || trace.graph != "task-lifecycle.mmd"
        || trace.action_id != "effect.launchTask"
        || trace.outcome != ActionOutcome::Unknown
        || trace_time >= event_time
    {
        return Err("Worker event has no fresh matching Graph-selected launch Action".into());
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
            .and_then(|history| history.iter().find(|row| row["id"] == execution_id))
            .and_then(|row| row["startedAt"].as_str())
            .unwrap_or(&trace.observed_at)
            .into(),
        lease_expires_at: expiry.to_rfc3339(),
    };
    let graph = Graph::parse(include_str!("../../workflow/task-lifecycle.mmd"))?;
    let applied = TaskLifecycle::new(&graph).apply_inbound_worker_event(authority, TaskTransition {
        job_id, task_id,
        input: GraphInput { transport:"event".into(), id:kind.into(), payload:json!({"jobId":job_id,"taskId":task_id,"executionId":execution_id,"leaseOwner":owner,"attempt":attempt}) },
        guard_facts:&HashMap::new(), at, events:vec![],
    }, &claim, &receipt)?;
    Ok(applied)
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
    if info["tls_required"] == true {
        return Err(
            "NATS ingress requires TLS; the native pilot transport is plaintext-only".into(),
        );
    }
    let connect = crate::native_outbox::connect_payload(info["auth_required"] == true)?;
    tcp.write_all(
        format!("CONNECT {connect}\r\nSUB relay.events.job.*.* 1\r\nPING\r\n").as_bytes(),
    )
    .map_err(|e| e.to_string())?;
    tcp.flush().map_err(|e| e.to_string())?;
    loop {
        if stopped.load(Ordering::SeqCst) {
            return Ok(());
        }
        let command = read_line(&mut reader, stopped)?;
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
            let at = current_time();
            let kind = serde_json::from_slice::<Value>(&bytes)
                .ok()
                .and_then(|event| event["type"].as_str().map(str::to_owned));
            if kind
                .as_deref()
                .is_some_and(|kind| matches!(kind, "task.started" | "task.progress"))
            {
                ingest_worker_lifecycle_event(&mut authority, subject, &bytes, &at)
            } else if kind.as_deref() == Some("task.interactive_decision") {
                Ok(ingest_nats_review_decision(&mut authority, subject, &bytes)?.is_some())
            } else if kind.as_deref() == Some("task.interactive_waiting") {
                ingest_nats_interactive_waiting(&mut authority, subject, &bytes, &at)
            } else {
                ingest_nats_worker_terminal_event(&mut authority, subject, &bytes, &at)
            }
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
    static NATS_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn nats_connect_uses_deployment_credentials_and_fails_closed() {
        let _guard = NATS_ENV_LOCK.lock().unwrap();
        let old = [
            std::env::var_os("AGENTS_RELAY_NATS_TOKEN"),
            std::env::var_os("AGENTS_RELAY_NATS_USERNAME"),
            std::env::var_os("AGENTS_RELAY_NATS_PASSWORD"),
        ];
        std::env::remove_var("AGENTS_RELAY_NATS_TOKEN");
        std::env::remove_var("AGENTS_RELAY_NATS_USERNAME");
        std::env::remove_var("AGENTS_RELAY_NATS_PASSWORD");
        assert!(crate::native_outbox::connect_payload(true).is_err());
        assert!(crate::native_outbox::connect_payload(false)
            .unwrap()
            .contains("relay-rust-native"));
        std::env::set_var("AGENTS_RELAY_NATS_TOKEN", "secret-token");
        let token_connect = crate::native_outbox::connect_payload(true).unwrap();
        assert!(
            serde_json::from_str::<Value>(&token_connect).unwrap()["auth_token"] == "secret-token"
        );
        assert!(crate::native_outbox::connect_payload(false)
            .unwrap()
            .contains("secret-token"));
        std::env::remove_var("AGENTS_RELAY_NATS_TOKEN");
        std::env::set_var("AGENTS_RELAY_NATS_USERNAME", "relay-user");
        std::env::set_var("AGENTS_RELAY_NATS_PASSWORD", "secret-password");
        let user_connect =
            serde_json::from_str::<Value>(&crate::native_outbox::connect_payload(true).unwrap())
                .unwrap();
        assert_eq!(user_connect["user"], "relay-user");
        assert_eq!(user_connect["pass"], "secret-password");
        std::env::set_var("AGENTS_RELAY_NATS_TOKEN", "conflicting-token");
        assert!(crate::native_outbox::connect_payload(true).is_err());
        for (name, value) in [
            ("AGENTS_RELAY_NATS_TOKEN", &old[0]),
            ("AGENTS_RELAY_NATS_USERNAME", &old[1]),
            ("AGENTS_RELAY_NATS_PASSWORD", &old[2]),
        ] {
            if let Some(value) = value {
                std::env::set_var(name, value);
            } else {
                std::env::remove_var(name);
            }
        }
    }
    use crate::authority::{tests::setup, ScriptClaimRequest};

    fn unstarted() -> (tempfile::TempDir, PathBuf, RelayAuthority) {
        let (dir, path) = setup();
        let mut store = RelayAuthority::open_existing(&path).unwrap();
        store
            .commit_job("91", "2026-11-13T20:00:01.000Z", |old| {
                let mut job = old.clone();
                job["updatedAt"] = json!("2026-11-13T20:00:01.000Z");
                let task = &mut job["tasks"][0];
                task["adapter"] = json!("script");
                task["dependencies"] = json!([]);
                task["timeoutMs"] = json!(120000);
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
        (dir, path, store)
    }
    fn running() -> (tempfile::TempDir, PathBuf, RelayAuthority) {
        let (dir, path, mut store) = unstarted();
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
    fn lifecycle_event(kind: &str, event_id: &str, timestamp: &str) -> Value {
        json!({
            "event_id":event_id,"type":kind,"job_id":"91","task_id":"101",
            "source":{"id":"job/91/task/101/execution/ingress-exec"},"timestamp":timestamp,
            "data":{"executionId":"ingress-exec","leaseOwner":"isolated","attempt":1,"adapter":"script"}
        })
    }
    fn submit_lifecycle(
        store: &mut RelayAuthority,
        event: &Value,
        subject: &str,
        at: &str,
    ) -> Result<bool, String> {
        ingest_worker_lifecycle_event(store, subject, event.to_string().as_bytes(), at)
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
    fn worker_start_and_progress_use_graph_and_renew_only_durable_activity_without_false_completion(
    ) {
        let (_dir, path, mut store) = unstarted();
        store
            .commit_job("91", "2026-11-13T20:00:02.900Z", |old| {
                let mut job = old.clone();
                job["updatedAt"] = json!("2026-11-13T20:00:02.900Z");
                let task = &mut job["tasks"][0];
                task["timeoutMs"] = json!(1000);
                task["leaseExpiresAt"] = json!("2026-11-13T20:00:10.000Z");
                Ok((job, vec![]))
            })
            .unwrap();
        let start = lifecycle_event("task.started", "start-1", "2026-11-13T20:00:03.000Z");
        assert!(submit_lifecycle(
            &mut store,
            &start,
            "relay.events.job.91.task.started",
            "2026-11-13T20:00:03.100Z"
        )
        .unwrap());
        assert_eq!(
            store.read_job("91").unwrap().unwrap()["tasks"][0]["state"],
            "RUNNING"
        );
        assert!(!submit_lifecycle(
            &mut store,
            &start,
            "relay.events.job.91.task.started",
            "2026-11-13T20:00:03.200Z"
        )
        .unwrap());
        let mut progress =
            lifecycle_event("task.progress", "progress-1", "2026-11-13T20:00:04.000Z");
        progress["data"]["status"] = json!("COMPLETED");
        progress["data"]["output"] = json!({"artifact":"unverified"});
        assert!(submit_lifecycle(
            &mut store,
            &progress,
            "relay.events.job.91.task.progress",
            "2026-11-13T20:00:04.100Z"
        )
        .unwrap());
        let snapshot = store.read_job("91").unwrap().unwrap();
        assert_eq!(snapshot["tasks"][0]["state"], "RUNNING");
        assert!(snapshot["tasks"][0]["result"].is_null());
        assert!(snapshot["tasks"][0].get("lastProgressAt").is_none());
        assert_eq!(
            snapshot["tasks"][0]["lastProgressEventAt"],
            "2026-11-13T20:00:04.000Z"
        );
        assert_eq!(
            snapshot["tasks"][0]["lastWorkerActivityAt"],
            "2026-11-13T20:00:04.000Z"
        );
        assert_eq!(
            snapshot["tasks"][0]["leaseExpiresAt"], "2026-11-13T20:00:35.000Z",
            "restart recovery must use the accepted activity deadline"
        );
        drop(store);
        let mut reopened = RelayAuthority::open_existing(&path).unwrap();
        assert!(!submit_lifecycle(
            &mut reopened,
            &start,
            "relay.events.job.91.task.started",
            "2100-01-01T00:00:00.000Z"
        )
        .unwrap());
        assert!(!submit_lifecycle(
            &mut reopened,
            &progress,
            "relay.events.job.91.task.progress",
            "2100-01-01T00:00:00.000Z"
        )
        .unwrap());
        assert_eq!(
            inbox_count(&path),
            0,
            "start/progress receipts use their own lifecycle consumer"
        );
        let lifecycle_receipts: i64 = rusqlite::Connection::open(&path).unwrap().query_row("SELECT COUNT(*) FROM workflow_event_inbox WHERE consumer_id='rust-worker-lifecycle'", [], |row| row.get(0)).unwrap();
        assert_eq!(lifecycle_receipts, 2);
        let reopened_job = reopened.read_job("91").unwrap().unwrap();
        assert_eq!(
            reopened_job["tasks"][0]["lastWorkerActivityAt"],
            "2026-11-13T20:00:04.000Z"
        );
        assert_eq!(
            reopened_job["tasks"][0]["leaseExpiresAt"],
            "2026-11-13T20:00:35.000Z"
        );
        assert!(crate::recovery::inspect_expired_execution(
            &reopened_job,
            "101",
            "2026-11-13T20:00:34.999Z",
            crate::authority::ProcessProbe::Gone,
            false,
        )
        .unwrap()
        .is_none());
        assert_eq!(
            crate::recovery::inspect_expired_execution(
                &reopened_job,
                "101",
                "2026-11-13T20:00:36.000Z",
                crate::authority::ProcessProbe::Gone,
                false,
            )
            .unwrap()
            .unwrap()
            .status,
            "eligible"
        );
        assert!(
            reopened.pending_events().unwrap().is_empty(),
            "inbound lifecycle events are not echoed to the outbox"
        );
    }

    #[test]
    fn worker_start_progress_reject_wrong_subject_correlation_and_out_of_order_without_mutation() {
        let (_dir, path, mut store) = running();
        let original = store.read_job("91").unwrap().unwrap();
        let mut wrong = lifecycle_event("task.progress", "wrong-1", "2026-11-13T20:00:04.000Z");
        wrong["source"]["id"] = json!("job/92/task/101/execution/ingress-exec");
        assert!(submit_lifecycle(
            &mut store,
            &wrong,
            "relay.events.job.91.task.progress",
            "2026-11-13T20:00:04.100Z"
        )
        .is_err());
        let valid = lifecycle_event("task.progress", "progress-new", "2026-11-13T20:00:04.000Z");
        for (field, value) in [
            ("executionId", json!("stale-exec")),
            ("leaseOwner", json!("wrong-owner")),
            ("attempt", json!(2)),
        ] {
            let mut fenced = lifecycle_event(
                "task.progress",
                &format!("fenced-{field}"),
                "2026-11-13T20:00:04.000Z",
            );
            fenced["data"][field] = value;
            assert!(submit_lifecycle(
                &mut store,
                &fenced,
                "relay.events.job.91.task.progress",
                "2026-11-13T20:00:04.100Z"
            )
            .is_err());
        }
        let unsupported = lifecycle_event(
            "task.interactive_waiting",
            "unsupported-1",
            "2026-11-13T20:00:04.000Z",
        );
        assert!(!submit_lifecycle(
            &mut store,
            &unsupported,
            "relay.events.job.91.task.interactive_waiting",
            "2026-11-13T20:00:04.100Z"
        )
        .unwrap());
        assert!(
            submit_lifecycle(
                &mut store,
                &valid,
                "relay.events.job.91.task.progress",
                "2100-01-01T00:00:00.000Z"
            )
            .is_err(),
            "expired lease must reject without a receipt"
        );
        assert!(submit_lifecycle(
            &mut store,
            &valid,
            "relay.events.job.92.task.progress",
            "2026-11-13T20:00:04.100Z"
        )
        .is_err());
        let unchanged = store.read_job("91").unwrap().unwrap();
        assert_eq!(
            unchanged["tasks"][0]["lastWorkerActivityAt"],
            original["tasks"][0]["lastWorkerActivityAt"]
        );
        assert_eq!(
            unchanged["tasks"][0]["leaseExpiresAt"],
            original["tasks"][0]["leaseExpiresAt"]
        );
        assert!(submit_lifecycle(
            &mut store,
            &valid,
            "relay.events.job.91.task.progress",
            "2026-11-13T20:00:04.100Z"
        )
        .unwrap());
        let out_of_order =
            lifecycle_event("task.progress", "progress-old", "2026-11-13T20:00:03.500Z");
        assert!(submit_lifecycle(
            &mut store,
            &out_of_order,
            "relay.events.job.91.task.progress",
            "2026-11-13T20:00:04.200Z"
        )
        .is_err());
        assert_eq!(
            store.read_job("91").unwrap().unwrap()["tasks"][0]["state"],
            original["tasks"][0]["state"]
        );
        let after_out_of_order = store.read_job("91").unwrap().unwrap();
        assert_eq!(
            after_out_of_order["tasks"][0]["lastWorkerActivityAt"],
            "2026-11-13T20:00:04.000Z"
        );
        assert_eq!(
            after_out_of_order["tasks"][0]["leaseExpiresAt"],
            original["tasks"][0]["leaseExpiresAt"]
        );
        let receipts: i64 = rusqlite::Connection::open(&path).unwrap().query_row("SELECT COUNT(*) FROM workflow_event_inbox WHERE consumer_id='rust-worker-lifecycle'", [], |row| row.get(0)).unwrap();
        assert_eq!(receipts, 1);
    }

    #[test]
    fn nats_review_ingress_binds_subject_source_payload_and_ledger_without_completing_task() {
        let (_dir, _path, mut store) = running();
        let before = store.read_job("91").unwrap().unwrap();
        let bound_at =
            crate::supervised_script::after_time(before["updatedAt"].as_str().unwrap()).unwrap();
        store
            .commit_job("91", &bound_at, |previous| {
                let mut job = previous.clone();
                job["updatedAt"] = json!(bound_at);
                let task = &mut job["tasks"][0];
                task["state"] = json!("AWAITING_DECISION");
                task["executionId"] = Value::Null;
                task["leaseOwner"] = Value::Null;
                task["leaseExpiresAt"] = Value::Null;
                task["interactiveInvocation"] = json!({
                    "invocationId":"ingress-exec","executionId":"ingress-exec",
                    "revision":"review-rev-1","status":"awaiting_decision",
                    "boundAt":bound_at
                });
                Ok((job, vec![]))
            })
            .unwrap();
        let event_at = crate::supervised_script::after_time(&bound_at).unwrap();
        let event = json!({
            "event_id":"host-review-1","type":"task.interactive_decision",
            "job_id":"91","task_id":"101","timestamp":event_at,
            "source":{"id":"job/91/task/101/execution/ingress-exec"},
            "data":{"interactive":{
                "jobId":"91","taskId":"101","executionId":"ingress-exec",
                "invocationId":"ingress-exec","revision":"review-rev-1",
                "decision":"changes_requested","feedback":"Revise the opening",
                "idempotencyKey":"review-delivery-1"
            }}
        });
        let subject = "relay.events.job.91.task.interactive_decision";
        let bytes = serde_json::to_vec(&event).unwrap();
        assert!(ingest_nats_review_decision(&mut store, subject, &bytes)
            .unwrap()
            .is_some_and(|receipt| receipt.outcome == "accepted"));
        assert_eq!(
            ingest_nats_review_decision(&mut store, subject, &bytes)
                .unwrap()
                .unwrap()
                .outcome,
            "duplicate"
        );
        let mut forged = event.clone();
        forged["source"]["id"] = json!("job/91/task/101/execution/forged");
        assert!(ingest_nats_review_decision(
            &mut store,
            subject,
            &serde_json::to_vec(&forged).unwrap()
        )
        .is_err());
        assert!(ingest_nats_review_decision(
            &mut store,
            "relay.events.job.92.task.interactive_decision",
            &bytes
        )
        .is_err());
        let after = store.read_job("91").unwrap().unwrap();
        assert_eq!(after["tasks"][0]["state"], "AWAITING_DECISION");
        assert_eq!(
            after["tasks"][0]["interactiveInvocation"]["status"],
            "changes_requested"
        );
        assert!(after["tasks"][0].get("result").is_none());
        assert_eq!(after["state"], "ACTIVE");
    }

    #[test]
    fn nats_interactive_wait_releases_only_the_bound_worker_and_deduplicates() {
        let (_dir, _path, mut store) = running();
        let before = store.read_job("91").unwrap().unwrap();
        let bound_at =
            crate::supervised_script::after_time(before["updatedAt"].as_str().unwrap()).unwrap();
        store
            .commit_job("91", &bound_at, |previous| {
                let mut job = previous.clone();
                job["updatedAt"] = json!(bound_at);
                job["tasks"][0]["interactiveInvocation"] = json!({
                    "invocationId":"ingress-exec","executionId":"ingress-exec",
                    "revision":"ingress-exec","status":"awaiting_decision",
                    "boundAt":bound_at
                });
                Ok((job, vec![]))
            })
            .unwrap();
        let event_at = crate::supervised_script::after_time(&bound_at).unwrap();
        let received_at = crate::supervised_script::after_time(&event_at).unwrap();
        let event = json!({
            "event_id":"interactive-wait-1","type":"task.interactive_waiting",
            "job_id":"91","task_id":"101","timestamp":event_at,"data":{},
            "source":{"id":"job/91/task/101/execution/ingress-exec","component":"interactive-review"}
        });
        let subject = "relay.events.job.91.task.interactive_waiting";
        let bytes = serde_json::to_vec(&event).unwrap();
        assert!(
            ingest_nats_interactive_waiting(&mut store, subject, &bytes, &received_at).unwrap()
        );
        assert!(
            !ingest_nats_interactive_waiting(&mut store, subject, &bytes, &received_at).unwrap()
        );
        let after = store.read_job("91").unwrap().unwrap();
        assert_eq!(after["tasks"][0]["state"], "AWAITING_DECISION");
        assert_eq!(after["tasks"][0]["executionId"], Value::Null);
        assert_eq!(after["tasks"][0]["leaseOwner"], Value::Null);
        assert_eq!(
            after["tasks"][0]["interactiveInvocation"]["status"],
            "awaiting_decision"
        );
        assert!(after["tasks"][0].get("result").is_none());

        let mut stale = event.clone();
        stale["source"]["id"] = json!("job/91/task/101/execution/stale");
        assert!(ingest_nats_interactive_waiting(
            &mut store,
            subject,
            &serde_json::to_vec(&stale).unwrap(),
            &received_at
        )
        .is_err());
    }

    #[test]
    fn configured_nats_subscriber_routes_wire_message_to_durable_ingress() {
        use std::net::TcpListener;
        use std::thread;
        use std::time::Instant;

        let _guard = NATS_ENV_LOCK.lock().unwrap();
        let old = [
            std::env::var_os("AGENTS_RELAY_NATS_TOKEN"),
            std::env::var_os("AGENTS_RELAY_NATS_USERNAME"),
            std::env::var_os("AGENTS_RELAY_NATS_PASSWORD"),
        ];
        std::env::set_var("AGENTS_RELAY_NATS_TOKEN", "wire-test-secret");
        std::env::remove_var("AGENTS_RELAY_NATS_USERNAME");
        std::env::remove_var("AGENTS_RELAY_NATS_PASSWORD");
        let (_dir, path, store) = running();
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .write_all(b"INFO {\"auth_required\":true,\"tls_required\":false}\r\n")
                .unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut connect = String::new();
            reader.read_line(&mut connect).unwrap();
            let connect = connect.strip_prefix("CONNECT ").unwrap().trim();
            assert_eq!(
                serde_json::from_str::<Value>(connect).unwrap()["auth_token"],
                "wire-test-secret"
            );
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line.trim() == "PING" {
                    stream.write_all(b"PONG\r\n").unwrap();
                    break;
                }
            }
            let bytes =
                lifecycle_event("task.progress", "wire-progress", "2026-11-13T20:00:04.000Z")
                    .to_string()
                    .into_bytes();
            write!(
                stream,
                "MSG relay.events.job.91.task.progress 1 {}\r\n",
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
            if state == "RUNNING"
                && store.read_job("91").unwrap().unwrap()["tasks"][0]
                    .get("lastProgressEventAt")
                    .is_some()
            {
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
        let lifecycle_receipts: i64 = rusqlite::Connection::open(&path).unwrap().query_row("SELECT COUNT(*) FROM workflow_event_inbox WHERE consumer_id='rust-worker-lifecycle'", [], |row| row.get(0)).unwrap();
        assert_eq!(lifecycle_receipts, 1);
        assert!(store.pending_events().unwrap().is_empty());
        for (name, value) in [
            ("AGENTS_RELAY_NATS_TOKEN", &old[0]),
            ("AGENTS_RELAY_NATS_USERNAME", &old[1]),
            ("AGENTS_RELAY_NATS_PASSWORD", &old[2]),
        ] {
            if let Some(value) = value {
                std::env::set_var(name, value);
            } else {
                std::env::remove_var(name);
            }
        }
    }

    #[test]
    fn authenticated_nats_session_delivers_wait_and_bound_review_decision() {
        use chrono::{DateTime, Duration as ChronoDuration, SecondsFormat};
        use std::net::TcpListener;
        use std::thread;
        use std::time::Instant;

        let _guard = NATS_ENV_LOCK.lock().unwrap();
        let old = [
            std::env::var_os("AGENTS_RELAY_NATS_TOKEN"),
            std::env::var_os("AGENTS_RELAY_NATS_USERNAME"),
            std::env::var_os("AGENTS_RELAY_NATS_PASSWORD"),
        ];
        std::env::set_var("AGENTS_RELAY_NATS_TOKEN", "review-wire-test-secret");
        std::env::remove_var("AGENTS_RELAY_NATS_USERNAME");
        std::env::remove_var("AGENTS_RELAY_NATS_PASSWORD");
        let (_dir, path, mut store) = running();
        // The ingress checks that an event timestamp is no later than its
        // receipt timestamp. Keep these wire fixtures comfortably in the
        // past so scheduling jitter cannot turn them into future events.
        let event_time = |seconds_ago: i64| {
            let now = DateTime::parse_from_rfc3339(&current_time()).unwrap();
            (now - ChronoDuration::seconds(seconds_ago))
                .to_rfc3339_opts(SecondsFormat::Millis, true)
        };
        let bind_at = event_time(60);
        store
            .commit_job("91", &bind_at, |previous| {
                let mut job = previous.clone();
                job["updatedAt"] = json!(bind_at);
                job["tasks"][0]["interactiveInvocation"] = json!({
                    "invocationId":"ingress-exec","executionId":"ingress-exec",
                    "revision":"review-wire-rev","status":"awaiting_decision","boundAt":bind_at
                });
                Ok((job, vec![]))
            })
            .unwrap();
        let waiting_at = event_time(30);
        let waiting = json!({
            "event_id":"waiting-wire-1","type":"task.interactive_waiting",
            "job_id":"91","task_id":"101","timestamp":waiting_at,
            "source":{"id":"job/91/task/101/execution/ingress-exec","component":"interactive-review"},
            "data":{}
        });
        let decision_at = event_time(15);
        let decision = json!({
            "event_id":"decision-wire-1","type":"task.interactive_decision",
            "job_id":"91","task_id":"101","timestamp":decision_at,
            "source":{"id":"job/91/task/101/execution/ingress-exec"},
            "data":{"interactive":{
                "jobId":"91","taskId":"101","executionId":"ingress-exec",
                "invocationId":"ingress-exec","revision":"review-wire-rev",
                "decision":"approved","feedback":"verified preview",
                "idempotencyKey":"wire-key-1"
            }}
        });
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .write_all(b"INFO {\"auth_required\":true,\"tls_required\":false}\r\n")
                .unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut connect = String::new();
            reader.read_line(&mut connect).unwrap();
            let connect = connect.strip_prefix("CONNECT ").unwrap().trim();
            assert_eq!(
                serde_json::from_str::<Value>(connect).unwrap()["auth_token"],
                "review-wire-test-secret"
            );
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line.trim() == "PING" {
                    stream.write_all(b"PONG\r\n").unwrap();
                    break;
                }
            }
            for (subject, event) in [
                ("relay.events.job.91.task.interactive_waiting", waiting),
                ("relay.events.job.91.task.interactive_decision", decision),
            ] {
                let bytes = event.to_string().into_bytes();
                write!(stream, "MSG {subject} 1 {}\r\n", bytes.len()).unwrap();
                stream.write_all(&bytes).unwrap();
                stream.write_all(b"\r\n").unwrap();
            }
            thread::sleep(Duration::from_millis(600));
        });
        let stopped = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stopped);
        let worker_db = path.clone();
        let worker = thread::spawn(move || run_nats_ingress(worker_db, port, worker_stop));
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let task = store.read_job("91").unwrap().unwrap()["tasks"][0].clone();
            if task["interactiveInvocation"]["status"] == "approved" {
                assert_eq!(task["state"], "AWAITING_DECISION");
                assert!(task["result"].is_null());
                break;
            }
            assert!(
                Instant::now() < deadline,
                "authenticated Review event was not accepted"
            );
            thread::sleep(Duration::from_millis(10));
        }
        stopped.store(true, Ordering::SeqCst);
        worker.join().unwrap();
        server.join().unwrap();
        let count: i64 = rusqlite::Connection::open(&path).unwrap().query_row(
            "SELECT COUNT(*) FROM host_invocation_decision WHERE job_id='91' AND task_id='101' AND invocation_id='ingress-exec'",
            [], |row| row.get(0),
        ).unwrap();
        assert_eq!(count, 1);
        for (name, value) in [
            ("AGENTS_RELAY_NATS_TOKEN", &old[0]),
            ("AGENTS_RELAY_NATS_USERNAME", &old[1]),
            ("AGENTS_RELAY_NATS_PASSWORD", &old[2]),
        ] {
            if let Some(value) = value {
                std::env::set_var(name, value);
            } else {
                std::env::remove_var(name);
            }
        }
    }
}
