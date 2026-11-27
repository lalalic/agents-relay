use agents_relay_rust2::usage::{
    CodexApiUsageReader,codex_and_zai_usage_registry,
};
use serde_json::{json,Value};
use std::{fs,os::unix::fs::PermissionsExt,path::PathBuf,time::{Instant,Duration}};

fn fake_app_server(reply:Option<&str>)->PathBuf{
    let path=std::env::temp_dir().join(format!("relay-fake-codex-{}-{}.sh",
        std::process::id(),std::time::SystemTime::now().duration_since(
            std::time::UNIX_EPOCH).unwrap().as_nanos()));
    let reply=reply.unwrap_or("");
    let script=format!("#!/bin/sh\nIFS= read -r init || exit 1\ncase \"$init\" in *initialize*) ;; *) exit 2;; esac\nprintf '%s\\n' '{{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{{}}}}'\nIFS= read -r initialized || exit 3\ncase \"$initialized\" in *initialized*) ;; *) exit 4;; esac\nIFS= read -r query || exit 5\ncase \"$query\" in *'account/rateLimits/read'*) ;; *) exit 6;; esac\nif [ -n '{reply}' ]; then\nprintf '%s\\n' '{reply}'\nsleep 30\nfi\n");
    fs::write(&path,script).unwrap();
    fs::set_permissions(&path,fs::Permissions::from_mode(0o700)).unwrap();
    path
}
#[test]
fn missing_owned_app_server_is_unavailable_without_launch_or_wait(){
    let start=Instant::now();
    let reader=CodexApiUsageReader::with_command_and_clock(
        "/the/definitely/missing/native-codex-fixture",
        ||"2026-11-17T22:35:00.000Z".to_owned());
    let snapshot=reader.read();
    assert_eq!(snapshot["available"],false);
    assert_eq!(snapshot["reason"],"Codex app-server could not be started.");
    assert_eq!(snapshot["generatedAt"],"2026-11-17T22:35:00.000Z");
    assert!(start.elapsed()<Duration::from_secs(1),
        "ENOENT must not wait for the 10-second provider timeout");
}
#[test]
fn usage_registry_factory_constructs_without_launching_any_provider(){
    let registry=codex_and_zai_usage_registry(None,None);
    assert!(registry.browser.is_some());
    // Production setup owns the reader; only a snapshot request can launch
    // the app-server. Do not call it in the test.
}

#[test]
fn app_server_waits_for_initialize_and_reads_actual_quota_before_process_exit(){
    let reply=json!({"jsonrpc":"2.0","id":2,"result":{"rateLimits":{
        "primary":{"usedPercent":25.0,"windowDurationMins":300.0,"resetsAt":1_800_000_000.0},
        "secondary":{"usedPercent":60.0,"windowDurationMins":10_080.0,"resetsAt":1_800_000_100.0}
    }}}).to_string();
    let command=fake_app_server(Some(&reply));
    let start=Instant::now();
    let snapshot=CodexApiUsageReader::with_command_and_clock(
        command.to_string_lossy(),||"2026-11-17T22:35:00.000Z".to_owned()).read();
    let _=fs::remove_file(command);
    assert_eq!(snapshot["available"],true);
    assert_eq!(snapshot["fiveHour"]["usedPercent"],25.0);
    assert_eq!(snapshot["fiveHour"]["resetsAt"],1_800_000_000.0);
    assert_eq!(snapshot["weekly"]["usedPercent"],60.0);
    assert_eq!(snapshot["generatedAt"],"2026-11-17T22:35:00.000Z");
    assert!(start.elapsed()<Duration::from_secs(3),
        "the reader should return the quota reply without waiting for app-server EOF");
}

#[test]
fn app_server_invalid_quota_is_truthfully_unavailable(){
    let command=fake_app_server(Some(r#"{"jsonrpc":"2.0","id":2,"result":{"rateLimits":{"primary":{"usedPercent":101,"windowDurationMins":300},"secondary":{}}}}"#));
    let snapshot=CodexApiUsageReader::with_command_and_clock(
        command.to_string_lossy(),||"2026-11-17T22:35:00.000Z".to_owned()).read();
    let _=fs::remove_file(command);
    assert_eq!(snapshot["available"],false);
    assert_eq!(snapshot["fiveHour"],Value::Null);
    assert_eq!(snapshot["weekly"],Value::Null);
    assert_eq!(snapshot["reason"],"Codex app-server did not return both account quota windows.");
}

#[test]
fn app_server_missing_reset_time_is_not_reported_as_valid_quota(){
    let command=fake_app_server(Some(r#"{"jsonrpc":"2.0","id":2,"result":{"rateLimits":{"primary":{"usedPercent":10,"windowDurationMins":300,"resetsAt":100},"secondary":{"usedPercent":20,"windowDurationMins":10080}}}}"#));
    let snapshot=CodexApiUsageReader::with_command_and_clock(
        command.to_string_lossy(),||"2026-11-17T22:35:00.000Z".to_owned()).read();
    let _=fs::remove_file(command);
    assert_eq!(snapshot["available"],false);
    assert_eq!(snapshot["weekly"],Value::Null);
}

#[test]
fn app_server_early_exit_is_unavailable_without_waiting_for_timeout(){
    let command=fake_app_server(None);
    let start=Instant::now();
    let snapshot=CodexApiUsageReader::with_command_and_clock(
        command.to_string_lossy(),||"2026-11-17T22:35:00.000Z".to_owned()).read();
    let _=fs::remove_file(command);
    assert_eq!(snapshot["available"],false);
    assert_eq!(snapshot["reason"],"Codex app-server closed before returning rate limits.");
    assert!(start.elapsed()<Duration::from_secs(3));
}
