// Source: Node src/relayd.ts. Disposable native daemon smoke verifying one
// SQLite-first scheduler and unchanged Dashboard asset through actual TCP.
// No Worker adapter, browser, production database or remote delivery is used.
use agents_relay_rust2::relayd::{run_daemon,DaemonConfig,DaemonServices};
use serde_json::{json,Value};
use std::{
    collections::HashMap,fs,
    io::{Read,Write},
    net::{TcpListener,TcpStream},
    path::{Path,PathBuf},
    sync::{Arc,atomic::{AtomicBool,Ordering}},
    thread,time::{Duration,SystemTime,UNIX_EPOCH}
};
struct NoJobs;
impl DaemonServices for NoJobs{
    fn control(&mut self,body:&Value)->Result<Value,String>{Ok(body.clone())}
    fn load(&mut self,_id:&str)->Result<Value,String>{Err("No local Job".into())}
    fn save_exact(&mut self,_id:&str,_prior:&Value,_next:&Value)
        ->Result<Value,String>{Err("No local Job".into())}
    fn job_action(&mut self,_id:&str,_action:&str)->Result<Value,String>{
        Err("No local Job".into())
    }
    fn task_command(&mut self,_body:&Value)->Result<Value,String>{
        Err("No local Job".into())
    }
    fn task_action(&mut self,_id:&str,_task_id:&str,_action:&str)
        ->Result<Value,String>{Err("No local Job".into())}
    fn job_set_state(&mut self,_id:&str,_state:&str,_target:&Value)
        ->Result<Value,String>{Err("No local Job".into())}
    fn task_set_state(&mut self,_id:&str,_task_id:&str,_state:&str,
        _target:&Value)->Result<Value,String>{Err("No local Job".into())}
    fn event_history(&mut self,_id:&str,_task_id:Option<&str>,_limit:i64)
        ->Result<Vec<Value>,String>{Ok(Vec::new())}
    fn publish_event(&mut self,_event:&Value)->Result<(),String>{Ok(())}
    fn subscribe_events(&mut self)->std::sync::mpsc::Receiver<String>{
        std::sync::mpsc::channel().1
    }
    fn router_test(&mut self,_id:&str,_task_id:&str)->Result<Value,String>{
        Err("No local Job".into())
    }
    fn decision_audit(&mut self)->Result<Vec<Value>,String>{Ok(Vec::new())}
    fn account_usage(&mut self)->Result<Value,String>{Ok(json!({}))}
    fn github_usage(&mut self)->Result<Option<Value>,String>{Ok(None)}
    fn status(&mut self)->Value{json!({"runtime":"isolated-test"})}
    fn registered_agents(&mut self)->Result<Vec<Value>,String>{Ok(Vec::new())}
    fn effect(&mut self,_action:&Value)->Result<(),String>{
        Err("Unexpected effect without a Job".into())
    }
}
fn send(port:u16,path:&str,body:Option<&str>)->String{
    let mut connected=None;
    for _ in 0..40{
        match TcpStream::connect(("127.0.0.1",port)){
            Ok(stream)=>{connected=Some(stream);break;},
            Err(_)=>thread::sleep(Duration::from_millis(25)),
        }
    }
    let mut stream=connected.expect("isolated daemon did not start listening");
    stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    let method=if body.is_some(){"POST"}else{"GET"};
    let body=body.unwrap_or("");
    let data=format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n\
        Content-Type: application/json\r\nContent-Length: {}\r\n\
        Connection: close\r\n\r\n{body}",body.len());
    stream.write_all(data.as_bytes()).unwrap();
    let mut reply=String::new();
    stream.read_to_string(&mut reply).unwrap();
    reply
}
#[test]
fn native_daemon_serves_original_ui_and_sqlite_first_status_then_stops_cleanly(){
    let port_socket=TcpListener::bind(("127.0.0.1",0)).unwrap();
    let port=port_socket.local_addr().unwrap().port();
    drop(port_socket);
    let root=std::env::temp_dir().join(format!("rust2-native-daemon-{}-{}",
        std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH)
            .unwrap().as_nanos()));
    fs::create_dir_all(&root).unwrap();
    let html=root.join("dashboard.html");
    let exact=b"<!doctype html>\n<html>Original JS/CSS remains untouched</html>\n";
    fs::write(&html,exact).unwrap();
    let config=DaemonConfig{
        workspace_root:root.join("workspace"),
        store_directory:root.join("store"),
        graph_directory:PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../workflow"),
        profile_home:root.join("profiles"),
        policy_path:root.join("policy"),
        router_rules_path:root.join("rules"),
        dashboard_asset:html,repositories:Vec::new(),
        port,concurrency:4,interval_ms:150,lease_ms:300000,
        no_github:true,event_transport:json!({}),
    };
    let stop=Arc::new(AtomicBool::new(false));
    let for_thread=stop.clone();
    let handle=thread::spawn(move ||{
        run_daemon(config,NoJobs,&for_thread,|_job|{
            panic!("There can be no Job Reconciler in an empty SQLite inventory")
        })
    });
    let response=send(port,"/",None);
    assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
    assert!(response.ends_with(include_str!("../../dashboard/index.html")));
    // PWA resources and version config use the same HTTP transport as Node.
    let css=send(port,"/dashboard.css",None);
    assert!(css.ends_with(include_str!("../../dashboard/dashboard.css")));
    let script=send(port,"/dashboard.js",None);
    assert!(script.ends_with(include_str!("../../dashboard/dashboard.js")));
    assert!(send(port,"/service-worker.js",None).contains("no-cache"));
    let response=send(port,"/api/status",None);
    assert!(response.contains("{\"runtime\":\"isolated-test\"}"));
    let response=send(port,"/api/control",
        Some("{\"command\":\"job.reconcile\",\"jobId\":\"101\"}"));
    assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
    assert!(response.contains("\"command\":\"job.reconcile\""));
    stop.store(true,Ordering::Release);
    handle.join().unwrap().unwrap();
    fs::remove_dir_all(root).unwrap();
}
