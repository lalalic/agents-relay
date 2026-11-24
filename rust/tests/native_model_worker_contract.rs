//! Model-adapter subprocess and receipt boundaries. An intentionally created
//! disposable executable is used instead of invoking real Codex credentials,
//! external ChatGPT/Z accounts, or a live WebHelm Session.
use agents_relay_rust2::{
    adapters::CodexAdapter,
};
use serde_json::json;
use std::{fs,path::PathBuf,sync::atomic::AtomicBool,time::{SystemTime,UNIX_EPOCH}};
fn script(source:&str)->(PathBuf,PathBuf){
    let root=std::env::temp_dir().join(format!("rust2-model-contract-{}-{}",
        std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
    fs::create_dir_all(&root).unwrap();
    let exe=root.join("disposable-provider-shim");fs::write(&exe,source).unwrap();
    #[cfg(unix)]{
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&exe,fs::Permissions::from_mode(0o700)).unwrap();
    }
    (root,exe)
}
#[test]
fn non_codex_test_executable_exit_never_forges_graph_completion(){
    let (root,exe)=script("#!/bin/sh\nprintf '%s\\n' '{\"type\":\"thread.started\",\"thread_id\":\"fixture-thread-12\"}' '{\"type\":\"turn.completed\"}'\nexit 0\n");
    let adapter=CodexAdapter{command:exe.to_string_lossy().to_string()};
    let task=json!({"id":"22","adapter":"codex","input":"isolated test payload",
        "routing":{"profile":"fixture","cwd":root},"timeoutMs":6000});
    let context=json!({"executionContext":{"project":{"path":root}}});
    let result=adapter.launch(&task,&context,&AtomicBool::new(false)).unwrap();
    assert_eq!(result.thread_id.as_deref(),Some("fixture-thread-12"));
    assert_eq!(result.process_exit.as_ref().unwrap()["exitCode"],0);
    assert!(result.result.get("state").is_none());
    assert!(result.result.get("status").is_none());
    assert!(result.delivery_receipt.is_none());
    assert!(result.summary.contains("terminal task state is event-owned"),
        "A provider process exit must never become a Task success event");
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn non_codex_test_executable_failure_is_technical_not_false_success(){
    let (root,exe)=script("#!/bin/sh\nprintf '%s\\n' '{\"type\":\"turn.failed\",\"error\":{\"message\":\"denied test token\"}}'\nexit 13\n");
    let adapter=CodexAdapter{command:exe.to_string_lossy().to_string()};
    let task=json!({"id":"22","adapter":"codex","input":"fixture",
        "routing":{"cwd":root},"timeoutMs":6000});
    let context=json!({"executionContext":{"project":{"path":root}}});
    let error=adapter.launch(&task,&context,&AtomicBool::new(false)).unwrap_err();
    assert!(error.contains("denied test token"),"{error}");
    fs::remove_dir_all(root).unwrap();
}
