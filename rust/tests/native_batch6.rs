// Node provenance: src/cli-artifact.ts, src/troubleshooter-qa-api.ts, src/webhelm-daemon-client.ts, src/dashboard-workflow-inspection.ts; deterministic native contract checks.
use agents_relay_rust2::{
    cli_artifact, dashboard_workflow_inspection, troubleshooter_qa_api as qa,
};
use std::{fs, path::Path};
#[test]
fn artifact_schema_fixture_and_failures() {
    let d = std::env::temp_dir().join(format!("relay-artifact-{}", std::process::id()));
    fs::create_dir_all(&d).unwrap();
    let a = d.join("a.json");
    let s = d.join("s.json");
    fs::write(&a, r#"{"title":42,"extra":true}"#).unwrap();
    fs::write(&s,r#"{"type":"object","required":["title"],"additionalProperties":false,"properties":{"title":{"type":"string","minLength":1}}}"#).unwrap();
    let r = cli_artifact::validate_artifact(a.to_str().unwrap(), s.to_str().unwrap()).unwrap();
    assert!(!r.valid);
    assert_eq!(r.errors.len(), 2);
    fs::remove_dir_all(d).unwrap();
}
#[test]
fn qa_http_semantics() {
    let d = std::env::temp_dir().join(format!("relay-qa-{}", std::process::id()));
    fs::create_dir_all(&d).unwrap();
    let p = d.join("qa.md");
    fs::write(&p, "current").unwrap();
    let get = qa::handle(
        &p,
        qa::Request {
            method: "GET".into(),
            content_type: None,
            body: vec![],
        },
    );
    assert_eq!(get.status, 200);
    let h = serde_json::from_slice::<serde_json::Value>(&get.body).unwrap()["hash"]
        .as_str()
        .unwrap()
        .to_owned();
    let put = qa::handle(
        &p,
        qa::Request {
            method: "PUT".into(),
            content_type: Some("application/json".into()),
            body: serde_json::json!({"text":"next","hash":h})
                .to_string()
                .into_bytes(),
        },
    );
    assert_eq!(put.status, 200);
    assert_eq!(fs::read_to_string(&p).unwrap(), "next");
    assert_eq!(
        qa::handle(
            &p,
            qa::Request {
                method: "POST".into(),
                content_type: None,
                body: vec![]
            }
        )
        .status,
        405
    );
    fs::remove_dir_all(d).unwrap();
}
#[test]
fn inspection_rejects_path_traversal() {
    assert!(dashboard_workflow_inspection::inspect_workflow_symbol(
        Path::new("."),
        "../package.json",
        "Event",
        "x"
    )
    .is_none());
}
