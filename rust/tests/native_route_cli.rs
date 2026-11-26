use serde_json::{json, Value};
use std::{
    io::Write,
    path::PathBuf,
    process::{Command, Output, Stdio},
};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "relay-native-route-{}",
            format!(
                "{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            )
        ));
        std::fs::create_dir_all(root.join(".codex")).unwrap();
        std::fs::create_dir_all(root.join(".agents-relay")).unwrap();
        std::fs::create_dir_all(root.join("bin")).unwrap();
        std::fs::write(root.join(".codex/config.toml"), "model = \"base\"\n").unwrap();
        std::fs::write(
            root.join(".codex/quality.config.toml"),
            "model = \"stronger\"\n",
        )
        .unwrap();
        let codex = root.join("bin/codex");
        // Never actually execute this fixture. Discovery only checks availability.
        std::fs::write(&codex, "#!/bin/sh\nexit 99\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&codex, std::fs::Permissions::from_mode(0o700)).unwrap();
        Self(root)
    }
    fn invoke(&self, input: &Value) -> Output {
        let mut child = Command::new(env!("CARGO_BIN_EXE_agents-relay-rust"))
            .args(["route", "--input-file", "-"])
            .env_remove("OPENROUTER_API_KEY")
            .env_remove("AGENTS_RELAY_EXECUTION_ROUTER_RULES")
            .env("HOME", &self.0)
            .env("CODEX_HOME", self.0.join(".codex"))
            .env("PATH", self.0.join("bin"))
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
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn result(out: Output) -> Value {
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).unwrap()
}
#[test]
fn standalone_binary_uses_canonical_profile_discovery_without_daemon_or_store() {
    let f = Fixture::new();
    let r = result(f.invoke(&json!({
        "eligibleProfiles":["quality"],"routingInstruction":"Prefer a nonexisting profile"
    })));
    assert_eq!(r["routing"]["profile"], "quality");
    assert_eq!(r["routing"]["model"], "stronger");
    assert_eq!(r["routing"]["decisionEvidence"]["bypassed"], true);
    let r = result(f.invoke(&json!({"routingPreferences":{"profile":"quality"}})));
    assert_eq!(r["routing"]["profile"], "quality");
    assert_eq!(r["routing"]["decisionEvidence"]["fallback"], true);
}
#[test]
fn hard_gates_and_invalid_inputs_fail_closed() {
    let f = Fixture::new();
    std::fs::write(
        f.0.join(".agents-relay/routing-policy.json"),
        r#"{"disabledProfiles":["quality"]}"#,
    )
    .unwrap();
    for input in [
        json!({"eligibleProfiles":["quality"],"routingInstruction":"Use quality anyway"}),
        json!({"eligibleProfiles":["not-configured"]}),
        json!({"routingPreferences":{"profile":""}}),
        json!({"routingInstruction":[]}),
        json!({"routingConstraints":{"typo":"x"}}),
    ] {
        let out = f.invoke(&input);
        assert!(!out.status.success(), "{input}");
        assert!(out.stdout.is_empty());
    }
}
#[test]
fn native_help_mentions_canonical_router() {
    let out = Command::new(env!("CARGO_BIN_EXE_agents-relay-rust"))
        .args(["route", "--help"])
        .output()
        .unwrap();
    assert!(out.status.success());
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(text.contains("same native Execution Router"));
    assert!(text.contains("routingInstruction"));
    assert!(text.contains("No Job, daemon or SQLite access"));
}
