// Native Rust regression for direct Node src/process-identity.ts process probes and fail-closed process-generation safety.
use agents_relay_rust2::process_identity::{
    active_relay_lease_owner, observe_process, probe_process_record, stop_orphaned_process_group,
};
use serde_json::json;
use std::time::Duration;

#[test]
fn invalid_pids_never_invent_live_processes() {
    assert_eq!(observe_process(-1), None);
    assert_eq!(observe_process(0), None);
    assert_eq!(observe_process(1), None);
    assert_eq!(observe_process(9_999_999_999), None);
    assert!(!active_relay_lease_owner("relayd-0"));
    assert!(!active_relay_lease_owner("relayd-1"));
    assert!(!active_relay_lease_owner("relayd-invalid"));
}

#[test]
fn native_relay_owner_probe_never_reclaims_a_live_pid_or_unknown_identity() {
    use agents_relay_rust2::process_identity::dead_native_relay_owner;
    let here = std::process::id();
    assert!(!dead_native_relay_owner(&format!("isolated-rust-daemon-{here}")));
    assert!(!dead_native_relay_owner(&format!("live-rust-daemon-{here}")));
    assert!(!dead_native_relay_owner("isolated-rust-daemon-0"));
    assert!(!dead_native_relay_owner("isolated-rust-daemon-invalid"));
    assert!(!dead_native_relay_owner("relayd-12345"));
    assert!(dead_native_relay_owner("isolated-rust-daemon-2147483647"));
}

#[test]
fn remote_and_nonleader_records_refuse_group_signals() {
    let remote = json!({"pid":42,"pgid":42,"host":"not.local.test.invalid","startToken":"fake"});
    assert_eq!(probe_process_record(&remote), "unknown");
    assert!(!stop_orphaned_process_group(&remote, Duration::ZERO));
    let invalid = json!({"pid":42,"pgid":43,"host":"not.local.test.invalid","startToken":"fake"});
    assert_eq!(probe_process_record(&invalid), "unknown");
    assert!(!stop_orphaned_process_group(&invalid, Duration::ZERO));
    assert_eq!(probe_process_record(&json!({})), "unknown");
}
