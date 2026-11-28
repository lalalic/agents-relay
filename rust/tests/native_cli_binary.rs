//! Live native CLI process tests. Every HTTP server is loopback, in this
//! process, with no access to the user's durable Relay store or Node daemon.
use serde_json::{json,Value};
use std::{io::{BufRead,BufReader,Read,Write},net::TcpListener,process::Command,thread};
fn binary()->String {env!("CARGO_BIN_EXE_agents-relay-rust").to_string()}
#[test]
fn cli_help_version_and_unwired_actions_fail_closed(){
    let help=Command::new(binary()).arg("--help").output().unwrap();
    assert!(help.status.success());
    let text=String::from_utf8(help.stdout).unwrap();
    assert!(text.contains("Agents Relay coordinates durable asynchronous"));
    let version=Command::new(binary()).arg("--version").output().unwrap();
    assert!(version.status.success());
    assert!(String::from_utf8(version.stdout).unwrap().contains("native preview"));
    let unavailable=Command::new(binary()).args(["job","run","--id","99"])
        .output().unwrap();
    assert!(!unavailable.status.success());
    assert!(String::from_utf8(unavailable.stderr).unwrap()
        .contains("job run requires --task-id"));
}
#[test]
fn unknown_cli_flags_fail_before_help_or_daemon_dispatch(){
    for command in [["job","show","--id","17"].as_slice(),
        ["job","create","--help"].as_slice(),["--help"].as_slice()]{
        let mut args=command.to_vec();
        args.push("--never-supported");
        let output=Command::new(binary()).args(&args).output().unwrap();
        assert!(!output.status.success(), "unknown flag must fail: {args:?}");
        assert!(String::from_utf8_lossy(&output.stderr)
            .contains("Unknown option --never-supported"));
    }
}
#[test]
fn cli_uses_real_daemon_http_get_and_post_without_node(){
    let listener=TcpListener::bind("127.0.0.1:0").unwrap();
    let port=listener.local_addr().unwrap().port().to_string();
    let server=thread::spawn(move||{
        for i in 0..2{
            let (mut stream,_) = listener.accept().unwrap();
            stream.set_read_timeout(Some(std::time::Duration::from_secs(3))).unwrap();
            let mut reader=BufReader::new(&mut stream);
            let mut first=String::new();
            reader.read_line(&mut first).unwrap();
            let mut content_length=0usize;
            loop{
                let mut line=String::new();
                reader.read_line(&mut line).unwrap();
                if line=="\r\n"||line.is_empty(){break;}
                if line.to_ascii_lowercase().starts_with("content-length:"){
                    content_length=line[15..].trim().parse::<usize>().unwrap();
                }
            }
            let mut bytes=vec![0u8;content_length];
            reader.read_exact(&mut bytes).unwrap();
            let data=format!("{first}{}",String::from_utf8_lossy(&bytes));
            drop(reader);
            let body=if i==0{
                // Node src/cli.ts status uses the public runtime summary,
                // not the lower-level /api/status health endpoint.
                assert!(data.starts_with("GET /api/runtime-summary"),
                    "Native CLI must match stable Node status route: {data}");
                json!({"runtime":"rust-native-test","active":0})
            }else{
                assert!(data.starts_with("POST /api/control"));
                let payload:Value=serde_json::from_slice(&bytes).unwrap();
                assert_eq!(payload["command"],"job.reconcile");
                assert_eq!(payload["jobId"],"13");
                json!({"accepted":true,"jobId":"13"})
            };
            let body=body.to_string();
            let response=format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
            stream.write_all(response.as_bytes()).unwrap();
        }
    });
    let result=Command::new(binary()).args(["status","--port",&port]).output().unwrap();
    assert!(result.status.success(),"{}",String::from_utf8_lossy(&result.stderr));
    let value:Value=serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(value["runtime"],"rust-native-test");
    let result=Command::new(binary()).args(["reconcile","--id","13","--port",&port])
        .output().unwrap();
    assert!(result.status.success(),"{}",String::from_utf8_lossy(&result.stderr));
    let value:Value=serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(value["accepted"],true);
    server.join().unwrap();
}

#[test]
fn native_cli_review_and_revision_use_exact_daemon_control_requests(){
    let listener=TcpListener::bind("127.0.0.1:0").unwrap();
    let port=listener.local_addr().unwrap().port().to_string();
    let server=thread::spawn(move||{
        for step in 0..2{
            let (mut stream,_) =listener.accept().unwrap();
            stream.set_read_timeout(Some(std::time::Duration::from_secs(4))).unwrap();
            let mut reader=BufReader::new(&mut stream);
            let mut first=String::new();reader.read_line(&mut first).unwrap();
            assert!(first.starts_with("POST /api/control"));
            let mut length=0usize;
            loop{
                let mut line=String::new();reader.read_line(&mut line).unwrap();
                if line.is_empty()||line=="\r\n"{break;}
                if line.to_ascii_lowercase().starts_with("content-length:"){
                    length=line[15..].trim().parse().unwrap();
                }
            }
            let mut bytes=vec![0u8;length];reader.read_exact(&mut bytes).unwrap();
            drop(reader);
            let request:Value=serde_json::from_slice(&bytes).unwrap();
            let response=if step==0{
                assert_eq!(request["command"],"review.request");
                assert_eq!(request["jobId"],"17");
                assert!(request.get("threadId").is_none());
                json!({"id":"17","prNumber":0})
            }else{
                assert_eq!(request["command"],"task.revise");
                assert_eq!(request["jobId"],"17");
                assert_eq!(request["taskId"],"2");
                assert_eq!(request["reviewTaskId"],"4");
                assert_eq!(request["reviewExecutionId"],"exec-4");
                assert_eq!(request["requestId"],"review-f1");
                assert_eq!(request["findings"][0]["summary"],"Correct the regression");
                json!({"request":{"requestId":"review-f1","originalTaskId":"2",
                  "revisionTaskId":"9"},"created":true})
            };
            let body=response.to_string();
            let frame=format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
            stream.write_all(frame.as_bytes()).unwrap();
        }
    });
    let review=Command::new(binary()).args(["review","job","--repo","project",
        "--id","17","--port",&port]).output().unwrap();
    assert!(review.status.success(),"{}",String::from_utf8_lossy(&review.stderr));
    let receipt:Value=serde_json::from_slice(&review.stdout).unwrap();
    assert_eq!(receipt["status"],"requested");
    assert!(receipt.get("reviewerThreadId").is_none());
    let temp=std::env::temp_dir().join(format!("rust-cli-revision-{}",std::process::id()));
    std::fs::write(&temp,"[{\"id\":\"f1\",\"summary\":\"Correct the regression\"}]").unwrap();
    let revise=Command::new(binary()).args(["task","revise","--repo","project",
        "--id","17","--task-id","2","--review-task-id","4",
        "--execution-id","exec-4","--head-sha","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "--request-id","review-f1","--findings-file",temp.to_str().unwrap(),
        "--port",&port]).output().unwrap();
    assert!(revise.status.success(),"{}",String::from_utf8_lossy(&revise.stderr));
    let result:Value=serde_json::from_slice(&revise.stdout).unwrap();
    assert_eq!(result["status"],"durable");
    assert_eq!(result["request"]["revisionTaskId"],"9");
    server.join().unwrap();
    std::fs::remove_file(temp).unwrap();
}

// Original Node src/cli-escalation.ts: installed native CLI must dispatch
// canonical Graph to an operator-selected owned subprocess; no live provider.
#[cfg(unix)]
#[test]
fn native_escalation_cli_uses_only_configured_executor_and_graph_exit_codes(){
    use std::{fs,os::unix::fs::PermissionsExt,
        path::Path,time::{SystemTime,UNIX_EPOCH}};
    let root=std::env::temp_dir().join(format!("rust2-escalation-cli-{}-{}",
        std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH)
            .unwrap().as_nanos()));
    fs::create_dir_all(&root).unwrap();
    let script=root.join("provider.sh");
    let log=root.join("handoff-path");
    fs::write(&script,r#"#!/bin/sh
printf '%s' "$4" > "$2"
test "$3" = "--handoff-file" || exit 9
test -r "$4" || exit 10
grep -q '# Intent' "$4" || exit 11
grep -q 'verify native escalation' "$4" || exit 12
if [ "$1" = "resolved" ]; then
    echo '{"status":"resolved","summary":"fixture complete"}'
elif [ "$1" = "needs_user" ]; then
    echo '{"status":"needs_user","summary":"requires user approval"}'
elif [ "$1" = "secret" ]; then
    echo 'SECRET-SHOULD-NOT-BE-PRINTED' >&2
    exit 7
else
    echo 'not valid JSON'
fi
"#).unwrap();
    fs::set_permissions(&script,fs::Permissions::from_mode(0o700)).unwrap();
    let graph=Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    for (mode,state,exit) in [
        ("resolved","resolved",0),("needs_user","needs_user",0),
        ("invalid","technical_failure",2),("secret","technical_failure",2)
    ]{
        // Prefix args select the local fixture mode, then native code
        // appends --handoff-file plus a newly created private path.
        let selected=json!([script.to_string_lossy(),mode,log.to_string_lossy()]);
        let result=Command::new(binary()).current_dir(graph)
            .env("AGENTS_RELAY_ESCALATION_COMMAND",selected.to_string())
            .args(["escalation","--intent","verify native escalation",
                "--blocked-on","fixture unavailable"]).output().unwrap();
        let out=String::from_utf8_lossy(&result.stdout);
        let err=String::from_utf8_lossy(&result.stderr);
        assert_eq!(result.status.code(),Some(exit),"{mode}: {err}");
        let payload:Value=serde_json::from_str(&out).unwrap();
        assert_eq!(payload["state"],state,"{mode}: {out}");
        assert!(!out.contains("SECRET-SHOULD-NOT-BE-PRINTED"));
        assert!(!err.contains("SECRET-SHOULD-NOT-BE-PRINTED"));
        // Operator handoff path must be transient and deleted after exit.
        if log.exists(){
            let handoff=fs::read_to_string(&log).unwrap();
            assert!(!Path::new(&handoff).exists(),"private handoff leaked");
        }
    }
    let denied=Command::new(binary()).current_dir(graph)
        .env_remove("AGENTS_RELAY_ESCALATION_COMMAND")
        .args(["escalation","--intent","verify native escalation",
            "--blocked-on","fixture unavailable"]).output().unwrap();
    assert_eq!(denied.status.code(),Some(2));
    assert_eq!(serde_json::from_slice::<Value>(&denied.stdout).unwrap()["state"],
        "technical_failure");
    fs::remove_dir_all(&root).unwrap();
}
