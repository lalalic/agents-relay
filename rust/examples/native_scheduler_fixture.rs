//! Isolated native Scheduler test fixture: no production daemon, no user
//! database, no inherited secrets. Exercises real Script Worker launch and
//! correlated completion before a Graph-selected terminal transition.
use agents_relay_rust::authority::{RelayAuthority, ScriptClaimRequest};
use agents_relay_rust::native_script::{execute_claimed_script, ScriptExecutionTimes};
use agents_relay_rust::worker::WorkerSpec;
use serde_json::json;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::Duration;
fn isolated(path: &Path) -> Result<PathBuf, String> {
    if std::env::var("RELAY_RUST_EXPERIMENTAL_TEST_ONLY")
        .ok()
        .as_deref()
        != Some("isolated-test")
    {
        return Err("native Scheduler fixture requires isolated-test".into());
    }
    let path = path.canonicalize().map_err(|e| e.to_string())?;
    let dir = path.parent().ok_or("database root missing")?;
    let temp = std::env::temp_dir()
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !dir.starts_with(temp)
        || !dir
            .file_name()
            .is_some_and(|n| n.to_string_lossy().starts_with("relay-rust-authority-"))
        || !dir.join(".relay-rust-authority-isolated-test").is_file()
    {
        return Err("native Scheduler fixture refuses non-test store".into());
    }
    Ok(path)
}
fn run() -> Result<(), String> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() != 2
        || !matches!(
            args[1].as_str(),
            "complete" | "no-proof" | "wrong-execution"
        )
    {
        return Err(
            "usage: native_scheduler_fixture ISOLATED_DB complete|no-proof|wrong-execution".into(),
        );
    }
    let path = isolated(Path::new(&args[0]))?;
    let dir = path.parent().ok_or("fixture root missing")?;
    let mut authority = RelayAuthority::open_existing(&path)?;
    let claim = authority
        .claim_queued_script(&ScriptClaimRequest {
            job_id: "91",
            task_id: "101",
            execution_id: "ex-native-scheduler-test",
            owner: "native-relay-test",
            at: "2099-01-01T00:00:01.000Z",
            lease_expires_at: "2099-01-01T00:10:00.000Z",
        })?
        .ok_or("native Scheduler did not claim")?;
    let evidence = dir.join("worker-result.json");
    let shell=match args[1].as_str(){
        "complete"=>"sleep 0.3; printf '%s' '{\"jobId\":\"91\",\"taskId\":\"101\",\"executionId\":\"ex-native-scheduler-test\",\"status\":\"COMPLETED\",\"output\":{\"artifact\":\"verified\"}}' > \"$EVIDENCE\"; echo completed",
        "wrong-execution"=>"sleep 0.3; printf '%s' '{\"jobId\":\"91\",\"taskId\":\"101\",\"executionId\":\"old-generation\",\"status\":\"COMPLETED\",\"output\":{\"artifact\":\"spoof\"}}' > \"$EVIDENCE\"; echo forged",
        _=>"sleep 0.3; echo exit-zero-without-evidence",
    };
    let spec = WorkerSpec {
        executable: PathBuf::from("/bin/sh"),
        args: vec!["-c".into(), shell.into()],
        cwd: dir.into(),
        env: BTreeMap::from([
            ("PATH".into(), "/bin:/usr/bin".into()),
            ("EVIDENCE".into(), evidence.to_string_lossy().to_string()),
        ]),
        stdout: dir.join("native.stdout"),
        stderr: dir.join("native.stderr"),
        timeout: Duration::from_secs(8),
        terminate_grace: Duration::from_millis(150),
    };
    let report = execute_claimed_script(
        &mut authority,
        &claim,
        &spec,
        &evidence,
        &AtomicBool::new(false),
        ScriptExecutionTimes {
            started_at: "2099-01-01T00:00:02.000Z",
            finished_at: "2099-01-01T00:00:03.000Z",
            verified_at: "2099-01-01T00:00:04.000Z",
        },
    )?;
    println!(
        "{}",
        json!({"report":report,"job":authority.read_job("91")?,
        "attempt":authority.action_trace(&claim.attempt_key)?,
        "events":authority.pending_events()?,
        "process":authority.process_record("91","101","ex-native-scheduler-test")?})
    );
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("native_scheduler_fixture: {error}");
        std::process::exit(2);
    }
}
