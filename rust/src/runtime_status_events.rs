// Direct port of Node src/runtime-status-events.ts: process-local status transition detector, with no durable status writes or polling.
use crate::runtime_status::derive_job_runtime_status;
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{json, Map, Value};
use std::{
    collections::HashMap,
    fs::File,
    io::Read,
    sync::atomic::{AtomicU64, Ordering},
    time::SystemTime,
};

static FALLBACK_UUID_COUNTER: AtomicU64 = AtomicU64::new(0);
fn uuid_v4() -> String {
    let mut bytes = [0u8; 16];
    if File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut bytes))
        .is_err()
    {
        let time = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        bytes.copy_from_slice(&time.to_be_bytes());
        let seed = FALLBACK_UUID_COUNTER
            .fetch_add(1, Ordering::Relaxed)
            .to_be_bytes();
        for (item, extra) in bytes[8..].iter_mut().zip(seed) {
            *item ^= extra;
        }
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!("{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],bytes[1],bytes[2],bytes[3],bytes[4],bytes[5],bytes[6],bytes[7],bytes[8],bytes[9],bytes[10],bytes[11],bytes[12],bytes[13],bytes[14],bytes[15])
}
fn js_id(object: &Value, key: &str) -> String {
    object
        .get(key)
        .map(|value| match value {
            Value::String(s) => s.clone(),
            Value::Null => "null".into(),
            _ => value.to_string(),
        })
        .unwrap_or_else(|| "undefined".into())
}

/// Callback is an EventBus.publish equivalent; a rejected callback is logged
/// but never mutates the authoritative Job, matching Node's fire-and-forget.
pub struct RuntimeStatusPublisher<F: FnMut(Value) -> Result<(), String>> {
    previous: HashMap<String, String>,
    publish_event: F,
}
impl<F: FnMut(Value) -> Result<(), String>> RuntimeStatusPublisher<F> {
    pub fn publish(&mut self, job: &Value) {
        let repository = js_id(job, "repository");
        let id = js_id(job, "id");
        let key = format!("{repository}\0{id}");
        let to = derive_job_runtime_status(job, "OPEN").to_owned();
        let old = self.previous.insert(key, to.clone());
        let Some(from) = old else { return };
        if from == to {
            return;
        }
        let mut data = Map::new();
        data.insert("from".into(), json!(from));
        data.insert("to".into(), json!(to));
        data.insert("repository".into(), json!(repository));
        if let Some(state) = job.get("state") {
            data.insert("jobState".into(), state.clone());
        }
        if let Some(updated_at) = job.get("updatedAt") {
            data.insert("updatedAt".into(), updated_at.clone());
        }
        let timestamp =
            DateTime::<Utc>::from(SystemTime::now()).to_rfc3339_opts(SecondsFormat::Millis, true);
        let event = json!({
            "version":1,"event_id":uuid_v4(),"job_id":id,"task_id":"","parent_task_id":null,
            "type":"job.runtime_status.changed","status":"info","timestamp":timestamp,
            "visibility":"orchestrator","level":"info", "message":format!("{from} → {to}"),
            "data":Value::Object(data),"source":{"agent":"relay","component":"runtime-status"}
        });
        if let Err(error) = (self.publish_event)(event) {
            eprintln!("runtime status change publish failed {id}: {error}");
        }
    }
}
pub fn create_runtime_status_publisher<F: FnMut(Value) -> Result<(), String>>(
    publish_event: F,
) -> RuntimeStatusPublisher<F> {
    RuntimeStatusPublisher {
        previous: HashMap::new(),
        publish_event,
    }
}
