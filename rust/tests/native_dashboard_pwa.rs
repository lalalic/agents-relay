use agents_relay_rust2::dashboard::{
    dashboard_config_script, dashboard_version, is_backend_route, serve_dashboard, static_response,
    DashboardBackend, DashboardRequest, DashboardResponse,
};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, Sender},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

#[derive(Default)]
struct FixtureBackend {
    received: Mutex<Vec<(String, String, Vec<u8>)>>,
    event_receiver: Mutex<Option<Receiver<String>>>,
}
impl DashboardBackend for FixtureBackend {
    fn api(&self, request: DashboardRequest<'_>) -> DashboardResponse {
        self.received.lock().unwrap().push((
            request.method.to_string(),
            request.target.to_string(),
            request.body.to_vec(),
        ));
        let body = serde_json::json!({"ok": true, "path": request.target}).to_string();
        DashboardResponse::new(200, "application/json", "no-store", body.into_bytes())
    }
    fn subscribe_events(&self) -> Receiver<String> {
        self.event_receiver
            .lock()
            .unwrap()
            .take()
            .expect("one test subscriber")
    }
}
fn running_server() -> (
    String,
    Arc<FixtureBackend>,
    Sender<String>,
    Arc<AtomicBool>,
    thread::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("127.0.0.1:{}", listener.local_addr().unwrap().port());
    let (tx, rx) = mpsc::channel();
    let backend = Arc::new(FixtureBackend {
        received: Mutex::new(Vec::new()),
        event_receiver: Mutex::new(Some(rx)),
    });
    let shutdown = Arc::new(AtomicBool::new(false));
    let handle = {
        let backend = Arc::clone(&backend);
        let shutdown = Arc::clone(&shutdown);
        thread::spawn(move || serve_dashboard(listener, backend, shutdown).unwrap())
    };
    (url, backend, tx, shutdown, handle)
}
fn request(addr: &str, raw: &str) -> Vec<u8> {
    let mut stream = TcpStream::connect(addr).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    stream.write_all(raw.as_bytes()).unwrap();
    let mut output = Vec::new();
    stream.read_to_end(&mut output).unwrap();
    output
}
fn response_body(bytes: &[u8]) -> &[u8] {
    let end = bytes
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .expect("HTTP headers");
    &bytes[end + 4..]
}

#[test]
fn pwa_static_assets_have_exact_shared_bytes_and_no_stale_runtime_state() {
    for (path, body, mime, cache) in [
        (
            "/dashboard.js",
            &include_bytes!("../../dashboard/dashboard.js")[..],
            "text/javascript",
            "no-cache",
        ),
        (
            "/dashboard.css",
            &include_bytes!("../../dashboard/dashboard.css")[..],
            "text/css",
            "no-cache",
        ),
        (
            "/vendor/markdown-it.min.js",
            &include_bytes!("../../dashboard/vendor/markdown-it.min.js")[..],
            "text/javascript",
            "no-cache",
        ),
        (
            "/pwa.js",
            &include_bytes!("../../dashboard/pwa.js")[..],
            "text/javascript",
            "no-cache",
        ),
        (
            "/service-worker.js",
            &include_bytes!("../../dashboard/service-worker.js")[..],
            "text/javascript",
            "no-cache",
        ),
        (
            "/manifest.webmanifest",
            &include_bytes!("../../dashboard/manifest.webmanifest")[..],
            "application/manifest+json",
            "no-cache",
        ),
        (
            "/icons/icon-180.png",
            &include_bytes!("../../dashboard/icons/icon-180.png")[..],
            "image/png",
            "no-cache",
        ),
        (
            "/icons/icon-192.png",
            &include_bytes!("../../dashboard/icons/icon-192.png")[..],
            "image/png",
            "no-cache",
        ),
        (
            "/icons/icon-512.png",
            &include_bytes!("../../dashboard/icons/icon-512.png")[..],
            "image/png",
            "no-cache",
        ),
    ] {
        let result = static_response("GET", path).unwrap();
        assert_eq!(result.status, 200, "{path}");
        assert_eq!(result.body, body, "{path}");
        assert!(result.content_type.starts_with(mime), "{path}");
        assert_eq!(result.cache_control, cache, "{path}");
        assert!(static_response("POST", path).is_none());
    }
    let page=String::from_utf8(static_response("GET","/").unwrap().body).unwrap();
    assert_eq!(page.replace(&format!("?v={}",dashboard_version()),""),
        include_str!("../../dashboard/index.html"),
        "native versioned HTML must be the same Node-owned template");
    for asset in ["/dashboard.css","/dashboard.js","/vendor/markdown-it.min.js"]{
        let url=format!("{asset}?v={}",dashboard_version());
        assert!(page.contains(&url),"{asset} requires immutable versioned URL");
        assert_eq!(static_response("GET",&url),static_response("GET",asset));
        for bad in [
            format!("{asset}?v=old"),
            format!("{asset}?v={}&v=old",dashboard_version()),
            format!("{asset}?v={}&extra=1",dashboard_version()),
        ]{
            assert!(static_response("GET",&bad).is_none(),
                "non-versioned or ambiguous asset query must be rejected: {bad}");
        }
    }
    assert!(static_response("GET", "/dashboard/../../secrets").is_none());
    assert!(static_response("GET", "/api/job?id=1").is_none());
    assert!(static_response("GET", "/events").is_none());
    let version: serde_json::Value =
        serde_json::from_slice(&static_response("GET", "/api/version").unwrap().body).unwrap();
    assert_eq!(version["version"], dashboard_version());
    assert!(dashboard_config_script().contains("buildJelDiagram:function jobJelDiagram("));
    assert!(dashboard_config_script().contains("\"statuses\":[\"DRAFT\",\"ACTIVE\",\"COMPLETED\"]"));
}

#[test]
fn rust_http_serves_pwa_delegates_api_and_streams_sse_events() {
    let (addr, backend, tx, shutdown, handle) = running_server();
    let page = request(&addr, "GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
    assert!(page.starts_with(b"HTTP/1.1 200 OK\r\n"));
    assert_eq!(
        response_body(&page),
        static_response("GET","/").unwrap().body.as_slice()
    );
    let js = request(
        &addr,
        "GET /dashboard.js HTTP/1.1\r\nHost: localhost\r\n\r\n",
    );
    assert_eq!(
        response_body(&js),
        include_bytes!("../../dashboard/dashboard.js")
    );
    let manifest = request(
        &addr,
        "GET /manifest.webmanifest HTTP/1.1\r\nHost: localhost\r\n\r\n",
    );
    assert_eq!(
        response_body(&manifest),
        include_bytes!("../../dashboard/manifest.webmanifest")
    );
    let config = request(
        &addr,
        "GET /dashboard-config.js HTTP/1.1\r\nHost: localhost\r\n\r\n",
    );
    assert_eq!(response_body(&config), dashboard_config_script().as_bytes());

    let payload = r#"{"command":"task.cancel","jobId":"9"}"#;
    let api = request(
        &addr,
        &format!(
            "POST /api/control HTTP/1.1\r\nHost: localhost\r\nContent-Length: {}\r\n\r\n{}",
            payload.len(),
            payload
        ),
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(response_body(&api)).unwrap()["path"],
        "/api/control"
    );
    let jobs = request(
        &addr,
        "GET /api/jobs?status=ACTIVE HTTP/1.1\r\nHost: localhost\r\n\r\n",
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(response_body(&jobs)).unwrap()["path"],
        "/api/jobs?status=ACTIVE"
    );
    let received = backend.received.lock().unwrap();
    assert_eq!(received[0].2, payload.as_bytes());
    assert_eq!(received[1].0, "GET");
    drop(received);

    let missing = request(
        &addr,
        "GET /icons/nope.png HTTP/1.1\r\nHost: localhost\r\n\r\n",
    );
    assert!(missing.starts_with(b"HTTP/1.1 404 Not Found"));

    let mut sse = TcpStream::connect(&addr).unwrap();
    sse.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    sse.write_all(b"GET /events HTTP/1.1\r\nHost: localhost\r\n\r\n")
        .unwrap();
    let mut bytes = vec![0u8; 1024];
    let count = sse.read(&mut bytes).unwrap();
    let header = String::from_utf8_lossy(&bytes[..count]);
    assert!(header.contains("Content-Type: text/event-stream"));
    assert!(header.contains(": connected"));
    tx.send("event: relay\ndata: {\"event\":\"test\"}\n\n".into())
        .unwrap();
    let count = sse.read(&mut bytes).unwrap();
    assert!(String::from_utf8_lossy(&bytes[..count]).contains("event: relay"));
    shutdown.store(true, Ordering::Relaxed);
    handle.join().unwrap();
}

#[test]
fn rust_dashboard_preserves_node_api_route_allowlist() {
    for route in [
        "/api/graph-symbol?symbol=job",
        "/api/troubleshooter-qa",
        "/api/graphs",
        "/api/jobs",
        "/api/control",
        "/api/job-action",
        "/api/task-command",
        "/api/task-action",
        "/api/job-state",
        "/api/task-state",
        "/api/job",
        "/api/events",
        "/api/execution-router-rules",
        "/api/router-test",
        "/api/decision-audit",
        "/api/runtime-summary",
        "/api/status",
        "/api/usage",
    ] {
        assert!(is_backend_route("GET", route), "{route}");
    }
    assert!(is_backend_route("POST", "/webhooks/github"));
    assert!(!is_backend_route("GET", "/webhooks/github"));
    assert!(!is_backend_route("GET", "/api/private"));
}

#[test]
fn rust_runtime_config_is_byte_identical_to_node_config() {
    use std::{path::Path, process::Command};
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let output = Command::new("node")
        .args([
            "--input-type=module",
            "-e",
            "import { dashboardConfigScript } from './dist/dashboard-html.js'; process.stdout.write(dashboardConfigScript());",
        ])
        .current_dir(root)
        .output()
        .expect("Node runtime is required for differential test");
    assert!(
        output.status.success(),
        "Node config error: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        output.stdout,
        dashboard_config_script().as_bytes(),
        "Node/Rust live config JS differs"
    );
}
