// Node provenance: src/webhelm-daemon-client.ts; performs newline-delimited JSON IPC over the configured WebHelm Unix socket.
use serde_json::{Map, Value};
use std::{
    io::{Read, Write},
    os::unix::net::UnixStream,
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
#[derive(Debug, Clone, PartialEq)]
pub struct DaemonRequest {
    pub op: String,
    pub fields: Map<String, Value>,
}
pub fn daemon_socket(env_get: impl Fn(&str) -> Option<String>, home: Option<String>) -> PathBuf {
    if let Some(p) = env_get("WEBHELM_SOCKET").filter(|x| !x.is_empty()) {
        return p.into();
    }
    let base = env_get("WEBHELM_RUNTIME_DIR")
        .filter(|x| !x.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            env_get("WEBHELM_CONFIG_ROOT")
                .filter(|x| !x.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    PathBuf::from(home.unwrap_or_else(|| ".".into())).join(".config/webhelm")
                })
                .join("runtime")
        });
    base.join("session-node.sock")
}
pub fn request(socket: &str, req: &DaemonRequest, timeout: Duration) -> Result<Value, String> {
    request_with_cancel(socket, req, timeout, None)
}

/// A cancellation token is the Rust equivalent of Node's AbortSignal.
/// Poll a short read window while preserving Node's overall idle timeout.
pub fn request_with_cancel(
    socket: &str,
    req: &DaemonRequest,
    timeout: Duration,
    cancelled: Option<&AtomicBool>,
) -> Result<Value, String> {
    let aborted = || cancelled.is_some_and(|token| token.load(Ordering::Acquire));
    if aborted() {
        return Err("WebHelm daemon request aborted".into());
    }
    let mut stream = UnixStream::connect(socket).map_err(|e| e.to_string())?;
    // Node's socket.setTimeout(0) disables the idle timeout entirely.
    let check_interval = Duration::from_millis(25);
    let read_window = if cancelled.is_some() {
        Some(if timeout.is_zero() {
            check_interval
        } else {
            timeout.min(check_interval)
        })
    } else if timeout.is_zero() {
        None
    } else {
        Some(timeout)
    };
    stream
        .set_read_timeout(read_window)
        .map_err(|e| e.to_string())?;
    if !timeout.is_zero() {
        stream
            .set_write_timeout(Some(timeout))
            .map_err(|e| e.to_string())?;
    }
    let mut v = req.fields.clone();
    v.insert("op".into(), Value::String(req.op.clone()));
    let mut bytes = serde_json::to_vec(&v).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    stream.write_all(&bytes).map_err(|e| e.to_string())?;
    let mut line = Vec::new();
    let mut last_read = Instant::now();
    // Read in socket-sized blocks. The original 1-byte reader caused millions
    // of syscall-layer iterations on large valid UTF-8 responses.
    let mut chunk = [0u8; 8192];
    loop {
        if aborted() {
            return Err("WebHelm daemon request aborted".into());
        }
        match stream.read(&mut chunk) {
            Ok(0) => return Err("WebHelm daemon closed without a response".into()),
            Ok(size) => {
                last_read = Instant::now();
                line.extend_from_slice(&chunk[..size]);
                // Node tracks the decoded JS string's UTF-16 length, not UTF8
                // bytes. Only a buffer over 2M raw bytes needs a full scan.
                if line.len() > 2_000_000
                    && String::from_utf8_lossy(&line).encode_utf16().count() > 2_000_000
                {
                    return Err("WebHelm daemon response exceeds limit".into());
                }
                if let Some(index) = line.iter().position(|&b| b == b'\n') {
                    return parse_response(&line[..index], &req.op);
                }
            }
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                if aborted() {
                    return Err("WebHelm daemon request aborted".into());
                }
                if timeout.is_zero() || last_read.elapsed() < timeout {
                    continue;
                }
                return Err(timeout_error(&req.op));
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}
fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::Number(number) => number.as_f64() != Some(0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(value) => value.to_string(),
        Value::String(value) => value.clone(),
        Value::Number(number) => number.to_string(),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if item.is_null() {
                    "".into()
                } else {
                    js_string(item)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

pub fn parse_response(line: &[u8], _op: &str) -> Result<Value, String> {
    // Node socket.setEncoding('utf8') decodes malformed bytes lossily before
    // JSON.parse; preserve that behavior at this transport boundary.
    let text = String::from_utf8_lossy(line);
    let result: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    if result.is_null() {
        return Err("Cannot read properties of null (reading 'error')".into());
    }
    if let Some(error) = result.get("error").filter(|error| js_truthy(error)) {
        return Err(js_string(error));
    }
    if result.get("ok") == Some(&Value::Bool(false)) {
        return Err("WebHelm daemon rejected request".into());
    }
    Ok(result)
}
pub fn timeout_error(op: &str) -> String {
    format!("WebHelm daemon {op} timed out")
}

/// Direct counterpart of Node src/webhelm-daemon-client.ts's exported request
/// handler; caller supplies the configured socket and optional timeout.
pub fn web_helm_daemon_request(
    socket: &str,
    request: &DaemonRequest,
    timeout: Duration,
) -> Result<Value, String> {
    self::request(socket, request, timeout)
}
