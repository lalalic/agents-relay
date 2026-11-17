// Wave4 Worker C native effects: only disposable owned processes and local files.
use agents_relay_rust2::{
    continuation::{
        continue_with_owned_process, run_delivery_owned_process, Continuation,
        DeliveryProcessOptions,
    },
    dag_result_contract::dag_completion_error_owned,
    owned_process::OwnedProcessManager,
};
use serde_json::json;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

fn options<'a>(cancelled: Option<&'a AtomicBool>) -> DeliveryProcessOptions<'a> {
    DeliveryProcessOptions {
        timeout: Some(Duration::from_secs(4)),
        cancelled,
        supervisor_path: Some(Path::new(env!("CARGO_BIN_EXE_owned-process-supervisor"))),
        environment: None,
    }
}

fn fixture_dir() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "rust2-native-wave4-delivery-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&path).unwrap();
    path
}

#[test]
fn real_continuation_command_success_exit_and_mismatch() {
    let mut owned = OwnedProcessManager::default();
    let good = continue_with_owned_process(
        "command",
        "literal",
        Continuation::Command {
            target: "/usr/bin/true",
        },
        None,
        &mut owned,
        options(None),
    );
    assert_eq!(good, Ok(()));
    let failed = continue_with_owned_process(
        "command",
        "literal",
        Continuation::Command {
            target: "/usr/bin/false",
        },
        None,
        &mut owned,
        options(None),
    );
    assert_eq!(failed.unwrap_err(), "Continuation exited 1");
    assert_eq!(
        continue_with_owned_process(
            "codex-thread",
            "literal",
            Continuation::Command {
                target: "/usr/bin/true"
            },
            None,
            &mut owned,
            options(None),
        )
        .unwrap_err(),
        "Continuation is not a Codex thread"
    );
    let codex_shape = continue_with_owned_process(
        "codex-thread",
        "literal",
        Continuation::CodexThread {
            target: "thread-fixture",
        },
        Some("/usr/bin/true"),
        &mut owned,
        options(None),
    );
    assert_eq!(codex_shape, Ok(()));
}

#[test]
fn native_owned_subprocess_stdout_stderr_timeout_and_cancel() {
    let mut owned = OwnedProcessManager::default();
    let output = run_delivery_owned_process(
        &mut owned,
        "/bin/sh",
        &["-c", "printf 'out'; printf 'err' >&2; exit 5"],
        None,
        "dag.stage-validation",
        options(None),
    )
    .unwrap();
    assert_eq!(output.code, 5);
    assert_eq!(output.stdout, "out");
    assert_eq!(output.stderr, "err");
    let mut short = options(None);
    short.timeout = Some(Duration::from_millis(80));
    let started = Instant::now();
    let timed_out = run_delivery_owned_process(
        &mut owned,
        "/bin/sh",
        &["-c", "sleep 5; printf 'never'"],
        None,
        "dag.stage-validation",
        short,
    )
    .unwrap_err();
    assert!(timed_out.contains("timed out"), "{timed_out}");
    assert!(started.elapsed() < Duration::from_secs(3));

    let cancelled = Arc::new(AtomicBool::new(false));
    let cancel_child = Arc::clone(&cancelled);
    let signal = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(80));
        cancel_child.store(true, Ordering::Release);
    });
    let result = run_delivery_owned_process(
        &mut owned,
        "/bin/sh",
        &["-c", "sleep 5"],
        None,
        "continuation.command",
        options(Some(&cancelled)),
    );
    signal.join().unwrap();
    assert!(result.unwrap_err().contains("cancelled"));
    assert_eq!(
        run_delivery_owned_process(
            &mut owned,
            "/usr/bin/true",
            &[],
            None,
            "continuation.command",
            options(Some(&cancelled)),
        )
        .unwrap_err(),
        "continuation.command aborted before launch"
    );
}

#[test]
fn dag_stage_contract_executes_real_script_and_rejects_timeout() {
    let root = fixture_dir();
    let work = root.join("runs/session/task");
    fs::create_dir_all(&work).unwrap();
    fs::create_dir_all(root.join("scripts")).unwrap();
    fs::write(
        root.join("project.run.json"),
        r#"{"stageValidation":{"agents":{"builder":"unit"},"script":"scripts/check.mjs"}}"#,
    )
    .unwrap();
    fs::write(
        root.join("scripts/check.mjs"),
        "printf '{\"stage\":\"unit\",\"status\":\"PASS\",\"errors\":[]}'\n",
    )
    .unwrap();
    let result = work.join("result.json");
    fs::write(
        &result,
        r#"{"status":"COMPLETED","output":{},"artifacts":[]}"#,
    )
    .unwrap();
    let task = json!({"dagNode":{"nodeId":"stage"},"agentName":"builder",
        "output":{"kind":"file","path":result.to_string_lossy()}});
    let mut owned = OwnedProcessManager::default();
    assert_eq!(
        dag_completion_error_owned(&task, Some(&root), "/bin/sh", &mut owned, options(None)),
        None
    );
    fs::write(root.join("scripts/check.mjs"), "sleep 5\n").unwrap();
    let mut short = options(None);
    short.timeout = Some(Duration::from_millis(60));
    let failure =
        dag_completion_error_owned(&task, Some(&root), "/bin/sh", &mut owned, short).unwrap();
    assert!(failure.starts_with("DAG Stage contract rejected Task completion: "));
    assert!(failure.contains("timed out"), "{failure}");
    let _ = fs::remove_dir_all(root);
}
