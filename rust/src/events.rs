// Direct Node src/events.ts port: in-process fan-out plus NATS wire-protocol event bus.
// Event delivery wakes an observer; SQLite remains the sole durable lifecycle authority.
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpStream, ToSocketAddrs},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime},
};

pub type Wake = Arc<dyn Fn(&Value) -> Result<(), String> + Send + Sync>;
pub const DEFAULT_NATS_URL: &str = "nats://127.0.0.1:4222";
pub const DEFAULT_NATS_SUBJECT_PREFIX: &str = "relay.events.job";
fn now() -> String {
    DateTime::<Utc>::from(SystemTime::now()).to_rfc3339_opts(SecondsFormat::Millis, true)
}
pub(crate) fn random_uuid() -> String {
    let mut bits = [0u8; 16];
    if let Ok(mut device) = std::fs::File::open("/dev/urandom") {
        let _ = device.read_exact(&mut bits);
    }
    bits[6] = (bits[6] & 0x0f) | 0x40;
    bits[8] = (bits[8] & 0x3f) | 0x80;
    let digits: Vec<String> = bits.iter().map(|n| format!("{n:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        digits[..4].join(""),
        digits[4..6].join(""),
        digits[6..8].join(""),
        digits[8..10].join(""),
        digits[10..].join("")
    )
}
pub fn subject_token(value: &str) -> Result<&str, String> {
    if !value.is_empty()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        Ok(value)
    } else {
        Err(format!("Unsafe event subject token: {value}"))
    }
}
pub fn subject_prefix(value: &str) -> Result<&str, String> {
    if !value.is_empty()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        Ok(value)
    } else {
        Err(format!("Unsafe event subject prefix: {value}"))
    }
}
// NATS protocol subject levels must be nonempty plain tokens. In particular,
// never put an untrusted event type with a newline into a raw PUB frame.
fn event_kind_subject(value: &str) -> Result<&str, String> {
    if !value.is_empty() && value.split('.').all(|part| subject_token(part).is_ok()) {
        Ok(value)
    } else {
        Err("Unsafe event type for NATS subject".into())
    }
}
// Node eventFor has nine positional arguments.
// Preserve all Node eventFor arguments including optional data and source.
#[allow(clippy::too_many_arguments)]
pub fn event_for(
    job_id: &str,
    task_id: &str,
    parent_task_id: Option<&str>,
    kind: &str,
    status: &str,
    message: &str,
    visibility: Option<&str>,
    data: Option<Value>,
    source: Option<Value>,
) -> Value {
    let mut result = json!({"version":1,"event_id":random_uuid(),"job_id":job_id,"task_id":task_id,"parent_task_id":parent_task_id,"type":kind,"status":status,"timestamp":now(),"visibility":visibility.unwrap_or("orchestrator"),"level":if status=="blocked"||status=="failed"{"error"}else{"info"},"message":message});
    if let Some(data) = data {
        result["data"] = data;
    }
    if let Some(source) = source {
        result["source"] = source;
    }
    result
}
#[derive(Default, Clone)]
pub struct MemoryEventBus {
    inner: Arc<Mutex<MemoryInner>>,
}
#[derive(Default)]
struct MemoryInner {
    handlers: HashMap<String, BTreeMap<usize, Wake>>,
    next: usize,
}
impl MemoryEventBus {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn publish(&self, event: &Value) -> Result<(), String> {
        let id = event["job_id"].as_str().unwrap_or("undefined");
        let handlers = {
            let guard = self.inner.lock().map_err(|e| e.to_string())?;
            let mut all = vec![];
            if let Some(subs) = guard.handlers.get(id) {
                all.extend(subs.values().cloned());
            }
            if let Some(subs) = guard.handlers.get("*") {
                all.extend(subs.values().cloned());
            }
            all
        };
        for wake in handlers {
            wake(event)?;
        }
        Ok(())
    }
    pub fn subscribe(&self, job_id: &str, wake: Wake) -> impl FnOnce() + Send + use<> {
        let mut guard = self.inner.lock().expect("memory event handlers mutex");
        let id = guard.next;
        guard.next += 1;
        guard
            .handlers
            .entry(job_id.into())
            .or_default()
            .insert(id, wake);
        let group = job_id.to_string();
        let inner = Arc::clone(&self.inner);
        move || {
            if let Ok(mut guard) = inner.lock() {
                if let Some(set) = guard.handlers.get_mut(&group) {
                    set.remove(&id);
                }
            }
        }
    }
    pub fn subscribe_all(&self, wake: Wake) -> impl FnOnce() + Send + use<> {
        self.subscribe("*", wake)
    }
}

pub struct NatsEventBus {
    url: String,
    prefix: String,
    connection: Mutex<Option<TcpStream>>,
}
pub struct NatsSubscription {
    active: Arc<AtomicBool>,
    socket: Arc<Mutex<TcpStream>>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl NatsSubscription {
    /// A TCP subscription is not necessarily alive merely because its owner
    /// still holds the handle. The reader exits on EOF / network errors;
    /// daemon callers must reconnect and re-subscribe instead of silently
    /// keeping a dead subscription forever.
    pub fn is_alive(&self) -> bool {
        self.active.load(Ordering::Acquire)
            && self.worker.as_ref().is_some_and(|worker| !worker.is_finished())
    }
    pub fn unsubscribe(mut self) {
        self.active.store(false, Ordering::SeqCst);
        if let Ok(mut stream) = self.socket.lock() {
            let _ = stream.write_all(b"UNSUB 1\r\n");
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
impl Drop for NatsSubscription {
    fn drop(&mut self) {
        self.active.store(false, Ordering::SeqCst);
        if let Ok(mut stream) = self.socket.lock() {
            let _ = stream.write_all(b"UNSUB 1\r\n");
        } /* Detached if caller drops; socket timeout exits reader */
    }
}
impl NatsEventBus {
    pub fn new(url: Option<&str>, prefix: Option<&str>) -> Result<Self, String> {
        let prefix = prefix.unwrap_or(DEFAULT_NATS_SUBJECT_PREFIX);
        subject_prefix(prefix)?;
        Ok(Self {
            url: url.unwrap_or(DEFAULT_NATS_URL).into(),
            prefix: prefix.into(),
            connection: Mutex::new(None),
        })
    }
    fn connect(&self) -> Result<TcpStream, String> {
        let url = url::Url::parse(&self.url).map_err(|e| e.to_string())?;
        if url.scheme() != "nats" {
            return Err(format!("unsupported NATS URL scheme: {}", url.scheme()));
        }
        // The native TCP transport has no TLS/SASL/NKey authenticator.
        // Never silently ignore credentials embedded in the server URL.
        if !url.username().is_empty() || url.password().is_some() {
            return Err("Authenticated NATS transport is not bound; refusing plaintext credentials".into());
        }
        let host = url.host_str().ok_or("NATS host is missing")?;
        let port = url.port().unwrap_or(4222);
        let addresses = (host, port).to_socket_addrs().map_err(|e| e.to_string())?;
        let mut last_error = None;
        for address in addresses {
            match TcpStream::connect_timeout(&address, Duration::from_secs(1)) {
                Ok(mut stream) => {
                    stream
                        .set_read_timeout(Some(Duration::from_secs(1)))
                        .map_err(|e| e.to_string())?;
                    stream
                        .set_write_timeout(Some(Duration::from_secs(1)))
                        .map_err(|e| e.to_string())?;
                    // A TCP connect is not a verified NATS session. Read
                    // the broker INFO before emitting CONNECT/SUB/PUB. A
                    // broker demanding authentication or TLS must fail closed
                    // until the production transport has those capabilities.
                    let mut info_line = Vec::new();
                    // Read exactly one bounded INFO line. BufReader may read
                    // ahead and discard the next NATS frame when dropped.
                    // An untrusted broker also must not force unbounded
                    // allocation by withholding CRLF.
                    for _ in 0..8192 {
                        let mut byte = [0u8; 1];
                        stream.read_exact(&mut byte).map_err(|e| e.to_string())?;
                        info_line.push(byte[0]);
                        if info_line.ends_with(b"\r\n") { break; }
                    }
                    if !info_line.ends_with(b"\r\n") {
                        return Err("NATS INFO handshake exceeds 8192 bytes".into());
                    }
                    let line = std::str::from_utf8(&info_line)
                        .map_err(|_|"NATS INFO handshake is not UTF-8")?;
                    let info = line.trim_end().strip_prefix("INFO ")
                        .ok_or("NATS server did not present INFO handshake")?;
                    let capabilities: Value = serde_json::from_str(info)
                        .map_err(|_|"NATS INFO handshake is not valid JSON")?;
                    if !capabilities.is_object() {
                        return Err("NATS INFO handshake must be an object".into());
                    }
                    if capabilities["auth_required"] == true {
                        return Err("NATS broker requires authentication not provided by native transport".into());
                    }
                    if capabilities["tls_required"] == true {
                        return Err("NATS broker requires TLS not provided by native transport".into());
                    }
                    let mut output = stream.try_clone().map_err(|e| e.to_string())?;
                    output
                        .write_all(b"CONNECT {\"verbose\":false,\"pedantic\":false}\r\n")
                        .map_err(|e| e.to_string())?;
                    return Ok(stream);
                }
                Err(e) => last_error = Some(e.to_string()),
            }
        }
        Err(last_error.unwrap_or_else(|| "NATS has no addresses".into()))
    }
    fn with_client<T>(
        &self,
        f: impl FnOnce(&mut TcpStream) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut client = self.connection.lock().map_err(|e| e.to_string())?;
        if client.is_none() {
            *client = Some(self.connect()?);
        }
        let result = f(client.as_mut().expect("connected"));
        // NATS reconnections belong to the next independent operation.
        // A failed PUB is delivery-uncertain and MUST NOT be replayed here.
        // Dropping the broken TCP connection permits later operations to
        // reconnect without treating a transport failure as an event ack.
        if result.is_err() {
            *client = None;
        }
        result
    }
    pub fn ping(&self) -> Result<(), String> {
        self.with_client(|stream| {
            stream.write_all(b"PING\r\n").map_err(|e| e.to_string())?;
            let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
            for _ in 0..10 {
                let mut line = String::new();
                reader.read_line(&mut line).map_err(|e| e.to_string())?;
                if line.starts_with("PONG") {
                    return Ok(());
                }
                if line.starts_with("PING") {
                    stream.write_all(b"PONG\r\n").map_err(|e| e.to_string())?;
                }
            }
            Err("NATS PONG timeout".into())
        })
    }
    pub fn publish(&self, event: &Value) -> Result<(), String> {
        let job = subject_token(event["job_id"].as_str().unwrap_or("undefined"))?;
        let kind = event_kind_subject(event["type"].as_str().unwrap_or("undefined"))?;
        let subject = format!("{}.{}.{}", self.prefix, job, kind);
        let json = crate::observability::json_wire(event);
        self.with_client(|stream| {
            stream
                .write_all(format!("PUB {subject} {}\r\n{json}\r\n", json.len()).as_bytes())
                .map_err(|e| e.to_string())
        })
    }
    fn subscribe_subject(&self, subject: String, wake: Wake) -> Result<NatsSubscription, String> {
        let mut stream = self.connect()?;
        stream
            .set_read_timeout(Some(Duration::from_millis(200)))
            .map_err(|e| e.to_string())?;
        stream
            .write_all(format!("SUB {subject} 1\r\n").as_bytes())
            .map_err(|e| e.to_string())?;
        let socket = Arc::new(Mutex::new(stream.try_clone().map_err(|e| e.to_string())?));
        let active = Arc::new(AtomicBool::new(true));
        let active2 = Arc::clone(&active);
        let socket2 = Arc::clone(&socket);
        let subject_root = format!("{}.", self.prefix);
        let worker = std::thread::spawn(move || {
            let mut reader = BufReader::new(&mut stream);
            while active2.load(Ordering::SeqCst) {
                let mut header = String::new();
                match reader.read_line(&mut header) {
                    Ok(0) => break,
                    Err(e)
                        if matches!(
                            e.kind(),
                            std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                        ) =>
                    {
                        continue
                    }
                    Err(_) => break,
                    Ok(_) => {}
                }
                if header.starts_with("PING") {
                    if let Ok(mut s) = socket2.lock() {
                        let _ = s.write_all(b"PONG\r\n");
                    }
                    continue;
                }
                if !header.starts_with("MSG ") {
                    continue;
                }
                let words = header.split_whitespace().collect::<Vec<_>>();
                let Some(len) = words
                    .last()
                    .and_then(|n| n.parse::<usize>().ok())
                else {
                    continue;
                };
                if len > 16 * 1024 * 1024 {
                    break;
                }
                let mut buf = vec![0u8; len + 2];
                if reader.read_exact(&mut buf).is_err() {
                    break;
                }
                if let Ok(event) = serde_json::from_slice::<Value>(&buf[..len]) {
                    // Verify the *wire subject* before passing the payload to
                    // a Job-scoped Graph/SQLite consumer. Broker subject ACLs
                    // are meaningless if job_id can retarget a decoded body.
                    let identity = words.get(1)
                        .and_then(|topic| topic.strip_prefix(&subject_root))
                        .and_then(|suffix| suffix.split_once('.'));
                    let correlated = matches!(words.len(), 4 | 5)
                        && words.get(2) == Some(&"1")
                        && identity.is_some_and(|(job, kind)| {
                            subject_token(job).is_ok()
                                && event_kind_subject(kind).is_ok()
                                && event["job_id"].as_str() == Some(job)
                                && event["type"].as_str() == Some(kind)
                        });
                    if !correlated { continue; }
                    if let Err(error) = wake(&event) {
                        eprintln!("warning: event handler failed for {subject}: {error}");
                    }
                }
            }
        });
        Ok(NatsSubscription {
            active,
            socket,
            worker: Some(worker),
        })
    }
    pub fn subscribe(&self, job_id: &str, wake: Wake) -> Result<NatsSubscription, String> {
        self.subscribe_subject(
            format!("{}.{}.>", self.prefix, subject_token(job_id)?),
            wake,
        )
    }
    pub fn subscribe_all(&self, wake: Wake) -> Result<NatsSubscription, String> {
        self.subscribe_subject(format!("{}.>", self.prefix), wake)
    }
    pub fn close(&self) -> Result<(), String> {
        *self.connection.lock().map_err(|e| e.to_string())? = None;
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn subject_validation() {
        assert_eq!(subject_token("job_3-X"), Ok("job_3-X"));
        for s in ["", "a.b", "a b", "🌲", "*/a"] {
            assert!(subject_token(s).is_err());
        }
        assert!(subject_prefix("a.b-c_d").is_ok());
        assert!(subject_prefix("a/>").is_err());
    }
    #[test]
    fn memory_order_unsubscribe_and_failure() {
        let bus = MemoryEventBus::new();
        let seen = Arc::new(Mutex::new(vec![]));
        let add = |key: &'static str| {
            let seen = Arc::clone(&seen);
            Arc::new(move |_: &Value| {
                seen.lock().unwrap().push(key);
                Ok(())
            }) as Wake
        };
        let clear = bus.subscribe("5", add("scoped"));
        let _all = bus.subscribe_all(add("all"));
        bus.publish(&json!({"job_id":"5"})).unwrap();
        clear();
        bus.publish(&json!({"job_id":"5"})).unwrap();
        assert_eq!(&*seen.lock().unwrap(), &["scoped", "all", "all"]);
    }
    #[test]
    fn event_for_has_correlation_and_level() {
        let event = event_for(
            "12",
            "44",
            Some("2"),
            "task.progress",
            "blocked",
            "x",
            None,
            Some(json!({"n":1})),
            None,
        );
        assert_eq!(event["level"], "error");
        assert_eq!(event["parent_task_id"], "2");
        assert_eq!(event["visibility"], "orchestrator");
        assert!(event.get("source").is_none());
        assert_eq!(event["data"]["n"], 1);
        assert_eq!(event["event_id"].as_str().unwrap().len(), 36);
    }
    #[test]
    fn no_live_server_needed_for_invalid_subject() {
        let n = NatsEventBus::new(None, None).unwrap();
        assert!(n.subscribe("x.y", Arc::new(|_| Ok(()))).is_err());
    }
}
