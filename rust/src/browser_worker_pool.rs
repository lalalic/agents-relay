// Direct port of Node src/browser-worker-pool.ts. SQLite is the cross-process
// resource authority; the canonical browser-worker-pool Graph selects effects.
// No HTTP receipt is interpreted as Task completion.
use crate::browser_worker_pool_graph::require_pool_decision;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::Duration,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSlot {
    pub provider: String,
    pub slot: i64,
    pub execution_id: String,
    pub generation: i64,
    pub session_id: Option<String>,
    pub thread_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPoolSnapshot {
    pub provider: String,
    pub capacity: i64,
    pub idle: i64,
    pub leased: i64,
    pub quarantined: i64,
    pub queued: i64,
    pub health: String,
    pub unavailable_until: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserPoolError {
    pub code: Option<&'static str>,
    pub message: String,
    pub submitted: bool,
}
impl BrowserPoolError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            code: None,
            message: message.into(),
            submitted: false,
        }
    }
    fn admission(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code: Some(code),
            message: message.into(),
            submitted: false,
        }
    }
}
/// Equivalent to Node BrowserPoolAdmissionError (a distinct, safe-to-retry
/// *pre-submission* failure), not an arbitrary operational SQLite error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserPoolAdmissionError {
    pub code: &'static str,
    pub message: String,
    pub submitted: bool,
}
impl std::fmt::Display for BrowserPoolAdmissionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}
impl std::error::Error for BrowserPoolAdmissionError {}

/// Public discriminated error, so callers cannot mistake a genuine
/// SQLite/lease/submission failure for an admission rejection.
#[derive(Debug)]
pub enum BrowserPoolFailure {
    Admission(BrowserPoolAdmissionError),
    Operational(BrowserPoolError),
}
impl std::fmt::Display for BrowserPoolFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Admission(error) => error.fmt(formatter),
            Self::Operational(error) => error.fmt(formatter),
        }
    }
}
impl std::error::Error for BrowserPoolFailure {}
impl From<BrowserPoolError> for BrowserPoolFailure {
    fn from(error: BrowserPoolError) -> Self {
        match error.code {
            Some(code @ ("PROVIDER_UNAVAILABLE" | "POOL_CAPACITY_FULL" | "POOL_WAIT_EXPIRED")) => {
                Self::Admission(BrowserPoolAdmissionError {
                    code,
                    message: error.message,
                    submitted: false,
                })
            }
            _ => Self::Operational(error),
        }
    }
}
impl std::fmt::Display for BrowserPoolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for BrowserPoolError {}
impl From<rusqlite::Error> for BrowserPoolError {
    fn from(value: rusqlite::Error) -> Self {
        Self::new(value.to_string())
    }
}
impl From<String> for BrowserPoolError {
    fn from(value: String) -> Self {
        Self::new(value)
    }
}
type PoolResult<T> = Result<T, BrowserPoolError>;

pub struct BrowserPoolOptions {
    pub path: Option<PathBuf>,
    pub capacity: i64,
    pub max_queue: i64,
    pub queue_wait_ms: i64,
    pub poll_ms: u64,
}
impl Default for BrowserPoolOptions {
    fn default() -> Self {
        Self {
            path: None,
            capacity: 3,
            max_queue: 12,
            queue_wait_ms: 60_000,
            poll_ms: 250,
        }
    }
}

pub struct BrowserWorkerPoolManager {
    db: Connection,
    capacity: i64,
    max_queue: i64,
    queue_wait_ms: i64,
    poll_ms: u64,
    now: Box<dyn Fn() -> i64 + Send>,
}
fn system_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}
fn base_path() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    let root = std::env::var_os("AGENTS_RELAY_STORE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".agents-relay/stores"));
    root.join("browser-worker-pool.sqlite")
}
fn check_provider(p: &str) -> PoolResult<()> {
    if p == "chatgpt" || p == "z" {
        Ok(())
    } else {
        Err(BrowserPoolError::new(format!(
            "Unknown browser pool provider {p}"
        )))
    }
}
fn count(db: &Connection, provider: &str, state: &str) -> PoolResult<i64> {
    Ok(db.query_row(
        "SELECT count(*) FROM browser_slots WHERE provider=? AND state=?",
        params![provider, state],
        |r| r.get(0),
    )?)
}
fn graph(state: &str, event: &str, action: &str, healthy: bool) -> PoolResult<()> {
    require_pool_decision(state, event, action, healthy)?;
    Ok(())
}
impl BrowserWorkerPoolManager {
    pub fn open(options: BrowserPoolOptions) -> PoolResult<Self> {
        Self::with_clock(options, system_ms)
    }
    pub fn with_clock(
        options: BrowserPoolOptions,
        now: impl Fn() -> i64 + Send + 'static,
    ) -> PoolResult<Self> {
        let path = options.path.unwrap_or_else(base_path);
        if path.as_os_str() != ":memory:" {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| BrowserPoolError::new(e.to_string()))?;
            }
        }
        let db = Connection::open(path)?;
        db.busy_timeout(Duration::from_millis(5000))?;
        db.execute_batch("PRAGMA journal_mode=WAL;
          CREATE TABLE IF NOT EXISTS browser_slots (
            provider TEXT NOT NULL, slot INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'IDLE',
            execution_id TEXT, generation INTEGER NOT NULL DEFAULT 0, session_id TEXT, thread_url TEXT,
            touched_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(provider,slot)
          );
          CREATE TABLE IF NOT EXISTS browser_queue (
            execution_id TEXT PRIMARY KEY, provider TEXT NOT NULL, queued_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS browser_queue_order ON browser_queue(provider,queued_at,execution_id);
          CREATE TABLE IF NOT EXISTS browser_provider_health (
            provider TEXT PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 0, unavailable_until INTEGER NOT NULL DEFAULT 0
          );")?;
        if !(1..=32).contains(&options.capacity) {
            return Err(BrowserPoolError::new("Invalid pool capacity"));
        }
        for provider in ["chatgpt", "z"] {
            for slot in 1..=options.capacity {
                db.execute(
                    "INSERT OR IGNORE INTO browser_slots(provider,slot) VALUES(?,?)",
                    params![provider, slot],
                )?;
            }
            db.execute(
                "INSERT OR IGNORE INTO browser_provider_health(provider) VALUES(?)",
                params![provider],
            )?;
        }
        Ok(Self {
            db,
            capacity: options.capacity,
            max_queue: options.max_queue,
            queue_wait_ms: options.queue_wait_ms,
            poll_ms: options.poll_ms,
            now: Box::new(now),
        })
    }
    /// Typed public Node-compatible admission API. The original acquire()
    /// remains available for existing Rust2 integrations; both use the same
    /// transactional SQLite/Graph implementation and return the same lease.
    pub fn acquire_typed(
        &mut self,
        provider: &str,
        execution_id: &str,
        abort: Option<&AtomicBool>,
    ) -> Result<BrowserSlot, BrowserPoolFailure> {
        self.acquire(provider, execution_id, abort)
            .map_err(Into::into)
    }
    pub fn snapshot(&self, provider: &str) -> PoolResult<BrowserPoolSnapshot> {
        check_provider(provider)?;
        let queued: i64 = self.db.query_row(
            "SELECT count(*) FROM browser_queue WHERE provider=?",
            [provider],
            |r| r.get(0),
        )?;
        let until: i64 = self.db.query_row(
            "SELECT unavailable_until FROM browser_provider_health WHERE provider=?",
            [provider],
            |r| r.get(0),
        )?;
        let unavailable = until > (self.now)();
        Ok(BrowserPoolSnapshot {
            provider: provider.into(),
            capacity: self.capacity,
            idle: count(&self.db, provider, "IDLE")?,
            leased: count(&self.db, provider, "LEASED")?,
            quarantined: count(&self.db, provider, "QUARANTINED")?,
            queued,
            health: if unavailable {
                "UNAVAILABLE"
            } else {
                "HEALTHY"
            }
            .into(),
            unavailable_until: unavailable.then_some(until),
        })
    }
    pub fn report_pre_submission_outage(&self, provider: &str, duration_ms: i64) -> PoolResult<()> {
        check_provider(provider)?;
        self.db.execute("UPDATE browser_provider_health SET failures=failures+1, unavailable_until=? WHERE provider=?",params![(self.now)()+duration_ms,provider])?;
        Ok(())
    }
    pub fn report_healthy(&self, provider: &str) -> PoolResult<()> {
        check_provider(provider)?;
        self.db.execute(
            "UPDATE browser_provider_health SET failures=0,unavailable_until=0 WHERE provider=?",
            [provider],
        )?;
        Ok(())
    }
    fn try_claim(&mut self, provider: &str, execution_id: &str) -> PoolResult<Option<BrowserSlot>> {
        check_provider(provider)?;
        let now = (self.now)();
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let until: i64 = tx.query_row(
            "SELECT unavailable_until FROM browser_provider_health WHERE provider=?",
            [provider],
            |r| r.get(0),
        )?;
        if until > now {
            let waiting: bool = tx
                .query_row(
                    "SELECT 1 FROM browser_queue WHERE execution_id=? AND provider=?",
                    params![execution_id, provider],
                    |r| r.get::<_, i64>(0),
                )
                .optional()?
                .is_some();
            graph(
                if waiting { "WAITING" } else { "AVAILABLE" },
                "pool.claim",
                "reject",
                false,
            )?;
            return Err(BrowserPoolError::admission(
                "PROVIDER_UNAVAILABLE",
                format!("{provider} circuit open until {until}"),
            ));
        }
        let existing: Option<i64> = tx
            .query_row(
                "SELECT slot FROM browser_slots WHERE execution_id=? AND provider=?",
                params![execution_id, provider],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(slot) = existing {
            return Err(BrowserPoolError::new(format!("Execution {execution_id} already owns {provider}-{slot}: refuse duplicate browser submission")));
        }
        tx.execute(
            "DELETE FROM browser_queue WHERE queued_at < ?",
            [now - self.queue_wait_ms - 30_000],
        )?;
        let queued:Option<String>=tx.query_row("SELECT execution_id FROM browser_queue WHERE provider=? ORDER BY queued_at,rowid LIMIT 1",[provider],|r|r.get(0)).optional()?;
        if queued.as_deref().is_none_or(|id| id == execution_id) {
            let idle:Option<(i64,i64)>=tx.query_row("SELECT slot,generation FROM browser_slots WHERE provider=? AND state='IDLE' ORDER BY slot LIMIT 1",[provider],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
            if let Some((slot, generation)) = idle {
                graph(
                    if queued.is_some() {
                        "WAITING"
                    } else {
                        "AVAILABLE"
                    },
                    "pool.claim",
                    "assign",
                    true,
                )?;
                let generation = generation + 1;
                let changed=tx.execute("UPDATE browser_slots SET state='LEASED',execution_id=?,generation=?,session_id=NULL,thread_url=NULL,touched_at=? WHERE provider=? AND slot=? AND state='IDLE'",params![execution_id,generation,now,provider,slot])?;
                if changed != 1 {
                    return Err(BrowserPoolError::new(
                        "Browser pool concurrent claim failed",
                    ));
                }
                tx.execute(
                    "DELETE FROM browser_queue WHERE execution_id=?",
                    [execution_id],
                )?;
                tx.commit()?;
                return Ok(Some(BrowserSlot {
                    provider: provider.into(),
                    slot,
                    execution_id: execution_id.into(),
                    generation,
                    session_id: None,
                    thread_url: None,
                }));
            }
        }
        tx.commit()?;
        Ok(None)
    }
    fn dequeue(&self, execution_id: &str, event: &str) -> PoolResult<()> {
        let queued = self
            .db
            .query_row(
                "SELECT 1 FROM browser_queue WHERE execution_id=?",
                [execution_id],
                |r| r.get::<_, i64>(0),
            )
            .optional()?
            .is_some();
        if queued {
            graph("WAITING", event, "dequeue", true)?;
            self.db.execute(
                "DELETE FROM browser_queue WHERE execution_id=?",
                [execution_id],
            )?;
        }
        Ok(())
    }
    /// Synchronous equivalent of Node acquire. The optional flag is checked before each poll;
    /// no browser submission or unrelated process is ever performed by this method.
    pub fn acquire(
        &mut self,
        provider: &str,
        execution_id: &str,
        abort: Option<&AtomicBool>,
    ) -> PoolResult<BrowserSlot> {
        let deadline = (self.now)() + self.queue_wait_ms;
        if let Some(lease) = self.try_claim(provider, execution_id)? {
            return Ok(lease);
        }
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let count: i64 = tx.query_row(
            "SELECT count(*) FROM browser_queue WHERE provider=?",
            [provider],
            |r| r.get(0),
        )?;
        let present = tx
            .query_row(
                "SELECT 1 FROM browser_queue WHERE execution_id=?",
                [execution_id],
                |r| r.get::<_, i64>(0),
            )
            .optional()?
            .is_some();
        if count >= self.max_queue && !present {
            return Err(BrowserPoolError::admission(
                "POOL_CAPACITY_FULL",
                format!("{provider} queue is full"),
            ));
        }
        if !present {
            graph("AVAILABLE", "pool.enqueue", "enqueue", true)?;
            tx.execute(
                "INSERT INTO browser_queue(execution_id,provider,queued_at) VALUES(?,?,?)",
                params![execution_id, provider, (self.now)()],
            )?;
        }
        tx.commit()?;
        let mut dequeue_event = "pool.cancel";
        let outcome = loop {
            if abort.is_some_and(|flag| flag.load(Ordering::Acquire)) {
                break Err(BrowserPoolError::new("Browser pool acquire aborted"));
            }
            match self.try_claim(provider, execution_id) {
                Ok(Some(lease)) => break Ok(lease),
                Ok(None) => (),
                Err(err) => {
                    if err.code == Some("PROVIDER_UNAVAILABLE") {
                        dequeue_event = "pool.unavailable";
                    }
                    break Err(err);
                }
            }
            if (self.now)() >= deadline {
                dequeue_event = "pool.expired";
                break Err(BrowserPoolError::admission(
                    "POOL_WAIT_EXPIRED",
                    format!("{provider} queue wait expired without browser submission"),
                ));
            }
            thread::sleep(Duration::from_millis(self.poll_ms.max(1)));
        };
        let cleaned = self.dequeue(execution_id, dequeue_event);
        match (outcome, cleaned) {
            (Ok(lease), _) => Ok(lease),
            (Err(_), Err(cleanup)) => Err(cleanup),
            (Err(err), _) => Err(err),
        }
    }
    fn update(
        &self,
        lease: &BrowserSlot,
        state: &str,
        session_id: Option<&str>,
        thread_url: Option<&str>,
        event: &str,
        action: &str,
    ) -> PoolResult<()> {
        graph("LEASED", event, action, true)?;
        let n=self.db.execute("UPDATE browser_slots SET state=?,session_id=?,thread_url=?,touched_at=? WHERE provider=? AND slot=? AND execution_id=? AND generation=? AND state='LEASED'",params![state,session_id,thread_url,(self.now)(),lease.provider,lease.slot,lease.execution_id,lease.generation])?;
        if n != 1 {
            return Err(BrowserPoolError::new(
                "Stale browser pool lease generation; refusing mutation",
            ));
        }
        Ok(())
    }
    pub fn bind_session(&self, lease: &mut BrowserSlot, session_id: &str) -> PoolResult<()> {
        lease.session_id = Some(session_id.into());
        self.update(
            lease,
            "LEASED",
            lease.session_id.as_deref(),
            lease.thread_url.as_deref(),
            "pool.sessionBound",
            "bindSession",
        )
    }
    pub fn bind_thread(&self, lease: &mut BrowserSlot, thread_url: &str) -> PoolResult<()> {
        let url = url::Url::parse(thread_url).map_err(|e| BrowserPoolError::new(e.to_string()))?;
        let expected = if lease.provider == "z" {
            "chat.z.ai"
        } else {
            "chatgpt.com"
        };
        let allowed = regex::Regex::new(r"^/c/[A-Za-z0-9_-]+/?$").expect("static URL regex");
        if url.scheme() != "https"
            || url.host_str() != Some(expected)
            || !allowed.is_match(url.path())
        {
            return Err(BrowserPoolError::new("Unsafe browser thread URL"));
        }
        let canonical = format!("{}{}", url.origin().ascii_serialization(), url.path());
        lease.thread_url = Some(canonical);
        self.update(
            lease,
            "LEASED",
            lease.session_id.as_deref(),
            lease.thread_url.as_deref(),
            "pool.threadBound",
            "bindThread",
        )
    }
    pub fn touch(&self, lease: &BrowserSlot) -> PoolResult<()> {
        self.update(
            lease,
            "LEASED",
            lease.session_id.as_deref(),
            lease.thread_url.as_deref(),
            "pool.activity",
            "touch",
        )
    }
    pub fn release(&self, lease: &BrowserSlot) -> PoolResult<()> {
        graph("LEASED", "pool.terminalVerified", "release", true)?;
        let n=self.db.execute("UPDATE browser_slots SET state='IDLE',execution_id=NULL,session_id=NULL,thread_url=NULL,touched_at=? WHERE provider=? AND slot=? AND execution_id=? AND generation=? AND state='LEASED'",params![(self.now)(),lease.provider,lease.slot,lease.execution_id,lease.generation])?;
        if n != 1 {
            return Err(BrowserPoolError::new("Stale browser pool lease release"));
        }
        Ok(())
    }
    pub fn quarantine(&self, lease: &BrowserSlot) -> PoolResult<()> {
        let state:Option<String>=self.db.query_row("SELECT state FROM browser_slots WHERE provider=? AND slot=? AND execution_id=? AND generation=?",params![lease.provider,lease.slot,lease.execution_id,lease.generation],|r|r.get(0)).optional()?;
        if state.as_deref() == Some("QUARANTINED") {
            graph("QUARANTINED", "pool.outcomeUnknown", "keepQuarantine", true)?;
            return Ok(());
        }
        self.update(
            lease,
            "QUARANTINED",
            lease.session_id.as_deref(),
            lease.thread_url.as_deref(),
            "pool.outcomeUnknown",
            "quarantine",
        )
    }
    pub fn release_quarantine(
        &self,
        lease: &BrowserSlot,
        verified_stopped: bool,
    ) -> PoolResult<()> {
        if !verified_stopped {
            return Err(BrowserPoolError::new(
                "Cannot release quarantined slot without independent stop verification",
            ));
        }
        graph(
            "QUARANTINED",
            "pool.stopVerified",
            "releaseQuarantine",
            true,
        )?;
        let n=self.db.execute("UPDATE browser_slots SET state='IDLE',execution_id=NULL,session_id=NULL,thread_url=NULL,touched_at=? WHERE provider=? AND slot=? AND execution_id=? AND generation=? AND state='QUARANTINED'",params![(self.now)(),lease.provider,lease.slot,lease.execution_id,lease.generation])?;
        if n != 1 {
            return Err(BrowserPoolError::new("Stale quarantine release"));
        }
        Ok(())
    }
    pub fn to_value(&self, provider: &str) -> PoolResult<Value> {
        Ok(json!(self.snapshot(provider)?))
    }
}
