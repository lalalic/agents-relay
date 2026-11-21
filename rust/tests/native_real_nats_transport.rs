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
