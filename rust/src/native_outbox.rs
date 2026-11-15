//! Optional Core NATS publisher for durable native Relay event outbox.
//! The canonical SQLite event identity is committed before network I/O.
//! A PONG confirms server processing, not subscriber delivery; retries
//! preserve a stable event ID so consumers can deduplicate after a crash.
use crate::authority::{RelayAuthority, WorkflowEvent};
use crate::supervised_script::current_time;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream};
use std::time::Duration;

fn envelope(event: &WorkflowEvent) -> Result<(String, Vec<u8>), String> {
    let payload = &event.payload;
    let job = payload["jobId"].as_str().ok_or("event missing Job ID")?;
    let task = payload["taskId"].as_str().ok_or("event missing Task ID")?;
    let exec = payload["executionId"]
        .as_str()
        .ok_or("event missing execution ID")?;
    let kind = payload["type"].as_str().ok_or("event missing type")?;
    if ![job, task]
        .iter()
        .all(|id| !id.is_empty() && id.bytes().all(|c| c.is_ascii_digit()))
        || exec.len() < 8
        || exec.len() > 128
        || !exec
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        || kind.is_empty()
        || kind.len() > 96
        || !kind
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-' || c == b'_')
    {
        return Err("invalid native event subject/execution identity".into());
    }
    let id = format!("{:x}", Sha256::digest(event.key.as_bytes()));
    let status = if kind.ends_with(".completed") || kind.ends_with(".approved") {
        "succeeded"
    } else if kind.ends_with(".failed") {
        "failed"
    } else if kind.ends_with(".cancelled") {
        "cancelled"
    } else {
        "running"
    };
    let serialized = serde_json::to_vec(&json!({
        "version":1,"event_id":id,"type":kind,"job_id":job,"task_id":task,
        "source":{"id":format!("job/{job}/task/{task}/execution/{exec}")},
        "status":status,"visibility":"orchestrator","level":"info",
        "message":kind,
        // Do not put Worker-controlled prompt/results in the transport.
        "data":{"executionId":exec},"timestamp":current_time()
    }))
    .map_err(|e| e.to_string())?;
    if serialized.len() > 16_384 {
        return Err("native event larger than transport policy".into());
    }
    Ok((format!("relay.events.job.{job}.{kind}"), serialized))
}
fn line(reader: &mut BufReader<TcpStream>) -> Result<String, String> {
    let mut text = String::new();
    let n = reader
        .take(8193)
        .read_line(&mut text)
        .map_err(|e| format!("NATS read: {e}"))?;
    if n == 0 || n > 8192 {
        return Err("NATS closed connection or oversized line".into());
    }
    Ok(text)
}

/// Serialize deployment-owned Core NATS credentials for both native ingress
/// and outbox clients. Credentials are not accepted on argv or logged.
pub(crate) fn connect_payload(auth_required: bool) -> Result<String, String> {
    let token = std::env::var("AGENTS_RELAY_NATS_TOKEN").ok();
    let username = std::env::var("AGENTS_RELAY_NATS_USERNAME").ok();
    let password = std::env::var("AGENTS_RELAY_NATS_PASSWORD").ok();
    let mut connect = json!({
        "verbose": false,
        "pedantic": true,
        "name": "relay-rust-native"
    });
    if token.is_some() && (username.is_some() || password.is_some()) {
        return Err("configure either NATS token or username/password, not both".into());
    }
    if let Some(token) = token {
        if token.is_empty() {
            return Err("NATS token must be nonempty".into());
        }
        connect["auth_token"] = json!(token);
    } else if username.is_some() || password.is_some() {
        let username = username
            .filter(|value| !value.is_empty())
            .ok_or("NATS username must be nonempty")?;
        let password = password
            .filter(|value| !value.is_empty())
            .ok_or("NATS password must be nonempty")?;
        connect["user"] = json!(username);
        connect["pass"] = json!(password);
    } else if auth_required {
        return Err(
            "NATS server requires credentials; configure AGENTS_RELAY_NATS_TOKEN or username/password"
                .into(),
        );
    }
    serde_json::to_string(&connect)
        .map_err(|error| format!("NATS CONNECT serialization failed: {error}"))
}
fn deliver(port: u16, subject: &str, bytes: &[u8]) -> Result<(), String> {
    if port == 0 {
        return Err("NATS port must be nonzero".into());
    }
    // Test/production control is an explicitly selected LOCAL port only.
    // Never accept a user-provided URL, nonloopback IP or plain TCP secret.
    let addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port));
    let mut tcp = TcpStream::connect_timeout(&addr, Duration::from_secs(2))
        .map_err(|e| format!("NATS connect failed: {e}"))?;
    tcp.set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(|e| e.to_string())?;
    tcp.set_write_timeout(Some(Duration::from_secs(3)))
        .map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(tcp.try_clone().map_err(|e| e.to_string())?);
    let info = line(&mut reader)?;
    let handshake = info
        .trim()
        .strip_prefix("INFO ")
        .ok_or("NATS INFO handshake missing")?;
    let data: Value =
        serde_json::from_str(handshake).map_err(|e| format!("NATS INFO invalid: {e}"))?;
    if data["tls_required"] == true {
        return Err("NATS requires TLS; the native pilot transport is plaintext-only".into());
    }
    let connect = connect_payload(data["auth_required"] == true)?;
    tcp.write_all(format!("CONNECT {connect}\r\n").as_bytes())
        .map_err(|e| e.to_string())?;
    tcp.write_all(format!("PUB {subject} {}\r\n", bytes.len()).as_bytes())
        .map_err(|e| e.to_string())?;
    tcp.write_all(bytes).map_err(|e| e.to_string())?;
    tcp.write_all(b"\r\nPING\r\n").map_err(|e| e.to_string())?;
    tcp.flush().map_err(|e| e.to_string())?;
    for _ in 0..16 {
        let response = line(&mut reader)?;
        match response.trim() {
            "PONG" => return Ok(()),
            "+OK" => continue,
            "PING" => tcp.write_all(b"PONG\r\n").map_err(|e| e.to_string())?,
            text if text.starts_with("-ERR") => return Err("NATS server rejected event".into()),
            _ => return Err("unexpected NATS protocol response".into()),
        }
    }
    Err("NATS did not acknowledge publication".into())
}
pub fn publish_pending(authority: &mut RelayAuthority, port: u16) -> Result<usize, String> {
    let pending = authority.pending_events()?;
    let mut count = 0;
    for event in pending.iter().take(100) {
        let (subject, payload) = envelope(event)?;
        // Confirm only after a server PONG. An uncertain crash may replay the
        // same SHA-256 event ID, never a fresh success/approval.
        deliver(port, &subject, &payload)?;
        if authority.confirm_published(&event.key, &current_time())? {
            count += 1;
        }
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn envelope_preserves_verified_task_and_stable_identity() {
        let event = WorkflowEvent {
            key: "1/2/execution-123/terminal".into(),
            event_id: "task.completed".into(),
            payload: json!({"type":"task.completed","jobId":"1","taskId":"2","executionId":"execution-123","reason":"verified"}),
        };
        let (subject, bytes) = envelope(&event).unwrap();
        assert_eq!(subject, "relay.events.job.1.task.completed");
        let data: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(data["source"]["id"], "job/1/task/2/execution/execution-123");
        assert!(
            data["data"].get("reason").is_none(),
            "private payload cannot cross transport"
        );
        assert_eq!(data["data"]["executionId"], "execution-123");
        assert_eq!(
            data["event_id"],
            format!("{:x}", Sha256::digest(event.key.as_bytes()))
        );
        assert!(data["timestamp"].is_string());
    }
    #[test]
    fn refuses_unknown_type_or_non_numeric_job() {
        let event = WorkflowEvent {
            key: "key".into(),
            event_id: "task.completed".into(),
            payload: json!({"type":"task.completed","jobId":"!1","taskId":"2","executionId":"test-12345"}),
        };
        assert!(envelope(&event).is_err());
    }
}
