// In-process NATS protocol E2E on an OS-assigned loopback port. No live NATS service.
use agents_relay_rust2::events::{NatsEventBus, Wake};
use serde_json::json;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn isolated_server() -> (TcpListener, String) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind disposable listener");
    let port = listener.local_addr().unwrap().port();
    (listener, format!("nats://127.0.0.1:{port}"))
}
#[test]
fn nats_ping_and_publish_use_raw_subject_and_exact_json_wire() {
    let (server, url) = isolated_server();
    let observed = Arc::new(Mutex::new(Vec::new()));
    let reader_result = Arc::clone(&observed);
    let handle = std::thread::spawn(move || {
        let (mut conn, _) = server.accept().unwrap();
        conn.set_read_timeout(Some(Duration::from_secs(4))).unwrap();
        conn.write_all(b"INFO {\"server_id\":\"test\",\"proto\":1}\r\n")
            .unwrap();
        let mut reader = BufReader::new(conn.try_clone().unwrap());
        loop {
            let mut header = String::new();
            if reader.read_line(&mut header).unwrap_or(0) == 0 {
                break;
            }
            if header.starts_with("PING") {
                conn.write_all(b"PONG\r\n").unwrap();
                break;
            }
            if header.starts_with("PUB ") {
                let len: usize = header.split_whitespace().last().unwrap().parse().unwrap();
                let mut body = vec![0; len + 2];
                reader.read_exact(&mut body).unwrap();
                reader_result.lock().unwrap().push((
                    header.trim().to_string(),
                    String::from_utf8_lossy(&body[..len]).to_string(),
                ));
            }
        }
    });
    let bus = NatsEventBus::new(Some(&url), Some("relay.events.job")).unwrap();
    let event = json!({"job_id":"123","type":"task.progress","message":"hello","status":"active"});
    bus.publish(&event).unwrap();
    bus.ping().unwrap();
    bus.close().unwrap();
    handle.join().unwrap();
    let reports = observed.lock().unwrap();
    assert_eq!(reports.len(), 1);
    assert!(reports[0]
        .0
        .starts_with("PUB relay.events.job.123.task.progress "));
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&reports[0].1).unwrap(),
        event
    );
}
#[test]
fn nats_subscription_reads_one_correlated_json_and_discards_bad_frame() {
    let (server, url) = isolated_server();
    let receiver = std::thread::spawn(move || {
        let (mut conn, _) = server.accept().unwrap();
        conn.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        conn.write_all(b"INFO {\"server_id\":\"test\"}\r\n")
            .unwrap();
        let mut reader = BufReader::new(conn.try_clone().unwrap());
        loop {
            let mut header = String::new();
            if reader.read_line(&mut header).unwrap_or(0) == 0 {
                break;
            }
            if header.starts_with("SUB ") {
                assert_eq!(header.trim(), "SUB relay.events.job.8.> 1");
                for payload in [
                    "broken json",
                    r#"{"job_id":"8","type":"task.completed","message":"okay"}"#,
                ] {
                    let frame = format!(
                        "MSG relay.events.job.8.task.completed 1 {}\r\n{}\r\n",
                        payload.len(),
                        payload
                    );
                    conn.write_all(frame.as_bytes()).unwrap();
                }
                std::thread::sleep(Duration::from_millis(100));
                break;
            }
        }
    });
    let seen = Arc::new(Mutex::new(Vec::new()));
    let callbacks = Arc::clone(&seen);
    let wake: Wake = Arc::new(move |event| {
        callbacks.lock().unwrap().push(event.clone());
        Ok(())
    });
    let bus = NatsEventBus::new(Some(&url), None).unwrap();
    let sub = bus.subscribe("8", wake).unwrap();
    receiver.join().unwrap();
    std::thread::sleep(Duration::from_millis(250));
    sub.unsubscribe();
    let events = seen.lock().unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["message"], "okay");
}
