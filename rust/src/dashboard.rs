//! Native Dashboard transport adapter. Shared PWA assets are compiled as Rust resources.
//! Job/Task persistence and Event Bus authority stay with the runtime-supplied backend.

use crate::dashboard_data::DEFAULT_DASHBOARD_JOB_STATUSES;
use std::{
    collections::HashMap,
    io::{self, Read, Write},
    net::{TcpListener, TcpStream},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{Receiver, RecvTimeoutError},
        Arc, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardResponse {
    pub status: u16,
    pub content_type: &'static str,
    pub cache_control: &'static str,
    pub body: Vec<u8>,
}
impl DashboardResponse {
    pub fn new(
        status: u16,
        content_type: &'static str,
        cache_control: &'static str,
        body: Vec<u8>,
    ) -> Self {
        Self {
            status,
            content_type,
            cache_control,
            body,
        }
    }
    fn text(status: u16, body: &str) -> Self {
        Self::new(
            status,
            "text/plain; charset=utf-8",
            "no-store",
            body.as_bytes().to_vec(),
        )
    }
}
pub struct DashboardRequest<'a> {
    pub method: &'a str,
    pub target: &'a str,
    pub body: &'a [u8],
    /// Lowercase HTTP header names, preserved for authenticated webhook
    /// verification by the native Graph/SQLite API backend.
    pub headers: &'a HashMap<String, String>,
}
pub trait DashboardBackend: Send + Sync + 'static {
    /// Must use the authoritative Graph and SQLite lifecycle, same as CLI.
    fn api(&self, request: DashboardRequest<'_>) -> DashboardResponse;
    /// Deliver complete SSE frames from the authoritative event bus.
    fn subscribe_events(&self) -> Receiver<String>;
}
pub fn dashboard_version() -> &'static str {
    static VERSION: OnceLock<String> = OnceLock::new();
    VERSION.get_or_init(|| {
        serde_json::from_str::<serde_json::Value>(include_str!("../../package.json"))
            .ok()
            .and_then(|pkg| pkg.get("version")?.as_str().map(str::to_owned))
            .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_owned())
    })
}
fn source_revision() -> Option<String> {
    let valid = |value: &str| value.len() == 40 && value.bytes().all(|b| b.is_ascii_hexdigit());
    if let Ok(value) = std::env::var("AGENTS_RELAY_WORKFLOW_SOURCE_REF") {
        if valid(&value) {
            return Some(value);
        }
    }
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent()?;
    let output = Command::new("git")
        .args(["-C", root.to_str()?, "rev-parse", "HEAD"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let revision = String::from_utf8(output.stdout).ok()?.trim().to_owned();
    valid(&revision).then_some(revision)
}
pub fn dashboard_config_script() -> String {
    let version = serde_json::to_string(dashboard_version()).expect("version JSON");
    let source_ref = serde_json::to_string(&source_revision()).expect("revision JSON");
    let statuses = serde_json::to_string(&DEFAULT_DASHBOARD_JOB_STATUSES).expect("status JSON");
    let jel = include_str!("../../dashboard/jel-function.js").trim_end();
    format!(
        "window.__RELAY_DASHBOARD_CONFIG=Object.assign({{\"version\":{version},\"sourceRef\":{source_ref},\"statuses\":{statuses}}},{{buildJelDiagram:{jel}}});\n\
document.querySelector('.version').textContent='v'+window.__RELAY_DASHBOARD_CONFIG.version;\n"
    )
}
/// Exact public path allowlist. No HTTP-supplied path is used in filesystem I/O.
/// Canonical shared PWA assets. The original Node server uses immutable
/// versioned paths to survive a CDN cache that can ignore no-cache headers.
/// Keep the native server's HTML/asset allowlist identical: no arbitrary query
/// strings or filesystem paths, and never cache the runtime config.
pub fn static_response(method: &str, target: &str) -> Option<DashboardResponse> {
    if method != "GET" {
        return None;
    }
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if !query.is_empty() {
        let mut pairs = url::form_urlencoded::parse(query.as_bytes());
        if !pairs.next().is_some_and(|(key, value)| key == "v" && value == dashboard_version())
            || pairs.next().is_some()
        {
            return None;
        }
    }
    let fixed = |mime, cache, bytes: &'static [u8]| {
        DashboardResponse::new(200, mime, cache, bytes.to_vec())
    };
    match path {
        "/" if target == "/" => {
            let version=dashboard_version();
            let html=include_str!("../../dashboard/index.html")
                .replace(r#"href="/dashboard.css""#, &format!(r#"href="/dashboard.css?v={version}""#))
                .replace(r#"src="/vendor/markdown-it.min.js""#, &format!(r#"src="/vendor/markdown-it.min.js?v={version}""#))
                .replace(r#"src="/dashboard.js""#, &format!(r#"src="/dashboard.js?v={version}""#));
            Some(DashboardResponse::new(200,"text/html; charset=utf-8","no-store",
                html.into_bytes()))
        },
        "/dashboard-config.js" => Some(DashboardResponse::new(
            200,
            "text/javascript; charset=utf-8",
            "no-store",
            dashboard_config_script().into_bytes(),
        )),
        "/dashboard.js" => Some(fixed(
            "text/javascript; charset=utf-8",
            "no-cache",
            include_bytes!("../../dashboard/dashboard.js"),
        )),
        "/vendor/markdown-it.min.js" => Some(fixed(
            "text/javascript; charset=utf-8",
            "no-cache",
            include_bytes!("../../dashboard/vendor/markdown-it.min.js"),
        )),
        "/dashboard.css" => Some(fixed(
            "text/css; charset=utf-8",
            "no-cache",
            include_bytes!("../../dashboard/dashboard.css"),
        )),
        "/pwa.js" => Some(fixed(
            "text/javascript; charset=utf-8",
            "no-cache",
            include_bytes!("../../dashboard/pwa.js"),
        )),
        "/service-worker.js" => Some(fixed(
            "text/javascript; charset=utf-8",
            "no-cache",
            include_bytes!("../../dashboard/service-worker.js"),
        )),
        "/manifest.webmanifest" => Some(fixed(
            "application/manifest+json; charset=utf-8",
            "no-cache",
            include_bytes!("../../dashboard/manifest.webmanifest"),
        )),
        "/icons/icon-180.png" => Some(fixed(
            "image/png",
            "no-cache",
            include_bytes!("../../dashboard/icons/icon-180.png"),
        )),
        "/icons/icon-192.png" => Some(fixed(
            "image/png",
            "no-cache",
            include_bytes!("../../dashboard/icons/icon-192.png"),
        )),
        "/icons/icon-512.png" => Some(fixed(
            "image/png",
            "no-cache",
            include_bytes!("../../dashboard/icons/icon-512.png"),
        )),
        "/api/version" => Some(DashboardResponse::new(
            200,
            "application/json",
            "no-store",
            serde_json::json!({"version": dashboard_version()})
                .to_string()
                .into_bytes(),
        )),
        _ => None,
    }
}
pub fn is_backend_route(method: &str, target: &str) -> bool {
    let path = target.split('?').next().unwrap_or("");
    (path == "/webhooks/github" && method == "POST")
        || matches!(
            path,
            "/api/graph-symbol"
                | "/api/troubleshooter-qa"
                | "/api/graphs"
                | "/api/jobs"
                | "/api/control"
                | "/api/job-action"
                | "/api/task-command"
                | "/api/task-action"
                | "/api/job-state"
                | "/api/task-state"
                | "/api/job"
                | "/api/events"
                | "/api/execution-router-rules"
                | "/api/router-test"
                | "/api/decision-audit"
                | "/api/runtime-summary"
                | "/api/status"
                | "/api/usage"
        )
}
fn status_text(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        413 => "Payload Too Large",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "Response",
    }
}
fn write_response(stream: &mut TcpStream, response: DashboardResponse) -> io::Result<()> {
    let headers = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nCache-Control: {}\r\nX-Content-Type-Options: nosniff\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        response.status, status_text(response.status), response.content_type,
        response.cache_control, response.body.len(),
    );
    stream.write_all(headers.as_bytes())?;
    stream.write_all(&response.body)
}
fn read_request(stream: &mut TcpStream) -> io::Result<(String, String, Vec<u8>, HashMap<String, String>)> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let mut bytes = Vec::new();
    let header_end = loop {
        let mut buf = [0u8; 8192];
        let n = stream.read(&mut buf)?;
        if n == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "empty request",
            ));
        }
        bytes.extend_from_slice(&buf[..n]);
        if bytes.len() > 1024 * 1024 + 16 * 1024 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "request too large",
            ));
        }
        if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
            if end > 16 * 1024 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "headers too large",
                ));
            }
            break end + 4;
        }
    };
    let header = std::str::from_utf8(&bytes[..header_end])
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "header encoding"))?;
    let mut parts = header.lines().next().unwrap_or("").split_whitespace();
    let method = parts.next().unwrap_or("").to_owned();
    let target = parts.next().unwrap_or("").to_owned();
    if !matches!(
        method.as_str(),
        "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD"
    ) || !target.starts_with('/')
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid request line",
        ));
    }
    let mut headers=HashMap::new();
    for line in header.lines().skip(1) {
        let line=line.trim_end_matches('\r');
        if line.is_empty() { break; }
        let (name,value)=line.split_once(':').ok_or_else(||
            io::Error::new(io::ErrorKind::InvalidData,"malformed HTTP header"))?;
        let name=name.trim().to_ascii_lowercase();
        if name.is_empty()||!name.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-') {
            return Err(io::Error::new(io::ErrorKind::InvalidData,"invalid HTTP header name"));
        }
        if headers.insert(name,value.trim().to_owned()).is_some() {
            return Err(io::Error::new(io::ErrorKind::InvalidData,"duplicate HTTP header"));
        }
    }
    let length = headers.get("content-length")
        .map(|raw|raw.parse::<usize>().map_err(|_|io::Error::new(
            io::ErrorKind::InvalidData,"invalid content-length")))
        .transpose()?.unwrap_or(0);
    if length > 1024 * 1024 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "body too large"));
    }
    let mut body = bytes[header_end..].to_vec();
    while body.len() < length {
        let mut buf = [0u8; 8192];
        let n = stream.read(&mut buf)?;
        if n == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "truncated body",
            ));
        }
        body.extend_from_slice(&buf[..n]);
    }
    body.truncate(length);
    Ok((method, target, body, headers))
}
fn handle_connection<B: DashboardBackend>(
    mut stream: TcpStream,
    backend: Arc<B>,
    shutdown: Arc<AtomicBool>,
) -> io::Result<()> {
    let (method, target, body, headers) = match read_request(&mut stream) {
        Ok(value) => value,
        Err(error) => {
            let _ = write_response(
                &mut stream,
                DashboardResponse::text(400, &error.to_string()),
            );
            return Err(error);
        }
    };
    if let Some(response) = static_response(&method, &target) {
        return write_response(&mut stream, response);
    }
    if method == "GET" && target == "/events" {
        stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\nX-Content-Type-Options: nosniff\r\n\r\n: connected\n\n")?;
        let receiver = backend.subscribe_events();
        let mut last_heartbeat = Instant::now();
        while !shutdown.load(Ordering::Relaxed) {
            match receiver.recv_timeout(Duration::from_millis(200)) {
                Ok(frame) => stream.write_all(frame.as_bytes())?,
                Err(RecvTimeoutError::Disconnected) => break,
                Err(RecvTimeoutError::Timeout) => {}
            }
            if last_heartbeat.elapsed() >= Duration::from_secs(15) {
                stream.write_all(b": heartbeat\n\n")?;
                last_heartbeat = Instant::now();
            }
        }
        return Ok(());
    }
    if is_backend_route(&method, &target) {
        return write_response(
            &mut stream,
            backend.api(DashboardRequest {
                method: &method,
                target: &target,
                body: &body,
                headers: &headers,
            }),
        );
    }
    write_response(&mut stream, DashboardResponse::text(404, "Not found"))
}
/// The runtime supplies a durable API/event backend and controls stop explicitly.
/// This transport never starts or replaces any production daemon implicitly.
pub fn serve_dashboard<B: DashboardBackend>(
    listener: TcpListener,
    backend: Arc<B>,
    shutdown: Arc<AtomicBool>,
) -> io::Result<()> {
    listener.set_nonblocking(true)?;
    while !shutdown.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok((stream, _)) => {
                let backend = Arc::clone(&backend);
                let shutdown = Arc::clone(&shutdown);
                thread::spawn(move || {
                    let _ = handle_connection(stream, backend, shutdown);
                });
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(20))
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
}
