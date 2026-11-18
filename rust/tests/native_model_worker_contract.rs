//! Model-adapter subprocess and receipt boundaries. An intentionally created
//! disposable executable is used instead of invoking real Codex credentials,
//! external ChatGPT/Z accounts, or a live WebHelm Session.
use agents_relay_rust2::{
    adapters::{CodexAdapter,parse_browser_worker_response,parse_driver_json},
    z_adapter::z_worker_launch_request,
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
#[test]
fn browser_receipts_reject_uncertain_and_temporary_submissions(){
    assert!(parse_driver_json("{\"status\":\"submitted\"}\n").is_err());
    assert!(parse_browser_worker_response(
        "{\"status\":\"submitted\",\"verified\":false}","chatgpt").is_err());
    let temp=json!({"status":"submitted","verified_by":"fixture",
        "mode":"new-thread","thread_id":"fixture-12345678",
        "thread_url":"https://chatgpt.com/c/fixture-12345678","temporary":true});
    assert!(parse_browser_worker_response(&temp.to_string(),"chatgpt").is_err());
    let receipt=json!({"status":"submitted","verified_by":"fixture",
        "mode":"new-thread","thread_id":"fixture-12345678",
        "thread_url":"https://chatgpt.com/c/fixture-12345678","temporary":false});
    assert_eq!(parse_browser_worker_response(&receipt.to_string(),"chatgpt").unwrap(),receipt);
}
#[test]
fn z_worker_transport_requires_generation_scoped_original_execution_source(){
    let prompt="Execution source: job/17/task/22/execution/00000000-0000-0000-0000-000000000012\n";
    let request=z_worker_launch_request(prompt,&[],"test-only-token",None,
        "00000000-0000-0000-0000-000000000012",300000).unwrap();
    assert_eq!(request["provider"],"z");
    assert_eq!(request["action"],"new-thread");
    assert_eq!(request["config"]["wait"],false);
    assert!(z_worker_launch_request("invalid source",&[],"test-only-token",None,
        "00000000-0000-0000-0000-000000000012",300000).is_err());
}
