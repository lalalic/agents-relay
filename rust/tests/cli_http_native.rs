// Source provenance: Node src/cli-blocker.ts, src/cli-revision.ts plus the
// explicit cli-support.ts HTTP transport. Test-owned 127.0.0.1 server only.
use agents_relay_rust2::{cli_blocker, cli_revision};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::TcpListener,
    thread,
    time::Duration,
};

fn server(status: &str, reply: Value) -> (Vec<String>, thread::JoinHandle<(String, String)>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("test-only ephemeral listener");
    let port = listener.local_addr().unwrap().port();
    let status = status.to_string();
    let handle = thread::spawn(move || {
        let (mut socket, _) = listener.accept().expect("one client");
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut input = Vec::new();
        let header_end = loop {
            let mut chunk = [0; 8192];
            let count = socket.read(&mut chunk).expect("read HTTP header");
            assert!(count > 0);
            input.extend_from_slice(&chunk[..count]);
            if let Some(end) = input.windows(4).position(|b| b == b"\r\n\r\n") {
                break end + 4;
            }
        };
        let headers = String::from_utf8_lossy(&input[..header_end]).to_string();
        let length = headers
            .lines()
            .find_map(|line| {
                line.to_lowercase()
                    .strip_prefix("content-length:")
                    .and_then(|n| n.trim().parse::<usize>().ok())
            })
            .unwrap_or(0);
        while input.len() - header_end < length {
            let mut chunk = [0; 8192];
            let count = socket.read(&mut chunk).expect("read HTTP body");
            assert!(count > 0);
            input.extend_from_slice(&chunk[..count]);
        }
        let body = String::from_utf8(input[header_end..].to_vec()).unwrap();
        let response = reply.to_string();
        let bytes = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
            response.len()
        );
        socket.write_all(bytes.as_bytes()).unwrap();
        (headers.lines().next().unwrap_or("").to_string(), body)
    });
    (
        vec![
            "--host".into(),
            "127.0.0.1".into(),
            "--port".into(),
            port.to_string(),
        ],
        handle,
    )
}
fn appended(mut args: Vec<String>, flags: &[&str]) -> Vec<String> {
    args.extend(flags.iter().map(|s| s.to_string()));
    args
}
#[test]
fn blocker_post_and_get_keep_identities() {
    let (server_args, handle) = server("200 OK", json!({"created":true,"id":"9"}));
    let args = appended(
        server_args,
        &[
            "--repo",
            "toy",
            "--id",
            "4",
            "--target-repo",
            "core",
            "--request-id",
            "repair-1",
            "--dependent-task",
            "6",
            "--reason",
            "broken",
            "--title",
            "fix",
            "--objective",
            "# fix",
            "--authorized",
        ],
    );
    let result = cli_blocker::run_blocker_command("ensure", &args, None).unwrap();
    assert_eq!(result["created"], true);
    let (request, body) = handle.join().unwrap();
    assert_eq!(request, "POST /api/control HTTP/1.1");
    let body: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(body["command"], "blocker.ensure");
    assert_eq!(body["request"]["dependentJobId"], "4");
    assert_eq!(body["request"]["dependentTaskId"], "6");
    assert_eq!(body["request"]["authorized"], true);

    let (server_args, handle) = server("200 OK", json!({"id":"9","repository":"toy"}));
    let args = appended(server_args, &["--repo", "toy", "--id", "9"]);
    let result = cli_blocker::run_blocker_command("show", &args, None).unwrap();
    assert_eq!(result["id"], "9");
    let (request, body) = handle.join().unwrap();
    assert_eq!(request, "GET /api/job?id=9&repo=toy HTTP/1.1");
    assert_eq!(body, "");
}
#[test]
fn targeted_revision_checks_http_receipt_and_errors() {
    let file = std::env::temp_dir().join(format!("rust2-cli-revision-{}.json", std::process::id()));
    std::fs::write(&file, r#"[{"id":"f1","summary":"repair"}]"#).unwrap();
    let (server_args, handle) = server(
        "200 OK",
        json!({"created":true,"request":{"requestId":"r","originalTaskId":"7","revisionTaskId":"8"}}),
    );
    let args = appended(
        server_args,
        &[
            "--repo",
            "toy",
            "--id",
            "5",
            "--task-id",
            "7",
            "--review-task-id",
            "9",
            "--execution-id",
            "execution",
            "--head-sha",
            "abc",
            "--request-id",
            "r",
            "--findings-file",
            file.to_str().unwrap(),
        ],
    );
    let receipt = cli_revision::run_task_revise_command(&args).unwrap();
    assert_eq!(receipt["status"], "durable");
    let (_, body) = handle.join().unwrap();
    let posted: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(posted["findings"][0]["id"], "f1");
    assert_eq!(posted["reviewExecutionId"], "execution");

    let (server_args, handle) = server("403 Forbidden", json!({"error":"denied"}));
    let args = appended(server_args, &["--repo", "toy", "--id", "7"]);
    let err = cli_blocker::run_blocker_command("resolve", &args, None).unwrap_err();
    assert_eq!(
        err,
        "Agents Relay control command failed: {\"error\":\"denied\"}"
    );
    handle.join().unwrap();
    std::fs::remove_file(file).unwrap();
}
