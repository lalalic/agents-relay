// Disposable escalation-only effects. No live Relay store or provider.
use agents_relay_rust2::cli_escalation::{
    run_configured_escalation_with_timeout, run_escalation_command,
};
use serde_json::{json, Value};
use std::{collections::HashMap, fs, path::{Path,PathBuf}, time::Duration};

fn isolated(label: &str) -> PathBuf {
    let root=std::env::temp_dir().join(format!(
        "rust2-native-escalation-{}-{label}",std::process::id()));
    fs::create_dir_all(&root).unwrap();
    root
}
fn create_executor(root: &Path, label: &str, source: &str) -> String {
    use std::io::Write;
    let path=root.join(format!("{label}.sh"));
    let mut file=fs::File::create(&path).unwrap();
    file.write_all(format!("#!/bin/sh\n{source}\n").as_bytes()).unwrap();
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path,fs::Permissions::from_mode(0o700)).unwrap();
    }
    path.to_string_lossy().to_string()
}
fn config(command: &str) -> HashMap<String,String> {
    HashMap::from([("AGENTS_RELAY_ESCALATION_COMMAND".into(),command.into())])
}
fn graph() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("workflow")
}
#[test]
fn native_executor_private_handoff_and_graph_approved() {
    let root=isolated("approved");
    let script=create_executor(&root,"ok",r#"
test "$1" = "--handoff-file" || exit 11
test -f "$2" || exit 12
grep -q '# Intent' "$2" || exit 13
grep -q 'compile safely' "$2" || exit 14
test "$(stat -f %Lp "$2")" = "600" || exit 15
test "$(stat -f %Lp "$(dirname "$2")")" = "700" || exit 16
echo '{"status":"resolved","summary":"verified","evidence":["proof"]}'
"#);
    let env=config(&script);
    let request=json!({"intent":"compile safely","blockedOn":"sample","cwd":root.to_str()});
    let outcome=run_configured_escalation_with_timeout(&request,&env,Duration::from_secs(4));
    assert_eq!(outcome["status"],"resolved", "{outcome}");
    assert_eq!(outcome["evidence"][0],"proof");
    let options=["--intent","compile safely","--blocked-on","sample","--cwd",root.to_str().unwrap()]
        .iter().map(|s|s.to_string()).collect::<Vec<_>>();
    let graph_result=run_escalation_command(&options,&env,&graph()).unwrap();
    assert_eq!(graph_result["state"],"resolved");
    assert_eq!(graph_result["status"],"resolved");
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn failed_provider_cannot_be_mistaken_for_human_approval() {
    let root=isolated("failure");
    let script=create_executor(&root,"broken",
        "echo '{\"status\":\"needs_user\",\"summary\":\"not real\"}'; exit 9");
    let env=config(&script);
    let outcome=run_configured_escalation_with_timeout(
        &json!({"intent":"i","blockedOn":"b"}),&env,Duration::from_secs(3));
    assert_eq!(outcome["status"],"failed");
    assert!(outcome["summary"].as_str().unwrap().contains("exit 9"));
    let options=["--intent","i","--blocked-on","b"].map(str::to_owned);
    let graph_result=run_escalation_command(&options,&env,&graph()).unwrap();
    assert_eq!(graph_result["state"],"technical_failure");
    assert_eq!(graph_result["status"],"failed");
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn timeouts_are_not_converted_into_success_and_terminate_owned_group() {
    let root=isolated("timeout");
    let script=create_executor(&root,"slow",
        "sleep 3; echo '{\"status\":\"resolved\",\"summary\":\"late\"}'");
    let outcome=run_configured_escalation_with_timeout(
        &json!({"intent":"i","blockedOn":"b"}),&config(&script),
        Duration::from_millis(60));
    assert_eq!(outcome["status"],"failed","{outcome}");
    assert!(outcome["summary"].as_str().unwrap().contains("signal"),"{outcome}");
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn invalid_config_does_not_create_executor_or_approval() {
    let result=run_configured_escalation_with_timeout(
        &Value::Null,&config("relative-executable"),Duration::from_millis(1));
    assert_eq!(result["status"],"failed");
    assert_eq!(result["reason"],result["summary"]);
}
