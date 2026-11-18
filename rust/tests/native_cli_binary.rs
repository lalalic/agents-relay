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
        .contains("not yet bound to the daemon"));
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
                assert!(data.starts_with("GET /api/status"));
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
                assert_eq!(request["threadId"],"thread-fixture-123456");
                json!({"id":"17","prNumber":0,"reviewerThreadId":"thread-fixture-123456"})
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
        "--id","17","--thread-id","thread-fixture-123456","--port",&port]).output().unwrap();
    assert!(review.status.success(),"{}",String::from_utf8_lossy(&review.stderr));
    let receipt:Value=serde_json::from_slice(&review.stdout).unwrap();
    assert_eq!(receipt["status"],"requested");
    assert_eq!(receipt["reviewerThreadId"],"thread-fixture-123456");
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
