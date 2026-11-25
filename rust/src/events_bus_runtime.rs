// Direct port of Node src/events-bus-runtime.ts: configured Events Bus endpoints and bounded read-only HTTP(S) history cursor paging.
use crate::observability::js_string;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Component, Path, PathBuf},
    time::Duration,
};
use ureq::{Agent, Error as HttpError};
use url::Url;

const DEFAULT_NATS: &str = "nats://127.0.0.1:4222";
const DEFAULT_API: &str = "http://127.0.0.1:4223";
const DEFAULT_SUBJECT: &str = "relay.events.job";
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Number(value)) => value.as_f64() != Some(0.0),
        _ => true,
    }
}
fn env_value<'a>(env: &'a Value, key: &str) -> Option<&'a Value> {
    env.get(key).filter(|value| truthy(Some(value)))
}
fn normalize_join(root: &str, file: &str) -> String {
    let path = Path::new(root).join(file);
    let mut normalized = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    normalized.push("..");
                }
            }
            _ => normalized.push(part.as_os_str()),
        }
    }
    normalized.to_string_lossy().into_owned()
}

pub fn events_bus_config_path(env: &Value) -> String {
    if let Some(value) = env_value(env, "EVENTS_BUS_CONFIG") {
        return js_string(value);
    }
    let fallback = std::env::var("HOME").unwrap_or_else(|_| "/".into());
    let default_dir = normalize_join(&fallback, "Library/Application Support/EventsBus");
    let data_dir = env_value(env, "EVENTS_BUS_DATA_DIR")
        .map(js_string)
        .unwrap_or(default_dir);
    normalize_join(&data_dir, "runtime.json")
}
fn config_read_error(path: &str, error: &std::io::Error) -> String {
    let description = match error.kind() {
        std::io::ErrorKind::PermissionDenied => format!("EACCES: permission denied, open '{path}'"),
        _ if error.raw_os_error() == Some(libc::EISDIR) => {
            "EISDIR: illegal operation on a directory, read".to_string()
        }
        _ => error.to_string(),
    };
    format!("Invalid Events Bus runtime config at {path}: {description}")
}
fn node_syntax_error(raw: &str, error: &serde_json::Error) -> String {
    let detail = error.to_string();
    let pos = error.column().saturating_sub(1);
    let length = raw.encode_utf16().count();
    let label = |message: &str, at: usize, line: usize, column: usize| {
        format!("{message} at position {at} (line {line} column {column})")
    };
    if detail.contains("trailing comma") {
        return label(
            "Expected double-quoted property name in JSON",
            pos,
            error.line(),
            error.column(),
        );
    }
    if detail.contains("key must be a string")
        || (detail.contains("EOF while parsing an object") && raw.trim() == "{")
    {
        let at = if raw.trim() == "{" { length } else { pos };
        let column = if raw.trim() == "{" {
            error.column() + 1
        } else {
            error.column()
        };
        let wording = if at == 1 {
            "Expected property name or '}' in JSON"
        } else {
            "Expected double-quoted property name in JSON"
        };
        return label(wording, at, error.line(), column);
    }
    if detail.contains("EOF while parsing a string") {
        return label(
            "Unterminated string in JSON",
            length,
            error.line(),
            error.column() + 1,
        );
    }
    if detail.contains("EOF while parsing") {
        return "Unexpected end of JSON input".into();
    }
    if detail.contains("trailing characters") {
        return label(
            "Unexpected non-whitespace character after JSON",
            pos,
            error.line(),
            error.column(),
        );
    }
    if detail.contains("expected value") && ["NaN", "undefined"].contains(&raw.trim()) {
        return format!("\"{}\" is not valid JSON", raw.trim());
    }
    detail
}
fn saved_runtime(path: &str) -> Result<Value, String> {
    let body = match fs::read_to_string(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(json!({})),
        Err(error) => return Err(config_read_error(path, &error)),
    };
    let decoded = serde_json::from_str::<Value>(&body).map_err(|error| {
        format!(
            "Invalid Events Bus runtime config at {path}: {}",
            node_syntax_error(&body, &error)
        )
    })?;
    if !decoded.is_object() {
        return Err(format!("Invalid Events Bus runtime config at {path}: Events Bus runtime configuration must be an object"));
    }
    Ok(decoded)
}
fn string_or_default(value: Option<&Value>, fallback: &str) -> String {
    value
        .filter(|value| truthy(Some(value)))
        .map(js_string)
        .unwrap_or_else(|| fallback.into())
}
pub fn resolve_events_bus_runtime(env: &Value) -> Result<Value, String> {
    let config_path = events_bus_config_path(env);
    let saved = saved_runtime(&config_path)?;
    if saved["subjectPrefix"] == "neo.events.job" && !truthy(env.get("EVENTS_BUS_SUBJECT_PREFIX")) {
        return Err("Legacy Events Bus subject in saved runtime config; coordinate migration to relay.events.job".into());
    }
    Ok(json!({
        "configPath":config_path,
        "natsUrl":string_or_default(env_value(env,"EVENTS_BUS_NATS_URL").or_else(||saved.get("natsUrl")),DEFAULT_NATS),
        "apiUrl":string_or_default(env_value(env,"EVENTS_BUS_API_URL").or_else(||saved.get("apiUrl")),DEFAULT_API),
        "subjectPrefix":string_or_default(env_value(env,"EVENTS_BUS_SUBJECT_PREFIX").or_else(||saved.get("subjectPrefix")),DEFAULT_SUBJECT),
    }))
}
fn safe_integer(value: &Value) -> Option<i64> {
    let number = value.as_f64()?;
    if !number.is_finite() || number.abs() > MAX_SAFE_INTEGER || number.fract() != 0.0 {
        return None;
    }
    Some(number as i64)
}
fn option_or<'a>(options: &'a Value, key: &str, fallback: &'a Value) -> &'a Value {
    options
        .get(key)
        .filter(|value| !value.is_null())
        .unwrap_or(fallback)
}
fn request_body(url: Url, timeout_ms: u64) -> Result<Value, String> {
    let config = Agent::config_builder()
        .timeout_global(Some(Duration::from_millis(timeout_ms)))
        .http_status_as_error(false)
        .build();
    let agent = Agent::new_with_config(config);
    let mut response = agent.get(url.as_str()).call().map_err(|error| {
        let reason = match error {
            HttpError::Timeout(_) => "The operation was aborted due to timeout".into(),
            HttpError::HostNotFound => "fetch failed: host not found".into(),
            other => other.to_string(),
        };
        format!("events-bus history unavailable: {reason}")
    })?;
    if !(200..300).contains(&response.status().as_u16()) {
        return Err(format!(
            "events-bus history unavailable: HTTP {}",
            response.status().as_u16()
        ));
    }
    response
        .body_mut()
        .read_json::<Value>()
        .map_err(|error| format!("events-bus history unavailable: {error}"))
}
fn payload_error() -> String {
    "events-bus history returned an unexpected Job, order, or events payload".into()
}
fn row_error() -> String {
    "events-bus history returned invalid, out-of-order, or cross-Task event data".into()
}
fn cursor_error() -> String {
    "events-bus history returned an invalid or non-advancing cursor".into()
}

pub fn events_bus_history_page(
    job_id: &str,
    task_id: Option<&str>,
    limit: &Value,
    options: &Value,
    env: &Value,
) -> Result<Value, String> {
    let limit = safe_integer(limit)
        .filter(|value| *value >= 1)
        .ok_or("Invalid event history page limit")?;
    let default_timeout = json!(12000);
    let timeout = safe_integer(option_or(options, "timeoutMs", &default_timeout))
        .filter(|value| *value >= 1 && *value <= 60000)
        .ok_or("Invalid event history timeout")?;
    let runtime = resolve_events_bus_runtime(env)?;
    let api = runtime["apiUrl"].as_str().unwrap_or(DEFAULT_API);
    let base = Url::parse(api).map_err(|_| "Invalid URL")?;
    let mut target = base.join("/events").map_err(|_| "Invalid URL")?;
    let order = options
        .get("order")
        .filter(|value| !value.is_null())
        .and_then(Value::as_str)
        .unwrap_or("desc");
    if order != "asc" && order != "desc" {
        return Err("Invalid event history order".into());
    }
    let default_after = json!(0);
    let after = safe_integer(option_or(options, "after", &default_after))
        .filter(|value| *value >= 0)
        .ok_or("Invalid event history cursor")?;
    if order == "desc" && after != 0 {
        return Err("Event history cursor requires ascending order".into());
    }
    let bounded = limit.clamp(1, 60);
    {
        let mut query = target.query_pairs_mut();
        query.append_pair("job", job_id);
        if let Some(id) = task_id.filter(|id| !id.is_empty()) {
            query.append_pair("task", id);
        }
        query.append_pair("limit", &bounded.to_string());
        query.append_pair("order", order);
        if order == "asc" {
            query.append_pair("after", &after.to_string());
        }
    }
    let body = request_body(target, timeout as u64)?;
    let records = body
        .get("events")
        .and_then(Value::as_array)
        .ok_or_else(payload_error)?;
    if !body.is_object()
        || body["job_id"] != job_id
        || body["order"] != order
        || records.len() > bounded as usize
    {
        return Err(payload_error());
    }
    let mut events = Vec::with_capacity(records.len());
    let mut rows = Vec::with_capacity(records.len());
    let mut previous = if order == "asc" { after } else { i64::MAX };
    for row in records {
        let cursor = row
            .get("cursor")
            .and_then(safe_integer)
            .filter(|value| *value > 0)
            .ok_or_else(row_error)?;
        let event = row.get("event").ok_or_else(row_error)?;
        let valid = event.is_object()
            && event["job_id"] == job_id
            && task_id.is_none_or(|id| event["task_id"] == id)
            && (if order == "asc" {
                cursor > previous
            } else {
                cursor < previous
            });
        if !valid {
            return Err(row_error());
        }
        previous = cursor;
        rows.push(json!({"cursor":cursor,"event":event}));
        events.push(event.clone());
    }
    let next = body
        .get("next_cursor")
        .and_then(safe_integer)
        .ok_or_else(cursor_error)?;
    let expected = if records.is_empty() {
        after
    } else if order == "asc" {
        records
            .last()
            .and_then(|row| row.get("cursor"))
            .and_then(safe_integer)
            .ok_or_else(cursor_error)?
    } else {
        records
            .first()
            .and_then(|row| row.get("cursor"))
            .and_then(safe_integer)
            .ok_or_else(cursor_error)?
    };
    if next != expected || (order == "asc" && !events.is_empty() && next <= after) {
        return Err(cursor_error());
    }
    Ok(json!({"events":events,"rows":rows,"nextCursor":next}))
}
pub fn events_bus_history(
    job_id: &str,
    task_id: Option<&str>,
    limit: &Value,
    env: &Value,
) -> Result<Value, String> {
    Ok(
        events_bus_history_page(job_id, task_id, limit, &json!({"order":"desc"}), env)?["events"]
            .clone(),
    )
}

/// Read verified native release receipts from the Events Bus history service.
/// This is observational projection data; it never changes Job lifecycle.
pub fn events_bus_release_history(
    package: &str,
    limit: usize,
    runtime: &Value,
) -> Result<Vec<Value>, String> {
    if package.is_empty() || package.len() > 64
        || !package.as_bytes()[0].is_ascii_lowercase()
        || !package.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err("Invalid release package".into());
    }
    let api = runtime.get("apiUrl").and_then(Value::as_str)
        .filter(|value| !value.is_empty()).ok_or("Events Bus API URL is missing")?;
    let mut target = Url::parse(api).map_err(|_| "Invalid Events Bus API URL")?
        .join("/releases").map_err(|_| "Invalid Events Bus API URL")?;
    target.query_pairs_mut().append_pair("package", package)
        .append_pair("limit", &limit.clamp(1, 500).to_string());
    let body = request_body(target, 12_000)?;
    let rows = body.get("events").and_then(Value::as_array)
        .ok_or("Events Bus release history returned an invalid payload")?;
    if body.get("package").and_then(Value::as_str) != Some(package) || rows.len() > 500 {
        return Err("Events Bus release history returned a mismatched package".into());
    }
    Ok(rows.clone())
}

#[cfg(test)]
mod release_history_tests {
    use super::*;
    use std::{io::{Read,Write},net::TcpListener,thread};
    #[test]
    fn release_history_uses_bounded_read_only_package_endpoint(){
        let listener=TcpListener::bind("127.0.0.1:0").unwrap();
        let address=listener.local_addr().unwrap();
        let body=json!({"package":"fixture","events":[{"cursor":4,"event":{
            "kind":"release","type":"package.published","data":{"jobId":"42"}}}]})
            .to_string();
        let response=body.clone();
        let server=thread::spawn(move||{
            let (mut stream,_)=listener.accept().unwrap();
            let mut request=[0u8;2048];let n=stream.read(&mut request).unwrap();
            let line=String::from_utf8_lossy(&request[..n]);
            assert!(line.starts_with("GET /releases?package=fixture&limit=500 HTTP/1.1"),"{line}");
            write!(stream,"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",response.len(),response).unwrap();
        });
        let rows=events_bus_release_history("fixture",usize::MAX,
            &json!({"apiUrl":format!("http://{address}")})).unwrap();
        server.join().unwrap();
        assert_eq!(rows.len(),1);
        assert_eq!(rows[0]["event"]["data"]["jobId"],"42");
    }
}
