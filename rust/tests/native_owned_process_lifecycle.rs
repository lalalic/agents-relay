// POSIX L3 isolated subprocesses; no system services, namescan or user PIDs.
use agents_relay_rust2::owned_process::{
    OwnedProcessManager, OwnedProcessOptions, TerminationReason,
};
use std::{
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};
fn options() -> OwnedProcessOptions {
    OwnedProcessOptions {
        invocation: "native-test-fixture".into(),
        grace_ms: 70,
        timeout_ms: None,
        cwd: None,
        supervisor_path: Some(PathBuf::from(env!(
            "CARGO_BIN_EXE_owned-process-supervisor"
        ))),
    }
}
#[test]
fn exact_owned_group_stops_without_signalling_unrelated_process() {
    let mut outsider = Command::new("/bin/sleep")
        .arg("15")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    let mut manager = OwnedProcessManager::default();
    let child = manager
        .spawn_owned_process("/bin/sh", &["-c", "sleep 15 & wait"], options())
        .unwrap();
    let owner = child.pid();
    assert_ne!(owner, outsider.id());
    assert_eq!(manager.owned_process_snapshot().len(), 1);
    assert!(!manager.terminate_owned_process(outsider.id(), TerminationReason::Cancel, None));
    assert!(
        outsider.try_wait().unwrap().is_none(),
        "untracked process must not be killed"
    );
    assert!(manager.terminate_owned_process(owner, TerminationReason::Cancel, Some(70)));
    assert!(child.wait_for_leader(Duration::from_secs(3)));
    assert_eq!(child.termination_reason(), Some(TerminationReason::Cancel));
    assert!(
        outsider.try_wait().unwrap().is_none(),
        "owned group kill crossed PGID boundary"
    );
    let _ = outsider.kill();
    let _ = outsider.wait();
}
#[test]
fn owned_timeout_fences_only_target_execution() {
    let mut manager = OwnedProcessManager::default();
    let mut config = options();
    config.timeout_ms = Some(30);
    let timed = manager
        .spawn_owned_process("/bin/sh", &["-c", "sleep 15"], config)
        .unwrap();
    assert!(timed.wait_for_leader(Duration::from_secs(4)));
    assert_eq!(timed.termination_reason(), Some(TerminationReason::Timeout));
}
#[test]
fn parent_crash_fixture() {
    let Ok(file) = std::env::var("OWNED_PROCESS_TEST_FILE") else {
        return;
    };
    let mut manager = OwnedProcessManager::default();
    let proc = manager
        .spawn_owned_process("/bin/sh", &["-c", "sleep 15 & wait"], options())
        .unwrap();
    std::fs::write(file, proc.pid().to_string()).unwrap();
    // Simulate abrupt parent death: no OwnedProcessManager Drop/exit hook.
    unsafe { libc::_exit(0) }
}
#[test]
fn parent_death_supervisor_reclaims_its_own_process_group() {
    let file = std::env::temp_dir().join(format!("rust2-owner-parent-{}", std::process::id()));
    let code = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "parent_crash_fixture", "--nocapture"])
        .env("OWNED_PROCESS_TEST_FILE", &file)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap();
    assert!(code.success());
    let pid: i32 = std::fs::read_to_string(&file).unwrap().parse().unwrap();
    let _ = std::fs::remove_file(file);
    let started = Instant::now();
    let disappeared = loop {
        let result = unsafe { libc::kill(-pid, 0) };
        if result != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
            break true;
        }
        if started.elapsed() > Duration::from_secs(4) {
            break false;
        }
        thread::sleep(Duration::from_millis(80));
    };
    assert!(
        disappeared,
        "native parent-death supervisor did not reclaim test PGID {pid}"
    );
}
#[test]
fn immediate_exit_and_background_grandchild_do_not_escape_owned_group() {
    let mut manager = OwnedProcessManager::default();
    let quick = manager
        .spawn_owned_process("/usr/bin/true", &[], options())
        .expect("fast leader must still register owned process");
    assert!(quick.wait_for_leader(Duration::from_secs(2)));
    let child = manager
        .spawn_owned_process(
            "/bin/sh",
            &["-c", "sleep 15 >/dev/null 2>&1 & kill -KILL $$"],
            options(),
        )
        .expect("detached grandchild still belongs to owned PGID");
    assert!(child.wait_for_leader(Duration::from_secs(2)));
    assert_eq!(
        child.termination_reason(),
        Some(TerminationReason::LeaderExit)
    );
}
