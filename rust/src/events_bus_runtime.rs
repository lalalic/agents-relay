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

fn condition(path:&str,op:&str,value:&str)->Value { json!({"path":path,"op":op,"value":value}) }
pub fn job_history_filter(job:&str,task:Option<&str>)->Value {
    let mut old=vec![condition("event.job_id","eq",job)];
    if let Some(task)=task { old.push(condition("event.task_id","eq",task)); }
    let prefix=match task {
        Some(task)=>format!("job/{job}/task/{task}/execution/"),
        None=>format!("job/{job}/task/"),
    };
    let canonical=vec![condition("event.source.id",if task.is_some(){"prefixSegment"}else{"prefix"},&prefix)];
    let mut groups=vec![old,canonical];
    if task.is_none(){groups.push(vec![condition("event.data.jobId","eq",job),condition("event.source.id","prefix","release/")]);}
    json!(groups)
}

/// Publication-specific view, owned by Relay. Preserve rich historical
/// receipts. New producer envelopes are verified by dashboard_publication.
pub fn normalize_release_receipt(event:&Value)->Option<Value>{
    let source=event.pointer("/source/id")?.as_str()?;
    if !source.starts_with("release/"){return None;}
    let status=match event["type"].as_str()?{
        "package.published"=>"succeeded",
        "package.publish_failed"=>"failed",
        _=>return None,
    };
    if event.get("kind").is_some_and(|k|k!="release") ||
       event.get("status").is_some_and(|s|s!=status) {return None;}
    let mut normalized=event.clone();
    normalized["kind"]=json!("release"); normalized["status"]=json!(status);
    if normalized.get("job_id").is_none(){
        if let Some(id)=event["data"]["jobId"].as_str(){normalized["job_id"]=json!(id);}
    }
    Some(normalized)
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
        query.append_pair("filter",&job_history_filter(job_id,task_id.filter(|id|!id.is_empty())).to_string());
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
        || body.get("job_id").is_some_and(|id|id!=job_id)
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
        if (order=="asc" && cursor<=previous)||(order=="desc"&&cursor>=previous){return Err(row_error());}
        previous=cursor;
        let raw=row.get("event").filter(|v|v.is_object()).ok_or_else(row_error)?;
        let source=raw.pointer("/source/id").and_then(Value::as_str).unwrap_or("");
        let job_prefix=format!("job/{job_id}/task/");
        let in_scope=raw["job_id"]==job_id&&task_id.is_none_or(|t|raw["task_id"]==t)
            || source.starts_with(&job_prefix)&&task_id.is_none_or(|t|{
                let prefix=format!("{job_prefix}{t}/execution/");
                source.strip_prefix(&prefix).is_some_and(|tail|!tail.is_empty()&&!tail.contains('/'))
            })
            || task_id.is_none()&&source.starts_with("release/")&&raw["data"]["jobId"]==job_id;
        if !in_scope{return Err(row_error());}
        let normalized=if source.starts_with("release/"){
            normalize_release_receipt(raw)
        }else{crate::events::normalize_incoming_event(raw)};
        let Some(event)=normalized else{
            // Opaque events in our queried namespace can be malformed for
            // Relay. Preserve the cursor but do not apply them to Graph.
            rows.push(json!({"cursor":cursor,"event":null}));
            continue;
        };
        if event["job_id"]!=job_id||task_id.is_some_and(|t|event["task_id"]!=t){return Err(row_error());}
        rows.push(json!({"cursor":cursor,"event":event}));
        events.push(event);
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
    if next != expected || (order == "asc" && !records.is_empty() && next <= after) {
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
    events_bus_release_history_with_timeout(package,limit,runtime,12_000)
}
pub fn events_bus_release_history_with_timeout(
    package:&str,limit:usize,runtime:&Value,timeout_ms:u64
)->Result<Vec<Value>,String>{
    if package.is_empty() || package.len() > 64
        || !package.as_bytes()[0].is_ascii_lowercase()
        || !package.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err("Invalid release package".into());
    }
    let api = runtime.get("apiUrl").and_then(Value::as_str)
        .filter(|value| !value.is_empty()).ok_or("Events Bus API URL is missing")?;
    let mut target = Url::parse(api).map_err(|_| "Invalid Events Bus API URL")?
        .join("/events").map_err(|_| "Invalid Events Bus API URL")?;
    let bounded=limit.clamp(1,500);
    let prefix=format!("release/{package}/");
    target.query_pairs_mut().append_pair("sourcePrefix",&prefix)
        .append_pair("order","desc").append_pair("limit",&bounded.to_string());
    let body = request_body(target, timeout_ms)?;
    let rows = body.get("events").and_then(Value::as_array)
        .ok_or("Events Bus release history returned an invalid payload")?;
    if body["order"]!="desc" || rows.len()>bounded {
        return Err("Events Bus release history returned a mismatched package".into());
    }
    let mut output=Vec::new();
    for row in rows {
        let event=&row["event"];
        if !event.pointer("/source/id").and_then(Value::as_str).is_some_and(|s|s.starts_with(&prefix)){return Err("Events Bus release history returned a mismatched package".into());}
        if let Some(event)=normalize_release_receipt(event){
            let mut normalized=row.clone(); normalized["event"]=event; output.push(normalized);
        }
    }
    Ok(output)
}

#[cfg(test)]
mod release_history_tests {
    use super::*;
    use std::{io::{Read,Write},net::TcpListener,thread};
    #[test]
    fn release_history_uses_generic_read_only_source_query(){
        let listener=TcpListener::bind("127.0.0.1:0").unwrap();
        let address=listener.local_addr().unwrap();
        let body=json!({"order":"desc","events":[{"cursor":4,"event":{
            "source":{"id":"release/fixture/abc"},"type":"package.published","data":{"jobId":"42"}}}]})
            .to_string();
        let response=body.clone();
        let server=thread::spawn(move||{
            let (mut stream,_)=listener.accept().unwrap();
            let mut request=[0u8;2048];let n=stream.read(&mut request).unwrap();
            let line=String::from_utf8_lossy(&request[..n]);
            assert!(line.starts_with("GET /events?sourcePrefix=release%2Ffixture%2F&order=desc&limit=500 HTTP/1.1"),"{line}");
            write!(stream,"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",response.len(),response).unwrap();
        });
        let rows=events_bus_release_history("fixture",usize::MAX,
            &json!({"apiUrl":format!("http://{address}")})).unwrap();
        server.join().unwrap();
        assert_eq!(rows.len(),1);
        assert_eq!(rows[0]["event"]["data"]["jobId"],"42");
    }
}
