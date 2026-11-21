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
    for kind in ["task.completed\r\nSUB forged 1", "task..completed", "task.*"] {
        assert!(bus.publish(&json!({"job_id":"123","type":kind})).is_err(),
            "NATS raw PUB must reject protocol injection: {kind:?}");
    }
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

#[test]
fn nats_subscribe_all_rejects_subject_body_job_and_type_mismatch() {
    let (server, url) = isolated_server();
    let wire = std::thread::spawn(move || {
        let (mut connection, _) = server.accept().unwrap();
        connection.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        connection.write_all(b"INFO {}\r\n").unwrap();
        let mut reader = BufReader::new(connection.try_clone().unwrap());
        for _ in 0..8 {
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap_or(0) == 0 { break; }
            if line.starts_with("SUB ") {
                assert_eq!(line.trim(), "SUB relay.events.job.> 1");
                for (subject, payload) in [
                    ("relay.events.job.8.task.completed",
                        json!({"job_id":"9","type":"task.completed","message":"forged-job"})),
                    ("relay.events.job.9.task.completed",
                        json!({"job_id":"8","type":"task.completed","message":"cross-subject"})),
                    ("relay.events.job.8.task.started",
                        json!({"job_id":"8","type":"task.completed","message":"forged-type"})),
                    ("relay.events.job.8.task.completed",
                        json!({"job_id":"8","type":"task.completed","message":"valid"})),
                ] {
                    let body = payload.to_string();
                    write!(connection,"MSG {subject} 1 {}\r\n{body}\r\n",
                        body.len()).unwrap();
                }
                connection.flush().unwrap();
                std::thread::sleep(Duration::from_millis(200));
                break;
            }
        }
    });
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&seen);
    let bus = NatsEventBus::new(Some(&url), None).unwrap();
    let subscription = bus.subscribe_all(Arc::new(move |event| {
        sink.lock().unwrap().push(event.clone());
        Ok(())
    })).unwrap();
    wire.join().unwrap();
    std::thread::sleep(Duration::from_millis(250));
    subscription.unsubscribe();
    let events = seen.lock().unwrap();
    assert_eq!(events.len(), 1, "only subject/body-correlated events may wake a Job");
    assert_eq!(events[0]["message"], "valid");
}

#[test]
fn nats_refuses_unverified_auth_tls_or_malformed_info() {
    let protected = NatsEventBus::new(
        Some("nats://username:password@127.0.0.1:1/"), None).unwrap();
    assert!(protected.ping().unwrap_err().contains("plaintext credentials"));
    for (wire_info, expected) in [
        ("INFO {\"auth_required\":true}\r\n", "requires authentication"),
        ("INFO {\"tls_required\":true}\r\n", "requires TLS"),
        ("INFO invalid\r\n", "not valid JSON"),
        ("PONG\r\n", "did not present INFO"),
    ] {
        let (listener, url) = isolated_server();
        let line = wire_info.to_string();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.write_all(line.as_bytes()).unwrap();
        });
        let bus = NatsEventBus::new(Some(&url), None).unwrap();
        let result = bus.subscribe_all(Arc::new(|_| Ok(())));
        assert!(result.err().unwrap().contains(expected),
            "failed to reject unverified broker INFO: {wire_info}");
        server.join().unwrap();
    }
    let (listener, url) = isolated_server();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let _ = stream.write_all(format!("INFO {}\r\n", "x".repeat(8200)).as_bytes());
    });
    let bus = NatsEventBus::new(Some(&url), None).unwrap();
    assert!(bus.subscribe_all(Arc::new(|_| Ok(()))).err().unwrap()
        .contains("NATS INFO handshake exceeds 8192 bytes"));
    server.join().unwrap();
}
