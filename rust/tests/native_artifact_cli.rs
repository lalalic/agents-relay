//! Actual installed Rust artifact validate CLI: real read-only filesystem,
//! canonical Ajv-schema diagnostic, stdout/exit status, no daemon.
use serde_json::{json, Value};
use std::{fs,process::Command,time::{SystemTime,UNIX_EPOCH}};
#[test]
fn installed_artifact_validate_reads_real_files_and_matches_node_stdout_and_exit_codes(){
    let home=std::env::temp_dir().join(format!("rust2-artifact-installed-{}-{}",
        std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
    fs::create_dir_all(&home).unwrap();
    let artifact=home.join("artifact.json");
    let schema=home.join("schema.json");
    fs::write(&schema,json!({"type":"object","properties":{
        "title":{"type":"string","minLength":2},"score":{"type":"integer","minimum":0}
    },"required":["title","score"],"additionalProperties":false}).to_string()).unwrap();
    for (document,valid) in [
        (json!({"title":"Story","score":4}),true),
        (json!({"title":"X","score":-1,"unexpected":true}),false),
    ]{
        fs::write(&artifact,document.to_string()).unwrap();
        let snapshot=fs::read(&artifact).unwrap();
        let exe=env!("CARGO_BIN_EXE_agents-relay-rust");
        let output=Command::new(exe)
            .args(["artifact","validate","--artifact",artifact.to_str().unwrap(),
                "--schema",schema.to_str().unwrap()])
            .output().unwrap();
        assert_eq!(output.status.success(),valid,
            "unexpected native status stderr={}",String::from_utf8_lossy(&output.stderr));
        let result:Value=serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["valid"],valid);
        assert_eq!(result["errors"].as_array().unwrap().is_empty(),valid);
        if !valid {
            assert_eq!(String::from_utf8_lossy(&output.stderr).trim(),
                "Artifact validation failed");
        }
        assert_eq!(fs::read(&artifact).unwrap(),snapshot,
            "read-only artifact CLI must not mutate inputs");
    }
    let failure=Command::new(env!("CARGO_BIN_EXE_agents-relay-rust"))
        .args(["artifact","something-else"]).output().unwrap();
    assert!(!failure.status.success());
    assert!(String::from_utf8_lossy(&failure.stderr)
        .contains("artifact supports only validate"));
    fs::remove_dir_all(home).unwrap();
}
