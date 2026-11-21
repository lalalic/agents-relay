// Optional real nats-server loopback E2E. Tests own and terminate the broker;
// never connect to the operator's event bus, stores or live worker accounts.
use agents_relay_rust2::events::NatsEventBus;
use serde_json::json;
use std::{
    io::{BufRead, BufReader, Write},
    net::{TcpListener, TcpStream},
    process::{Child, Command, Stdio},
    sync::{mpsc, Arc},
    thread,
    time::{Duration, Instant},
};

struct OwnedBroker(Child);
impl Drop for OwnedBroker {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

const FIXTURE_TOKEN: &str = "rust2-isolated-auth-test-token-20261121";

fn launch_broker_with_token(port: u16) -> OwnedBroker {
    let child = Command::new("nats-server")
        .args(["-a", "127.0.0.1", "-p", &port.to_string(),
            "-auth", FIXTURE_TOKEN])
        .stdout(Stdio::null()).stderr(Stdio::null())
        .spawn().expect("launch test-owned authenticated nats-server");
    OwnedBroker(child)
}

fn launch_broker(port: u16) -> OwnedBroker {
    let child = Command::new("nats-server")
        .args(["-a", "127.0.0.1", "-p", &port.to_string()])
        .stdout(Stdio::null()).stderr(Stdio::null())
        .spawn().expect("launch test-owned nats-server");
    OwnedBroker(child)
}

#[test]
fn real_nats_server_subject_body_identity_is_enforced_before_callback() {
    if Command::new("nats-server").arg("-v").output().is_err() {
        eprintln!("SKIP: optional nats-server executable not installed");
        return;
    }
    let ephemeral = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = ephemeral.local_addr().unwrap().port();
    drop(ephemeral);
    let _owned = launch_broker(port);
    let url = format!("nats://127.0.0.1:{port}");
    let bus = NatsEventBus::new(Some(&url), None).unwrap();
    let start = Instant::now();
    loop {
        if bus.ping().is_ok() { break; }
        assert!(start.elapsed() < Duration::from_secs(5), "isolated NATS did not start");
        thread::sleep(Duration::from_millis(30));
    }
    let (sender, receiver) = mpsc::channel();
    let subscription = bus.subscribe("42", Arc::new(move |event| {
        sender.send(event.clone()).map_err(|error|error.to_string())
    })).unwrap();
    thread::sleep(Duration::from_millis(100));

    bus.publish(&json!({"job_id":"42","type":"task.started","message":"valid"})).unwrap();
    let good = receiver.recv_timeout(Duration::from_secs(3)).expect("real broker did not deliver valid event");
    assert_eq!(good["message"], "valid");

    // A publisher permitted on Job 42's subject cannot retarget the body
    // into Job 43, even if a consumer uses the wider subscribe_all selector.
    let mut raw = TcpStream::connect(("127.0.0.1", port)).unwrap();
    raw.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    let mut info = String::new();
    BufReader::new(raw.try_clone().unwrap()).read_line(&mut info).unwrap();
    assert!(info.starts_with("INFO "), "{info}");
    raw.write_all(b"CONNECT {\"verbose\":false}\r\n").unwrap();
    let forged = json!({"job_id":"43","type":"task.started","message":"forged"}).to_string();
    write!(raw,"PUB relay.events.job.42.task.started {}\r\n{}\r\n",forged.len(),forged).unwrap();
    raw.flush().unwrap();
    assert!(receiver.recv_timeout(Duration::from_millis(400)).is_err(),
        "cross-Job forged event reached Graph/SQLite callback");
    subscription.unsubscribe();
    bus.close().unwrap();
}

#[test]
fn real_nats_broker_restart_recovers_on_next_operation_without_replaying_pub() {
    if Command::new("nats-server").arg("-v").output().is_err() {
        eprintln!("SKIP: optional nats-server executable not installed");
        return;
    }
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let first = launch_broker(port);
    let url = format!("nats://127.0.0.1:{port}");
    let bus = NatsEventBus::new(Some(&url), None).unwrap();
    let before = Instant::now();
    while bus.ping().is_err() {
        assert!(before.elapsed() < Duration::from_secs(5));
        thread::sleep(Duration::from_millis(40));
    }
    drop(first);
    // A closed broker socket is not an accepted delivery. The failed read
    // resets only this client's stale transport; it never resends a PUB.
    assert!(bus.ping().is_err(), "stopped NATS broker cannot acknowledge PING");
    let second = launch_broker(port);
    let restart = Instant::now();
    loop {
        if bus.ping().is_ok() { break; }
        assert!(restart.elapsed() < Duration::from_secs(5),
            "native client retained a stale NATS connection after broker restart");
        thread::sleep(Duration::from_millis(40));
    }
    bus.close().unwrap();
    drop(second);
}

#[test]
fn real_nats_through_installed_daemon_commits_only_subject_verified_graph_events() {
    real_nats_graph_sqlite_case(false);
}
#[test]
fn authenticated_nats_through_installed_daemon_commits_only_subject_verified_graph_events() {
    real_nats_graph_sqlite_case(true);
}

fn real_nats_graph_sqlite_case(authenticated: bool) {
    use agents_relay_rust2::{
        events::{event_for, NatsEventBus},
        execution_event_identity::execution_event_source,
        relay_store::SQLiteRelayStore,
        relay_store_discovery::relay_unified_store_path,
    };
    use std::{fs, path::Path, time::{SystemTime, UNIX_EPOCH}};
    if Command::new("nats-server").arg("-v").output().is_err() {
        eprintln!("SKIP: optional nats-server executable not installed");
        return;
    }
    let directory = std::env::temp_dir().join(format!(
        "rust2-real-nats-graph-{}-{}",
        std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH)
            .unwrap().as_nanos()
    ));
    struct OwnedFixture(std::path::PathBuf);
    impl Drop for OwnedFixture {
        fn drop(&mut self) { let _=fs::remove_dir_all(&self.0); }
    }
    let _fixture=OwnedFixture(directory.clone());
    fs::create_dir_all(directory.join("stores")).unwrap();
    let project=directory.join("fixture");
    fs::create_dir_all(&project).unwrap();
    assert!(Command::new("git").args(["init","-q","-b","main"])
        .current_dir(&project).status().unwrap().success());
    let db=relay_unified_store_path(&directory.join("stores"));
    let store=SQLiteRelayStore::open(&db,Some("17")).unwrap();
    let execution="real-nats-graph-execution-17-2";
    store.save_job(&json!({
        "id":"17","repository":"fixture","projectRoot":project,
        "title":"Test-owned NATS Graph/SQLite","objective":"isolated ingress",
        "state":"ACTIVE","prNumber":0,"autoMerge":false,
        "reviewEnabled":false,"createdAt":"2026-11-20T00:00:00.000Z",
        "updatedAt":"2026-11-20T00:00:00.000Z",
        "tasks":[{
            "id":"2","jobId":"17","kind":"work","agentName":"implementation",
            "adapter":"chatgpt","state":"QUEUED","attempt":1,
            "maxAttempts":3,"dependencies":[],
            "executionId":execution,"leaseOwner":"owned-model-worker",
            "leaseExpiresAt":"2027-11-21T23:59:59.000Z",
            "createdAt":"2026-11-20T00:00:00.000Z",
            "updatedAt":"2026-11-20T00:00:00.000Z"
        }],"plans":[]
    })).unwrap();
    store.close().unwrap();
    let free_port=||{
        TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
    };
    let nats_port=free_port();
    let mut broker=Some(if authenticated { launch_broker_with_token(nats_port) }
        else { launch_broker(nats_port) });
    let nats=format!("nats://127.0.0.1:{nats_port}/");
    let publisher=NatsEventBus::with_loopback_token(
        Some(&nats),None,authenticated.then_some(FIXTURE_TOKEN)).unwrap();
    let start=Instant::now();
    while publisher.ping().is_err(){
        assert!(start.elapsed()<Duration::from_secs(5),"real local NATS startup");
        thread::sleep(Duration::from_millis(30));
    }

    struct NativeDaemon(Child);
    impl Drop for NativeDaemon{
        fn drop(&mut self){
            let _=self.0.kill();let _=self.0.wait();
        }
    }
    let port=free_port();
    let token_file=directory.join("stores").join("nats.token");
    if authenticated {
        fs::write(&token_file,FIXTURE_TOKEN).unwrap();
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&token_file,fs::Permissions::from_mode(0o600)).unwrap();
        }
    }
    let mut native=Command::new(env!("CARGO_BIN_EXE_agents-relayd-rust"));
    // The authenticated branch uses a 5-minute watchdog interval. Only a
    // real NATS callback wake can deliver start/terminal within the fixture
    // deadline; a fast timer cannot mask missing push notification.
    let interval=if authenticated{"300000"}else{"100"};
    native.args(["--isolated-write-store-dir",directory.join("stores").to_str().unwrap(),
            "--port",&port.to_string(),"--interval",interval,
            "--isolated-nats-url",&nats,"--trust-isolated-model-events"]);
    if authenticated {
        native.args(["--isolated-nats-token-file",token_file.to_str().unwrap()]);
    }
    let daemon=native
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .stdout(Stdio::null())
        .stderr(Stdio::from(fs::File::create(directory.join("daemon.log")).unwrap()))
        .spawn().unwrap();
    let mut daemon=NativeDaemon(daemon);
    // macOS native binary loading can lag while all-target Rust regression
    // compiles in parallel; readiness is distinct from Graph/event delivery.
    let until=Instant::now()+Duration::from_secs(35);
    loop{
        if let Ok(mut socket)=TcpStream::connect(("127.0.0.1",port)){
            socket.set_read_timeout(Some(Duration::from_millis(300))).unwrap();
            socket.write_all(b"GET /api/status HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n").unwrap();
            let mut response=String::new();
            let _=std::io::Read::read_to_string(&mut socket,&mut response);
            if response.starts_with("HTTP/1.1 200"){break;}
        }
        assert!(daemon.0.try_wait().unwrap().is_none(),
            "native daemon exited before test ingress: {}",
            fs::read_to_string(directory.join("daemon.log")).unwrap_or_default());
        assert!(Instant::now()<until,
            "native daemon never became ready: {}",
            fs::read_to_string(directory.join("daemon.log")).unwrap_or_default());
        thread::sleep(Duration::from_millis(35));
    }
    thread::sleep(Duration::from_millis(100));

    let source=json!({"id":execution_event_source("17","2",execution),
        "agent":"fixture","component":"agents-relay"});
    let forged=event_for("17","2",None,"task.started","started",
        "cross-job subject forged",None,None,Some(source.clone()));
    let mut raw=TcpStream::connect(("127.0.0.1",nats_port)).unwrap();
    raw.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    let mut info=String::new();
    BufReader::new(raw.try_clone().unwrap()).read_line(&mut info).unwrap();
    assert!(info.starts_with("INFO "));
    if authenticated {
        raw.write_all(format!("CONNECT {}\r\nPING\r\n",
            json!({"verbose":false,"auth_token":FIXTURE_TOKEN})).as_bytes()).unwrap();
        let mut pong=String::new();
        BufReader::new(raw.try_clone().unwrap()).read_line(&mut pong).unwrap();
        assert_eq!(pong,"PONG\r\n","fake publisher must authenticate with test-owned NATS");
    }else{
        raw.write_all(b"CONNECT {\"verbose\":false}\r\n").unwrap();
    }
    let forged_body=forged.to_string();
    write!(raw,"PUB relay.events.job.99.task.started {}\r\n{forged_body}\r\n",
        forged_body.len()).unwrap();
    raw.flush().unwrap();
    thread::sleep(Duration::from_millis(220));
    let before=SQLiteRelayStore::open_without_claim_reset(&db,Some("17")).unwrap();
    let snapshot=before.load_job("17").unwrap().unwrap();
    assert_eq!(snapshot["tasks"][0]["state"],"QUEUED",
        "real NATS forged subject may not start another Job");
    drop(before);

    let start_event=event_for("17","2",None,"task.started","started",
        "real NATS worker started",None,None,Some(source.clone()));
    let terminal=event_for("17","2",None,"task.completed","completed",
        "real NATS worker finished",None,None,Some(source));
    publisher.publish(&start_event).unwrap();
    // NATS is asynchronous; wait until durable Graph/SQLite start before
    // delivering a terminal. A publish socket ACK is not a worker-start ACK.
    let deadline=Instant::now()+Duration::from_secs(12);
    loop {
        let store=SQLiteRelayStore::open_without_claim_reset(&db,Some("17")).unwrap();
        let current=store.load_job("17").unwrap().unwrap();
        if current["tasks"][0]["state"]=="RUNNING"{break;}
        assert!(Instant::now()<deadline,
            "real NATS Worker start not committed to SQLite: {current}");
        thread::sleep(Duration::from_millis(30));
    }
    if authenticated {
        // Restart the ACTUAL authenticated broker after a committed start.
        // The model event reader must detect EOF and re-authenticate
        // independently of a 300000ms watchdog tick. The same execution
        // continues; no second start or fabricated terminal is allowed.
        drop(broker.take());
        thread::sleep(Duration::from_millis(250));
        broker=Some(launch_broker_with_token(nats_port));
        let restarted=Instant::now();
        loop {
            if publisher.ping().is_ok(){break;}
            assert!(restarted.elapsed()<Duration::from_secs(6),
                "authenticated NATS publisher could not reconnect");
            thread::sleep(Duration::from_millis(50));
        }
        // Subscription discovery is asynchronous. Give the host's bounded
        // reconnect cycle one full interval before publishing the terminal.
        thread::sleep(Duration::from_millis(1450));
    }
    publisher.publish(&terminal).unwrap();
    let deadline=Instant::now()+Duration::from_secs(12);
    loop {
        let store=SQLiteRelayStore::open_without_claim_reset(&db,Some("17")).unwrap();
        let current=store.load_job("17").unwrap().unwrap();
        if current["tasks"][0]["state"]=="SUCCEEDED"{
            let event_count:i64=store.db.query_row(
                "SELECT COUNT(*) FROM workflow_event_outbox WHERE event_key LIKE 'model-event/17/2/%'",
                [],|row|row.get(0)).unwrap();
            assert_eq!(event_count,2,
                "forged cross-subject event must not produce a Graph/SQLite receipt");
            assert!(current["tasks"][0]["executionId"].is_null());
            break;
        }
        assert!(Instant::now()<deadline,
            "real NATS Worker completion not committed to SQLite: {current}");
        thread::sleep(Duration::from_millis(35));
    }
    publisher.close().unwrap();
    drop(daemon);
    drop(broker);
}

#[test]
fn authenticated_broker_rejects_wrong_token_and_unbound_urls_without_leaking_secret() {
    if Command::new("nats-server").arg("-v").output().is_err() {
        eprintln!("SKIP: optional nats-server executable not installed");
        return;
    }
    let port=TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let _broker=launch_broker_with_token(port);
    let url=format!("nats://127.0.0.1:{port}/");
    let trusted=NatsEventBus::with_loopback_token(
        Some(&url),None,Some(FIXTURE_TOKEN)).unwrap();
    let start=Instant::now();
    while trusted.ping().is_err(){
        assert!(start.elapsed()<Duration::from_secs(5),"authenticated broker startup");
        thread::sleep(Duration::from_millis(30));
    }
    let missing=NatsEventBus::new(Some(&url),None).unwrap();
    let no_auth=missing.ping().unwrap_err();
    assert!(no_auth.contains("requires authentication"));
    let wrong=NatsEventBus::with_loopback_token(
        Some(&url),None,Some("bad-test-token")).unwrap();
    let denied=wrong.ping().unwrap_err();
    assert!(!denied.contains("bad-test-token"));
    assert!(!denied.contains(FIXTURE_TOKEN));
    assert!(NatsEventBus::with_loopback_token(
        None,None,Some(FIXTURE_TOKEN)).is_err());
    for input in ["nats://test.example:4222/","nats://user:pass@127.0.0.1:4222/"]{
        assert!(NatsEventBus::with_loopback_token(
            Some(input),None,Some(FIXTURE_TOKEN)).is_err());
    }
    for secret in ["","bad\nsecret","bad secret"] {
        assert!(NatsEventBus::with_loopback_token(
            Some(&url),None,Some(secret)).is_err());
    }
    trusted.close().unwrap();
}

#[cfg(unix)]
#[test]
fn isolated_daemon_rejects_insecure_nats_token_files_before_opening_broker() {
    use std::{fs, os::unix::fs::{symlink,PermissionsExt}, time::{SystemTime,UNIX_EPOCH}};
    let fixture=std::env::temp_dir().join(format!("rust2-nats-token-fence-{}-{}",
        std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH)
            .unwrap().as_nanos()));
    struct Cleanup(std::path::PathBuf);
    impl Drop for Cleanup{
        fn drop(&mut self){let _=std::fs::remove_dir_all(&self.0);}
    }
    let _cleanup=Cleanup(fixture.clone());
    let store=fixture.join("stores");
    fs::create_dir_all(&store).unwrap();
    let secret_path=store.join("token");
    fs::write(&secret_path,FIXTURE_TOKEN).unwrap();
    fs::set_permissions(&secret_path,fs::Permissions::from_mode(0o600)).unwrap();
    let outside=fixture.join("outside-token");
    fs::write(&outside,FIXTURE_TOKEN).unwrap();
    fs::set_permissions(&outside,fs::Permissions::from_mode(0o600)).unwrap();
    let linked=store.join("symlink-token");
    symlink(&secret_path,&linked).unwrap();
    let invoke=|token_path:&std::path::Path, expected:&str|{
        let output=Command::new(env!("CARGO_BIN_EXE_agents-relayd-rust"))
            .args(["--isolated-write-store-dir",store.to_str().unwrap(),
                "--isolated-nats-url","nats://127.0.0.1:65511/",
                "--trust-isolated-model-events","--isolated-nats-token-file",
                token_path.to_str().unwrap()])
            .current_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
            .output().unwrap();
        assert!(!output.status.success(),"invalid token file must not launch daemon");
        let error=String::from_utf8_lossy(&output.stderr);
        assert!(error.contains(expected),"{error}");
        assert!(!error.contains(FIXTURE_TOKEN),"token must not be leaked to stderr");
    };
    invoke(&outside,"inside its caller-owned store");
    invoke(&linked,"non-symlink");
    fs::set_permissions(&secret_path,fs::Permissions::from_mode(0o644)).unwrap();
    invoke(&secret_path,"0600");
    fs::set_permissions(&secret_path,fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(&secret_path,format!("{FIXTURE_TOKEN}\n")).unwrap();
    invoke(&secret_path,"invalid length or characters");
}
