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
        // Never signal a PID already reaped by the test. PID reuse could
        // otherwise terminate an unrelated process on a busy test host.
        if self.0.try_wait().ok().flatten().is_some(){return;}
        unsafe{libc::kill(self.0.id() as i32,libc::SIGTERM);}
        for _ in 0..35{
            if self.0.try_wait().ok().flatten().is_some(){return;}
            thread::sleep(Duration::from_millis(100));
        }
        let _=self.0.kill();let _=self.0.wait();
    }
}
fn start_mode(root:&Path,port:u16,store_flag:&str)->Guard{
    start_mode_with_lease(root,port,store_flag,None)
}
fn start_mode_with_lease(root:&Path,port:u16,store_flag:&str,lease_ms:Option<u64>)->Guard{
    let mut command=Command::new(binary());
    command.current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .arg(store_flag).arg(root.join("stores"))
        .arg("--port").arg(port.to_string())
        .arg("--interval").arg("100");
    if let Some(lease)=lease_ms{
        command.arg("--lease-ms").arg(lease.to_string());
    }
    let child=command.stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::from(
            fs::File::create(root.join("native-daemon.log")).unwrap()))
        .spawn().unwrap();
    let mut guard=Guard(child);
    for _ in 0..300{
        // A successful TCP connect alone is not proof the daemon is ready.
        // Under simultaneous all-target Rust builds, macOS process scheduling
        // can delay the isolated daemon beyond a 2.5s fixed polling window.
        // A startup probe must observe the actual HTTP status response.
        if request(port,"GET","/api/status","")
            .is_ok_and(|response|response.starts_with("HTTP/1.1 200")){
            return guard;
        }
        if let Some(status)=guard.0.try_wait().unwrap(){panic!("native daemon exited before serving: {status}");}
        thread::sleep(Duration::from_millis(50));
    }
    panic!("native daemon never listened on isolated port")
}
fn start(root:&Path,port:u16)->Guard{start_mode(root,port,"--isolated-store-dir")}
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
        // A port may briefly recover from a listener restart (Darwin
        // EAGAIN/os error 35). Retry only this transient transport failure;
        // every other CLI error is an immediate test failure.
        let mut cli=Command::new(env!("CARGO_BIN_EXE_agents-relay-rust"))
            .args(["status","--port",&port.to_string()]).output().unwrap();
        for _ in 0..5{
            if cli.status.success(){break;}
            let error=String::from_utf8_lossy(&cli.stderr);
            if !error.contains("Resource temporarily unavailable")
                && !error.contains("os error 35"){
                break;
            }
            thread::sleep(Duration::from_millis(120));
            cli=Command::new(env!("CARGO_BIN_EXE_agents-relay-rust"))
                .args(["status","--port",&port.to_string()]).output().unwrap();
        }
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

// Darwin can momentarily return EAGAIN or EPIPE during a listener restart.
 // Retry only these transient transport failures; persistent errors fail the
 // exact native integration test (no retry for daemon-side control rejection).
fn native_cli_transient_retry(args:&[&str])->std::process::Output{
    let mut output=Command::new(env!("CARGO_BIN_EXE_agents-relay-rust"))
        .args(args).output().unwrap();
    for _ in 0..5{
        if output.status.success(){break;}
        let stderr=String::from_utf8_lossy(&output.stderr);
        if !stderr.contains("Resource temporarily unavailable")
            && !stderr.contains("os error 35")
            && !stderr.contains("Broken pipe")
            && !stderr.contains("os error 32"){
            break;
        }
        thread::sleep(Duration::from_millis(120));
        output=Command::new(env!("CARGO_BIN_EXE_agents-relay-rust"))
            .args(args).output().unwrap();
    }
    output
}
#[test]
fn native_write_mode_mutations_use_one_sqlite_cas_and_survive_process_restart(){
    let root=root();let path=root.join("relay.sqlite");
    let store=SQLiteRelayStore::open(&path,Some("17")).unwrap();
    let initial=json!({"id":"17","repository":"fixture","projectRoot":"/tmp/fixture",
        "title":"Before native writes","state":"DRAFT","prNumber":0,
        "createdAt":"2026-11-18T17:00:00.000Z","updatedAt":"2026-11-18T17:00:00.000Z",
        "tasks":[{"id":"2","jobId":"17","kind":"work","agentName":"implementation",
            "state":"DRAFT","title":"Child Task","createdAt":"2026-11-18T17:00:00.000Z",
            "updatedAt":"2026-11-18T17:00:00.000Z","comments":[]}],"plans":[]});
    store.save_job(&initial).unwrap();store.close().unwrap();
    let port=socket_port();
    for attempt in 0..2{
        let daemon=start_mode(&root,port,"--isolated-write-store-dir");
        let status=body(&request(port,"GET","/api/status","").unwrap());
        assert_eq!(status["mode"],"isolated-write");
        assert_eq!(status["productionReady"],false);
        assert_eq!(status["jobCount"],1);
        // Real native CLI users see the exact durable SQLite records served
        // by the native daemon; no legacy Node CLI or duplicated store.
        for (args,key,expected) in [
            (vec!["job","show","--id","17"],"id","17"),
            (vec!["task","show","--id","17","--task-id","2"],"id","2"),
        ]{
            let mut cli_args=args.clone();
            let port_arg=port.to_string();
            cli_args.extend_from_slice(&["--port",port_arg.as_str()]);
            let result=native_cli_transient_retry(&cli_args);
            assert!(result.status.success(),"{}",String::from_utf8_lossy(&result.stderr));
            assert_eq!(serde_json::from_slice::<Value>(&result.stdout).unwrap()[key],expected);
        }
        let list=native_cli_transient_retry(&["job","list","--port",&port.to_string()]);
        assert!(list.status.success(),"{}",String::from_utf8_lossy(&list.stderr));
        let rows:Value=serde_json::from_slice(&list.stdout).unwrap();
        assert_eq!(rows.as_array().unwrap().len(),1);
        assert_eq!(rows[0]["id"],"17");
        if attempt==0{
            let cli=native_cli_transient_retry(&["job","update","--id","17",
                "--title","After native write","--port",&port.to_string()]);
            assert!(cli.status.success(),"{}",String::from_utf8_lossy(&cli.stderr));
            assert_eq!(serde_json::from_slice::<Value>(&cli.stdout).unwrap()["title"],"After native write");
            let comment=request(port,"POST","/api/control",
                r#"{"command":"task.comment","jobId":"17","taskId":"2","message":"Rust SQLite persisted"}"#).unwrap();
            assert!(comment.starts_with("HTTP/1.1 200"),"{comment}");
            assert!(comment.contains("Rust SQLite persisted"));
            let rejected=request(port,"POST","/api/control",
                r#"{"command":"job.update","jobId":"17","patch":{"projectPath":"/tmp/forbidden"}}"#).unwrap();
            assert!(!rejected.starts_with("HTTP/1.1 200"));
            let forged=request(port,"POST","/api/control",
                r#"{"command":"task.complete","jobId":"17","taskId":"2","repository":"fixture","executionId":"forged","commitSha":"0000000000000000000000000000000000000000","summary":"fake"}"#).unwrap();
            assert!(!forged.starts_with("HTTP/1.1 200"));
            let wake=request(port,"POST","/api/control",
                r#"{"command":"job.reconcile","jobId":"17"}"#).unwrap();
            assert!(wake.starts_with("HTTP/1.1 200"),"{wake}");
            assert_eq!(body(&request(port,"GET","/api/status","").unwrap())["wakeCount"],1);
        }
        let read=request(port,"GET","/api/job?id=17","").unwrap();
        assert!(read.starts_with("HTTP/1.1 200"),"{read}");
        let saved=body(&read);
        assert_eq!(saved["title"],"After native write");
        assert_eq!(saved["state"],"DRAFT");
        assert!(saved["tasks"][0]["comments"].as_array().unwrap().iter()
            .any(|c|c.to_string().contains("Rust SQLite persisted")));
        drop(daemon);
        // Reopening a fresh scoped connection observes exactly the same durable
        // state; no event receipt was treated as a Task success.
        let persisted=SQLiteRelayStore::open_without_claim_reset(&path,Some("17"))
            .unwrap().load_job("17").unwrap().unwrap();
        assert_eq!(persisted["title"],"After native write");
        assert_eq!(persisted["tasks"][0]["state"],"DRAFT");
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn native_write_daemon_reconciles_real_active_sqlite_job_but_never_fakes_worker_completion(){
    let root=root();
    let project=root.join("project");fs::create_dir_all(&project).unwrap();
    let init=Command::new("git").arg("-C").arg(&project).args(["init","-q","-b","main"]).output().unwrap();
    assert!(init.status.success(),"{}",String::from_utf8_lossy(&init.stderr));
    let path=root.join("relay.sqlite");
    let store=SQLiteRelayStore::open(&path,Some("27")).unwrap();
    let job=json!({"id":"27","repository":"project","projectRoot":project,
        "title":"Real Graph reconciliation without worker","state":"ACTIVE","prNumber":0,
        "reviewEnabled":false,"priority":"P2",
        "createdAt":"2026-11-18T00:00:00.000Z","updatedAt":"2026-11-18T00:00:00.000Z",
        "tasks":[{"id":"2","jobId":"27","kind":"work","adapter":"script",
            "agentName":"implementation","title":"Single fixture task","state":"QUEUED",
            "attempt":0,"maxAttempts":3,"priority":"P2", "dependencies":[],
            "output":{"kind":"file","path":root.join("out/result.json")},
            "input":"{}","createdAt":"2026-11-18T00:00:00.000Z",
            "updatedAt":"2026-11-18T00:00:00.000Z"}],"plans":[]});
    store.save_job(&job).unwrap();store.close().unwrap();
    let port=socket_port();let daemon=start_mode(&root,port,"--isolated-write-store-dir");
    let mut attempts=0;
    for _ in 0..35{
        let status=body(&request(port,"GET","/api/status","").unwrap());
        attempts=status["reconcileAttempts"].as_u64().unwrap_or(0);
        if attempts>0{break}
        thread::sleep(Duration::from_millis(100));
    }
    assert!(attempts>0,"Actual Reconciler was never called from the daemon Pool");
    let observed=body(&request(port,"GET","/api/job?id=27","").unwrap());
    assert_eq!(observed["id"],"27");
    assert_ne!(observed["tasks"][0]["state"],"SUCCEEDED",
        "missing Worker effect cannot complete a Task");
    drop(daemon);
    let durable=SQLiteRelayStore::open_without_claim_reset(&path,Some("27"))
        .unwrap().load_job("27").unwrap().unwrap();
    assert_eq!(durable["tasks"][0]["state"],"FAILED",
        "Canonical effect.launchTask.failed must settle the actual Task when the trusted Shortcut is absent");
    assert_eq!(durable["tasks"][0]["error"],
        "Source Worker has no declared trusted Shortcut");
    assert!(durable["tasks"][0].get("executionId").is_none_or(Value::is_null),
        "Rejected launch must not claim a nonexistent Worker execution");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn real_native_daemon_claims_and_completes_shortcut_through_owned_process_graph_and_sqlite(){
    let node=std::env::var("AGENTS_RELAY_SCRIPT_NODE")
        .expect("Set AGENTS_RELAY_SCRIPT_NODE for real native Script E2E");
    assert!(Path::new(&node).is_absolute(),"Script runtime must be an absolute executable");
    let root=root();let project=root.join("project");
    fs::create_dir_all(project.join("agents/.shortcut")).unwrap();
    fs::write(project.join("agents/fixture.agent.md"),
        "---\nname: fixture\ncapabilities: [script]\n---\n# Real Worker\n").unwrap();
    fs::write(project.join("agents/.shortcut/fixture.agent.mjs"),
        "export async function run({input}) { return {status:'COMPLETED',output:{realWorker:true,execution:input.executionId},artifacts:{}} }\n").unwrap();
    let git=Command::new("git").arg("-C").arg(&project).args(["init","-q","-b","main"])
        .output().unwrap();assert!(git.status.success());
    let output=root.join("worker-result.json");
    let store_path=root.join("relay.sqlite");
    let store=SQLiteRelayStore::open(&store_path,Some("37")).unwrap();
    store.save_job(&json!({
        "id":"37","repository":"project","projectRoot":project,
        "title":"Native Rust Script Job","state":"ACTIVE","prNumber":0,
        "reviewEnabled":false,"priority":"P2",
        "createdAt":"2026-11-18T00:00:00.000Z","updatedAt":"2026-11-18T00:00:00.000Z",
        "tasks":[{"id":"2","jobId":"37","kind":"work","adapter":"script",
            "agentName":"fixture","title":"Real Script Worker","state":"QUEUED",
            "attempt":0,"maxAttempts":2,"priority":"P2","dependencies":[],
            "input":"{}", "output":{"kind":"file","path":output},
            "createdAt":"2026-11-18T00:00:00.000Z","updatedAt":"2026-11-18T00:00:00.000Z"}],
        "plans":[],
    })).unwrap();store.close().unwrap();
    let port=socket_port();
    let daemon=start_mode(&root,port,"--isolated-write-store-dir");
    let mut current=Value::Null;
    for _ in 0..90{
        let result=request(port,"GET","/api/job?id=37","").unwrap();
        current=body(&result);
        if matches!(current["tasks"][0]["state"].as_str(),Some("SUCCEEDED"|"FAILED")){
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    assert_eq!(current["tasks"][0]["state"],"SUCCEEDED",
        "Native Worker did not reach verified Graph completion: {current};\nstatus={:?};\nlogs={}",
        body(&request(port,"GET","/api/status","").unwrap()),
        fs::read_to_string(root.join("native-daemon.log")).unwrap_or_default());
    assert_eq!(current["tasks"][0]["result"]["data"]["output"]["realWorker"],true);
    assert!(current["tasks"][0]["executionId"].is_null());
    assert_eq!(current["tasks"][0]["attempt"],1,
        "one legitimate Script effect must reserve exactly one leased execution");
    let file:Value=serde_json::from_str(&fs::read_to_string(&output).unwrap()).unwrap();
    assert_eq!(file["output"]["realWorker"],true);
    let after=SQLiteRelayStore::open_without_claim_reset(&store_path,Some("37")).unwrap();
    let pending_count:i64=after.db.query_row(
        "SELECT COUNT(*) FROM workflow_event_outbox WHERE event_key LIKE 'script-event/37/2/%'",
        [],|row|row.get(0)).unwrap();
    assert_eq!(pending_count,2,"Task started and completed must be durable events");
    let owned=current["tasks"][0]["executionHistory"].as_array().unwrap()[0]["id"]
        .as_str().unwrap().to_owned();
    let identity=after.load_execution_process("37","2",&owned)
        .unwrap().expect("Real daemon Script Worker POSIX identity must be durable");
    assert_eq!(identity["pid"],identity["pgid"]);
    assert!(identity["endedAt"].is_string());
    drop(daemon);
    let restart=start_mode(&root,port,"--isolated-write-store-dir");
    thread::sleep(Duration::from_millis(200));
    let persisted=body(&request(port,"GET","/api/job?id=37","").unwrap());
    assert_eq!(persisted["tasks"][0]["state"],"SUCCEEDED");
    assert_eq!(persisted["tasks"][0]["attempt"],1,
        "Reboot must never relaunch a completed Script Task");
    drop(restart);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn native_daemon_runs_two_dependent_script_workers_once_in_graph_order(){
    let root=root();let project=root.join("project");
    fs::create_dir_all(project.join("agents/.shortcut")).unwrap();
    for name in ["first","second"]{
        fs::write(project.join(format!("agents/{name}.agent.md")),
            format!("---\nname: {name}\ncapabilities: [script]\n---\n# {name}\n")).unwrap();
        fs::write(project.join(format!("agents/.shortcut/{name}.agent.mjs")),
            format!("export async function run({{input}}) {{ return {{status:'COMPLETED',output:{{agent:'{name}',execution:input.executionId}},artifacts:{{}}}} }}\n")).unwrap();
    }
    let initialized=Command::new("git").arg("-C").arg(&project)
        .args(["init","-q","-b","main"]).output().unwrap();
    assert!(initialized.status.success());
    let path=root.join("relay.sqlite");
    let store=SQLiteRelayStore::open(&path,Some("42")).unwrap();
    let task=|id:&str,agent:&str,state:&str,deps:Vec<&str>|{
        json!({"id":id,"jobId":"42","kind":"work","adapter":"script",
            "agentName":agent,"title":agent,"state":state,
            "attempt":0,"maxAttempts":1,"priority":"P2","dependencies":deps,
            "executionId":null,"leaseOwner":null,"leaseExpiresAt":null,
            "input":"{}","output":{"kind":"file","path":root.join(format!("{agent}.json"))},
            "createdAt":"2026-11-18T00:00:00.000Z","updatedAt":"2026-11-18T00:00:00.000Z"})
    };
    store.save_job(&json!({"id":"42","repository":"project","projectRoot":project,
        "title":"Script dependency Graph", "state":"ACTIVE","prNumber":0,
        "reviewEnabled":false,"priority":"P2",
        "createdAt":"2026-11-18T00:00:00.000Z","updatedAt":"2026-11-18T00:00:00.000Z",
        "tasks":[task("2","first","QUEUED",vec![]),
            task("3","second","DRAFT",vec!["2"])],"plans":[]})).unwrap();
    let snapshot=store.load_job("42").unwrap().unwrap();
    let mut diagnostic=agents_relay_rust2::reconciler::Reconciler::new(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow"),
        root.join("stores"),root.join("profiles"),root.join("routing.json"),
        root.join("rules.md"),json!({"maxConcurrent":4,"owner":"diagnostic"}));
    let result=diagnostic.reconcile_snapshot(&snapshot,None,&project,
        &json!({"workspaceRoot":root}),&[],&[],None);
    let preflight=result.expect("canonical Graph must accept a valid two-Task dependency fixture");
    assert!(preflight.effects.iter().any(|effect|effect["action"]=="effect.launchTask"),
        "First Task should be ready while its dependent remains DRAFT");
    store.close().unwrap();
    let port=socket_port();let daemon=start_mode(&root,port,"--isolated-write-store-dir");
    let mut job=Value::Null;
    for _ in 0..125{
        job=body(&request(port,"GET","/api/job?id=42","").unwrap());
        if job["tasks"][0]["state"]=="SUCCEEDED"
            &&job["tasks"][1]["state"]=="SUCCEEDED"{break;}
        thread::sleep(Duration::from_millis(100));
    }
    assert_eq!(job["tasks"][0]["state"],"SUCCEEDED","{job}");
    assert_eq!(job["tasks"][1]["state"],"SUCCEEDED","{job}");
    for (idx,agent) in ["first","second"].iter().enumerate(){
        assert_eq!(job["tasks"][idx]["attempt"],1,"{job}");
        let output:Value=serde_json::from_str(&fs::read_to_string(root.join(format!("{agent}.json"))).unwrap()).unwrap();
        assert_eq!(output["output"]["agent"],*agent);
    }
    let observed=SQLiteRelayStore::open_without_claim_reset(&path,Some("42")).unwrap();
    let outbox:i64=observed.db.query_row(
        "SELECT COUNT(*) FROM workflow_event_outbox WHERE event_key LIKE 'script-event/42/%'",
        [],|row|row.get(0)).unwrap();
    assert_eq!(outbox,4,"Two Workers require started and completed events each");
    drop(daemon);
    fs::remove_dir_all(root).unwrap();
}

#[test]
#[cfg(unix)]
fn isolated_write_flag_rejects_live_sqlite_symlink_hardlink_and_sidecars(){
    let root=root();
    let live=root.join("live");let isolated=root.join("isolated");
    fs::create_dir_all(live.join("stores")).unwrap();
    fs::create_dir_all(isolated.join("stores")).unwrap();
    let database=live.join("relay.sqlite");
    fs::write(&database,b"pretend live SQLite - must not open").unwrap();
    let candidate=isolated.join("relay.sqlite");
    let run=||{
        Command::new(binary())
            .env("AGENTS_RELAY_STORE_DIR",live.join("stores"))
            .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
            .arg("--isolated-write-store-dir")
            .arg(isolated.join("stores"))
            .arg("--port").arg("0")
            .output().unwrap()
    };
    std::os::unix::fs::symlink(&database,&candidate).unwrap();
    let result=run();
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("linked SQLite"));
    fs::remove_file(&candidate).unwrap();
    fs::hard_link(&database,&candidate).unwrap();
    let result=run();
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("live SQLite"));
    fs::remove_file(&candidate).unwrap();
    let sidecar=isolated.join("relay.sqlite-wal");
    std::os::unix::fs::symlink(live.join("relay.sqlite-wal"),&sidecar).unwrap();
    let result=run();
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("linked SQLite"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn killed_native_daemon_never_accepts_orphaned_script_completion_after_restart(){
    let runtime=std::env::var("AGENTS_RELAY_SCRIPT_NODE")
        .expect("Crash lifecycle test requires an absolute isolated Script runtime");
    assert!(Path::new(&runtime).is_absolute());
    let root=root();let project=root.join("project");
    fs::create_dir_all(project.join("agents/.shortcut")).unwrap();
    fs::write(project.join("agents/delayed.agent.md"),
        "---\nname: delayed\ncapabilities: [script]\n---\n# Delayed Script\n").unwrap();
    fs::write(project.join("agents/.shortcut/delayed.agent.mjs"),
        "import {writeFile} from 'node:fs/promises';\nexport async function run({input}){\n  await writeFile(input.marker, 'started');\n  await new Promise(resolve=>setTimeout(resolve,2400));\n  await writeFile(input.late, 'unexpected after daemon SIGKILL');\n  return {status:'COMPLETED',output:{ok:true},artifacts:{}};\n}\n").unwrap();
    let git=Command::new("git").arg("-C").arg(&project)
        .args(["init","-q","-b","main"]).output().unwrap();
    assert!(git.status.success());
    let marker=root.join("worker.started");let late=root.join("worker.late");
    let data=root.join("relay.sqlite");
    let store=SQLiteRelayStore::open(&data,Some("77")).unwrap();
    store.save_job(&json!({"id":"77","repository":"project","projectRoot":project,
        "title":"Crash recovery Source Task","state":"ACTIVE","prNumber":0,
        "priority":"P2","reviewEnabled":false,
        "createdAt":"2026-11-18T00:00:00.000Z","updatedAt":"2026-11-18T00:00:00.000Z",
        "tasks":[{"id":"5","jobId":"77","kind":"work","adapter":"script",
            "agentName":"delayed","title":"Delayed Task","state":"QUEUED",
            "executionId":null,"leaseOwner":null,"leaseExpiresAt":null,
            "attempt":0,"maxAttempts":1,"priority":"P2","dependencies":[],
            "input":json!({"marker":marker,"late":late}).to_string(),
            "output":{"kind":"file","path":root.join("out.json")},
            "createdAt":"2026-11-18T00:00:00.000Z",
            "updatedAt":"2026-11-18T00:00:00.000Z"}],"plans":[]})).unwrap();
    store.close().unwrap();
    let port=socket_port();let mut daemon=start_mode_with_lease(&root,port,
        "--isolated-write-store-dir",Some(400));
    let mut leased=Value::Null;
    for _ in 0..70{
        let reply=request(port,"GET","/api/job?id=77","").unwrap();
        leased=body(&reply);
        if marker.exists() && leased["tasks"][0]["state"]=="RUNNING"{break;}
        thread::sleep(Duration::from_millis(35));
    }
    assert!(marker.exists(),"Script Worker never entered source module");
    assert_eq!(leased["tasks"][0]["state"],"RUNNING");
    let execution=leased["tasks"][0]["executionId"].as_str().unwrap().to_owned();
    let persisted=SQLiteRelayStore::open_without_claim_reset(&data,Some("77")).unwrap();
    let record=persisted.load_execution_process("77","5",&execution)
        .unwrap().expect("Owned Script Worker must record PID/PGID before crash");
    assert!(record["pid"].as_i64().is_some_and(|pid|pid>0));
    drop(persisted);
    // Deliberately kill ONLY the Child handle spawned by this test. The
    // owned-process supervisor is responsible for the Task's subprocess group.
    daemon.0.kill().unwrap();daemon.0.wait().unwrap();
    drop(daemon);
    thread::sleep(Duration::from_millis(2600));
    assert!(!late.exists(),"Orphaned Script kept writing after daemon SIGKILL");
    let restart=start_mode_with_lease(&root,port,"--isolated-write-store-dir",Some(400));
    let mut restored=Value::Null;
    for _ in 0..50{
        restored=body(&request(port,"GET","/api/job?id=77","").unwrap());
        if restored["tasks"][0]["state"]=="FAILED"{break;}
        thread::sleep(Duration::from_millis(100));
    }
    assert_eq!(restored["tasks"][0]["state"],"FAILED",
        "Crash recovery must fail closed for orphaned execution: {restored}");
    assert_eq!(restored["tasks"][0]["attempt"],1,
        "Crash must not relaunch a task with exhausted attempt budget");
    assert!(!root.join("out.json").exists(),"Orphaned Script result was accepted");
    drop(restart);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn native_daemon_completes_planned_script_job_through_task_and_job_graph(){
    let root=root();let project=root.join("project");
    fs::create_dir_all(project.join("agents/.shortcut")).unwrap();
    fs::write(project.join("agents/fixture.agent.md"),
        "---\nname: fixture\ncapabilities: [script]\n---\n# Fixture\n").unwrap();
    fs::write(project.join("agents/.shortcut/fixture.agent.mjs"),
        "export async function run(){return {status:'COMPLETED',output:{ok:true},artifacts:{}}}\n").unwrap();
    assert!(Command::new("git").arg("-C").arg(&project)
        .args(["init","-q","-b","main"]).status().unwrap().success());
    let store_path=root.join("relay.sqlite");
    let store=SQLiteRelayStore::open(&store_path,Some("51")).unwrap();
    store.save_job(&json!({
        "id":"51","repository":"project","projectRoot":project,
        "state":"ACTIVE","prNumber":0,"reviewEnabled":false,"priority":"P2",
        "title":"Planned native Script completion",
        "createdAt":"2026-11-18T00:00:00.000Z","updatedAt":"2026-11-18T00:00:00.000Z",
        "plans":[{"id":"1","round":1,"status":"SUCCEEDED","objectiveStatus":"satisfied"}],
        "tasks":[{"id":"2","jobId":"51","kind":"work","adapter":"script",
            "agentName":"fixture","title":"Actual Shortcut","state":"QUEUED",
            "executionId":null,"leaseOwner":null,"leaseExpiresAt":null,
            "attempt":0,"maxAttempts":1,"dependencies":[],"input":"{}",
            "output":{"kind":"file","path":root.join("result.json")},
            "createdAt":"2026-11-18T00:00:00.000Z","updatedAt":"2026-11-18T00:00:00.000Z"}]})).unwrap();
    store.close().unwrap();
    let port=socket_port();let daemon=start_mode(&root,port,"--isolated-write-store-dir");
    let mut observed=Value::Null;
    for _ in 0..100{
        observed=body(&request(port,"GET","/api/job?id=51","").unwrap());
        if observed["state"]=="COMPLETED"{break;}
        thread::sleep(Duration::from_millis(100));
    }
    assert_eq!(observed["state"],"COMPLETED","{observed}");
    assert_eq!(observed["tasks"][0]["state"],"SUCCEEDED");
    assert_eq!(observed["tasks"][0]["attempt"],1);
    assert!(root.join("result.json").exists());
    drop(daemon);
    let again=start_mode(&root,port,"--isolated-write-store-dir");
    thread::sleep(Duration::from_millis(200));
    let persisted=body(&request(port,"GET","/api/job?id=51","").unwrap());
    assert_eq!(persisted["state"],"COMPLETED");
    assert_eq!(persisted["tasks"][0]["attempt"],1);
    drop(again);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn native_daemon_merges_verified_source_branch_and_persists_job_terminal_state(){
    let root=root();let project=root.join("project");
    fs::create_dir_all(&project).unwrap();
    let git=|args:&[&str]|{
        let result=Command::new("git").arg("-C").arg(&project)
            .args(args).output().unwrap();
        assert!(result.status.success(),"{}",String::from_utf8_lossy(&result.stderr));
        String::from_utf8_lossy(&result.stdout).trim().to_string()
    };
    git(&["init","-q","-b","main"]);
    git(&["config","user.name","Rust2 isolated source"]);
    git(&["config","user.email","fixture@example.invalid"]);
    fs::write(project.join("base.txt"),"base\n").unwrap();
    git(&["add","base.txt"]);git(&["commit","-qm","baseline"]);
    git(&["checkout","-qb","relay/job-61"]);
    fs::write(project.join("feature.txt"),"feature\n").unwrap();
    git(&["add","feature.txt"]);git(&["commit","-qm","source"]);
    let source=git(&["rev-parse","HEAD"]);
    git(&["checkout","-q","main"]);
    let store_path=root.join("relay.sqlite");
    let store=SQLiteRelayStore::open(&store_path,Some("61")).unwrap();
    store.save_job(&json!({
        "id":"61","repository":"project","projectRoot":project,
        "state":"ACTIVE","prNumber":0,"reviewEnabled":false,"autoMerge":true,
        "title":"Native source delivery",
        "createdAt":"2026-11-18T00:00:00.000Z","updatedAt":"2026-11-18T00:00:00.000Z",
        "plans":[{"id":"1","round":1,"status":"SUCCEEDED","objectiveStatus":"satisfied"}],
        "tasks":[{"id":"2","jobId":"61","kind":"work","adapter":"script",
            "agentName":"fixture","title":"Already delivered source","state":"SUCCEEDED",
            "output":{"kind":"task_pr"},
            "createdAt":"2026-11-18T00:00:00.000Z","updatedAt":"2026-11-18T00:00:00.000Z"}],
        "localMerge":{"status":"pending","attempts":0,
            "sourceRef":"refs/heads/relay/job-61","targetRef":"refs/heads/main"}
    })).unwrap();
    store.close().unwrap();
    let port=socket_port();let daemon=start_mode(&root,port,"--isolated-write-store-dir");
    let mut observed=Value::Null;
    for _ in 0..100{
        observed=body(&request(port,"GET","/api/job?id=61","").unwrap());
        if observed["state"]=="COMPLETED"{break;}
        thread::sleep(Duration::from_millis(100));
    }
    assert_eq!(observed["state"],"COMPLETED","{observed}");
    assert_eq!(observed["localMerge"]["status"],"succeeded");
    assert_eq!(observed["localMerge"]["sourceSha"],source);
    let merged=git(&["rev-parse","refs/heads/main"]);
    assert_eq!(observed["localMerge"]["mergedCommitSha"],merged);
    assert!(project.join("feature.txt").exists());
    assert_eq!(git(&["rev-list","--parents","-n","1","main"])
        .split_whitespace().count(),3);
    // The next daemon reconciliation tick must inspect the durable completed
    // merge and settle optional origin delivery without a second CLI command.
    for _ in 0..50{
        observed=body(&request(port,"GET","/api/job?id=61","").unwrap());
        if observed["remoteDelivery"]["status"]=="skipped"{break;}
        thread::sleep(Duration::from_millis(100));
    }
    assert_eq!(observed["remoteDelivery"]["status"],"skipped",
        "Native daemon failed to process post-completion no-origin Graph projection: {observed}");
    drop(daemon);
    let restart=start_mode(&root,port,"--isolated-write-store-dir");
    thread::sleep(Duration::from_millis(200));
    let persisted=body(&request(port,"GET","/api/job?id=61","").unwrap());
    assert_eq!(persisted["state"],"COMPLETED");
    assert_eq!(git(&["rev-parse","main"]),merged);
    drop(restart);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn isolated_native_daemon_submits_chatgpt_through_webhelm_and_waits_for_real_graph_terminal(){
    use agents_relay_rust2::{
        native_worker_event_ingress::apply_verified_worker_event,
        execution_event_identity::execution_event_source,
        events::event_for,
        browser_worker_pool::{BrowserPoolOptions,BrowserWorkerPoolManager},
    };
    use std::{io::{BufRead,BufReader},os::unix::{net::UnixListener,fs::PermissionsExt},
        sync::{Arc,atomic::{AtomicBool,Ordering}}};
    // A short AF_UNIX path, a disposable fake WebHelm daemon, and a fake
    // CLI profile; absolutely no user browser Session/ChatGPT/Codex calls.
    let root=PathBuf::from("/tmp").join(format!("r2b-{}-{}",std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
            .unwrap().as_nanos()));
    let project=root.join("project");
    fs::create_dir_all(root.join("stores")).unwrap();
    fs::create_dir_all(&project).unwrap();
    let cli=root.join("fake-webhelm");
    fs::write(&cli,"#!/bin/sh\nif [ \"$1\" = \"platform\" ]; then printf '{\"platform\":\"chatgpt\"}\\n'; else printf '{\"ok\":true}\\n'; fi\n").unwrap();
    fs::set_permissions(&cli,fs::Permissions::from_mode(0o700)).unwrap();
    let socket=root.join("webhelm.sock");
    let listener=UnixListener::bind(&socket).unwrap();
    listener.set_nonblocking(true).unwrap();
    let submitted=Arc::new(AtomicBool::new(false));
    let got_submission=Arc::clone(&submitted);
    let socket_worker=thread::spawn(move||{
        // Isolated daemon startup may be delayed by macOS full-target Rust
        // build contention. Keep the fake Unix service available through
        // actual HTTP readiness and the Worker submission; do not allow a
        // fixture timeout to masquerade as a failed production Worker.
        let deadline=std::time::Instant::now()+Duration::from_secs(90);
        let mut ops=Vec::new();
        loop{
            if std::time::Instant::now()>deadline{break;}
            let (mut stream,_)=match listener.accept(){
                Ok(value)=>value,
                Err(error) if error.kind()==std::io::ErrorKind::WouldBlock=>{
                    thread::sleep(Duration::from_millis(5));continue;
                },
                Err(error)=>panic!("fake WebHelm accept: {error}"),
            };
            stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            let mut line=String::new();
            BufReader::new(&stream).read_line(&mut line).unwrap();
            let command:Value=serde_json::from_str(&line).unwrap();
            let op=command["op"].as_str().unwrap().to_string();
            ops.push(op.clone());
            let response=match op.as_str(){
                "workspace-create"=>json!({"ok":true}),
                "start"=>json!({"ok":true,"workspace":"Relay",
                    "workspace_supported":true,"session_id":"fixture-session-23"}),
                "platform-run"=>{
                    assert_eq!(command["platform"],"chatgpt");
                    assert_eq!(command["action"],"new-thread");
                    assert_eq!(command["config"]["temporary"],false);
                    let prompt=command["config"]["message"].as_str().unwrap();
                    assert!(prompt.contains("You are implementation with responsibility at "),
                        "Selected Agent identity must be prompt-reference bound: {prompt}");
                    let ref_path=prompt.split("You are implementation with responsibility at ")
                        .nth(1).unwrap().split_whitespace().next().unwrap()
                        .trim_end_matches('.');
                    let agent_contract=fs::read_to_string(ref_path)
                        .expect("Immutable managed Agent reference must be readable");
                    assert!(agent_contract.contains("Implementation Agent"),
                        "Selected Agent contract is not the real Markdown");
                    assert!(prompt.contains("task-job-contract.md")
                        &&prompt.contains("event-contract.md"),
                        "Managed Worker must receive Task/Job and Event contracts");
                    assert!(prompt.contains("Job: 83")&&prompt.contains("Task: 2"));
                    assert!(!prompt.contains("Execute real task and send genuine events"),
                        "Original Task text must be retrieved through authorized Relay CLI, not copied into transport prompt");
                    got_submission.store(true,Ordering::Release);
                    json!({"ok":true,"status":"submitted","verified_by":"test-fixture",
                        "temporary":false,"thread_id":"fixturethread4321",
                        "thread_url":"https://chatgpt.com/c/fixturethread4321"})
                },
                "stop"=>{
                    assert_eq!(command["session_id"],"fixture-session-23");
                    json!({"ok":true,"returned_to_idle":true})
                },
                other=>panic!("unexpected isolated WebHelm operation {other}"),
            };
            stream.write_all(format!("{response}\n").as_bytes()).unwrap();
            if op=="stop"{break;}
        }
        ops
    });
    let initialized=Command::new("git").arg("-C").arg(&project)
        .args(["init","-q","-b","main"]).status().unwrap();
    assert!(initialized.success());
    let path=root.join("relay.sqlite");
    let store=SQLiteRelayStore::open(&path,Some("83")).unwrap();
    store.save_job(&json!({"id":"83","repository":"project","projectRoot":project,
        "title":"Real native WebHelm IPC with fake browser", "state":"ACTIVE",
        "prNumber":0,"priority":"P2","reviewEnabled":false,
        "createdAt":"2026-11-18T00:00:00.000Z","updatedAt":"2026-11-18T00:00:00.000Z",
        "tasks":[{"id":"2","jobId":"83","kind":"work","adapter":"chatgpt",
            "agentName":"implementation","title":"Model Task","state":"QUEUED",
            "executionId":null,"leaseOwner":null,"leaseExpiresAt":null,
            "attempt":0,"maxAttempts":1,"priority":"P2","dependencies":[],
            "routing":{"adapter":"chatgpt","projectId":"isolated"},
            "input":"[Relay agent: worker; adapter: chatgpt]\nExecute real task and send genuine events",
            "chatgptTabClosePolicy":"after-terminal","timeoutMs":8000,
            "output":{"kind":"file","path":root.join("out.json")},
            "createdAt":"2026-11-18T00:00:00.000Z",
            "updatedAt":"2026-11-18T00:00:00.000Z"}],"plans":[]})).unwrap();
    store.close().unwrap();
    let port=socket_port();
    let child=Command::new(binary())
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .args(["--isolated-write-store-dir",root.join("stores").to_str().unwrap(),
            "--port",&port.to_string(),"--interval","100"])
        .env("AGENTS_RELAY_WEBHELM_SOCKET",&socket)
        .env("AGENTS_RELAY_WEBHELM_EXECUTABLE",&cli)
        .env("AGENTS_RELAY_WEBHELM_WORKSPACE","Relay")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::from(
            fs::File::create(root.join("native-daemon.log")).unwrap()))
        .spawn().unwrap();
    let mut daemon=Guard(child);
    let mut ready=false;
    for _ in 0..300{
        if request(port,"GET","/api/status","")
            .is_ok_and(|reply|reply.starts_with("HTTP/1.1 200")){
            ready=true;break;
        }
        if let Some(status)=daemon.0.try_wait().unwrap(){
            panic!("Isolated WebHelm daemon exited before startup {status}: {}",
                fs::read_to_string(root.join("native-daemon.log")).unwrap_or_default());
        }
        thread::sleep(Duration::from_millis(50));
    }
    assert!(ready,"Native WebHelm daemon never became HTTP-ready: {}",
        fs::read_to_string(root.join("native-daemon.log")).unwrap_or_default());
    let mut current=Value::Null;
    let mut seen=false;
    for _ in 0..150{
        if let Ok(result)=request(port,"GET","/api/job?id=83",""){
            current=body(&result);
            if submitted.load(Ordering::Acquire)
                &&current["tasks"][0]["executionId"].is_string(){seen=true;break;}
        }
        thread::sleep(Duration::from_millis(40));
    }
    let daemon_status=request(port,"GET","/api/status","")
        .ok().and_then(|reply|std::panic::catch_unwind(||body(&reply)).ok());
    assert!(seen,"Native daemon never submitted through its own isolated WebHelm port. Job={current}, Status={daemon_status:?}, Log={}",
        fs::read_to_string(root.join("native-daemon.log")).unwrap_or_default());
    assert_eq!(current["tasks"][0]["state"],"QUEUED",
        "WebHelm submitted receipt must not change the Task state");
    let execution=current["tasks"][0]["executionId"].as_str().unwrap().to_owned();
    let source=json!({"id":execution_event_source("83","2",&execution),
        "agent":"implementation","component":"agents-relay"});
    let event=|kind,status,message:&str|{
        event_for("83","2",None,kind,status,message,Some("orchestrator"),
            Some(json!({"fixture":true})),Some(source.clone()))
    };
    let graph=Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow");
    apply_verified_worker_event(&path,&graph,"83","2",&execution,
        &event("task.started","started","actual start from test-authenticated provider")).unwrap();
    apply_verified_worker_event(&path,&graph,"83","2",&execution,
        &event("task.completed","completed","actual test provider terminal")).unwrap();
    let mut complete=false;
    for _ in 0..75{
        current=body(&request(port,"GET","/api/job?id=83","").unwrap());
        let pool=BrowserWorkerPoolManager::open(BrowserPoolOptions{
            path:Some(root.join("stores/browser-worker-pool.sqlite")),..Default::default()});
        if let Ok(pool)=pool{
            let snapshot=pool.snapshot("chatgpt").unwrap();
            if current["tasks"][0]["state"]=="SUCCEEDED"
                &&snapshot.leased==0&&snapshot.quarantined==0{
                complete=true;break;
            }
        }
        thread::sleep(Duration::from_millis(80));
    }
    assert!(complete,"Native WebHelm Worker submission wasn't released after real terminal: {current}; Log={}",
        fs::read_to_string(root.join("native-daemon.log")).unwrap_or_default());
    assert_eq!(current["tasks"][0]["attempt"],1);
    assert_eq!(current["tasks"][0]["result"]["summary"],"actual test provider terminal");
    let ops=socket_worker.join().unwrap();
    assert_eq!(ops,vec!["workspace-create","start","platform-run","stop"]);
    drop(daemon);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn native_daemon_job_plan_uses_real_isolated_planner_shortcut_and_graph_apply(){
    let root=root();let project=root.join("project");
    fs::create_dir_all(project.join("agents/.shortcut")).unwrap();
    fs::write(project.join("agents/.shortcut/planner.agent.mjs"),
        "export async function run({input}){\n if(input.objective!=='Complete already verified work')throw Error('Wrong Job objective');\n return {objective_status:'satisfied',assessment:'Existing Task verified',next_tasks:[],unblocks:[]};\n}\n").unwrap();
    let git=Command::new("git").arg("-C").arg(&project)
        .args(["init","-q","-b","main"]).output().unwrap();
    assert!(git.status.success());
    let db=root.join("relay.sqlite");
    let store=SQLiteRelayStore::open(&db,Some("91")).unwrap();
    store.save_job(&json!({"id":"91","repository":"project","projectRoot":project,
        "title":"Manual Planner Shortcut","objective":"Complete already verified work",
        "state":"ACTIVE","prNumber":0,"priority":"P2","reviewEnabled":false,
        "createdAt":"2026-11-18T00:00:00.000Z","updatedAt":"2026-11-18T00:00:00.000Z",
        "tasks":[{"id":"2","jobId":"91","kind":"work","adapter":"script",
            "agentName":"implementation","title":"Already verified Task","state":"SUCCEEDED",
            "attempt":1,"maxAttempts":1,"result":{"summary":"Verified"},
            "output":{"kind":"file","path":root.join("old-result.json")},
            "createdAt":"2026-11-18T00:00:00.000Z",
            "updatedAt":"2026-11-18T00:00:00.000Z"}],"plans":[]})).unwrap();
    store.close().unwrap();
    let port=socket_port();let daemon=start_mode(&root,port,"--isolated-write-store-dir");
    let plan_request=json!({"command":"job.plan","jobId":"91","repository":"project",
        "guidance":"Verify the existing result"});
    let response=request_to_json(port,"/api/control",&plan_request);
    assert!(response["round"]==1 || response["status"]=="PLANNING", "{response}");
    let mut completed=Value::Null;
    for _ in 0..100{
        completed=body(&request(port,"GET","/api/job?id=91","").unwrap());
        if completed["plans"][0]["status"]=="SUCCEEDED"
            &&completed["state"]=="COMPLETED"{break;}
        thread::sleep(Duration::from_millis(70));
    }
    assert_eq!(completed["plans"][0]["status"],"SUCCEEDED",
        "Native Planner did not commit canonical Plan Graph: {completed}; logs: {}",
        fs::read_to_string(root.join("native-daemon.log")).unwrap_or_default());
    assert_eq!(completed["state"],"COMPLETED");
    assert_eq!(completed["plans"][0]["objectiveStatus"],"satisfied");
    assert!(completed["plans"][0]["appliedExecutionId"].is_string());
    assert_eq!(completed["tasks"].as_array().unwrap().len(),1);
    assert_eq!(completed["tasks"][0]["state"],"SUCCEEDED");
    let saved=SQLiteRelayStore::open_without_claim_reset(&db,Some("91")).unwrap();
    let count:i64=saved.db.query_row(
        "SELECT COUNT(*) FROM workflow_event_outbox WHERE event_key LIKE 'isolated-planner/91/%'",
        [],|row|row.get(0)).unwrap();
    assert_eq!(count,2,"Planner started and completion are durable, not only process exit");
    drop(daemon);
    let restart=start_mode(&root,port,"--isolated-write-store-dir");
    thread::sleep(Duration::from_millis(150));
    let actual=body(&request(port,"GET","/api/job?id=91","").unwrap());
    assert_eq!(actual["plans"][0]["status"],"SUCCEEDED");
    assert_eq!(actual["state"],"COMPLETED");
    assert_eq!(actual["plans"].as_array().unwrap().len(),1);
    drop(restart);
    fs::remove_dir_all(root).unwrap();
}
fn request_to_json(port:u16,path:&str,payload:&Value)->Value{
    let body=payload.to_string();
    let response=request(port,"POST",path,&body).unwrap();
    assert!(response.starts_with("HTTP/1.1 200"),"Native daemon rejected request: {response}");
    self::body(&response)
}

// Original Node src/cli-coordinator.ts: a real native CLI POST must reach
// native daemon Graph/SQLite and preserve its immutable binding across restart.
#[test]
fn native_coordinator_cli_run_uses_real_daemon_and_survives_restart(){
    let root=root();
    let project=root.join("fixture");
    fs::create_dir_all(&project).unwrap();
    let initialized=Command::new("git").args(["init","-q","-b","main"])
        .current_dir(&project).output().unwrap();
    assert!(initialized.status.success());
    let path=root.join("relay.sqlite");
    let store=SQLiteRelayStore::open(&path,Some("17")).unwrap();
    store.save_job(&json!({
        "id":"17","repository":"fixture","projectRoot":project,"state":"DRAFT",
        "title":"Native coordinator integration","prNumber":0,
        "createdAt":"2026-11-18T00:00:00.000Z",
        "updatedAt":"2026-11-18T00:00:00.000Z",
        "tasks":[{
            "id":"2","jobId":"17","kind":"work","title":"Coordinator",
            "agentName":"coordinator","state":"DRAFT","attempt":0,"maxAttempts":1,
            "dependencies":[],"agentGraph":"flowchart TD\nA[agent:developer]",
            "updatedAt":"2026-11-18T00:00:00.000Z"
        }],"plans":[]
    })).unwrap();
    store.close().unwrap();
    let port=socket_port();
    let daemon=start_mode(&root,port,"--isolated-write-store-dir");
    let port_arg=port.to_string();
    let workspace=root.to_string_lossy().to_string();
    let opts=["job","run","--id","17","--task-id","2",
        "--workspace-root",&workspace,"--port",&port_arg];
    let result=native_cli_transient_retry(&opts);
    assert!(result.status.success(),"{}",String::from_utf8_lossy(&result.stderr));
    let receipt:Value=serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(receipt["scheduled"],true);
    assert_eq!(receipt["graphRuntime"],"tasks");
    let after=SQLiteRelayStore::open_without_claim_reset(&path,Some("17"))
        .unwrap().load_job("17").unwrap().unwrap();
    assert_eq!(after["graphStartContext"]["projectRoot"],
        json!(fs::canonicalize(&project).unwrap()));
    assert_eq!(after["graphStartContext"]["workspaceRoot"],
        json!(fs::canonicalize(&root).unwrap()));
    assert_ne!(after["state"],"DRAFT");
    for rejected in [
        vec!["job","run","--id","17","--task-id","absent","--port",&port_arg],
        vec!["job","run","--id","17","--task-id","2",
            "--shortcut-local","--port",&port_arg],
        vec!["job","run","--id","17","--task-id","2",
            "--foreground","--port",&port_arg],
    ]{
        let negative=native_cli_transient_retry(&rejected);
        assert!(!negative.status.success(),"invalid Coordinator request accepted");
    }
    drop(daemon);
    let restarted=start_mode(&root,port,"--isolated-write-store-dir");
    let persisted=SQLiteRelayStore::open_without_claim_reset(&path,Some("17"))
        .unwrap().load_job("17").unwrap().unwrap();
    assert_eq!(persisted["graphStartContext"],after["graphStartContext"]);
    drop(restarted);
    fs::remove_dir_all(root).unwrap();
}

// Production ingress, not parity harness: installed native CLI pause/resume
// -> localhost daemon -> Job Graph/SQLite -> process restart persistence.
#[test]
fn native_cli_pause_resume_round_trip_is_durable_after_daemon_restart(){
    let root=root();
    let path=root.join("relay.sqlite");
    let store=SQLiteRelayStore::open(&path,Some("17")).unwrap();
    store.save_job(&json!({
        "id":"17","repository":"fixture","projectRoot":"/tmp/fixture",
        "title":"Pause fixture","prNumber":0,"state":"ACTIVE",
        "createdAt":"2026-11-18T00:00:00.000Z",
        "updatedAt":"2026-11-18T00:00:00.000Z",
        "tasks":[{"id":"2","jobId":"17","kind":"work","agentName":"developer",
            "state":"RUNNING","attempt":1,"maxAttempts":1,
            "executionId":"run-1","leaseOwner":"test",
            "leaseExpiresAt":"2100-01-01T00:00:00.000Z"}],
        "plans":[{"id":"3","status":"PLANNING","executionId":"plan-1"}]
    })).unwrap();
    store.close().unwrap();
    let port=socket_port();
    let port_arg=port.to_string();
    let daemon=start_mode(&root,port,"--isolated-write-store-dir");
    let paused=native_cli_transient_retry(&[
        "job","pause","--id","17","--port",&port_arg]);
    assert!(paused.status.success(),"{}",String::from_utf8_lossy(&paused.stderr));
    let response:Value=serde_json::from_slice(&paused.stdout).unwrap();
    assert_eq!(response["tasks"][0]["state"],"QUEUED");
    assert_eq!(response["tasks"][0]["pausedExecution"]["id"],"run-1");
    assert_eq!(response["plans"][0]["pausedExecutionId"],"plan-1");
    drop(daemon);
    let after_restart=start_mode(&root,port,"--isolated-write-store-dir");
    let loaded=body(&request(port,"GET","/api/job?id=17","").unwrap());
    assert_eq!(loaded["pause"],response["pause"]);
    assert_eq!(loaded["tasks"][0]["pausedExecution"],
        response["tasks"][0]["pausedExecution"]);
    let resumed=native_cli_transient_retry(&[
        "job","resume","--id","17","--port",&port_arg]);
    assert!(resumed.status.success(),"{}",String::from_utf8_lossy(&resumed.stderr));
    let resumed:Value=serde_json::from_slice(&resumed.stdout).unwrap();
    assert!(resumed.get("pause").is_none());
    assert_eq!(resumed["tasks"][0]["maxAttempts"],2);
    assert!(resumed["tasks"][0].get("pausedExecution").is_none());
    drop(after_restart);
    let saved=SQLiteRelayStore::open_without_claim_reset(&path,Some("17"))
        .unwrap().load_job("17").unwrap().unwrap();
    assert_eq!(saved,resumed);
    fs::remove_dir_all(root).unwrap();
}

// Public original force-restate adapter must enter the same authoritative
// manual Planner Graph/SQLite and owned Script planner as normal job.plan.
// This is the real installed native daemon, no Node Relay, no model provider.
#[test]
fn real_daemon_force_restate_creates_verified_work_and_survives_restart(){
    use std::os::unix::{net::UnixListener,fs::PermissionsExt};
    // AF_UNIX paths must be short on macOS, and the fixture must be beneath
    // the exact isolated store parent rather than the user's WebHelm socket.
    let root=PathBuf::from("/tmp").join(format!("r2force-{}",
        std::process::id()));
    let _=fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("stores")).unwrap();
    let project=root.join("project");
    fs::create_dir_all(project.join("agents/.shortcut")).unwrap();
    let script=r#"export async function run({input}){
      if(input.objective!=='Validate force-restate graph')throw Error('Wrong objective');
      const context=input.executionContext;
      if(context?.role!=='planner' ||
         !context?.agents?.some(a=>a.name==='registered-fixture') ||
         !context?.runtimes?.some(r=>r.name==='chatgpt/browser-worker'))
        throw Error('Planner did not get the real resolved Agent/Runtime context');
      return {objective_status:'in_progress',assessment:'Needs a new verified browser task',
        next_tasks:[{id:'draft-auditor',title:'Verify force restate',
          agentName:'auditor',adapter:'chatgpt',priority:'P2',storySize:'S',
          routing:{provider:'chatgpt',model:'isolated-fixture',decidedBy:'planner',
            decidedAt:'2026-11-18T00:00:00.000Z'},input:'Verify this new task',
          output:{kind:'file',path:input.job.projectRoot+'/proof.json'},
          dependencies:['2']}],unblocks:[]};
    }"#;
    fs::write(project.join("agents/.shortcut/planner.agent.mjs"),script).unwrap();
    let socket=root.join("webhelm.sock");
    let _listener=UnixListener::bind(&socket).unwrap();
    let webhelm=root.join("fake-webhelm");
    fs::write(&webhelm,"#!/bin/sh\nif [ \"$1\" = \"platform\" ]; then echo '{\"platform\":\"chatgpt\"}'; else echo '{\"ok\":true}'; fi\n").unwrap();
    fs::set_permissions(&webhelm,fs::Permissions::from_mode(0o700)).unwrap();
    assert!(Command::new("git").arg("-C").arg(&project)
        .args(["init","-q","-b","main"]).status().unwrap().success());
    let path=root.join("relay.sqlite");
    let store=SQLiteRelayStore::open(&path,Some("117")).unwrap();
    store.save_job(&json!({
        "id":"117","repository":"project","projectRoot":project,"state":"DRAFT",
        "title":"Force restate isolated","objective":"Validate force-restate graph",
        "prNumber":0,"reviewEnabled":false,"priority":"P2",
        "createdAt":"2026-11-18T00:00:00.000Z","updatedAt":"2026-11-18T00:00:00.000Z",
        "tasks":[{"id":"2","jobId":"117","kind":"work","adapter":"script",
            "agentName":"implementation","title":"Verified existing work","state":"SUCCEEDED",
            "attempt":1,"maxAttempts":1,"result":{"summary":"Done"},
            "output":{"kind":"file","path":root.join("old.json")},
            "createdAt":"2026-11-18T00:00:00.000Z",
            "updatedAt":"2026-11-18T00:00:00.000Z"}],"plans":[]
    })).unwrap();
    store.save_agents(&[json!({"id":"registered-fixture", "name":"registered-fixture",
        "capabilities":["test"],"responsibility":"Isolated registered Agent",
        "runtime":{"adapter":"chatgpt"},"routing":{"trustDomains":[]},
        "boundaries":[]})]).unwrap();
    store.close().unwrap();
    let port=socket_port();
    let previous_socket=std::env::var_os("AGENTS_RELAY_WEBHELM_SOCKET");
    let previous_exe=std::env::var_os("AGENTS_RELAY_WEBHELM_EXECUTABLE");
    unsafe{
        std::env::set_var("AGENTS_RELAY_WEBHELM_SOCKET",&socket);
        std::env::set_var("AGENTS_RELAY_WEBHELM_EXECUTABLE",&webhelm);
    }
    let daemon=start_mode(&root,port,"--isolated-write-store-dir");
    unsafe{
        if let Some(v)=previous_socket{std::env::set_var("AGENTS_RELAY_WEBHELM_SOCKET",v);}
        else{std::env::remove_var("AGENTS_RELAY_WEBHELM_SOCKET");}
        if let Some(v)=previous_exe{std::env::set_var("AGENTS_RELAY_WEBHELM_EXECUTABLE",v);}
        else{std::env::remove_var("AGENTS_RELAY_WEBHELM_EXECUTABLE");}
    }
    let request_body=json!({"command":"job.plan","jobId":"117",
        "guidance":"Reconsider the complete objective","forceRestate":true});
    let response=request_to_json(port,"/api/control",&request_body);
    assert!(response["forceRestate"]==true || response["round"]==1,
        "Native Force Restate did not create a Plan: {response}");
    let mut snapshot=Value::Null;
    for _ in 0..100{
        snapshot=body(&request(port,"GET","/api/job?id=117","").unwrap());
        if snapshot["plans"][0]["status"]=="SUCCEEDED"{break;}
        thread::sleep(Duration::from_millis(60));
    }
    assert_eq!(snapshot["plans"][0]["status"],"SUCCEEDED","{snapshot}");
    assert_eq!(snapshot["plans"][0]["forceRestate"],true);
    assert_eq!(snapshot["plans"][0]["restateTaskIds"],json!([]));
    assert!(snapshot["plans"][0]["appliedExecutionId"].is_string());
    assert_eq!(snapshot["plans"][0]["objectiveStatus"],"in_progress");
    assert_eq!(snapshot["tasks"].as_array().unwrap().len(),2);
    assert_eq!(snapshot["tasks"][1]["agentName"],"auditor");
    assert_ne!(snapshot["state"],"COMPLETED",
        "A verified new work Task cannot instantly complete the Job");
    drop(daemon);
    let restart=start_mode(&root,port,"--isolated-write-store-dir");
    let after=body(&request(port,"GET","/api/job?id=117","").unwrap());
    assert_eq!(after["plans"][0]["forceRestate"],true);
    assert_eq!(after["plans"][0]["appliedExecutionId"],
        snapshot["plans"][0]["appliedExecutionId"]);
    assert_eq!(after["tasks"].as_array().unwrap().len(),2);
    drop(restart);
    fs::remove_dir_all(root).unwrap();
}

// Original workflow-effect-failures public reducer drives the *real* native
// daemon when a Graph-selected Worker launch fails before a process is claimed.
// This is disposable SQLite+Git; no provider, Node Relay or live data.
#[test]
fn native_daemon_failed_script_launch_is_durable_graph_failure_after_restart(){
    let root=root();
    let project=root.join("fixture");
    fs::create_dir_all(&project).unwrap();
    assert!(Command::new("git").args(["init","-q","-b","main"])
        .current_dir(&project).status().unwrap().success());
    let path=root.join("relay.sqlite");
    let store=SQLiteRelayStore::open(&path,Some("17")).unwrap();
    store.save_job(&json!({
        "id":"17","repository":"fixture","projectRoot":project,
        "title":"Failure effect E2E","state":"ACTIVE","prNumber":0,
        "reviewEnabled":false,
        "createdAt":"2026-11-18T00:00:00.000Z",
        "updatedAt":"2026-11-18T00:00:00.000Z",
        "tasks":[{
            "id":"2","jobId":"17","kind":"work",
            "agentName":"no-such-shortcut","adapter":"script",
            "routing":{"decisionId":"decision-script-no-shortcut",
                "provider":"fixture-script","model":"local-executable",
                "profile":"local"},
            "title":"Cannot start without a trusted Shortcut",
            "state":"QUEUED","attempt":0,"maxAttempts":1,
            "dependencies":[],"input":"must not execute",
            "output":{"kind":"file","path":project.join("uncreated.json")},
            "createdAt":"2026-11-18T00:00:00.000Z",
            "updatedAt":"2026-11-18T00:00:00.000Z"
        }],"plans":[]
    })).unwrap();store.close().unwrap();
    let port=socket_port();let daemon=start_mode(&root,port,"--isolated-write-store-dir");
    let mut observed=Value::Null;
    for _ in 0..90{
        observed=body(&request(port,"GET","/api/job?id=17","").unwrap());
        if observed["tasks"][0]["state"]=="FAILED"{break;}
        thread::sleep(Duration::from_millis(60));
    }
    assert_eq!(observed["tasks"][0]["state"],"FAILED","{observed}");
    assert_eq!(observed["tasks"][0]["error"],
        "Source Worker has no declared trusted Shortcut");
    assert!(observed["tasks"][0].get("executionId").is_none_or(Value::is_null));
    assert!(!project.join("uncreated.json").exists(),
        "A rejected launch cannot fabricate output or completion");
    let original_error=observed["tasks"][0]["error"].clone();
    let audit_path=root.join("decision-audit.jsonl");
    let audit=fs::read_to_string(&audit_path).unwrap();
    let rows=audit.lines().map(|line|serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(rows.len(),1,"Only one postcommit launch-failure audit may be appended");
    assert_eq!(rows[0]["decision_id"],"decision-script-no-shortcut");
    assert_eq!(rows[0]["kind"],"launch_failure");
    assert_eq!(rows[0]["evidence"]["task_id"],"2");
    drop(daemon);
    let restart=start_mode(&root,port,"--isolated-write-store-dir");
    let persisted=body(&request(port,"GET","/api/job?id=17","").unwrap());
    assert_eq!(persisted["tasks"][0]["state"],"FAILED");
    assert_eq!(persisted["tasks"][0]["error"],original_error);
    assert_eq!(fs::read_to_string(&audit_path).unwrap(),audit,
        "Restart must not duplicate settled launch failure audit");
    assert!(!project.join("uncreated.json").exists());
    drop(restart);
    fs::remove_dir_all(root).unwrap();
}

// The same installed native CLI public src/cli-prompt.ts functions must read
// the real SQLite Job through the actual daemon, render the real managed
// Agent/Planner contract, and refuse stale-generation context. Read-only
// observer mode is intentional: no model session or Task writes.
#[test]
fn native_cli_prompt_plan_and_task_context_reads_are_real_daemon_read_only(){
    use std::os::unix::fs::PermissionsExt;
    let root=root();
    let project=root.join("fixture");
    fs::create_dir_all(project.join("agents")).unwrap();
    fs::write(project.join("agents/implementation.agent.md"),
        "---\nname: implementation\n---\n# Real fixture Agent Contract\nBounded repository-only work.\n").unwrap();
    let init=Command::new("git").args(["init","-q","-b","main"])
        .current_dir(&project).output().unwrap();
    assert!(init.status.success());
    let home=root.join("home");let globals=root.join("global");
    fs::create_dir_all(&home).unwrap();fs::create_dir_all(&globals).unwrap();
    let store=SQLiteRelayStore::open(&root.join("relay.sqlite"),Some("17")).unwrap();
    store.save_job(&json!({
        "id":"17","repository":"fixture","projectRoot":project,
        "title":"Read-only CLI Prompt Job","objective":"Verify real Prompt provenance",
        "state":"ACTIVE","prNumber":0,"reviewEnabled":false,
        "createdAt":"2026-11-18T00:00:00.000Z",
        "updatedAt":"2026-11-18T00:00:00.000Z",
        "tasks":[{
            "id":"2","jobId":"17","kind":"work","adapter":"chatgpt",
            "agentName":"implementation","title":"Real Task Contract",
            "state":"RUNNING","attempt":1,"maxAttempts":1,
            "executionId":"execution-17-2","leaseOwner":"isolated-reporter",
            "dependencies":[],"input":"Ensure prompt references immutable Task",
            "output":{"kind":"file","path":root.join("proof.json")},
            "createdAt":"2026-11-18T00:00:00.000Z",
            "updatedAt":"2026-11-18T00:00:00.000Z"
        }],
        "plans":[{
            "jobId":"17","id":"plan-1","round":1,"status":"PLANNING",
            "executionId":"plan-generation-1","source":"model-planner",
            "trigger":{"source":"manual","taskIds":[],"reason":"Isolated test"},
            "assessment":"Read-only fixture","generatedTaskIds":[],
            "createdAt":"2026-11-18T00:00:01.000Z",
            "updatedAt":"2026-11-18T00:00:01.000Z"
        }]
    })).unwrap();store.close().unwrap();
    let port=socket_port();let _daemon=start(&root,port);
    let port=port.to_string();
    let run=|args:&[&str]|{
        let execute=||Command::new(env!("CARGO_BIN_EXE_agents-relay-rust"))
            .args(args).env("HOME",&home).env("AGENTS_HOME",&globals)
            .env("AGENTS_RELAY_WORKSPACE_ROOT",&root)
            .env_remove("AGENTS_RELAY_SHARED_ROOT")
            .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
            .output().unwrap();
        let mut output=execute();
        // An isolated macOS TCP listener may transiently return EAGAIN.
        // Retry that transport error only, never semantic CLI rejections.
        for _ in 0..5{
            if output.status.success(){break;}
            let stderr=String::from_utf8_lossy(&output.stderr);
            if !stderr.contains("Resource temporarily unavailable")
                &&!stderr.contains("os error 35")
                &&!stderr.contains("Broken pipe") {break;}
            thread::sleep(Duration::from_millis(120));
            output=execute();
        }
        output
    };
    let args=["prompt","--id","17","--task-id","2","--port",&port];
    let source_root=Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let stores=root.join("stores").to_string_lossy().to_string();
    let run_original=|args:&[&str]|{
        Command::new("node").arg(source_root.join("dist/cli.js"))
            .args(args).args(["--store-dir",&stores])
            .env("HOME",&home).env("AGENTS_HOME",&globals)
            .env("AGENTS_RELAY_WORKSPACE_ROOT",&root)
            .env_remove("AGENTS_RELAY_SHARED_ROOT")
            .current_dir(source_root).output().unwrap()
    };
    let expected_task=run_original(&["prompt","--id","17","--task-id","2"]);
    assert!(expected_task.status.success(),"{}",
        String::from_utf8_lossy(&expected_task.stderr));
    let task=run(&args);
    assert!(task.status.success(),"{}",String::from_utf8_lossy(&task.stderr));
    assert_eq!(task.stdout,expected_task.stdout,"Native prompt Task diverges from original Node CLI");
    let task=String::from_utf8(task.stdout).unwrap();
    assert!(task.contains("You are implementation with responsibility at "),"{task}");
    assert!(task.contains("Job: 17"),"{task}");
    assert!(task.contains("Task: 2"),"{task}");
    assert!(task.contains("Execution: execution-17-2"),"{task}");
    let filepath=task.split("You are implementation with responsibility at ")
        .nth(1).unwrap().split_whitespace().next().unwrap()
        .trim_end_matches('.');
    assert!(fs::read_to_string(filepath).unwrap().contains("Real fixture Agent Contract"));
    let file=root.join("prompt-export.txt");
    let file_arg=file.to_string_lossy().to_string();
    let saved=run(&["prompt","--id","17","--task-id","2","--output",
        &file_arg,"--port",&port]);
    assert!(saved.status.success(),"{}",String::from_utf8_lossy(&saved.stderr));
    assert!(saved.stdout.is_empty(),"Writing --output must not echo secret Prompt");
    assert_eq!(fs::read_to_string(&file).unwrap(),task);
    assert_eq!(fs::metadata(&file).unwrap().permissions().mode()&0o777,0o600);
    let plan=run(&["prompt","--id","17","--plan-id","plan-1","--port",&port]);
    assert!(plan.status.success(),"{}",String::from_utf8_lossy(&plan.stderr));
    let expected_plan=run_original(&["prompt","--id","17","--plan-id","plan-1"]);
    assert!(expected_plan.status.success(),"{}",
        String::from_utf8_lossy(&expected_plan.stderr));
    assert_eq!(plan.stdout,expected_plan.stdout,"Native Planner Prompt differs from original Node CLI");
    let plan=String::from_utf8(plan.stdout).unwrap();
    assert!(plan.contains("You are planner"),"{plan}");
    assert!(plan.contains("plan-1")&&plan.contains("plan-generation-1"));
    let current=run(&["plan","context","--id","17","--plan-id","plan-1",
        "--execution-id","plan-generation-1","--port",&port]);
    assert!(current.status.success(),"{}",String::from_utf8_lossy(&current.stderr));
    let plan_context:Value=serde_json::from_slice(&current.stdout).unwrap();
    assert_eq!(plan_context["plan_execution"]["planId"],"plan-1");
    assert_eq!(plan_context["plan_execution"]["executionId"],"plan-generation-1");
    let expected_context=run_original(&["plan","context","--id","17",
        "--plan-id","plan-1","--execution-id","plan-generation-1"]);
    assert!(expected_context.status.success(),"{}",
        String::from_utf8_lossy(&expected_context.stderr));
    assert_eq!(plan_context,serde_json::from_slice::<Value>(&expected_context.stdout).unwrap(),
        "Native Plan Context differs from original Node authoritative SQLite Context");
    let task_context=run(&["task","context","--id","17","--task-id","2",
        "--execution-id","execution-17-2","--port",&port]);
    assert!(task_context.status.success(),"{}",String::from_utf8_lossy(&task_context.stderr));
    let task_json:Value=serde_json::from_slice(&task_context.stdout).unwrap();
    assert_eq!(task_json["job"]["id"],"17");
    assert_eq!(task_json["task"]["executionId"],"execution-17-2");
    let expected_context=run_original(&["task","context","--id","17",
        "--task-id","2","--execution-id","execution-17-2"]);
    assert!(expected_context.status.success(),"{}",
        String::from_utf8_lossy(&expected_context.stderr));
    assert_eq!(task_json,serde_json::from_slice::<Value>(&expected_context.stdout).unwrap(),
        "Native Task Context differs from original Node authoritative SQLite Context");
    for action in ["show","comments"]{
        let native=run(&["task",action,"--id","17","--task-id","2","--port",&port]);
        let original=run_original(&["task",action,"--id","17","--task-id","2"]);
        assert!(native.status.success()&&original.status.success(),
            "{action} Node/Rust: native={}, original={}",
            String::from_utf8_lossy(&native.stderr),
            String::from_utf8_lossy(&original.stderr));
        assert_eq!(serde_json::from_slice::<Value>(&native.stdout).unwrap(),
            serde_json::from_slice::<Value>(&original.stdout).unwrap(),
            "Node/Rust Task {action} value mismatch");
    }
    for arguments in [
        vec!["plan","context","--id","17","--plan-id","plan-1",
            "--execution-id","stale","--port",&port],
        vec!["task","context","--id","17","--task-id","2",
            "--execution-id","stale","--port",&port],
        vec!["prompt","--id","17","--task-id","nonexistent","--port",&port],
    ] {
        let rejected=run(&arguments);
        assert!(!rejected.status.success(),"Stale/fabricated CLI Context accepted");
        assert!(rejected.stdout.is_empty(),"Denied Context cannot leak Task content");
    }
    let persisted=SQLiteRelayStore::open_without_claim_reset(&root.join("relay.sqlite"),Some("17"))
        .unwrap().load_job("17").unwrap().unwrap();
    assert_eq!(persisted["tasks"][0]["executionId"],"execution-17-2");
    assert_eq!(persisted["plans"][0]["executionId"],"plan-generation-1");
    // The original compiled src/cli-prompt.ts is the oracle for all four
    // durable read-only entry points, not a duplicate hand-written expectation.
    // Both read the same persisted snapshot and layered Agent contracts;
    // Node uses only a disposable --file snapshot while native Rust uses the
    // actual isolated daemon GET /api/job endpoint.
    let fixture=root.join("original-node-job.json");
    fs::write(&fixture,serde_json::to_vec(&persisted).unwrap()).unwrap();
    let source_root=Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let file=fixture.to_string_lossy().to_string();
    for (command,action,flags) in [
        ("task","show",vec!["--task-id","2"]),
        ("task","comments",vec!["--task-id","2"]),
        ("task","context",vec!["--task-id","2","--execution-id","execution-17-2"]),
        ("plan","context",vec!["--plan-id","plan-1","--execution-id","plan-generation-1"]),
    ]{
        let node=Command::new("node")
            .arg(source_root.join("dist/cli.js"))
            .args([command,action,"--id","17","--file",&file])
            .args(&flags)
            .env("HOME",&home).env("AGENTS_HOME",&globals)
            .env("AGENTS_RELAY_WORKSPACE_ROOT",&root)
            .env_remove("AGENTS_RELAY_SHARED_ROOT")
            .current_dir(source_root).output().unwrap();
        let native=Command::new(env!("CARGO_BIN_EXE_agents-relay-rust"))
            .args([command,action,"--id","17","--port",&port])
            .args(&flags)
            .env("HOME",&home).env("AGENTS_HOME",&globals)
            .env("AGENTS_RELAY_WORKSPACE_ROOT",&root)
            .env_remove("AGENTS_RELAY_SHARED_ROOT")
            .current_dir(source_root).output().unwrap();
        assert!(node.status.success(),"Original Node {command} {action}: {}",
            String::from_utf8_lossy(&node.stderr));
        assert!(native.status.success(),"Rust {command} {action}: {}",
            String::from_utf8_lossy(&native.stderr));
        let expected:Value=serde_json::from_slice(&node.stdout).unwrap();
        let actual:Value=serde_json::from_slice(&native.stdout).unwrap();
        assert_eq!(actual,expected,"Original Node/Rust {command} {action} context diverged");
    }
    fs::remove_dir_all(root).unwrap();
}

// Public original Node CLI task-events reader and installed native CLI must
// consume the same test-owned Events Bus HTTP cursor API with the same
// authoritative read-only Job/Task binding; never query a live EventBus.
#[test]
fn native_task_events_cli_matches_original_node_real_event_history_and_rejects_stale_ids(){
    use std::sync::mpsc;
    let root=root();
    let project=root.join("fixture");
    fs::create_dir_all(&project).unwrap();
    assert!(Command::new("git").args(["init","-q","-b","main"])
        .current_dir(&project).status().unwrap().success());
    let store=SQLiteRelayStore::open(&root.join("relay.sqlite"),Some("17")).unwrap();
    store.save_job(&json!({
        "id":"17","repository":"fixture","projectRoot":project,
        "title":"Read-only Task Events", "state":"ACTIVE","prNumber":0,
        "tasks":[{"id":"2","jobId":"17","state":"RUNNING",
            "agentName":"implementation","adapter":"chatgpt",
            "executionId":"execution-17-2","dependencies":[],
            "input":"Read-only Task event cursor","comments":[]}],"plans":[],
        "createdAt":"2026-11-18T00:00:00.000Z",
        "updatedAt":"2026-11-18T00:00:00.000Z"
    })).unwrap();store.close().unwrap();
    let daemon_port=socket_port();let _daemon=start(&root,daemon_port);
    let listener=TcpListener::bind("127.0.0.1:0").unwrap();
    let event_port=listener.local_addr().unwrap().port();
    let (query_tx,query_rx)=mpsc::channel::<String>();
    let handler=thread::spawn(move||{
        for _ in 0..4{
            let (mut stream,_)=listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(4))).unwrap();
            let mut bytes=[0u8;4096];
            let size=stream.read(&mut bytes).unwrap();
            let request=String::from_utf8_lossy(&bytes[..size]);
            let query=request.lines().next().unwrap_or("").to_string();
            query_tx.send(query.clone()).unwrap();
            let asc=query.contains("order=asc");
            let event=|cursor:i64|json!({"cursor":cursor,"event":{
                "event_id":format!("event-{cursor}"),"job_id":"17",
                "task_id":"2","type":"task.progress","status":"running",
                "message":format!("Fixture event {cursor}"),
                "timestamp":"2026-11-18T00:00:00.000Z"}});
            let rows=if asc{vec![event(4),event(5)]}
                else{vec![event(5),event(4)]};
            let body=json!({"job_id":"17","order":if asc{"asc"}else{"desc"},
                "events":rows,"next_cursor":if asc{5}else{5}}).to_string();
            let response=format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body);
            stream.write_all(response.as_bytes()).unwrap();
        }
    });
    let native_port=daemon_port.to_string();
    let event_url=format!("http://127.0.0.1:{event_port}");
    let project_root=Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let stores=root.join("stores").to_string_lossy().to_string();
    let run=|node:bool,order:&str|{
        let invoke=||{
            let mut c=if node{
                let mut c=Command::new("node");c.arg(project_root.join("dist/cli.js"));c
            }else{Command::new(env!("CARGO_BIN_EXE_agents-relay-rust"))};
            c.current_dir(project_root)
                .args(["task","events","--id","17","--task-id","2",
                    "--store-dir",&stores,"--port",&native_port,
                    "--limit","2","--order",order]);
            if order=="asc"{c.args(["--after","0"]);}
            c.env("EVENTS_BUS_API_URL",&event_url)
                .env("EVENTS_BUS_CONFIG",root.join("missing-events-runtime.json"))
                .env("HOME",&root)
                .env("AGENTS_HOME",root.join("nonexistent-home"));
            c.output().unwrap()
        };
        let mut output=invoke();
        if !node{
            for _ in 0..5{
                if output.status.success(){break;}
                let stderr=String::from_utf8_lossy(&output.stderr);
                // A failed immutable Job GET under macOS transient EAGAIN
                // has not queried or consumed any EventBus cursor.
                if !(stderr.contains("Agents Relay job request failed:")
                    &&(stderr.contains("Resource temporarily unavailable")
                    ||stderr.contains("os error 35"))){break;}
                thread::sleep(Duration::from_millis(120));
                output=invoke();
            }
        }
        output
    };
    for order in ["asc","desc"]{
        let node=run(true,order);
        assert!(node.status.success(),"{}",String::from_utf8_lossy(&node.stderr));
        let rust=run(false,order);
        assert!(rust.status.success(),"{}",String::from_utf8_lossy(&rust.stderr));
        let expected:Value=serde_json::from_slice(&node.stdout).unwrap();
        let observed:Value=serde_json::from_slice(&rust.stdout).unwrap();
        assert_eq!(observed,expected,"Read-only native CLI EventBus cursor diverges");
        assert_eq!(observed["events"].as_array().unwrap().len(),2);
        assert_eq!(observed["jobId"],"17");
        assert_eq!(observed["taskId"],"2");
        assert_eq!(observed["order"],if order=="asc"{"oldest-first"}else{"newest-first"});
    }
    handler.join().unwrap();
    let observed_requests=query_rx.try_iter().collect::<Vec<_>>();
    assert_eq!(observed_requests.len(),4);
    for query in &observed_requests{
        assert!(query.contains("/events?job=17&task=2&limit=2&order="),"{query}");
    }
    // Preflight rejects stale/unbound Task without touching Events Bus.
    let missing=Command::new(env!("CARGO_BIN_EXE_agents-relay-rust"))
        .current_dir(project_root)
        .args(["task","events","--id","17","--task-id","999",
            "--port",&native_port,"--store-dir",&stores])
        .env("EVENTS_BUS_API_URL",&event_url).output().unwrap();
    assert!(!missing.status.success());
    assert!(missing.stdout.is_empty());
    fs::remove_dir_all(root).unwrap();
}

/// Real native daemon owner must preallocate one Graph-approved semantic
/// dependency revision in its isolated SQLite store BEFORE Reconciler claims
/// the new Worker. A pure reconciliation with an empty reserved-ID vector
/// previously swallowed the missing-ID error and lost the Task forever.
#[test]
fn native_daemon_creates_numeric_semantic_revision_and_survives_restart(){
    let root=root();let project=root.join("project");
    fs::create_dir_all(project.join("agents/.shortcut")).unwrap();
    fs::write(project.join("agents/implementation.agent.md"),
        "---\nname: implementation\ncapabilities: [script]\n---\n# Real revision Worker\n").unwrap();
    fs::write(project.join("agents/.shortcut/implementation.agent.mjs"),
        "export async function run({input}) { return {status:'COMPLETED',output:{evidence:input.executionId},artifacts:{}}; }\n").unwrap();
    assert!(Command::new("git").arg("-C").arg(&project)
        .args(["init","-q","-b","main"]).status().unwrap().success());
    let store=SQLiteRelayStore::open(&root.join("relay.sqlite"),Some("93")).unwrap();
    let task=|id:&str,title:&str,deps:Value,mode:Value,state:&str|json!({
        "id":id,"jobId":"93","kind":"work","title":title,"state":state,
        "agentName":"implementation","adapter":"script","priority":"P2",
        "storySize":"S","attempt":1,"maxAttempts":2,
        "capabilities":["script"],"dependencies":deps,
        "dependencyValidity":mode,"input":format!("Build {title}"),
        "result":{"summary":"Already verified"},
        "output":{"kind":"file","path":root.join(format!("artifact-{id}.json"))},
        "createdAt":"2026-11-17T00:00:00.000Z",
        "updatedAt":"2026-11-17T00:00:00.000Z"
    });
    let up=task("1","Original upstream",json!([]),json!({}),"SUCCEEDED");
    let down=task("2","Dependent original",json!(["1"]),json!({"1":"rerun"}),"SUCCEEDED");
    let mut new=task("3","Revised upstream",json!(["1"]),json!({}),"SUCCEEDED");
    new["revision"]=json!({"kind":"rerun","originalTaskId":"1",
        "dependencyVector":{},"requestIds":["fixture-rq"]});
    new["createdAt"]=json!("2026-11-17T01:00:00.000Z");
    store.save_job(&json!({"id":"93","repository":"project","projectRoot":project,
        "state":"ACTIVE","prNumber":0,"title":"Semantic dependency revision",
        "priority":"P2","reviewEnabled":false,"plans":[],
        "createdAt":"2026-11-17T00:00:00.000Z",
        "updatedAt":"2026-11-17T00:00:00.000Z","tasks":[up,down,new]
    })).unwrap();store.close().unwrap();
    let port=socket_port();let daemon=start_mode(&root,port,"--isolated-write-store-dir");
    let mut seen=Value::Null;
    for _ in 0..100{
        seen=body(&request(port,"GET","/api/job?id=93","").unwrap());
        let latest=seen["tasks"].as_array().into_iter().flatten().filter(|task|
            task.pointer("/revision/originalTaskId")==Some(&json!("2")))
            .collect::<Vec<_>>();
        if latest.len()==1&&latest[0]["state"]=="SUCCEEDED"{break;}
        thread::sleep(Duration::from_millis(100));
    }
    let descendants=seen["tasks"].as_array().unwrap().iter().filter(|task|
        task.pointer("/revision/originalTaskId")==Some(&json!("2")))
        .collect::<Vec<_>>();
    assert_eq!(descendants.len(),1,"Daemon must create only one semantic child: {seen}");
    let child=descendants[0];
    assert!(child["id"].as_str().unwrap_or("").parse::<u64>().is_ok(),"{child}");
    assert_eq!(child["revision"]["kind"],"rerun");
    assert_eq!(child["revision"]["dependencyVector"]["1"],"3:1");
    assert_eq!(child["dependencies"],json!(["2","3"]));
    assert_eq!(child["state"],"SUCCEEDED","Worker must be real owned Shortcut: {seen}");
    assert_eq!(child["result"]["data"]["output"]["evidence"].as_str().is_some(),true);
    let child_id=child["id"].clone();
    drop(daemon);
    let restarted=start_mode(&root,port,"--isolated-write-store-dir");
    let restored=body(&request(port,"GET","/api/job?id=93","").unwrap());
    let descendants=restored["tasks"].as_array().unwrap().iter().filter(|task|
        task.pointer("/revision/originalTaskId")==Some(&json!("2")))
        .collect::<Vec<_>>();
    assert_eq!(descendants.len(),1,"Restart must not manufacture another child: {restored}");
    assert_eq!(descendants[0]["id"],child_id);
    assert_eq!(descendants[0]["state"],"SUCCEEDED");
    drop(restarted);fs::remove_dir_all(root).unwrap();
}
