// Native Rust regressions for Node src/events-bus-runtime.ts: isolated runtime.json, exact cursor ordering and real localhost HTTP (no production Events Bus).
use agents_relay_rust2::events_bus_runtime::{
    events_bus_config_path, events_bus_history, events_bus_history_page, resolve_events_bus_runtime,
};
use serde_json::json;
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
fn temp() -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let unique = NEXT.fetch_add(1, Ordering::Relaxed);
    let id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "rust2-events-native-{}-{id}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(&path).unwrap();
    path
}
fn server(payload: String) -> (String, thread::JoinHandle<String>) {
    let socket = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("http://{}", socket.local_addr().unwrap());
    let worker = thread::spawn(move || {
        let (mut stream, _) = socket.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut data = [0u8; 4096];
        let len = stream.read(&mut data).unwrap();
        let request = String::from_utf8_lossy(&data[..len]).into_owned();
        let answer=format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{payload}",payload.len());
        stream.write_all(answer.as_bytes()).unwrap();
        request
    });
    (address, worker)
}
#[test]
fn saved_configuration_overrides_defaults_and_legacy_subject_requires_explicit_cutover() {
    let dir = temp();
    let path = dir.join("runtime.json");
    fs::write(&path,r#"{"natsUrl":"nats://localhost:5222","apiUrl":"http://localhost:5223","subjectPrefix":"neo.events.job"}"#).unwrap();
    let env = json!({"EVENTS_BUS_CONFIG":path});
    assert!(resolve_events_bus_runtime(&env)
        .unwrap_err()
        .contains("coordinate migration"));
    let env = json!({"EVENTS_BUS_CONFIG":path,"EVENTS_BUS_SUBJECT_PREFIX":"relay.events.job"});
    let runtime = resolve_events_bus_runtime(&env).unwrap();
    assert_eq!(runtime["natsUrl"], "nats://localhost:5222");
    assert_eq!(runtime["apiUrl"], "http://localhost:5223");
    assert_eq!(runtime["subjectPrefix"], "relay.events.job");
    assert_eq!(events_bus_config_path(&env), path.to_str().unwrap());
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn malformed_config_fails_closed_instead_of_using_default_namespace() {
    let dir = temp();
    let file = dir.join("runtime.json");
    for content in ["[]", "null", "{corrupt", "{"] {
        fs::write(&file, content).unwrap();
        let err = resolve_events_bus_runtime(&json!({"EVENTS_BUS_CONFIG":file})).unwrap_err();
        assert!(err.starts_with(&format!(
            "Invalid Events Bus runtime config at {}",
            file.display()
        )));
    }
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn real_http_ascending_page_enforces_request_query_and_cursor_watermark() {
    let dir = temp();
    let config = dir.join("missing.json");
    let row = json!({"job_id":"j","order":"asc","events":[
        {"cursor":7,"event":{"event_id":"e7","job_id":"j","task_id":"t"}},
        {"cursor":8,"event":{"event_id":"e8","job_id":"j","task_id":"t"}}],"next_cursor":8});
    let (api, worker) = server(row.to_string());
    let runtime = json!({"EVENTS_BUS_CONFIG":config,"EVENTS_BUS_API_URL":api});
    let page = events_bus_history_page(
        "j",
        Some("t"),
        &json!(30),
        &json!({"order":"asc","after":6}),
        &runtime,
    )
    .unwrap();
    assert_eq!(page["nextCursor"], 8);
    assert_eq!(page["events"][0]["event_id"], "e7");
    assert_eq!(page["rows"][1]["cursor"], 8);
    let request = worker.join().unwrap();
    assert!(
        request.contains("GET /events?filter=") && request.contains("&limit=30&order=asc&after=6 HTTP/1.1"),
        "{request}"
    );
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn cross_task_events_are_rejected_after_real_http_response() {
    let dir = temp();
    let config = dir.join("missing.json");
    let row = json!({"job_id":"j","order":"desc","events":[
        {"cursor":3,"event":{"event_id":"e3","job_id":"j","task_id":"wrong"}}],"next_cursor":3});
    let (api, worker) = server(row.to_string());
    let runtime = json!({"EVENTS_BUS_CONFIG":config,"EVENTS_BUS_API_URL":api});
    let error = events_bus_history("j", Some("t"), &json!(20), &runtime).unwrap_err();
    assert_eq!(
        error,
        "events-bus history returned invalid, out-of-order, or cross-Task event data"
    );
    worker.join().unwrap();
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn invalid_page_limit_and_descending_cursor_reject_without_network() {
    let dir = temp();
    let env =
        json!({"EVENTS_BUS_CONFIG":dir.join("absent"),"EVENTS_BUS_API_URL":"http://127.0.0.1:3"});
    assert_eq!(
        events_bus_history_page("j", None, &json!(0), &json!({}), &env).unwrap_err(),
        "Invalid event history page limit"
    );
    assert_eq!(
        events_bus_history_page(
            "j",
            None,
            &json!(10),
            &json!({"after":7,"order":"desc"}),
            &env
        )
        .unwrap_err(),
        "Event history cursor requires ascending order"
    );
    assert_eq!(
        events_bus_history_page("j", None, &json!(10), &json!({"timeoutMs":0}), &env).unwrap_err(),
        "Invalid event history timeout"
    );
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn malformed_same_scope_event_does_not_block_later_valid_history(){
    let dir=temp();
    let (api,worker)=server(json!({"order":"asc","next_cursor":8,"events":[
        {"cursor":7,"event":{"source":{"id":"job/j/task/t"},"type":"task.started","data":{}}},
        {"cursor":8,"event":{"source":{"id":"job/j/task/t/execution/lease"},"type":"task.started","data":{}}}
    ]}).to_string());
    let page=events_bus_history_page("j",None,&json!(60),&json!({"order":"asc","after":6}),
        &json!({"EVENTS_BUS_CONFIG":dir.join("absent"),"EVENTS_BUS_API_URL":api})).unwrap();
    assert!(page["rows"][0]["event"].is_null());
    assert_eq!(page["events"].as_array().unwrap().len(),1);
    assert_eq!(page["events"][0]["task_id"],"t");
    assert_eq!(page["nextCursor"],8);
    worker.join().unwrap();
    fs::remove_dir_all(dir).unwrap();
}
