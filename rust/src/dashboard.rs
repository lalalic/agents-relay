// Node provenance: src/dashboard.ts. Native serveDashboard HTTP/PWA/SSE transport.
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
        Arc,
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
    env!("CARGO_PKG_VERSION")
}
pub fn source_revision() -> Option<String> {
    let valid = |value: &str| value.len() == 40 && value.bytes().all(|b| b.is_ascii_hexdigit());
    // A running installed executable must retain its own immutable identity
    // even during a live symlink switch before the service restarts.
    if let Ok(exe) = std::env::current_exe().and_then(|path| path.canonicalize()) {
        if let Some(root) = exe.parent().and_then(|bin| bin.parent()) {
            if let Ok(value) = std::fs::read_to_string(root.join("SOURCE_REVISION")) {
                let value = value.trim();
                if valid(value) { return Some(value.to_owned()); }
            }
        }
    }
    let root = crate::runtime_resources::package_root().ok();
    // Immutable package identity wins over a stale launcher override.
    if let Some(root) = &root {
        if let Ok(value) = std::fs::read_to_string(root.join("SOURCE_REVISION")) {
            let value = value.trim();
            if valid(value) { return Some(value.to_owned()); }
        }
    }
    if let Ok(value) = std::env::var("AGENTS_RELAY_WORKFLOW_SOURCE_REF") {
        if valid(&value) { return Some(value); }
    }
    let root = root?;
    let output = Command::new("git")
        .args(["-C", root.to_str()?, "rev-parse", "HEAD"])
        .output().ok()?;
    if !output.status.success() { return None; }
    let revision = String::from_utf8(output.stdout).ok()?.trim().to_owned();
    valid(&revision).then_some(revision)
}
pub fn dashboard_asset_version() -> String {
    match source_revision() {
        Some(sha) => format!("{}-{sha}", dashboard_version()),
        None => dashboard_version().to_owned(),
    }
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
    // Original Node server checks req.url === '/api/version' without a
    // method guard. Preserve that exact route before the GET-only PWA
    // allowlist; do not accept query variants or silently map POST to 404.
    if target=="/api/version"{
        return Some(DashboardResponse::new(
            200,"application/json","no-store",
            serde_json::json!({"version":dashboard_version(),"sourceRef":source_revision()})
                .to_string().into_bytes()));
    }
    if method != "GET" {
        return None;
    }
    // The original Node static asset lookup uses new URL(req.url, base).
    // WHATWG URL normalizes /foo/../../assets and encoded dot segments
    // before applying the *fixed* allowlist; naive string splitting
    // incorrectly returned 404 for those accepted canonical paths.
    let normalized=url::Url::parse(&format!("http://127.0.0.1{target}")).ok()?;
    let path=normalized.path();
    let query=normalized.query().unwrap_or("");
    if !query.is_empty() {
        let mut pairs = url::form_urlencoded::parse(query.as_bytes());
        if !pairs.next().is_some_and(|(key, value)| key == "v" && value == dashboard_asset_version())
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
            let version=dashboard_asset_version();
            let html=include_str!("../../dashboard/index.html")
                .replace(r#"href="./dashboard.css""#, &format!(r#"href="./dashboard.css?v={version}""#))
                .replace(r#"src="./vendor/markdown-it.min.js""#, &format!(r#"src="./vendor/markdown-it.min.js?v={version}""#))
                .replace(r#"src="./dashboard.js""#, &format!(r#"src="./dashboard.js?v={version}""#));
            Some(DashboardResponse::new(200,"text/html; charset=utf-8","no-store",
                html.into_bytes()))
        },
        "/dashboard-config.js" if target=="/dashboard-config.js" => Some(DashboardResponse::new(
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
        _ => None,
    }
}
pub fn is_backend_route(method: &str, target: &str) -> bool {
    let path = target.split('?').next().unwrap_or("");
    (path == "/webhooks/github" && method == "POST")
        || path.starts_with("/api/mobile/")
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
/// A blocking Darwin localhost socket can still transiently return EAGAIN
/// while writing a large Job/Task JSON response. Keep the exact write offset
/// across retries: restarting write_all from the beginning would duplicate
/// bytes after a partial successful send and corrupt Content-Length framing.
fn write_full_retry(mut sink:impl Write,mut remaining:&[u8])->io::Result<()>{
    let started=Instant::now();
    while !remaining.is_empty(){
        match sink.write(remaining){
            Ok(0)=>return Err(io::Error::new(io::ErrorKind::WriteZero,
                "Dashboard HTTP stream closed before response completed")),
            Ok(n)=>remaining=&remaining[n..],
            Err(error) if matches!(error.kind(),
                io::ErrorKind::WouldBlock|io::ErrorKind::TimedOut|io::ErrorKind::Interrupted)
                &&started.elapsed()<Duration::from_secs(5)=>{
                thread::sleep(Duration::from_millis(5));
            },
            Err(error)=>return Err(error),
        }
    }
    Ok(())
}
fn write_response(stream: &mut TcpStream, response: DashboardResponse) -> io::Result<()> {
    let headers = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nCache-Control: {}\r\nX-Content-Type-Options: nosniff\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        response.status, status_text(response.status), response.content_type,
        response.cache_control, response.body.len(),
    );
    write_full_retry(&mut *stream,headers.as_bytes())?;
    write_full_retry(&mut *stream,&response.body)
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
/// Never forward Dashboard's potentially private JSON to Mobile subscribers.
/// An authenticated Mobile SSE stream is only a wake-up signal.
fn mobile_change_frame(frame: &str) -> Option<&'static [u8]> {
    let has_change = frame.lines().filter_map(|line| line.strip_prefix("data:"))
        .filter_map(|data| serde_json::from_str::<serde_json::Value>(data.trim()).ok())
        .any(|payload| payload.get("event").is_some_and(|v| v.is_object())
            || payload.get("job").is_some_and(|v| v.is_object()));
    has_change.then_some(b"event: change\ndata: {\"refresh\":true}\n\n")
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
    if method == "GET" && (target == "/events" || target == "/api/mobile/events") {
        let mobile = target == "/api/mobile/events";
        stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\nX-Content-Type-Options: nosniff\r\n\r\n: connected\n\n")?;
        let receiver = backend.subscribe_events();
        let mut last_heartbeat = Instant::now();
        while !shutdown.load(Ordering::Relaxed) {
            match receiver.recv_timeout(Duration::from_millis(200)) {
                Ok(frame) => {
                    if mobile {
                        if let Some(safe) = mobile_change_frame(&frame) {
                            stream.write_all(safe)?;
                        }
                    } else {
                        stream.write_all(frame.as_bytes())?;
                    }
                },
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


#[cfg(test)]
mod write_retry_tests{
    use super::*;
    #[test]
    fn mobile_sse_never_leaks_dashboard_job_or_event_payload() {
        let event = r#"event: relay
data: {"event":{"type":"task.progress","message":"PRIVATE PROMPT","path":"/Users/private/secret"}}

"#;
        let projected = b"event: change\ndata: {\"refresh\":true}\n\n".as_slice();
        assert_eq!(mobile_change_frame(event), Some(projected));
        assert_eq!(mobile_change_frame("data: {\"job\":{\"id\":\"694\",\"prompt\":\"PRIVATE\"}}\n\n"),Some(projected));
        assert_eq!(mobile_change_frame(": heartbeat\n\n"),None);
        assert_eq!(mobile_change_frame("data: invalid-json\n\n"),None);
        assert_eq!(mobile_change_frame("data: {\"unexpected\":\"PRIVATE\"}\n\n"),None);
    }
    #[derive(Default)]
    struct InterruptedWriter{
        writes:usize,
        bytes:Vec<u8>,
    }
    impl Write for InterruptedWriter{
        fn write(&mut self,buf:&[u8])->io::Result<usize>{
            self.writes+=1;
            match self.writes{
                1=>Err(io::Error::from(io::ErrorKind::WouldBlock)),
                2=>{
                    self.bytes.extend_from_slice(&buf[..3]);
                    Ok(3)
                },
                3=>Err(io::Error::from(io::ErrorKind::Interrupted)),
                _=>{
                    self.bytes.extend_from_slice(buf);
                    Ok(buf.len())
                },
            }
        }
        fn flush(&mut self)->io::Result<()> {Ok(())}
    }
    #[test]
    fn mobile_sse_loopback_streams_only_sanitized_wakeups() {
        use std::sync::{mpsc, Mutex};
        use std::io::{Read, Write};
        struct Fixture { sender: Mutex<Option<mpsc::Sender<String>>> }
        impl DashboardBackend for Fixture {
            fn api(&self, _req: DashboardRequest<'_>) -> DashboardResponse {
                DashboardResponse::text(404,"Not found")
            }
            fn subscribe_events(&self) -> mpsc::Receiver<String> {
                let (sender, receiver) = mpsc::channel();
                *self.sender.lock().unwrap() = Some(sender);
                receiver
            }
        }
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let backend = Arc::new(Fixture { sender: Mutex::new(None) });
        let shutdown = Arc::new(AtomicBool::new(false));
        let server = {
            let backend = Arc::clone(&backend);
            let shutdown = Arc::clone(&shutdown);
            thread::spawn(move || serve_dashboard(listener,backend,shutdown).unwrap())
        };
        let mut client=TcpStream::connect(("127.0.0.1",port)).unwrap();
        client.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        client.write_all(b"GET /api/mobile/events HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").unwrap();
        let sender = (0..80).find_map(|_| {
            if let Some(s) = backend.sender.lock().unwrap().clone() { return Some(s); }
            thread::sleep(Duration::from_millis(20));
            None
        }).expect("SSE client should subscribe");
        sender.send("event: relay\ndata: {\"event\":{\"type\":\"task.progress\",\"message\":\"PRIVATE\"}}\n\n".into()).unwrap();
        let mut response=Vec::new();
        let mut buf=[0u8;2048];
        for _ in 0..8 {
            let n=client.read(&mut buf).unwrap();
            response.extend_from_slice(&buf[..n]);
            if response.windows(b"event: change\n".len()).any(|w|w==b"event: change\n"){break;}
        }
        let response=String::from_utf8(response).unwrap();
        assert!(response.contains("HTTP/1.1 200 OK"),"{response}");
        assert!(response.contains("Content-Type: text/event-stream"),"{response}");
        assert!(response.contains("event: change\ndata: {\"refresh\":true}\n\n"),"{response}");
        assert!(!response.contains("PRIVATE"),"SSE exposed private event data");
        shutdown.store(true,Ordering::Relaxed);
        drop(client);
        server.join().unwrap();
    }

    #[test]
    fn transient_dashboard_write_keeps_exact_partial_content_length_bytes(){
        let bytes=b"Content-Length: 42\r\n\r\nreliable response body";
        let mut writer=InterruptedWriter::default();
        write_full_retry(&mut writer,bytes).unwrap();
        assert_eq!(writer.bytes,bytes);
        assert_eq!(writer.writes,4);
    }

    #[test]
    fn real_loopback_dashboard_streams_large_job_response_without_truncation(){
        let listener=TcpListener::bind("127.0.0.1:0").unwrap();
        let address=listener.local_addr().unwrap();
        let expected=900_000;
        let server=thread::spawn(move||{
            let (mut stream,_)=listener.accept().unwrap();
            write_response(&mut stream,DashboardResponse::new(200,
                "application/json","no-store",vec![b'X';expected])).unwrap();
        });
        let mut client=TcpStream::connect(address).unwrap();
        client.set_read_timeout(Some(Duration::from_secs(8))).unwrap();
        let mut response=Vec::new();
        client.read_to_end(&mut response).unwrap();
        let boundary=response.windows(4).position(|b|b==b"\r\n\r\n").unwrap();
        let headers=std::str::from_utf8(&response[..boundary]).unwrap();
        assert!(headers.contains(&format!("Content-Length: {expected}\r\n")));
        let body=&response[boundary+4..];
        assert_eq!(body.len(),expected);
        assert!(body.iter().all(|b|*b==b'X'));
        server.join().unwrap();
    }
}
