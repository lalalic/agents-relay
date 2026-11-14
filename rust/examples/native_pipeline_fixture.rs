//! Physical local-script lifecycle E2E only. No production daemon is started.
use agents_relay_rust::authority::{
    ActionIdentity, ExecutionProcessRecord, RelayAuthority, WorkflowEvent,
};
use agents_relay_rust::graph::{Decision, Graph, GraphInput};
use agents_relay_rust::lifecycle::{TaskLifecycle, TaskTransition};
use agents_relay_rust::worker::{run_worker, WorkerSpec};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

fn fail<T>(message: impl Into<String>) -> Result<T, String> {
    Err(message.into())
}
fn secure_fixture(db: &Path) -> Result<PathBuf, String> {
    if std::env::var("RELAY_RUST_EXPERIMENTAL_TEST_ONLY")
        .ok()
        .as_deref()
        != Some("isolated-test")
    {
        return fail("test-only environment required");
    }
    let db = db.canonicalize().map_err(|e| e.to_string())?;
    let root = db.parent().ok_or("missing database parent")?;
    let temp = std::env::temp_dir()
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !root.starts_with(temp)
        || !root
            .file_name()
            .is_some_and(|n| n.to_string_lossy().starts_with("relay-rust-authority-"))
        || !root.join(".relay-rust-authority-isolated-test").is_file()
    {
        return fail("only a marked, disposable isolated SQLite is supported");
    }
    Ok(db)
}
fn input(event: &str, execution: Option<&str>) -> GraphInput {
    let mut payload = json!({"taskId":"101"});
    if let Some(execution) = execution {
        payload["executionId"] = json!(execution);
    }
    GraphInput {
        transport: "event".into(),
        id: event.into(),
        payload,
    }
}
fn event(key: &str) -> WorkflowEvent {
    WorkflowEvent {
        key: key.into(),
        event_id: "task.completed".into(),
        payload: json!({"event_id":key,"type":"task.completed","jobId":"91","taskId":"101","executionId":"ex-rust-1"}),
    }
}
fn capture_process(pid: u32) -> Result<(String, String), String> {
    let display = pid.to_string();
    let output = Command::new("/bin/ps")
        .args(["-p", &display, "-o", "pgid=", "-o", "lstart="])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return fail("failed to observe launched PID");
    }
    let stdout = String::from_utf8(output.stdout).map_err(|e| e.to_string())?;
    let mut fields = stdout.split_whitespace();
    let pgid = fields
        .next()
        .ok_or("missing observed PGID")?
        .parse::<u32>()
        .map_err(|e| e.to_string())?;
    if pgid != pid {
        return fail("worker PID is not its process group leader");
    }
    let start_token = fields.collect::<Vec<_>>().join(" ");
    if start_token.len() < 8 {
        return fail("missing process creation token");
    }
    let host = Command::new("/bin/hostname")
        .output()
        .map_err(|e| e.to_string())?;
    if !host.status.success() {
        return fail("cannot resolve host identity");
    }
    let host = String::from_utf8(host.stdout)
        .map_err(|e| e.to_string())?
        .trim()
        .to_string();
    if host.is_empty() {
        return fail("empty host name");
    }
    Ok((host, start_token))
}
fn main() {
    if let Err(error) = run() {
        eprintln!("native_pipeline_fixture: {error}");
        std::process::exit(2)
    }
}
fn run() -> Result<(), String> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 1 {
        return fail("usage: native_pipeline_fixture EXPLICIT_ISOLATED_DB");
    }
    let path = secure_fixture(Path::new(&args[0]))?;
    let directory = path.parent().ok_or("missing parent")?;
    let mut authority = RelayAuthority::open_existing(&path)?;
    let graph = Graph::parse(include_str!("../../workflow/task-lifecycle.mmd"))?;
    let engine = TaskLifecycle::new(&graph);
    let task = authority.read_job("91")?.ok_or("fixture Job 91 missing")?;
    if task["tasks"][0]["state"] != "DRAFT" {
        return fail("fixture task must start DRAFT");
    }
    let _ = engine.apply(
        &mut authority,
        TaskTransition {
            job_id: "91",
            task_id: "101",
            input: input("release", None),
            guard_facts: &HashMap::new(),
            at: "2099-01-01T00:00:00.000Z",
            events: vec![],
        },
    )?;
    authority.commit_job("91", "2099-01-01T00:00:01.000Z", |original| {
        let mut next = original.clone();
        next["updatedAt"] = json!("2099-01-01T00:00:01.000Z");
        next["tasks"][0]["executionId"] = json!("ex-rust-1");
        next["tasks"][0]["leaseOwner"] = json!("relayd-native-rust-test");
        next["tasks"][0]["leaseExpiresAt"] = json!("2099-01-01T00:10:00.000Z");
        next["tasks"][0]["attempt"] = json!(1);
        next["tasks"][0]["executionHistory"] =
            json!([{"id":"ex-rust-1","attempt":1,"startedAt":"2099-01-01T00:00:01.000Z"}]);
        Ok((next, vec![]))
    })?;
    let decision = graph.decide(
        "QUEUED",
        input("dispatch", Some("ex-rust-1")),
        &HashMap::from([("dispatchable".to_string(), true)]),
    )?;
    if !matches!(decision, Decision::Accepted { .. }) {
        return fail("Graph denied dispatch");
    }
    let identity = ActionIdentity {
        job_id: "91".into(),
        task_id: "101".into(),
        execution_id: "ex-rust-1".into(),
        lease_owner: "relayd-native-rust-test".into(),
        attempt: 1,
        generation: 1,
        graph: "task-lifecycle.mmd".into(),
        action_id: "effect.launchTask".into(),
        attempt_key: "91/101/ex-rust-1/launch".into(),
    };
    if !authority.reserve_action(
        &identity,
        &decision,
        "worker.started",
        "2099-01-01T00:00:02.000Z",
        "QUEUED",
    )? {
        return fail("duplicate launch reservation");
    }
    let spec = WorkerSpec {
        executable: PathBuf::from("/bin/sh"),
        args: vec![
            "-c".into(),
            "sleep 0.25; printf 'rust-worker-output'; printf 'rust-worker-stderr' >&2".into(),
        ],
        cwd: directory.into(),
        env: BTreeMap::from([("PATH".into(), "/bin:/usr/bin".into())]),
        stdout: directory.join("worker.stdout"),
        stderr: directory.join("worker.stderr"),
        timeout: Duration::from_secs(5),
        terminate_grace: Duration::from_millis(200),
    };
    let result = run_worker(&spec, &AtomicBool::new(false), |pid| {
        let (host, start_token) = capture_process(pid)?;
        let process = ExecutionProcessRecord {
            job_id: "91".into(),
            task_id: "101".into(),
            execution_id: "ex-rust-1".into(),
            lease_owner: "relayd-native-rust-test".into(),
            host,
            pid: i64::from(pid),
            pgid: i64::from(pid),
            start_token,
            observed_at: "2099-01-01T00:00:03.000Z".into(),
            ended_at: None,
        };
        authority.record_process(&process)?;
        engine.apply(
            &mut authority,
            TaskTransition {
                job_id: "91",
                task_id: "101",
                input: input("task.started", Some("ex-rust-1")),
                guard_facts: &HashMap::new(),
                at: "2099-01-01T00:00:03.000Z",
                events: vec![],
            },
        )?;
        Ok(())
    })?;
    if result.exit_code != Some(0) || result.cancelled || result.timed_out {
        return fail("physical Rust Worker failed");
    }
    authority.finish_process("91", "101", "ex-rust-1", "2099-01-01T00:00:04.000Z")?;
    let (finished, _) = engine.apply(
        &mut authority,
        TaskTransition {
            job_id: "91",
            task_id: "101",
            input: input("task.completed", Some("ex-rust-1")),
            guard_facts: &HashMap::new(),
            at: "2099-01-01T00:00:04.000Z",
            events: vec![event("native-rust-completed")],
        },
    )?;
    let observed = authority.verify_action(
        &identity.attempt_key,
        Some(true),
        "2099-01-01T00:00:05.000Z",
    )?;
    let output = serde_json::json!({"jobId":finished.job_id,"state":finished.job["tasks"][0]["state"],
        "actionOutcome":observed.outcome,"pid":result.pid,"exitCode":result.exit_code,
        "stdout":std::fs::read_to_string(&spec.stdout).map_err(|e|e.to_string())?,
        "stderr":std::fs::read_to_string(&spec.stderr).map_err(|e|e.to_string())?,
        "events":authority.pending_events()?,"process":authority.process_record("91","101","ex-rust-1")?});
    println!(
        "{}",
        serde_json::to_string(&output).map_err(|e| e.to_string())?
    );
    let _: Option<Value> = None;
    Ok(())
}
