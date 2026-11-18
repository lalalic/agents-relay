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
    for _ in 0..50{
        if request(port,"GET","/api/status","").is_ok(){return guard;}
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
            let result=Command::new(env!("CARGO_BIN_EXE_agents-relay-rust"))
                .args(args).args(["--port",&port.to_string()]).output().unwrap();
            assert!(result.status.success(),"{}",String::from_utf8_lossy(&result.stderr));
            assert_eq!(serde_json::from_slice::<Value>(&result.stdout).unwrap()[key],expected);
        }
        let list=Command::new(env!("CARGO_BIN_EXE_agents-relay-rust"))
            .args(["job","list","--port",&port.to_string()]).output().unwrap();
        assert!(list.status.success(),"{}",String::from_utf8_lossy(&list.stderr));
        let rows:Value=serde_json::from_slice(&list.stdout).unwrap();
        assert_eq!(rows.as_array().unwrap().len(),1);
        assert_eq!(rows[0]["id"],"17");
        if attempt==0{
            let cli=Command::new(env!("CARGO_BIN_EXE_agents-relay-rust"))
                .args(["job","update","--id","17","--title","After native write",
                    "--port",&port.to_string()]).output().unwrap();
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
    assert_eq!(durable["tasks"][0]["state"],"QUEUED", "Worker launch failure must preserve queued Task state, not claim execution");
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
