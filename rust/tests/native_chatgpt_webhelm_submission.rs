//! Real Unix-socket WebHelm IPC and native owned CLI subprocesses against
//! a disposable test-owned fake daemon, never a user ChatGPT browser Session.
//! A verified WebHelm receipt cannot mark a Relay Task SUCCEEDED. Uncertain
//! submissions quarantine the exact Browser Pool lease.
use agents_relay_rust2::{
    adapters::ChatGptAdapter,
    browser_worker_pool::{BrowserPoolOptions,BrowserWorkerPoolManager},
};
use serde_json::{json,Value};
use std::{
    fs,io::{BufRead,BufReader,Write},
    os::unix::{fs::PermissionsExt,net::UnixListener},
    path::{Path,PathBuf},
    sync::atomic::AtomicBool,
    thread,time::{Duration,Instant,SystemTime,UNIX_EPOCH},
};
fn fixture()->(PathBuf,PathBuf,PathBuf){
    // macOS AF_UNIX sockaddr.sun_path is short; use a short, isolated
    // temporary path so the test fails on protocol, not socket name length.
    let root=PathBuf::from("/tmp").join(format!("r2w-{}-{}",std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
    fs::create_dir_all(&root).unwrap();
    let command=root.join("fake-webhelm");
    fs::write(&command,"#!/bin/sh\nif [ \"$1\" = \"platform\" ]; then printf '{\"platform\":\"chatgpt\"}\\n'; else printf '{\"ok\":true}\\n'; fi\n").unwrap();
    fs::set_permissions(&command,fs::Permissions::from_mode(0o700)).unwrap();
    (root.clone(),command,root.join("webhelm.sock"))
}
fn server(socket:&Path,receipt:Value,release:bool)->thread::JoinHandle<Vec<String>>{
    let listener=UnixListener::bind(socket).unwrap();
    listener.set_nonblocking(true).unwrap();
    thread::spawn(move||{
        let mut seen=Vec::new();
        let until=Instant::now()+Duration::from_secs(6);
        loop{
            if Instant::now()>until{break;}
            let (mut stream,_)=match listener.accept(){
                Ok(value)=>value,
                Err(error) if error.kind()==std::io::ErrorKind::WouldBlock=>{
                    thread::sleep(Duration::from_millis(5));continue;
                },
                Err(error)=>panic!("test-owned WebHelm socket failed: {error}"),
            };
            stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            let mut reader=BufReader::new(&stream);
            let mut line=String::new();reader.read_line(&mut line).unwrap();
            drop(reader);
            let command:Value=serde_json::from_str(&line).unwrap();
            let op=command["op"].as_str().unwrap().to_owned();
            seen.push(op.clone());
            let response=match op.as_str(){
                "workspace-create"=>json!({"ok":true}),
                "start"=>json!({"ok":true,"workspace":"Relay",
                    "workspace_supported":true,"session_id":"fixture-session-01"}),
                "platform-run"=>{
                    assert_eq!(command["platform"],"chatgpt");
                    assert_eq!(command["action"],"new-thread");
                    assert_eq!(command["session_id"],"fixture-session-01");
                    assert_eq!(command["config"]["temporary"],false);
                    assert!(command["config"]["message"].is_string());
                    receipt.clone()
                },
                "stop"=>{
                    assert_eq!(command["session_id"],"fixture-session-01");
                    json!({"ok":true,"returned_to_idle":true})
                },
                other=>panic!("unexpected WebHelm test IPC operation {other}"),
            };
            stream.write_all(format!("{response}\n").as_bytes()).unwrap();
            if op=="platform-run"&&!release{break;}
            if op=="stop"{break;}
        }
        seen
    })
}
fn run_case(temporary:bool,barrier_ok:bool)->(Result<agents_relay_rust2::adapters::WorkerExecution,String>,i64,i64,Vec<String>){
    let (root,cli,socket)=fixture();
    let receipt=json!({"status":"submitted","verified_by":"fixture",
        "thread_id":"fixturethread12345",
        "thread_url":"https://chatgpt.com/c/fixturethread12345",
        "temporary":temporary});
    let expect_release=!temporary&&barrier_ok;
    let hosted=server(&socket,receipt,expect_release);
    let mut pool=BrowserWorkerPoolManager::open(BrowserPoolOptions{
        path:Some(root.join("pool.sqlite")),capacity:1,queue_wait_ms:1500,
        poll_ms:5,..Default::default()
    }).unwrap();
    let task=json!({"id":"2","jobId":"17","executionId":"fixture-uuid-00000001",
        "adapter":"chatgpt","input":"[Relay agent: worker; adapter: chatgpt]\nDo actual work",
        "routing":{"adapter":"chatgpt","projectId":"isolated-test"},
        "chatgptTabClosePolicy":"after-terminal","timeoutMs":6000});
    let adapter=ChatGptAdapter::default();
    let response=adapter.launch(&task,&socket,&cli,"Relay",&mut pool,
        &AtomicBool::new(false),|barrier|{
            assert_eq!(barrier,"terminal","Browser submission is NOT Worker start proof");
            if barrier_ok{Ok(())}else{Err("No verified terminal event".into())}
        });
    let snapshot=pool.snapshot("chatgpt").unwrap();
    let operations=hosted.join().unwrap();
    fs::remove_dir_all(root).unwrap();
    (response,snapshot.idle,snapshot.quarantined,operations)
}
#[test]
fn valid_browser_submission_releases_only_after_verified_terminal_barrier(){
    let (response,idle,quarantined,ops)=run_case(false,true);
    let result=response.unwrap();
    assert_eq!(result.delivery_receipt.as_ref().unwrap()["thread_id"],"fixturethread12345");
    assert_eq!(result.result["data"]["submitted"],true);
    assert_eq!(result.result["data"]["mode"],"new-thread");
    assert_eq!(idle,1);assert_eq!(quarantined,0);
    assert_eq!(ops,vec!["workspace-create","start","platform-run","stop"]);
    assert!(result.result.get("state").is_none(),
        "WebHelm submission must not report Task state as SUCCEEDED");
}
#[test]
fn temporary_or_unverified_browser_thread_quarantines_uncertain_pool_lease(){
    let (response,idle,quarantined,ops)=run_case(true,true);
    assert!(response.unwrap_err().contains("durable ChatGPT thread"));
    assert_eq!(idle,0);assert_eq!(quarantined,1);
    assert_eq!(ops,vec!["workspace-create","start","platform-run"]);
}
#[test]
fn missing_authoritative_terminal_event_quarantines_submitted_session(){
    let (response,idle,quarantined,ops)=run_case(false,false);
    assert!(response.unwrap_err().contains("No verified terminal event"));
    assert_eq!(idle,0);assert_eq!(quarantined,1);
    assert_eq!(ops,vec!["workspace-create","start","platform-run"]);
}
