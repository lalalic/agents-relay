// Native regression for Node src/cli-projection.ts: injection-safe validated projection command dispatch through real disposable localhost HTTP.
use agents_relay_rust2::cli_projection::{
    projection_control_command, projection_help, run_projection_command,
};
use serde_json::json;
use std::{
    io::{Read, Write},
    net::TcpListener,
    thread,
};
fn args(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).to_string()).collect()
}
#[test]
fn all_public_projection_help_strings_match_the_node_contract() {
    assert!(
        projection_help(None).contains("projection conflicts --repo LOCAL_ROOT_NAME --id JOB_ID")
    );
    assert_eq!(projection_help(Some("resolve")),"Explicitly repair one classified projection conflict.\n\nRequired: --repo LOCAL_ROOT_NAME --id JOB_ID --projection-id ID --action requeue|discard-local.");
    assert_eq!(projection_help(Some("list")), projection_help(None));
}
#[test]
fn ensure_required_job_id_and_strict_positive_integer_projection_id() {
    assert_eq!(
        projection_control_command("conflicts", &[]).unwrap_err(),
        "projection commands require --id JOB_ID"
    );
    assert_eq!(
        projection_control_command("resolve", &args(&["--id", "42"])).unwrap_err(),
        "projection resolve requires --projection-id ID"
    );
    assert_eq!(
        projection_control_command("resolve", &args(&["--id", "42", "--projection-id", "-1"]))
            .unwrap_err(),
        "--projection-id must be a non-negative integer"
    );
    assert_eq!(
        projection_control_command("resolve", &args(&["--id", "42", "--projection-id", "1.5"]))
            .unwrap_err(),
        "--projection-id must be a non-negative integer"
    );
    assert_eq!(
        projection_control_command(
            "resolve",
            &args(&["--id", "42", "--projection-id", "3", "--action", "merge"])
        )
        .unwrap_err(),
        "--action must be requeue or discard-local"
    );
}
#[test]
fn resolved_http_command_uses_only_explicit_local_job_and_projection_id() {
    let body = projection_control_command(
        "resolve",
        &args(&[
            "--id",
            "job-42",
            "--projection-id",
            "0x10",
            "--action",
            "discard-local",
            "--note",
            "approved",
        ]),
    )
    .unwrap();
    assert_eq!(
        body,
        json!({"command":"projection.resolve","jobId":"job-42","projectionId":16,"action":"discard_local","note":"approved"})
    );
    let listing = projection_control_command("conflicts", &args(&["--id", "job-42"])).unwrap();
    assert_eq!(
        listing,
        json!({"command":"projection.conflicts","jobId":"job-42"})
    );
}
#[test]
fn real_localhost_http_post_emits_correct_body_and_printed_json() {
    let server = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = server.local_addr().unwrap().port().to_string();
    let worker = thread::spawn(move || {
        let (mut stream, _) = server.accept().unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        let mut body = Vec::new();
        let mut buffer = [0u8; 4096];
        let len = stream.read(&mut buffer).unwrap();
        body.extend_from_slice(&buffer[..len]);
        let mut text = String::from_utf8_lossy(&body).to_string();
        // The kernel may split HTTP headers from the JSON POST body across
        // multiple packets; do not assert after only one read().
        while !text.contains("projection.conflicts") {
            let read = stream.read(&mut buffer).unwrap_or(0);
            if read == 0 {
                break;
            }
            body.extend_from_slice(&buffer[..read]);
            text = String::from_utf8_lossy(&body).to_string();
        }
        let reply = r#"{"answer":"accepted","items":[1,2]}"#;
        let result=format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{reply}",reply.len());
        stream.write_all(result.as_bytes()).unwrap();
        text
    });
    let output =
        run_projection_command("conflicts", &args(&["--id", "42", "--port", &port])).unwrap();
    let request = worker.join().unwrap();
    assert!(request.contains("POST /api/control HTTP/1.1"));
    let body = request.split("\r\n\r\n").nth(1).expect("HTTP POST body");
    let posted: serde_json::Value = serde_json::from_str(body).expect("valid JSON request");
    assert_eq!(
        posted,
        json!({"command":"projection.conflicts","jobId":"42"})
    );
    assert!(output.contains("\"answer\": \"accepted\""));
}
#[test]
fn projection_cli_rejects_invalid_ports_before_network_or_durable_writes() {
    for port in ["0", "65536", "oops", "1.5", "-1"] {
        let error = run_projection_command("conflicts", &args(&["--id", "job", "--port", port]))
            .unwrap_err();
        assert_eq!(error, "--port must be an integer between 1 and 65535");
    }
}
