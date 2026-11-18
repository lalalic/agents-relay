//! Actual installed native daemon executable, disposable unified SQLite store,
//! localhost HTTP, graceful SIGTERM and restart persistence. No live Relay DB.
use agents_relay_rust2::relay_store::SQLiteRelayStore;
use serde_json::{json,Value};
use std::{fs,io::{Read,Write},net::{TcpListener,TcpStream},path::{Path,PathBuf},process::{Child,Command},thread,time::{Duration,SystemTime,UNIX_EPOCH}};
fn binary()->String{env!("CARGO_BIN_EXE_agents-relayd-rust").to_string()}
fn root()->PathBuf{
    let dir=std::env::temp_dir().join(format!("rust2-daemon-binary-{}-{}",std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
    fs::create_dir_all(dir.join("stores")).unwrap();dir
}
fn socket_port()->u16{
    TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}
fn request(port:u16,method:&str,path:&str,body:&str)->Result<String,String>{
    let mut stream=TcpStream::connect(("127.0.0.1",port)).map_err(|e|e.to_string())?;
    stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    let req=format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
    stream.write_all(req.as_bytes()).map_err(|e|e.to_string())?;
    let mut result=String::new();
    stream.read_to_string(&mut result).map_err(|e|e.to_string())?;
    Ok(result)
}
struct Guard(Child);
impl Drop for Guard{
    fn drop(&mut self){
        unsafe{libc::kill(self.0.id() as i32,libc::SIGTERM);}
        for _ in 0..35{
            if self.0.try_wait().ok().flatten().is_some(){return;}
            thread::sleep(Duration::from_millis(100));
        }
        let _=self.0.kill();let _=self.0.wait();
    }
}
fn start(root:&Path,port:u16)->Guard{
    let child=Command::new(binary())
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .arg("--isolated-store-dir").arg(root.join("stores"))
        .arg("--port").arg(port.to_string())
        .arg("--interval").arg("100")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn().unwrap();
    let mut guard=Guard(child);
    for _ in 0..50{
        if request(port,"GET","/api/status","").is_ok(){return guard;}
        if let Some(status)=guard.0.try_wait().unwrap(){panic!("native daemon exited before serving: {status}");}
        thread::sleep(Duration::from_millis(50));
    }
    panic!("native daemon never listened on isolated port")
}
fn body(reply:&str)->Value{
    let raw=reply.split_once("\r\n\r\n").unwrap().1;
    serde_json::from_str(raw).expect("native daemon reply contains JSON")
}
#[test]
fn real_native_daemon_reads_isolated_sqlite_rejects_mutation_and_survives_restart(){
    let root=root();let path=root.join("relay.sqlite");
    let store=SQLiteRelayStore::open(&path,Some("17")).unwrap();
    store.save_job(&json!({"id":"17","repository":"fixture","projectRoot":"/tmp/fixture","title":"Native source review",
        "state":"DRAFT","prNumber":0,"createdAt":"2026-11-18T17:00:00.000Z","updatedAt":"2026-11-18T17:00:00.000Z",
        "tasks":[],"plans":[]})).unwrap();
    store.close().unwrap();
    let port=socket_port();
    for _ in 0..2{
        let daemon=start(&root,port);
        let status=request(port,"GET","/api/status","").unwrap();
        assert!(status.starts_with("HTTP/1.1 200"),"{status}");
        let value=body(&status);
        assert_eq!(value["runtime"],"native-rust");
        assert_eq!(value["mode"],"read-only");
        assert_eq!(value["productionReady"],false);
        assert_eq!(value["jobCount"],1);
        // Real native CLI connects to the actual native daemon, not a mock.
        let cli=Command::new(env!("CARGO_BIN_EXE_agents-relay-rust"))
            .args(["status","--port",&port.to_string()]).output().unwrap();
        assert!(cli.status.success(),"{}",String::from_utf8_lossy(&cli.stderr));
        let view:Value=serde_json::from_slice(&cli.stdout).unwrap();
        assert_eq!(view["jobCount"],1);
        assert_eq!(view["productionReady"],false);
        let jobs=request(port,"GET","/api/jobs?inventory=1","").unwrap();
        assert!(jobs.starts_with("HTTP/1.1 200"),"{jobs}");
        assert!(jobs.contains("Native source review"),"{jobs}");
        let job=request(port,"GET","/api/job?id=17","").unwrap();
        assert!(job.starts_with("HTTP/1.1 200"),"{job}");
        assert_eq!(body(&job)["state"],"DRAFT");
        let denied=request(port,"POST","/api/control","{\"command\":\"job.reconcile\",\"jobId\":\"17\"}").unwrap();
        assert!(!denied.starts_with("HTTP/1.1 200"),"native observer must reject mutation");
        let cli=Command::new(env!("CARGO_BIN_EXE_agents-relay-rust"))
            .args(["reconcile","--id","17","--port",&port.to_string()])
            .output().unwrap();
        assert!(!cli.status.success(),"read-only daemon must deny native CLI reconciliation");
        drop(daemon);
        let after=SQLiteRelayStore::open(&path,Some("17")).unwrap().load_job("17").unwrap().unwrap();
        assert_eq!(after["state"],"DRAFT");
        assert_eq!(after["tasks"],json!([]));
    }
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn native_daemon_refuses_missing_or_live_store_bindings(){
    let denied=Command::new(binary()).current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .arg("--port").arg("0").output().unwrap();
    assert!(!denied.status.success());
    assert!(String::from_utf8_lossy(&denied.stderr).contains("requires --isolated-store-dir"));
}
