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
    // An actual native Rust fixture executable rather than /bin/sh shebang.
    // The verified owned-process-supervisor and WebHelm AF_UNIX socket are
    // still exercised. The profile-only shim is never a model Worker.
    fs::copy(env!("CARGO_BIN_EXE_relay-rust2-parity"),&command).unwrap();
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
            let mut line=String::new();
            let read_deadline=Instant::now()+Duration::from_secs(3);
            loop{
                match reader.read_line(&mut line){
                    Ok(size) if size>0=>break,
                    Err(error) if error.kind()==std::io::ErrorKind::WouldBlock
                        ||error.kind()==std::io::ErrorKind::TimedOut=>{
                        assert!(Instant::now()<read_deadline,
                            "disposable WebHelm IPC read deadline expired: {error}");
                        thread::sleep(Duration::from_millis(5));
                    },
                    Ok(_)=>panic!("test-owned WebHelm received empty request"),
                    Err(error)=>panic!("test-owned WebHelm read failed: {error}"),
                }
            }
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
fn run_case_with_policy_with_start(
    temporary:bool,barrier_ok:bool,policy:&str,start_ok:bool)
    ->(Result<agents_relay_rust2::adapters::WorkerExecution,String>,i64,i64,i64,Vec<String>){
    let (root,cli,socket)=fixture();
    let receipt=json!({"status":"submitted","verified_by":"fixture",
        "thread_id":"fixturethread12345",
        "thread_url":"https://chatgpt.com/c/fixturethread12345",
        "temporary":temporary});
    let expect_release=!temporary&&barrier_ok&&start_ok&&policy!="never";
    let hosted=server(&socket,receipt,expect_release);
    let mut pool=BrowserWorkerPoolManager::open(BrowserPoolOptions{
        path:Some(root.join("pool.sqlite")),capacity:1,queue_wait_ms:1500,
        poll_ms:5,..Default::default()
    }).unwrap();
    let task=json!({"id":"2","jobId":"17","executionId":"fixture-uuid-00000001",
        "adapter":"chatgpt","input":"[Relay agent: worker; adapter: chatgpt]\nDo actual work",
        "routing":{"adapter":"chatgpt","projectId":"isolated-test"},
        "chatgptTabClosePolicy":policy,"timeoutMs":6000});
    let adapter=ChatGptAdapter::default();
    let mut barriers=Vec::<String>::new();
    let response=adapter.launch(&task,&socket,&cli,"Relay",&mut pool,
        &AtomicBool::new(false),|barrier|{
            assert!(matches!(barrier,"worker-start"|"terminal"),
                "unrecognized Worker barrier: {barrier}");
            if barrier=="terminal"{
                assert_eq!(policy,"after-terminal");
                assert_eq!(barriers,vec!["worker-start"],
                    "terminal is never a substitute for committed task.started");
            }
            barriers.push(barrier.into());
            if barrier=="worker-start"&&!start_ok{
                Err("worker_start_timeout: no worker start-ack".into())
            }else if !barrier_ok
                &&(barrier=="terminal"||policy=="never"){
                Err("No verified terminal event".into())
            }else{Ok(())}
        });
    if !temporary{
        if !start_ok||policy=="never"{
            assert_eq!(barriers,vec!["worker-start"]);
        }else{
            assert_eq!(barriers,vec!["worker-start","terminal"]);
        }
    }
    let snapshot=pool.snapshot("chatgpt").unwrap();
    let operations=hosted.join().unwrap();
    fs::remove_dir_all(root).unwrap();
    (response,snapshot.idle,snapshot.leased,snapshot.quarantined,operations)
}
fn run_case_with_policy(temporary:bool,barrier_ok:bool,policy:&str)
    ->(Result<agents_relay_rust2::adapters::WorkerExecution,String>,i64,i64,i64,Vec<String>){
    run_case_with_policy_with_start(temporary,barrier_ok,policy,true)
}
#[test]
fn after_terminal_without_authoritative_worker_start_quarantines_immediately(){
    let (result,idle,leased,quarantined,operations)=
        run_case_with_policy_with_start(false,true,"after-terminal",false);
    assert!(result.unwrap_err().contains("worker_start_timeout"));
    assert_eq!((idle,leased,quarantined),(0,0,1));
    assert_eq!(operations,vec!["workspace-create","start","platform-run"]);
}
fn run_case(temporary:bool,barrier_ok:bool)
    ->(Result<agents_relay_rust2::adapters::WorkerExecution,String>,i64,i64,Vec<String>){
    let (outcome,idle,_leased,quarantined,ops)=
        run_case_with_policy(temporary,barrier_ok,"after-terminal");
    (outcome,idle,quarantined,ops)
}
#[test]
fn verified_submission_with_never_close_still_requires_real_start_ack(){
    let (result,idle,leased,quarantined,operations)=
        run_case_with_policy(false,true,"never");
    assert!(result.is_ok(),"verified worker start should allow never-close");
    assert_eq!((idle,leased,quarantined),(0,1,0),
        "never-close only retains a live leased Session after actual Task start");
    assert_eq!(operations,vec!["workspace-create","start","platform-run"]);
}
#[test]
fn never_close_without_authoritative_start_ack_quarantines_webhelm_lease(){
    let (result,idle,leased,quarantined,operations)=
        run_case_with_policy(false,false,"never");
    assert!(result.unwrap_err().contains("No verified terminal event"));
    assert_eq!((idle,leased,quarantined),(0,0,1),
        "no-start timeout must quarantine uncertain browser Session");
    assert_eq!(operations,vec!["workspace-create","start","platform-run"]);
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
    let error=response.unwrap_err();
    assert!(error.contains("No verified terminal event"),
        "expected Graph terminal barrier rejection, got: {error}");
    assert_eq!(idle,0);assert_eq!(quarantined,1);
    assert_eq!(ops,vec!["workspace-create","start","platform-run"]);
}
