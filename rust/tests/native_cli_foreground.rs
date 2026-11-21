// Foreground attachment uses the installed native CLI + actual native daemon.
// All Git roots/SQLite/HTTP ports/processes are isolated disposable fixtures.
use agents_relay_rust2::{
    cli_foreground::attach_foreground_daemon,
    relay_store::SQLiteRelayStore,
};
use serde_json::json;
use std::{
    fs,
    path::{Path,PathBuf},
    net::{TcpListener,TcpStream},
    io::{Read,Write},
    process::{Child,Command,Stdio},
    sync::atomic::{AtomicI32,Ordering},
    thread,
    time::{Duration,Instant,SystemTime,UNIX_EPOCH},
};
fn root()->PathBuf{
    let p=std::env::temp_dir().join(format!("rust2-cli-foreground-{}-{}",
        std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH)
            .unwrap().as_nanos()));
    fs::create_dir_all(p.join("stores")).unwrap();
    p
}
fn port()->u16{
    TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}
fn status(port:u16)->bool{
    let Ok(mut socket)=TcpStream::connect(("127.0.0.1",port))else{return false};
    let _=socket.set_read_timeout(Some(Duration::from_millis(100)));
    if socket.write_all(b"GET /api/status HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").is_err(){return false;}
    let mut response=String::new();
    socket.read_to_string(&mut response).is_ok()&&response.starts_with("HTTP/1.1 200")
}
struct Guard(Child);
impl Drop for Guard{
    fn drop(&mut self){
        if self.0.try_wait().ok().flatten().is_some(){return;}
        unsafe{libc::kill(self.0.id() as i32,libc::SIGTERM);}
        for _ in 0..40{
            if self.0.try_wait().ok().flatten().is_some(){return;}
            thread::sleep(Duration::from_millis(50));
        }
        let _=self.0.kill();let _=self.0.wait();
    }
}
fn daemon(root:&Path,port:u16)->Guard{
    daemon_with_history(root,port,None)
}
fn daemon_with_history(root:&Path,port:u16,history:Option<&str>)->Guard{
    daemon_with_model_ingress(root,port,history,false)
}
fn daemon_with_model_ingress(root:&Path,port:u16,history:Option<&str>,trust:bool)->Guard{
    daemon_with_model_transports(root,port,history,None,trust)
}
fn daemon_with_model_transports(root:&Path,port:u16,
    history:Option<&str>,nats:Option<&str>,trust:bool)->Guard{
    let mut command=Command::new(env!("CARGO_BIN_EXE_agents-relayd-rust"));
    command.args(["--isolated-write-store-dir",
            root.join("stores").to_str().unwrap(),"--port",&port.to_string(),
            "--interval","100"]);
    if let Some(history)=history{
        command.args(["--event-history-api",history]);
    }
    if let Some(nats)=nats{
        command.args(["--isolated-nats-url",nats]);
    }
    if trust{command.arg("--trust-isolated-model-events");}
    let child=command
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .stdout(Stdio::null())
        .stderr(Stdio::from(fs::File::create(root.join("daemon.log")).unwrap()))
        .spawn().unwrap();
    let mut child=Guard(child);
    for _ in 0..300{
        if status(port){return child;}
        assert!(child.0.try_wait().unwrap().is_none(),
            "isolated native daemon exited: {}",fs::read_to_string(
                root.join("daemon.log")).unwrap_or_default());
        thread::sleep(Duration::from_millis(40));
    }
    panic!("native daemon did not become ready on isolated loopback port");
}
fn job(root:&Path,state:&str,paused:bool){
    let git=root.join("fixture");
    fs::create_dir_all(&git).unwrap();
    assert!(Command::new("git").args(["init","-q","-b","main"])
        .current_dir(&git).status().unwrap().success());
    let path=root.join("relay.sqlite");
    let store=SQLiteRelayStore::open(&path,Some("17")).unwrap();
    let task_state=if state=="COMPLETED"{"SUCCEEDED"}else{"QUEUED"};
    let mut value=json!({
        "id":"17","repository":"fixture","projectRoot":git,
        "title":"Real native foreground attachment",
        "objective":"No external Worker in test",
        "state":state,"prNumber":0,"reviewEnabled":false,"autoMerge":false,
        "createdAt":"2026-11-18T00:00:00.000Z",
        "updatedAt":"2026-11-18T00:00:00.000Z",
        "tasks":[{
            "id":"2","jobId":"17","kind":"work","agentName":"coordinator",
            "state":task_state,"attempt":0,"maxAttempts":3,
            "dependencies":[],"agentGraph":"flowchart TD\nA[agent:developer]",
            "createdAt":"2026-11-18T00:00:00.000Z",
            "updatedAt":"2026-11-18T00:00:00.000Z"
        }],"plans":[]
    });
    if paused{value["pause"]=json!({"reason":"Fixture maintenance","at":"2026-11-18T00:00:00.000Z"});}
    store.save_job(&value).unwrap();
    store.close().unwrap();
}
#[test]
fn attachment_reuses_authoritative_durable_load_events_and_reconcile(){
    use std::cell::Cell;
    let interrupted=AtomicI32::new(0);
    let rounds=Cell::new(0usize);
    let mut messages=Vec::<String>::new();
    let event_calls=Cell::new(0usize);
    let attached=attach_foreground_daemon(
        "17","2",
        ||Ok(json!({"id":"17","state":if rounds.get()>=2{"COMPLETED"}else{"ACTIVE"},
            "tasks":[{"id":"2","agentName":"coordinator","state":"QUEUED"}]})),
        ||{rounds.set(rounds.get()+1);Ok(())},
        ||{
            event_calls.set(event_calls.get()+1);
            Ok(vec![json!({"job_id":"17","task_id":"2",
                "event_id":"unique-1","type":"task.started",
                "message":"Started","timestamp":"2026-11-20T17:00:00.000Z"})])
        },|message|messages.push(message),
        Duration::from_millis(0),&interrupted
    ).unwrap();
    assert_eq!(attached.job["state"],"COMPLETED");
    assert_eq!(attached.interrupted_signal,None);
    assert_eq!(rounds.get(),2,"exactly two canonical Reconciler passes");
    assert_eq!(event_calls.get(),3);
    assert_eq!(messages.iter().filter(|message|message.contains("task.started")).count(),1,
        "repeated history rows must never duplicate a foreground progress line");
    assert!(messages.iter().any(|line|line.contains("coordinator  task.started")));
    assert!(messages.iter().any(|line|line=="Job 17: COMPLETED"));
}
#[test]
fn attachment_interrupt_never_claims_job_completed_or_cancels_durable_work(){
    let interrupted=AtomicI32::new(0);
    let mut messages=Vec::<String>::new();
    let original=json!({"id":"17","state":"ACTIVE","pause":{"reason":"Fixture"},
        "tasks":[{"id":"2","agentName":"coordinator","state":"QUEUED"}]});
    let completed=attach_foreground_daemon(
        "17","2",||Ok(original.clone()),
        ||{
            interrupted.store(libc::SIGINT,Ordering::SeqCst);
            Ok(())
        },
        ||Ok(vec![]),|message|messages.push(message),
        Duration::from_millis(500),&interrupted
    ).unwrap();
    assert_eq!(completed.interrupted_signal,Some(libc::SIGINT));
    assert_eq!(completed.job,original);
    assert!(messages.iter().any(|message|message.contains("PAUSED")));
    assert!(messages.iter().any(|message|message.contains("daemon-owned Workers continue")));
    assert!(messages.iter().any(|message|message.contains("Leaving foreground")));
    assert!(!messages.iter().any(|message|message=="Job 17: COMPLETED"));
}
#[test]
fn installed_native_cli_attaches_to_terminal_real_daemon_without_restarting_job(){
    let home=root();job(&home,"COMPLETED",false);
    let before=SQLiteRelayStore::open_without_claim_reset(
        &home.join("relay.sqlite"),Some("17")).unwrap().load_job("17").unwrap().unwrap();
    let port=port();let running=daemon(&home,port);
    let output=Command::new(env!("CARGO_BIN_EXE_agents-relay-rust"))
        .args(["job","run","--id","17","--task-id","2","--foreground",
            "--port",&port.to_string()]).output().unwrap();
    assert!(output.status.success(),"{}",
        String::from_utf8_lossy(&output.stderr));
    let stdout=String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains("Coordinator job 17, task 2: foreground daemon attachment"),"{stdout}");
    assert!(stdout.contains("Job 17: COMPLETED"),"{stdout}");
    assert!(stdout.contains("\"state\": \"COMPLETED\""),"{stdout}");
    let after=SQLiteRelayStore::open_without_claim_reset(
        &home.join("relay.sqlite"),Some("17")).unwrap().load_job("17").unwrap().unwrap();
    assert_eq!(after,before,"completed Job must never be restarted by attaching CLI");
    drop(running);fs::remove_dir_all(home).unwrap();
}
#[test]
fn installed_native_cli_signals_detach_paused_job_keep_graph_sqlite_across_restart(){
    for (signal,expected_exit) in [(libc::SIGINT,130),(libc::SIGTERM,143)]{
    let home=root();job(&home,"ACTIVE",true);
    let port=port();let running=daemon(&home,port);
    let port_arg=port.to_string();
    let out=home.join("foreground-stdout.log");
    let err=home.join("foreground-stderr.log");
    let cli=Command::new(env!("CARGO_BIN_EXE_agents-relay-rust"))
        .args(["job","run","--id","17","--task-id","2","--foreground",
            "--workspace-root",home.to_str().unwrap(),"--port",&port_arg])
        .stdout(Stdio::from(fs::File::create(&out).unwrap()))
        .stderr(Stdio::from(fs::File::create(&err).unwrap()))
        .spawn().unwrap();
    let mut cli=Guard(cli);
    let start=Instant::now();
    loop{
        let printed=fs::read_to_string(&out).unwrap_or_default();
        if printed.contains("Job 17: PAUSED"){break;}
        assert!(start.elapsed()<Duration::from_secs(15),"foreground CLI did not attach: stdout={printed}, stderr={}",
            fs::read_to_string(&err).unwrap_or_default());
        assert!(cli.0.try_wait().unwrap().is_none(),"foreground unexpectedly exited: {}",
            fs::read_to_string(&err).unwrap_or_default());
        thread::sleep(Duration::from_millis(80));
    }
    assert_eq!(unsafe{libc::kill(cli.0.id() as i32,signal)},0);
    let deadline=Instant::now();
    let exit=loop{
        if let Some(status)=cli.0.try_wait().unwrap(){break status;}
        assert!(deadline.elapsed()<Duration::from_secs(8),"SIGINT did not detach foreground CLI");
        thread::sleep(Duration::from_millis(50));
    };
    assert_eq!(exit.code(),Some(expected_exit),"signal needs Node-compatible exit code");
    let output=fs::read_to_string(&out).unwrap();
    assert!(output.contains("Leaving foreground for Job 17;"),"{output}");
    let saved=SQLiteRelayStore::open_without_claim_reset(
        &home.join("relay.sqlite"),Some("17")).unwrap().load_job("17").unwrap().unwrap();
    assert_eq!(saved["state"],"ACTIVE");
    assert_eq!(saved["tasks"][0]["state"],"QUEUED");
    assert!(!saved["pause"].is_null());
    assert!(saved["graphStartContext"]["projectRoot"].is_string());
    drop(running);
    let restarted=daemon(&home,port);
    let replay=SQLiteRelayStore::open_without_claim_reset(
        &home.join("relay.sqlite"),Some("17")).unwrap().load_job("17").unwrap().unwrap();
    assert_eq!(replay["state"],saved["state"]);
    assert_eq!(replay["tasks"][0]["state"],saved["tasks"][0]["state"]);
    assert_eq!(replay["graphStartContext"],saved["graphStartContext"]);
    drop(restarted);
    fs::remove_dir_all(home).unwrap();
    }
}

#[test]
fn native_cli_foreground_runs_real_script_worker_to_verified_graph_sqlite_completion(){
    let home=root();
    let project=home.join("fixture");
    fs::create_dir_all(project.join("agents/.shortcut")).unwrap();
    fs::write(project.join("agents/fixture.agent.md"),
        "---\nname: fixture\ncapabilities: [script]\n---\n# Native foreground Script Worker\n").unwrap();
    fs::write(project.join("agents/.shortcut/fixture.agent.mjs"),
        "export async function run({input}) { return {status:'COMPLETED',output:{foreground:true,execution:input.executionId},artifacts:{}} }\n").unwrap();
    assert!(Command::new("git").args(["init","-q","-b","main"])
        .current_dir(&project).status().unwrap().success());
    let output=home.join("real-worker-output.json");
    let db=SQLiteRelayStore::open(&home.join("relay.sqlite"),Some("17")).unwrap();
    db.save_job(&json!({
        "id":"17","repository":"fixture","projectRoot":project,
        "title":"Foreground real Script Worker","state":"DRAFT","prNumber":0,
        "objective":"Complete verified Script via native Coordinator",
        "reviewEnabled":false,"autoMerge":true,"priority":"P2",
        "createdAt":"2026-11-18T00:00:00.000Z",
        "updatedAt":"2026-11-18T00:00:00.000Z",
        "plans":[{"id":"plan-1","round":1,"status":"SUCCEEDED",
            "objectiveStatus":"satisfied","assessment":"Fixture scope approved"}],
        "tasks":[{
            "id":"2","jobId":"17","kind":"work","adapter":"script",
            "agentName":"fixture","title":"Real Script Worker","state":"DRAFT",
            "agentGraph":"flowchart TD\nA[agent:fixture]",
            "attempt":0,"maxAttempts":1,"priority":"P2",
            "dependencies":[],"input":"{}",
            "output":{"kind":"file","path":output},
            "createdAt":"2026-11-18T00:00:00.000Z",
            "updatedAt":"2026-11-18T00:00:00.000Z"
        }]
    })).unwrap();
    db.close().unwrap();
    let port=port();
    let service=daemon(&home,port);
    let stdout=home.join("actual-foreground-out.log");
    let stderr=home.join("actual-foreground-err.log");
    let process=Command::new(env!("CARGO_BIN_EXE_agents-relay-rust"))
        .args(["job","run","--id","17","--task-id","2","--foreground",
            "--workspace-root",home.to_str().unwrap(),"--port",&port.to_string()])
        .stdout(Stdio::from(fs::File::create(&stdout).unwrap()))
        .stderr(Stdio::from(fs::File::create(&stderr).unwrap()))
        .spawn().unwrap();
    let mut process=Guard(process);
    let start=Instant::now();
    let completed=loop{
        if let Some(status)=process.0.try_wait().unwrap(){break status;}
        assert!(start.elapsed()<Duration::from_secs(25),
            "real Script coordinator did not complete: stdout={}, stderr={}, daemon={}",
            fs::read_to_string(&stdout).unwrap_or_default(),
            fs::read_to_string(&stderr).unwrap_or_default(),
            fs::read_to_string(home.join("daemon.log")).unwrap_or_default());
        thread::sleep(Duration::from_millis(60));
    };
    assert!(completed.success(),
        "native CLI foreground exit {completed}: stdout={}, stderr={}, daemon={}",
        fs::read_to_string(&stdout).unwrap_or_default(),
        fs::read_to_string(&stderr).unwrap_or_default(),
        fs::read_to_string(home.join("daemon.log")).unwrap_or_default());
    let progress=fs::read_to_string(&stdout).unwrap();
    assert!(progress.contains("Coordinator job 17, task 2: foreground daemon attachment"));
    assert!(progress.contains("Job 17: COMPLETED"),"{progress}");
    let saved=SQLiteRelayStore::open_without_claim_reset(
        &home.join("relay.sqlite"),Some("17")).unwrap();
    let after=saved.load_job("17").unwrap().unwrap();
    assert_eq!(after["state"],"COMPLETED");
    assert_eq!(after["tasks"][0]["state"],"SUCCEEDED");
    assert_eq!(after["tasks"][0]["attempt"],0,
        "Graph Coordinator root is an aggregation, not a fake Worker launch");
    let children=after["tasks"].as_array().unwrap().iter().filter(|row|
        row.pointer("/dagNode/parentTaskId").and_then(serde_json::Value::as_str)==Some("2"))
        .collect::<Vec<_>>();
    assert_eq!(children.len(),1,"one declared DAG agent gets one Task generation");
    let child=children[0];
    assert_eq!(child["state"],"SUCCEEDED");
    assert_eq!(child["attempt"],1);
    assert!(child["executionId"].is_null());
    assert_eq!(child["result"]["data"]["output"]["foreground"],true);
    // A Coordinator is an aggregate DAG root. The verified child carries
    // the Script result in canonical SQLite; the root's output-file field
    // does not automatically propagate to its child.
    assert!(!output.exists(),
        "Coordinator root must not fabricate a Worker artifact");
    let child_id=child["id"].as_str().unwrap();
    let rows:i64=saved.db.query_row(
        "SELECT COUNT(*) FROM workflow_event_outbox WHERE event_key LIKE ?",
        [format!("script-event/17/{child_id}/%")],|row|row.get(0)).unwrap();
    assert_eq!(rows,2,"real DAG child start and completion are durable events");
    drop(saved);drop(service);
    let reboot=daemon(&home,port);
    thread::sleep(Duration::from_millis(200));
    let check=SQLiteRelayStore::open_without_claim_reset(
        &home.join("relay.sqlite"),Some("17")).unwrap();
    let restarted=check.load_job("17").unwrap().unwrap();
    assert_eq!(restarted["state"],"COMPLETED");
    assert_eq!(restarted["tasks"][0]["attempt"],0);
    assert_eq!(restarted["tasks"][1]["attempt"],1,
        "restarted daemon cannot relaunch the already completed Script");
    assert_eq!(restarted["tasks"][1]["executionHistory"],
        after["tasks"][1]["executionHistory"]);
    drop(check);drop(reboot);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn installed_native_daemon_reads_explicit_events_bus_http_history_without_graph_mutation(){
    use std::io::{Read as _,Write as _};
    let home=root();job(&home,"COMPLETED",false);
    let before=SQLiteRelayStore::open_without_claim_reset(
        &home.join("relay.sqlite"),Some("17")).unwrap()
        .load_job("17").unwrap().unwrap();
    let listener=TcpListener::bind("127.0.0.1:0").unwrap();
    let event_port=listener.local_addr().unwrap().port();
    let mock=thread::spawn(move ||{
        let (mut stream,_)=listener.accept().unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let mut request=String::new();
        let mut buffer=[0u8;1024];
        while !request.contains("\r\n\r\n"){
            let size=stream.read(&mut buffer).unwrap();
            assert!(size>0);
            request.push_str(&String::from_utf8_lossy(&buffer[..size]));
            assert!(request.len()<4000);
        }
        assert!(request.starts_with("GET /events?"),"{request}");
        assert!(request.contains("job=17"),"{request}");
        assert!(request.contains("task=2"),"{request}");
        let payload=json!({"job_id":"17","order":"desc",
            "events":[{"cursor":5,"event":{"event_id":"persisted_event_0005",
                "job_id":"17","task_id":"2","type":"task.progress",
                "message":"Real external read-only Events Bus"}}],
            "next_cursor":5}).to_string();
        write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            payload.len(),payload).unwrap();
    });
    let daemon_port=port();
    let service=daemon_with_history(&home,daemon_port,
        Some(&format!("http://127.0.0.1:{event_port}/")));
    let mut socket=TcpStream::connect(("127.0.0.1",daemon_port)).unwrap();
    socket.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    socket.write_all(
        b"GET /api/events?job=17&task=2&limit=5 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
    ).unwrap();
    let mut raw=Vec::new();socket.read_to_end(&mut raw).unwrap();
    mock.join().unwrap();
    let text=String::from_utf8(raw).unwrap();
    assert!(text.starts_with("HTTP/1.1 200"),"{text}");
    let body=text.split_once("\r\n\r\n").unwrap().1;
    let events:serde_json::Value=serde_json::from_str(body).unwrap();
    assert_eq!(events.as_array().unwrap().len(),1);
    assert_eq!(events[0]["event_id"],"persisted_event_0005");
    assert_eq!(events[0]["message"],"Real external read-only Events Bus");
    let after=SQLiteRelayStore::open_without_claim_reset(
        &home.join("relay.sqlite"),Some("17")).unwrap()
        .load_job("17").unwrap().unwrap();
    assert_eq!(before,after,"external events history cannot mutate Job status");
    drop(service);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn native_daemon_opt_in_model_event_ingress_commits_verified_worker_terminal(){
    use agents_relay_rust2::{
        events::event_for,execution_event_identity::execution_event_source,
        relay_store_discovery::relay_unified_store_path,
    };
    let home=root();
    job(&home,"ACTIVE",false);
    let execution="native_ingress_verified_001";
    let db=relay_unified_store_path(&home.join("stores"));
    let store=SQLiteRelayStore::open_without_claim_reset(&db,Some("17")).unwrap();
    store.mutate_job("17",|mut job|{
        let task=&mut job["tasks"][0];
        task["adapter"]=json!("chatgpt");
        task["agentName"]=json!("implementation");
        task["agentGraph"]=serde_json::Value::Null;
        task["attempt"]=json!(1);
        task["executionId"]=json!(execution);
        task["leaseOwner"]=json!("isolated-model-provider");
        task["leaseExpiresAt"]=json!("2027-11-21T23:59:59.000Z");
        job["autoMerge"]=json!(false);
        Ok(job)
    }).unwrap();
    drop(store);
    let expected_source=json!({
        "id":execution_event_source("17","2",execution),
        "agent":"fixture","component":"agents-relay",
    });
    let events=vec![
        event_for("17","2",None,"task.started","started",
            "Observed exactly issued worker start",None,None,
            Some(expected_source.clone())),
        event_for("17","2",None,"task.completed","completed",
            "Observed exactly issued worker completion",None,None,
            Some(expected_source)),
    ];
    let listener=TcpListener::bind("127.0.0.1:0").unwrap();
    let bus_port=listener.local_addr().unwrap().port();
    let bus=thread::spawn(move||{
        let (mut stream,_)=listener.accept().unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let mut raw=String::new();let mut buf=[0u8;1024];
        while !raw.contains("\r\n\r\n"){
            let n=stream.read(&mut buf).unwrap();assert!(n>0);
            raw.push_str(&String::from_utf8_lossy(&buf[..n]));
        }
        assert!(raw.starts_with("GET /events?"),"{raw}");
        assert!(raw.contains("job=17")&&raw.contains("order=asc"),"{raw}");
        let payload=json!({
            "job_id":"17","order":"asc","events":events.into_iter()
                .enumerate().map(|(i,event)|
                    json!({"cursor":i+1,"event":event})).collect::<Vec<_>>(),
            "next_cursor":2,
        }).to_string();
        write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            payload.len(),payload).unwrap();
    });
    let port=port();
    let running=daemon_with_model_ingress(&home,port,
        Some(&format!("http://127.0.0.1:{bus_port}/")),true);
    let began=Instant::now();
    let saved=loop{
        let store=SQLiteRelayStore::open_without_claim_reset(&db,Some("17")).unwrap();
        let snapshot=store.load_job("17").unwrap().unwrap();
        if snapshot["tasks"][0]["state"]=="SUCCEEDED"{break snapshot;}
        assert!(began.elapsed()<Duration::from_secs(20),
            "native daemon never committed model Events Bus terminal: {snapshot}; daemon={}",
            fs::read_to_string(home.join("daemon.log")).unwrap_or_default());
        thread::sleep(Duration::from_millis(100));
    };
    bus.join().unwrap();
    assert!(saved["tasks"][0]["executionId"].is_null());
    let outbox=SQLiteRelayStore::open_without_claim_reset(&db,Some("17")).unwrap();
    let count:i64=outbox.db.query_row(
        "SELECT COUNT(*) FROM workflow_event_outbox WHERE event_key LIKE 'model-event/17/2/%'",
        [],|row|row.get(0)).unwrap();
    assert_eq!(count,2,"only verified start and terminal can persist");
    drop(outbox);drop(running);
    let restarted=daemon(&home,port);
    thread::sleep(Duration::from_millis(220));
    let store=SQLiteRelayStore::open_without_claim_reset(&db,Some("17")).unwrap();
    let after=store.load_job("17").unwrap().unwrap();
    assert_eq!(after["tasks"][0]["state"],"SUCCEEDED");
    assert_eq!(after["tasks"][0]["attempt"],1);
    assert_eq!(after["tasks"][0]["executionHistory"],
        saved["tasks"][0]["executionHistory"]);
    drop(store);drop(restarted);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn installed_native_daemon_receives_nats_push_as_authoritative_graph_worker_event(){
    use agents_relay_rust2::{
        events::event_for,execution_event_identity::execution_event_source,
        relay_store_discovery::relay_unified_store_path,
    };
    use std::io::{BufRead,BufReader,Write as _};
    let home=root();
    job(&home,"ACTIVE",false);
    let execution="real-daemon-nats-001";
    let db=relay_unified_store_path(&home.join("stores"));
    let store=SQLiteRelayStore::open_without_claim_reset(&db,Some("17")).unwrap();
    store.mutate_job("17",|mut job|{
        let task=&mut job["tasks"][0];
        task["adapter"]=json!("chatgpt");
        task["agentName"]=json!("implementation");
        task["agentGraph"]=serde_json::Value::Null;
        task["attempt"]=json!(1);
        task["executionId"]=json!(execution);
        task["leaseOwner"]=json!("trusted-nats-test-provider");
        task["leaseExpiresAt"]=json!("2027-11-21T23:59:59.000Z");
        job["autoMerge"]=json!(false);
        Ok(job)
    }).unwrap();
    drop(store);
    let source=json!({
        "id":execution_event_source("17","2",execution),
        "agent":"fixture","component":"agents-relay",
    });
    let events=vec![
        event_for("17","2",None,"task.started","started",
            "Real NATS leased model worker",None,None,Some(source.clone())),
        event_for("17","2",None,"task.completed","completed",
            "Real NATS model terminal",None,None,Some(source)),
    ];
    let listener=TcpListener::bind("127.0.0.1:0").unwrap();
    let nats_port=listener.local_addr().unwrap().port();
    let server=thread::spawn(move||{
        let (mut socket,_)=listener.accept().unwrap();
        socket.set_read_timeout(Some(Duration::from_secs(4))).unwrap();
        socket.write_all(b"INFO {}\r\n").unwrap();
        let mut reader=BufReader::new(socket.try_clone().unwrap());
        let mut subscribed=false;
        for _ in 0..8{
            let mut line=String::new();
            if reader.read_line(&mut line).unwrap()==0{break;}
            if line.starts_with("SUB "){
                assert!(line.contains("relay.events.job.> 1"),"{line}");
                subscribed=true;break;
            }
        }
        assert!(subscribed,"native daemon did not subscribe to disposable NATS server");
        for event in events{
            let topic=format!("relay.events.job.17.{}",event["type"].as_str().unwrap());
            let payload=event.to_string();
            write!(socket,"MSG {topic} 1 {}\r\n{payload}\r\n",payload.len()).unwrap();
        }
        socket.flush().unwrap();
        thread::sleep(Duration::from_millis(250));
    });
    let port=port();
    let nats=format!("nats://127.0.0.1:{nats_port}/");
    let running=daemon_with_model_transports(&home,port,None,Some(&nats),true);
    let begin=Instant::now();
    let committed=loop{
        let store=SQLiteRelayStore::open_without_claim_reset(&db,Some("17")).unwrap();
        let current=store.load_job("17").unwrap().unwrap();
        if current["tasks"][0]["state"]=="SUCCEEDED"{break current;}
        assert!(begin.elapsed()<Duration::from_secs(18),
            "actual native NATS event subscription did not complete Graph/SQLite Task: {current}; daemon={}",
            fs::read_to_string(home.join("daemon.log")).unwrap_or_default());
        thread::sleep(Duration::from_millis(75));
    };
    server.join().unwrap();
    assert!(committed["tasks"][0]["executionId"].is_null());
    assert_eq!(committed["tasks"][0]["attempt"],1);
    let store=SQLiteRelayStore::open_without_claim_reset(&db,Some("17")).unwrap();
    let rows:i64=store.db.query_row(
        "SELECT COUNT(*) FROM workflow_event_outbox WHERE event_key LIKE 'model-event/17/2/%'",
        [],|row|row.get(0)).unwrap();
    assert_eq!(rows,2,"NATS transport cannot bypass durable exact event receipts");
    drop(store);drop(running);
    let restarted=daemon(&home,port);
    thread::sleep(Duration::from_millis(180));
    let after=SQLiteRelayStore::open_without_claim_reset(&db,Some("17")).unwrap()
        .load_job("17").unwrap().unwrap();
    assert_eq!(after["tasks"][0]["state"],"SUCCEEDED");
    assert_eq!(after["tasks"][0]["attempt"],1);
    assert_eq!(after["tasks"][0]["executionHistory"],
        committed["tasks"][0]["executionHistory"]);
    drop(restarted);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn installed_native_daemon_dashboard_sse_emits_node_frames_only_after_commit(){
    let home=root();job(&home,"DRAFT",false);
    let port=port();
    let running=daemon(&home,port);
    let mut live=TcpStream::connect(("127.0.0.1",port)).unwrap();
    live.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    live.write_all(b"GET /events HTTP/1.1\r\nHost: localhost\r\n\r\n").unwrap();
    let mut got=String::new();
    let mut buf=[0u8;4096];
    let deadline=Instant::now()+Duration::from_secs(7);
    while !got.contains(": connected\n\n"){
        let n=live.read(&mut buf).unwrap();assert!(n>0);
        got.push_str(&String::from_utf8_lossy(&buf[..n]));
        assert!(Instant::now()<deadline,"native SSE startup did not open a live stream");
    }
    assert!(got.starts_with("HTTP/1.1 200"),"{got}");
    assert!(got.contains("Content-Type: text/event-stream"),"{got}");
    assert!(!got.contains("\"state\":\"ACTIVE\""),
        "SSE must never send an activated Job before the Graph/SQLite commit");
    let mut control=TcpStream::connect(("127.0.0.1",port)).unwrap();
    control.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    control.write_all(
        b"POST /api/job-action?id=17&action=start HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    ).unwrap();
    let mut result=String::new();
    control.read_to_string(&mut result).unwrap();
    assert!(result.starts_with("HTTP/1.1 200"),"{result}");
    let committed:serde_json::Value=serde_json::from_str(
        result.split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(committed["state"],"ACTIVE");
    let deadline=Instant::now()+Duration::from_secs(7);
    while !got.contains("event: relay\ndata: ")
        || !got.contains("\"type\":\"relay.wake\"")
        || !got.contains("\"job\":") || !got.contains("\"state\":\"ACTIVE\""){
        let n=live.read(&mut buf).unwrap();
        assert!(n>0,"native SSE connection dropped before forwarding committed Job");
        got.push_str(&String::from_utf8_lossy(&buf[..n]));
        assert!(Instant::now()<deadline,"daemon sent no Node-compatible SSE after SQLite commit: {got}");
    }
    let saved=SQLiteRelayStore::open_without_claim_reset(
        &home.join("relay.sqlite"),Some("17")).unwrap().load_job("17").unwrap().unwrap();
    assert_eq!(saved["state"],"ACTIVE");
    let payload=got.split("data: ").find(|part|part.starts_with("{\"job\":"))
        .expect("Node EventSource onmessage requires a data-only Job frame");
    let job_json:serde_json::Value=serde_json::from_str(
        payload.split_once("\n\n").unwrap().0).unwrap();
    assert_eq!(job_json["job"]["id"],"17");
    assert_eq!(job_json["job"]["state"],"ACTIVE");
    drop(live);drop(running);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn installed_daemon_sse_watches_external_graph_sqlite_worker_commits(){
    use agents_relay_rust2::{
        events::event_for,execution_event_identity::execution_event_source,
        native_worker_event_ingress::apply_verified_worker_event,
    };
    let home=root();job(&home,"ACTIVE",false);
    let db=home.join("relay.sqlite");
    let execution="outofprocess-worker-generation-001";
    let store=SQLiteRelayStore::open_without_claim_reset(&db,Some("17")).unwrap();
    store.mutate_job("17",|mut job|{
        let task=&mut job["tasks"][0];
        task["adapter"]=json!("chatgpt");
        task["agentName"]=json!("implementation");
        task["agentGraph"]=serde_json::Value::Null;
        task["attempt"]=json!(1);
        task["executionId"]=json!(execution);
        task["leaseOwner"]=json!("external-Graph-writer");
        task["leaseExpiresAt"]=json!("2027-11-21T23:59:59.000Z");
        job["autoMerge"]=json!(false);
        Ok(job)
    }).unwrap();
    drop(store);
    let port=port();
    let running=daemon(&home,port);
    let mut live=TcpStream::connect(("127.0.0.1",port)).unwrap();
    live.set_read_timeout(Some(Duration::from_secs(4))).unwrap();
    live.write_all(b"GET /events HTTP/1.1\r\nHost: localhost\r\n\r\n").unwrap();
    let mut received=String::new();
    let mut buf=[0u8;8192];
    while !received.contains(": connected\n\n"){
        let count=live.read(&mut buf).unwrap();assert!(count>0);
        received.push_str(&String::from_utf8_lossy(&buf[..count]));
    }
    assert!(!received.contains("\"state\":\"SUCCEEDED\""),
        "No Worker may appear completed before a real Graph/SQLite event");
    let issued=json!({"id":execution_event_source("17","2",execution),
        "agent":"fixture","component":"agents-relay"});
    let graph=Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow");
    // These are real Graph-owned mutations from a separate SQLite connection
    // (just as an external Worker does), not a call to daemon SSE emit.
    let started=event_for("17","2",None,"task.started","started",
        "external actual Graph start",None,None,Some(issued.clone()));
    let completed=event_for("17","2",None,"task.completed","completed",
        "external actual Graph terminal",None,None,Some(issued));
    apply_verified_worker_event(&db,&graph,"17","2",execution,&started).unwrap();
    apply_verified_worker_event(&db,&graph,"17","2",execution,&completed).unwrap();
    let deadline=Instant::now()+Duration::from_secs(9);
    loop{
        if received.contains("\"state\":\"SUCCEEDED\""){break;}
        assert!(Instant::now()<deadline,
            "Native SSE missed completed out-of-process SQLite commit: {received}");
        let count=live.read(&mut buf).unwrap();assert!(count>0);
        received.push_str(&String::from_utf8_lossy(&buf[..count]));
    }
    let frames=received.split("\n\n").filter_map(|frame|
        frame.find("data: ").and_then(|n|
            serde_json::from_str::<serde_json::Value>(&frame[n+6..]).ok()))
        .collect::<Vec<_>>();
    assert!(frames.iter().any(|frame|frame["job"]["tasks"][0]["state"]=="SUCCEEDED"),
        "EventSource must receive a real committed Task status snapshot");
    assert!(frames.iter().all(|frame|frame.get("event").is_none()),
        "separate process commit observation must not fabricate relay event payloads");
    let before=SQLiteRelayStore::open_without_claim_reset(&db,Some("17")).unwrap()
        .load_job("17").unwrap().unwrap();
    assert_eq!(before["tasks"][0]["state"],"SUCCEEDED");
    assert_eq!(before["tasks"][0]["attempt"],1);
    drop(live);drop(running);
    let restarted=daemon(&home,port);
    thread::sleep(Duration::from_millis(150));
    let after=SQLiteRelayStore::open_without_claim_reset(&db,Some("17")).unwrap()
        .load_job("17").unwrap().unwrap();
    assert_eq!(before["tasks"][0]["executionHistory"],
        after["tasks"][0]["executionHistory"]);
    assert_eq!(after["tasks"][0]["attempt"],1);
    drop(restarted);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn installed_native_cli_plan_apply_uses_only_authoritative_daemon_graph_sqlite(){
    let home=root();job(&home,"ACTIVE",false);
    let db=home.join("relay.sqlite");
    let store=SQLiteRelayStore::open_without_claim_reset(&db,Some("17")).unwrap();
    store.mutate_job("17",|mut job|{
        job["tasks"][0]["state"]=json!("SUCCEEDED");
        job["plans"]=json!([{
            "id":"plan-1","jobId":"17","status":"PLANNING",
            "round":1,"source":"model-planner",
            "executionId":"owned-cli-plan-generation-1",
            "leaseOwner":"isolated-owned-plan",
            "leaseExpiresAt":"2027-11-20T00:00:00Z",
            "attempt":1,"maxAttempts":3,"manualPlanning":true,
            "createdAt":"2026-11-18T00:00:00.000Z",
            "updatedAt":"2026-11-18T00:00:00.000Z",
            "trigger":{"source":"manual"},"forceRestate":false,
            "generatedTaskIds":[]
        }]);
        Ok(job)
    }).unwrap();drop(store);
    let proposal=home.join("proposal.json");
    fs::write(&proposal,json!({
        "objective_status":"satisfied",
        "assessment":"Original Graph and SQLite evidence verified",
        "next_tasks":[],"unblocks":[]
    }).to_string()).unwrap();
    let before=SQLiteRelayStore::open_without_claim_reset(&db,Some("17")).unwrap()
        .load_job("17").unwrap().unwrap();
    let port=port();let server=daemon(&home,port);
    let invoke=|generation:&str|{
        Command::new(env!("CARGO_BIN_EXE_agents-relay-rust"))
            .args(["plan","apply","--id","17","--plan-id","plan-1",
                "--execution-id",generation,
                "--file",proposal.to_str().unwrap(),"--port",&port.to_string()])
            .output().unwrap()
    };
    let rejected=invoke("foreign-execution");
    assert!(!rejected.status.success(),
        "unowned generation cannot apply a proposed Plan");
    let unchanged=SQLiteRelayStore::open_without_claim_reset(&db,Some("17")).unwrap()
        .load_job("17").unwrap().unwrap();
    assert_eq!(unchanged["plans"],before["plans"],
        "forged generation cannot commit planner state");
    let accepted=invoke("owned-cli-plan-generation-1");
    assert!(accepted.status.success(),"{}",
        String::from_utf8_lossy(&accepted.stderr));
    let plan:serde_json::Value=serde_json::from_slice(&accepted.stdout).unwrap();
    assert_eq!(plan["status"],"SUCCEEDED","{plan}");
    assert_eq!(plan["appliedExecutionId"],"owned-cli-plan-generation-1");
    let fresh=SQLiteRelayStore::open_without_claim_reset(&db,Some("17")).unwrap();
    let committed=fresh.load_job("17").unwrap().unwrap();
    assert_eq!(committed["plans"][0],plan);
    let outbox:i64=fresh.db.query_row(
        "SELECT COUNT(*) FROM workflow_event_outbox WHERE event_key LIKE 'isolated-planner/17/planner.completed/%'",
        [],|r|r.get(0)).unwrap();
    assert_eq!(outbox,1,"Plan application must produce exactly one durable event");
    drop(fresh);
    let replay=invoke("owned-cli-plan-generation-1");
    assert!(replay.status.success(),"{}",
        String::from_utf8_lossy(&replay.stderr));
    let final_snapshot=SQLiteRelayStore::open_without_claim_reset(&db,Some("17")).unwrap()
        .load_job("17").unwrap().unwrap();
    assert_eq!(final_snapshot["plans"],committed["plans"],
        "repeating exact plan cannot mutate committed revision");
    drop(server);
    let restarted=daemon(&home,port);
    let persisted=SQLiteRelayStore::open_without_claim_reset(&db,Some("17")).unwrap()
        .load_job("17").unwrap().unwrap();
    assert_eq!(persisted["plans"],committed["plans"]);
    drop(restarted);
    fs::remove_dir_all(home).unwrap();
}
