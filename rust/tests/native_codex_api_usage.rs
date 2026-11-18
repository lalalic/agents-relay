use agents_relay_rust2::usage::{
    CodexApiUsageReader,codex_and_zai_usage_registry,
};
use std::time::{Instant,Duration};
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
