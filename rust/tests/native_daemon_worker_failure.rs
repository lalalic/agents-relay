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
            "id": task_id, "jobId": job_id, "kind": "work", "adapter": "codex",
            "agentName": "implementation", "title": "Failing Codex Task",
            "state": "QUEUED", "executionId": null, "leaseOwner": null,
            "leaseExpiresAt": null, "attempt": 0, "maxAttempts": 1,
            "priority": "P2", "dependencies": [],
            "routing": {"provider": "openai", "model": "fixture"},
            "input": "[Relay agent: worker; adapter: codex]\nDeliverable work",
            "timeoutMs": 6000,
            "output": {"kind": "file", "path": root.join("out.json")},
            "createdAt": "2026-11-20T00:00:00.000Z",
            "updatedAt": "2026-11-20T00:00:00.000Z"
        }],
        "plans": []
    })).unwrap();
    store.close().unwrap();
    path
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
    let make_ports = |live: std::sync::Arc<
        std::sync::Mutex<DaemonLiveWorkers>>| {
        DaemonWorkerFailurePorts::new(
            path.clone(), graph.clone(), Some("85".to_string()),
            None, None,
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

#[test]
fn quota_continuation_uses_daemon_ports_and_keeps_same_task_without_troubleshooter(){
    use agents_relay_rust2::{
        daemon_worker_failure::{DaemonFailureState,DaemonLiveWorkers,DaemonWorkerFailurePorts},
        worker_failure_recovery::handle_worker_launch_failure,
    };
    use std::sync::{Arc,Mutex};
    let root=root();
    let path=seed_job(&root,&root.join("project"),"85","4");
    let store=SQLiteRelayStore::open(&path,Some("85")).unwrap();
    let mut job=store.load_job("85").unwrap().unwrap();
    let task=&mut job["tasks"][0];
    task["state"]=json!("RUNNING");
    task["executionId"]=json!("exec-85-1");
    task["leaseOwner"]=json!("daemon-owner");
    task["leaseExpiresAt"]=json!("2099-01-01T00:00:00Z");
    task["attempt"]=json!(1);
    task["maxAttempts"]=json!(3);
    task["threadId"]=json!("38f84f9e-410d-4e36-96e0-a420594a102d");
    task["routing"]=json!({"provider":"zai","model":"glm-5.3-flash","profile":"zai"});
    store.save_job(&job).unwrap();store.close().unwrap();
    let home=root.join("profiles");fs::create_dir_all(&home).unwrap();
    fs::write(home.join("config.toml"),"model = \"gpt-6-luna\"\n").unwrap();
    fs::write(home.join("zai.config.toml"),"model_provider = \"zai\"\nmodel = \"glm-5.3-flash\"\n").unwrap();
    let state=Arc::new(DaemonFailureState::new());
    let live=Arc::new(Mutex::new(DaemonLiveWorkers::default()));
    live.lock().unwrap().register("4","exec-85-1");
    let graph=Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow");
    let mut ports=DaemonWorkerFailurePorts::new(path.clone(),graph,Some("85".into()),
        None,Some(home),live,Arc::clone(&state)).with_routing_policy(root.join("policy.json"),root.join("rules.md"));
    handle_worker_launch_failure(&mut ports,"85","4",Some("exec-85-1"),
        &json!("codex_provider_continuation_quota_exhausted: rate limit exceeded"),"process").unwrap();
    let after=SQLiteRelayStore::open_without_claim_reset(&path,Some("85")).unwrap().load_job("85").unwrap().unwrap();
    assert_eq!(after["tasks"].as_array().unwrap().len(),1);
    let task=&after["tasks"][0];
    assert_eq!(task["state"],"QUEUED");
    assert_eq!(task["threadId"],"38f84f9e-410d-4e36-96e0-a420594a102d");
    assert_eq!(task["routingExclusions"][0]["profile"],"zai");
    assert_eq!(task["platformFailure"]["classification"],"quota_exhausted");
    assert!(task["routing"].is_null());
    assert!(task["executionId"].is_null());
    assert_eq!(state.wake_count(),1);
    fs::remove_dir_all(root).unwrap();
}
