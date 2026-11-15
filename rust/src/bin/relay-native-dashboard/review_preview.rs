use agents_relay_rust::authority::RelayAuthority;
use serde_json::{json, Value};
use std::io::Write;
use std::net::TcpStream;
use std::path::Path;

fn respond_json(tcp: &mut TcpStream, status: &str, value: &Value) -> Result<(), String> {
    let payload = value.to_string();
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
        payload.len()
    );
    tcp.write_all(head.as_bytes()).map_err(|e| e.to_string())?;
    tcp.write_all(payload.as_bytes()).map_err(|e| e.to_string())
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}

pub(super) fn begin(
    tcp: &mut TcpStream,
    db: &Path,
    body: &[u8],
    authorization: Option<&str>,
    host_token: Option<&str>,
) -> Result<(), String> {
    let Some(token) = host_token.filter(|value| value.as_bytes().len() >= 32) else {
        return respond_json(
            tcp,
            "503 Service Unavailable",
            &json!({"error":"review host authentication is not configured"}),
        );
    };
    let Some(header) = authorization else {
        return respond_json(
            tcp,
            "401 Unauthorized",
            &json!({"error":"review host authentication required"}),
        );
    };
    let Some(provided) = header.strip_prefix("Bearer ") else {
        return respond_json(
            tcp,
            "401 Unauthorized",
            &json!({"error":"review host authentication required"}),
        );
    };
    if !constant_time_equal(provided.as_bytes(), token.as_bytes()) {
        return respond_json(
            tcp,
            "401 Unauthorized",
            &json!({"error":"review host authentication failed"}),
        );
    }
    let payload: Value = match serde_json::from_slice::<Value>(body) {
        Ok(value) if value.is_object() => value,
        _ => {
            return respond_json(
                tcp,
                "400 Bad Request",
                &json!({"error":"invalid review preview request"}),
            )
        }
    };
    let allowed = [
        "jobId",
        "taskId",
        "executionId",
        "revision",
        "contentHash",
        "revisionId",
        "previewId",
        "requestId",
        "idempotencyKey",
    ];
    if payload.as_object().is_none_or(|object| {
        ["jobId", "taskId", "executionId"]
            .iter()
            .any(|key| !object.contains_key(*key))
            || object.keys().any(|key| !allowed.contains(&key.as_str()))
    }) {
        return respond_json(
            tcp,
            "400 Bad Request",
            &json!({"error":"review preview request requires Job, Task and execution identity"}),
        );
    }
    let (Some(job_id), Some(task_id), Some(execution_id)) = (
        payload["jobId"].as_str(),
        payload["taskId"].as_str(),
        payload["executionId"].as_str(),
    ) else {
        return respond_json(
            tcp,
            "400 Bad Request",
            &json!({"error":"review preview identity must be strings"}),
        );
    };
    if payload
        .get("revision")
        .is_some_and(|value| !value.is_string())
    {
        return respond_json(
            tcp,
            "400 Bad Request",
            &json!({"error":"review Preview revision must be a string"}),
        );
    }
    let mut authority = RelayAuthority::open_existing(db)?;
    let revision = payload
        .get("revision")
        .and_then(Value::as_str)
        .unwrap_or(execution_id);
    let mut identity = serde_json::Map::new();
    for key in [
        "contentHash",
        "revisionId",
        "previewId",
        "requestId",
        "idempotencyKey",
    ] {
        if let Some(value) = payload.get(key) {
            identity.insert(key.into(), value.clone());
        }
    }
    let identity = Value::Object(identity);
    match authority.begin_interactive_review_with_identity(
        job_id,
        task_id,
        execution_id,
        revision,
        &identity,
        &agents_relay_rust::supervised_script::current_time(),
    ) {
        Ok(binding) => respond_json(tcp, "200 OK", &json!({"status":"bound","binding":binding})),
        Err(error) if error.contains("missing") => {
            respond_json(tcp, "404 Not Found", &json!({"error":error}))
        }
        Err(error) => respond_json(tcp, "409 Conflict", &json!({"error":error})),
    }
}

pub(super) fn decision(
    tcp: &mut TcpStream,
    db: &Path,
    body: &[u8],
    authorization: Option<&str>,
    host_token: Option<&str>,
) -> Result<(), String> {
    let Some(token) = host_token.filter(|value| value.as_bytes().len() >= 32) else {
        return respond_json(
            tcp,
            "503 Service Unavailable",
            &json!({"error":"review host authentication is not configured"}),
        );
    };
    let Some(provided) = authorization.and_then(|header| header.strip_prefix("Bearer ")) else {
        return respond_json(
            tcp,
            "401 Unauthorized",
            &json!({"error":"review host authentication required"}),
        );
    };
    if !constant_time_equal(provided.as_bytes(), token.as_bytes()) {
        return respond_json(
            tcp,
            "401 Unauthorized",
            &json!({"error":"review host authentication failed"}),
        );
    }
    let payload: Value = match serde_json::from_slice::<Value>(body) {
        Ok(value) if value.is_object() => value,
        _ => {
            return respond_json(
                tcp,
                "400 Bad Request",
                &json!({"error":"invalid review decision"}),
            )
        }
    };
    let allowed = [
        "jobId",
        "taskId",
        "executionId",
        "invocationId",
        "revision",
        "contentHash",
        "revisionId",
        "previewId",
        "requestId",
        "decision",
        "feedback",
        "comments",
        "idempotencyKey",
        "eventId",
        "deliveredAt",
    ];
    if payload
        .as_object()
        .is_none_or(|object| object.keys().any(|key| !allowed.contains(&key.as_str())))
    {
        return respond_json(
            tcp,
            "400 Bad Request",
            &json!({"error":"review decision contains unsupported fields"}),
        );
    }
    let delivery = match serde_json::from_value(payload) {
        Ok(value) => value,
        Err(error) => {
            return respond_json(
                tcp,
                "400 Bad Request",
                &json!({"error":format!("invalid review decision: {error}")}),
            )
        }
    };
    let mut authority = RelayAuthority::open_existing(db)?;
    match authority.accept_review_decision(&delivery) {
        Ok(receipt) if receipt.outcome == "stale" => {
            respond_json(tcp, "409 Conflict", &json!({"receipt":receipt}))
        }
        Ok(receipt) => respond_json(tcp, "200 OK", &json!({"receipt":receipt})),
        Err(error) => respond_json(tcp, "400 Bad Request", &json!({"error":error})),
    }
}
