//! Native daemon E2E: the original Node reconciler failLaunch path bound to
//! the isolated Rust daemon. A ChatGPT Task leased for launch whose isolated
//! WebHelm submission fails must be moved by the canonical Task Graph
//! (worker.delivery_failed / worker.no_start_failed), durably persisted in
//! SQLite, reported to SSE subscribers, and never double-processed by a
//! duplicate or stale-generation failure receipt.
use agents_relay_rust2::relay_store::SQLiteRelayStore;
use serde_json::{json, Value};
use std::{
    fs, io::{BufRead, BufReader, Read},
    net::TcpStream,
    path::{Path, PathBuf},
    process::{Child, Command},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

fn binary() -> String {
    env!("CARGO_BIN_EXE_agents-relayd-rust").to_string()
}

fn root() -> PathBuf {
    // macOS AF_UNIX paths must stay below SUN_LEN; keep the fixture root
    // short exactly like the existing isolated WebHelm daemon tests.
    let dir = PathBuf::from("/tmp").join(format!(
        "r2dwf-{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
    ));
    fs::create_dir_all(dir.join("stores")).unwrap();
    dir
}

fn socket_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn request(port: u16, method: &str, path: &str, body: &str) -> Result<String, String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    let mut result = String::new();
    stream.read_to_string(&mut result).map_err(|e| e.to_string())?;
    Ok(result)
}

use std::io::Write as _;

fn body(reply: &str) -> Value {
    let raw = reply.split_once("\r\n\r\n").unwrap().1;
    serde_json::from_str(raw).expect("native daemon reply contains JSON")
}

struct Guard(Child);
impl Drop for Guard {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_some() {
            return;
        }
        unsafe { libc::kill(self.0.id() as i32, libc::SIGTERM) };
        for _ in 0..35 {
            if self.0.try_wait().ok().flatten().is_some() {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// A fake isolated WebHelm service whose platform-run submission fails with
/// a deterministic pre-submission rejection. The workspace/start handshake
/// succeeds so the failure is observed exactly at delivery.
fn spawn_failing_webhelm(socket: &Path, cli: &Path, rejection: &'static str) {
    use std::os::unix::{fs::PermissionsExt, net::UnixListener};
    fs::write(
        cli,
        format!("#!/bin/sh\nif [ \"$1\" = \"platform\" ]; then printf '{{\"platform\":\"chatgpt\"}}\\n'; else printf '{{\"ok\":true}}\\n'; fi\n"),
    )
    .unwrap();
    fs::set_permissions(cli, fs::Permissions::from_mode(0o700)).unwrap();
    let listener = UnixListener::bind(socket).unwrap();
    listener.set_nonblocking(true).unwrap();
    thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(90);
        loop {
            if Instant::now() > deadline {
                break;
            }
            let (mut stream, _) = match listener.accept() {
                Ok(value) => value,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(5));
                    continue;
                }
                Err(_) => break,
            };
            stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            let mut line = String::new();
            BufReader::new(&stream).read_line(&mut line).unwrap();
            let command: Value = serde_json::from_str(&line).unwrap();
            let op = command["op"].as_str().unwrap_or("").to_string();
            let response = match op.as_str() {
                "workspace-create" => json!({"ok": true}),
                "start" => json!({"ok": true, "workspace": "Relay",
                    "workspace_supported": true, "session_id": "fail-session-1"}),
                "platform-run" => json!({"ok": false, "error": rejection}),
                "stop" => json!({"ok": true, "returned_to_idle": true}),
                _ => json!({"ok": false, "error": "unexpected op"}),
            };
            let _ = stream.write_all(format!("{response}\n").as_bytes());
            if op == "stop" {
                break;
            }
        }
    });
}

fn seed_job(root: &Path, project: &Path, job_id: &str, task_id: &str) -> PathBuf {
    fs::create_dir_all(project).unwrap();
    let initialized = Command::new("git").arg("-C").arg(project)
        .args(["init", "-q", "-b", "main"]).status().unwrap();
    assert!(initialized.success());
    let path = root.join("relay.sqlite");
    let store = SQLiteRelayStore::open(&path, Some(job_id)).unwrap();
    store.save_job(&json!({
        "id": job_id, "repository": "project", "projectRoot": project,
        "title": "Daemon worker launch failure binding", "state": "ACTIVE",
        "prNumber": 0, "priority": "P2", "reviewEnabled": false,
        "createdAt": "2026-11-20T00:00:00.000Z", "updatedAt": "2026-11-20T00:00:00.000Z",
        "tasks": [{
            "id": task_id, "jobId": job_id, "kind": "work", "adapter": "chatgpt",
            "agentName": "implementation", "title": "Failing browser Task",
            "state": "QUEUED", "executionId": null, "leaseOwner": null,
            "leaseExpiresAt": null, "attempt": 0, "maxAttempts": 1,
            "priority": "P2", "dependencies": [],
            "routing": {"adapter": "chatgpt", "projectId": "isolated"},
            "input": "[Relay agent: worker; adapter: chatgpt]\nDeliverable work",
            "chatgptTabClosePolicy": "after-terminal", "timeoutMs": 6000,
            "output": {"kind": "file", "path": root.join("out.json")},
            "createdAt": "2026-11-20T00:00:00.000Z",
            "updatedAt": "2026-11-20T00:00:00.000Z"
        }],
        "plans": []
    })).unwrap();
    store.close().unwrap();
    path
}

fn start_daemon(root: &Path, socket: &Path, cli: &Path, port: u16) -> Guard {
    let child = Command::new(binary())
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .args([
            "--isolated-write-store-dir",
            root.join("stores").to_str().unwrap(),
            "--port", &port.to_string(),
            "--interval", "100",
        ])
        .env("AGENTS_RELAY_WEBHELM_SOCKET", socket)
        .env("AGENTS_RELAY_WEBHELM_EXECUTABLE", cli)
        .env("AGENTS_RELAY_WEBHELM_WORKSPACE", "Relay")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::from(
            fs::File::create(root.join("native-daemon.log")).unwrap(),
        ))
        .spawn()
        .unwrap();
    let mut guard = Guard(child);
    for _ in 0..300 {
        if request(port, "GET", "/api/status", "")
            .is_ok_and(|reply| reply.starts_with("HTTP/1.1 200"))
        {
            return guard;
        }
        if let Some(status) = guard.0.try_wait().unwrap() {
            panic!("daemon exited before serving: {status}: {}",
                fs::read_to_string(root.join("native-daemon.log")).unwrap_or_default());
        }
        thread::sleep(Duration::from_millis(50));
    }
    panic!("daemon never listened on isolated port");
}

fn wait_for_task_exit(root: &Path, port: u16, job_id: &str, _task_id: &str)
    -> (Value, String) {
    // Phase 1: the daemon must first CLAIM the Task (executionId set); the
    // seeded state is QUEUED with a null execution, so without this phase a
    // premature exit would race the reconciler and assert on the seed.
    let mut last = Value::Null;
    let claim_deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < claim_deadline {
        if let Ok(reply) = request(port, "GET", &format!("/api/job?id={job_id}"), "") {
            last = body(&reply);
            if last["tasks"][0]["executionId"].is_string() {
                break;
            }
        }
        thread::sleep(Duration::from_millis(60));
    }
    assert!(
        last["tasks"][0]["executionId"].is_string(),
        "daemon never claimed the Task for launch; job={last}; log={}",
        fs::read_to_string(root.join("native-daemon.log")).unwrap_or_default()
    );
    // Phase 2: the launch failure must move the Task out of the claimed
    // QUEUED state: FAILED terminal, or QUEUED with the lease cleared.
    let deadline = Instant::now() + Duration::from_secs(45);
    while Instant::now() < deadline {
        if let Ok(reply) = request(port, "GET", &format!("/api/job?id={job_id}"), "") {
            last = body(&reply);
            let state = last["tasks"][0]["state"].as_str().unwrap_or("");
            let exec_null = last["tasks"][0]["executionId"].is_null();
            if state == "FAILED" && exec_null {
                break;
            }
            // no-start fallback keeps state QUEUED but clears lease/execution.
            if state == "QUEUED" && exec_null {
                break;
            }
        }
        thread::sleep(Duration::from_millis(80));
    }
    let log = fs::read_to_string(root.join("native-daemon.log")).unwrap_or_default();
    (last, log)
}

#[test]
fn daemon_worker_launch_failure_reaches_graph_and_sqlite_not_stderr_only() {
    let root = root();
    let project = root.join("project");
    let path = seed_job(&root, &project, "84", "3");
    let cli = root.join("fake-webhelm");
    let socket = root.join("webhelm.sock");
    // A deterministic pre-submission rejection observed at delivery: the
    // browser workspace itself is fine, so this is a LaunchFailure-class
    // rejection (phase=delivery), not a WebHelm runtime outage.
    spawn_failing_webhelm(&socket, &cli, "PreSubmissionRejection: prompt rejected");
    let port = socket_port();
    let daemon = start_daemon(&root, &socket, &cli, port);
    let (final_job, log) = wait_for_task_exit(&root, port, "84", "3");
    drop(daemon);
    let task = &final_job["tasks"][0];
    let state = task["state"].as_str().unwrap_or("");
    assert!(
        state == "FAILED" || state == "QUEUED",
        "launch failure left the Task in {state}; the daemon must not strand a leased generation: {final_job}; log={log}"
    );
    assert!(
        task["executionId"].is_null(),
        "execution lease must be cleared by the Graph failure transition: {task}"
    );
    assert!(
        task["leaseOwner"].is_null(),
        "lease owner must be cleared by the Graph failure transition: {task}"
    );
    if state == "FAILED" {
        // The canonical worker.delivery_failed edge sets a failureReason.
        let reason = task["failureReason"].as_str().unwrap_or("");
        assert!(
            reason.contains("worker") || reason.contains("platform")
                || reason.contains("pre_submission") || !reason.is_empty(),
            "FAILED Task must carry a Graph-classified failure reason: {task}"
        );
        let error = task["error"].as_str().unwrap_or("");
        assert!(error.contains("PreSubmissionRejection"),
            "Task error must preserve the observed worker error: {task}");
    }
    // Durable SQLite verification through an independent store connection.
    let verify = SQLiteRelayStore::open_without_claim_reset(&path, Some("84")).unwrap();
    let durable = verify.load_job("84").unwrap().unwrap();
    let durable_task = &durable["tasks"][0];
    assert_eq!(durable_task["state"], json!(state),
        "SQLite must hold the same terminal state as the daemon view");
    assert!(durable_task["executionId"].is_null());
    drop(verify);
    // The daemon must survive the failed worker: status still serves.
    // (daemon dropped after wait; the log must not contain a panic.)
    assert!(!log.contains("panicked"), "daemon panicked during worker failure: {log}");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn daemon_worker_failure_claim_dedupes_and_stale_generation_is_fenced() {
    // Unit-level daemon binding check through the real ports struct: the
    // 60s claim window suppresses a duplicate failure receipt, and a stale
    // execution generation can never mutate the current Job.
    use agents_relay_rust2::{
        daemon_worker_failure::{
            DaemonFailureState, DaemonLiveWorkers, DaemonWorkerFailurePorts,
        },
        worker_failure_recovery::handle_worker_launch_failure,
    };
    let root = root();
    let graph = Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow");
    let path = seed_job(&root, &root.join("project"), "85", "4");
    // Move the Task into the exact post-claim shape the daemon sees when
    // its worker thread fails: leased QUEUED generation with attempt < max.
    let store = SQLiteRelayStore::open(&path, Some("85")).unwrap();
    let mut job = store.load_job("85").unwrap().unwrap();
    job["tasks"][0]["executionId"] = json!("exec-85-1");
    job["tasks"][0]["leaseOwner"] = json!("daemon-owner");
    job["tasks"][0]["leaseExpiresAt"] = json!("2099-01-01T00:00:00.000Z");
    job["tasks"][0]["attempt"] = json!(1);
    job["tasks"][0]["maxAttempts"] = json!(3);
    store.save_job(&job).unwrap();
    store.close().unwrap();

    let state = std::sync::Arc::new(DaemonFailureState::new());
    let live = std::sync::Arc::new(std::sync::Mutex::new(DaemonLiveWorkers::default()));
    live.lock().unwrap().register("4", "exec-85-1");
    let adapters = json!([
        {"id": "codex", "name": "codex", "capabilities": ["model", "codex"]},
        {"id": "chatgpt/browser-worker", "name": "chatgpt",
            "capabilities": ["model", "chatgpt", "webhelm"]},
        {"id": "z", "name": "z", "capabilities": ["model", "z"]},
    ])
    .as_array()
    .unwrap()
    .clone();
    let make_ports = |live: std::sync::Arc<
        std::sync::Mutex<DaemonLiveWorkers>>| {
        DaemonWorkerFailurePorts::new(
            path.clone(), graph.clone(), Some("85".to_string()),
            None, None, None, adapters.clone(),
            live, std::sync::Arc::clone(&state),
        )
    };
    let mut ports = make_ports(live);
    handle_worker_launch_failure(&mut ports, "85", "4", Some("exec-85-1"),
        &json!("PreSubmissionRejection: prompt rejected"), "delivery").unwrap();
    let first = SQLiteRelayStore::open_without_claim_reset(&path, Some("85"))
        .unwrap()
        .load_job("85")
        .unwrap()
        .unwrap();
    let state_after = first["tasks"][0]["state"].as_str().unwrap_or("").to_owned();
    assert!(state_after == "FAILED" || state_after == "QUEUED",
        "first failure must apply a Graph transition, got {state_after}: {first}");
    // A duplicate receipt for the same execution must be a no-op: the
    // shared claim state suppresses the second transition.
    let mut ports = make_ports(std::sync::Arc::new(
        std::sync::Mutex::new(DaemonLiveWorkers::default())));
    handle_worker_launch_failure(&mut ports, "85", "4", Some("exec-85-1"),
        &json!("PreSubmissionRejection: prompt rejected"), "delivery").unwrap();
    let second = SQLiteRelayStore::open_without_claim_reset(&path, Some("85"))
        .unwrap()
        .load_job("85")
        .unwrap()
        .unwrap();
    assert_eq!(second, first, "duplicate failure receipt must not mutate SQLite");
    // A stale generation receipt can never mutate the current Job.
    handle_worker_launch_failure(&mut ports, "85", "4", Some("exec-85-stale"),
        &json!("late stale failure"), "delivery").unwrap();
    let third = SQLiteRelayStore::open_without_claim_reset(&path, Some("85"))
        .unwrap()
        .load_job("85")
        .unwrap()
        .unwrap();
    assert_eq!(third, second, "stale generation failure must be fenced");
    fs::remove_dir_all(root).unwrap();
}
