// Node provenance: src/webhelm-daemon-client.ts; performs newline-delimited JSON IPC over the configured WebHelm Unix socket.
use serde_json::{Map, Value};
use std::{
    io::{BufReader, Read, Write},
    os::unix::net::UnixStream,
    path::PathBuf,
    time::Duration,
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
    let mut stream = UnixStream::connect(socket).map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|e| e.to_string())?;
    let mut v = req.fields.clone();
    v.insert("op".into(), Value::String(req.op.clone()));
    let mut bytes = serde_json::to_vec(&v).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    stream.write_all(&bytes).map_err(|e| e.to_string())?;
    let mut line = Vec::new();
    let mut reader = BufReader::new(stream);
    let mut total = 0;
    loop {
        let mut b = [0];
        match reader.read_exact(&mut b) {
            Ok(()) => {
                total += 1;
                if total > 2_000_000 {
                    return Err("WebHelm daemon response exceeds limit".into());
                }
                if b[0] == b'\n' {
                    break;
                }
                line.push(b[0]);
            }
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                return Err(timeout_error(&req.op))
            }
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                return Err("WebHelm daemon closed without a response".into())
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    parse_response(&line, &req.op)
}
pub fn parse_response(line: &[u8], op: &str) -> Result<Value, String> {
    let result: Value = serde_json::from_slice(line).map_err(|e| e.to_string())?;
    if let Some(err) = result.get("error").filter(|v| !v.is_null() && *v != "") {
        return Err(err
            .as_str()
            .unwrap_or("WebHelm daemon rejected request")
            .into());
    }
    if result.get("ok") == Some(&Value::Bool(false)) {
        return Err("WebHelm daemon rejected request".into());
    }
    let _ = op;
    Ok(result)
}
pub fn timeout_error(op: &str) -> String {
    format!("WebHelm daemon {op} timed out")
}
