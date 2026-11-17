// Direct Rust native regression: src/troubleshooter-qa-api.ts and src/webhelm-daemon-client.ts with isolated real IO.
use agents_relay_rust2::{troubleshooter_qa_api as qa, webhelm_daemon_client as wh};
use serde_json::{json, Map, Value};
use std::{
    fs,
    io::Read,
    os::unix::net::UnixListener,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

fn temp() -> PathBuf {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::path::PathBuf::from("/tmp").join(format!("r2-{}-{now}", std::process::id()))
}

#[test]
fn qa_get_uses_node_utf8_replacement_and_hash() {
    use sha2::{Digest, Sha256};
    let root = temp();
    fs::create_dir_all(&root).unwrap();
    let file = root.join("qa.md");
    fs::write(&file, [0x66, 0x6f, 0x80]).unwrap();
    let result = qa::handle_troubleshooter_qa(
        &file,
        qa::Request {
            method: "GET".into(),
            content_type: None,
            body: vec![],
        },
    );
    assert_eq!(result.status, 200);
    let body: Value = serde_json::from_slice(&result.body).unwrap();
    assert_eq!(body["text"], "fo�");
    assert_eq!(
        body["hash"],
        format!("{:x}", Sha256::digest("fo�".as_bytes()))
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn webhelm_native_request_handles_live_cancelled_unix_stream() {
    let dir = temp();
    fs::create_dir_all(&dir).unwrap();
    let sock = dir.join("webhelm.sock");
    let listener = UnixListener::bind(&sock).unwrap();
    let server = thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        let mut buffer = [0; 1024];
        let read = socket.read(&mut buffer).unwrap();
        assert!(read > 0);
        thread::sleep(Duration::from_millis(150));
    });
    let cancelled = Arc::new(AtomicBool::new(false));
    let canceller = Arc::clone(&cancelled);
    let cancel_thread = thread::spawn(move || {
        thread::sleep(Duration::from_millis(40));
        canceller.store(true, Ordering::Release);
    });
    let request = wh::DaemonRequest {
        op: "capacity".into(),
        fields: Map::new(),
    };
    assert_eq!(
        wh::request_with_cancel(
            sock.to_str().unwrap(),
            &request,
            Duration::from_secs(2),
            Some(&cancelled)
        )
        .unwrap_err(),
        "WebHelm daemon request aborted"
    );
    cancel_thread.join().unwrap();
    server.join().unwrap();
    // The cancellation assertion is complete; parallel temp cleanup may have
    // removed this test-only socket directory already. Do not fail on ENOENT.
    if let Err(error) = fs::remove_dir_all(dir) {
        assert_eq!(error.kind(), std::io::ErrorKind::NotFound, "{error}");
    }
}

#[test]
fn native_webhelm_framing_and_truthy_error_results() {
    assert_eq!(
        wh::parse_response(br#"{"ok":true,"result":5}"#, "capacity").unwrap()["result"],
        5
    );
    assert_eq!(
        wh::parse_response(br#"{"error":42}"#, "capacity").unwrap_err(),
        "42"
    );
    assert_eq!(
        wh::parse_response(br#"{"error":{}}"#, "capacity").unwrap_err(),
        "[object Object]"
    );
    assert_eq!(
        wh::parse_response(br#"{"error":[],"ok":true}"#, "capacity").unwrap_err(),
        ""
    );
    assert_eq!(
        wh::parse_response(b"null", "capacity").unwrap_err(),
        "Cannot read properties of null (reading 'error')"
    );
    let req = wh::DaemonRequest {
        op: "capacity".into(),
        fields: serde_json::from_value(json!({"name":"test"})).unwrap(),
    };
    let aborted = AtomicBool::new(true);
    assert_eq!(
        wh::request_with_cancel("/none", &req, Duration::from_millis(1), Some(&aborted))
            .unwrap_err(),
        "WebHelm daemon request aborted"
    );
}
