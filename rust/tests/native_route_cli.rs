use serde_json::{json, Value};
use std::{
    io::Write,
    process::{Command, Output, Stdio},
};

fn invoke(input: &Value) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_agents-relay-rust"))
        .args(["route", "--input-file", "-"])
        .env_remove("OPENROUTER_API_KEY")
        .env("AGENTS_RELAY_STORE_DIR", "/dev/null/not-a-relay-store")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.to_string().as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}
fn input() -> Value {
    json!({"facts":{"capability":"vision"},"contract":{"type":"choice","question":"Select an eligible route","choices":["a","b"]}})
}
#[test]
fn standalone_binary_uses_no_store_or_daemon_and_handles_engine_unavailable() {
    let mut req = input();
    req["contract"]["choices"] = json!(["b"]);
    let out = invoke(&req);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let result: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(result["choice"], "b");
    assert_eq!(result["evidence"]["bypassed"], true);
    req["contract"]["choices"] = json!(["a", "b"]);
    let out = invoke(&req);
    assert!(!out.status.success());
    assert!(out.stdout.is_empty());
    assert!(String::from_utf8_lossy(&out.stderr).contains("OPENROUTER_API_KEY"));
    req["fallback"] = json!("b");
    let out = invoke(&req);
    assert!(out.status.success());
    let result: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(result["choice"], "b");
    assert_eq!(result["evidence"]["fallback"], true);
}
#[test]
fn rejects_ineligible_fallback_and_duplicate_choices() {
    let mut req = input();
    req["fallback"] = json!("c");
    let out = invoke(&req);
    assert!(!out.status.success());
    assert!(out.stdout.is_empty());
    assert!(String::from_utf8_lossy(&out.stderr).contains("outside"));
    req["contract"]["choices"] = json!(["a", "a"]);
    let out = invoke(&req);
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("duplicate"));
}
#[test]
fn native_help_mentions_detached_contract() {
    let out = Command::new(env!("CARGO_BIN_EXE_agents-relay-rust"))
        .args(["route", "--help"])
        .output()
        .unwrap();
    assert!(out.status.success());
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(text.contains("--input-file"));
    assert!(text.contains("without a Job, daemon or SQLite"));
}
