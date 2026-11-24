//! Daemon-bound Worker launch failure port: the original Node
//! src/worker-failure-recovery.ts handleWorkerLaunchFailure path bound to
//! the isolated native daemon's SQLite store, Graph directory, Browser Pool
//! health snapshot, decision audit trail and SSE event subscriptions.
//! The Graph alone owns retry/terminal policy; this module only observes
//! execution facts, applies the selected durable transition atomically and
//! cleans its own volatile state. A browser receipt never authors success.
use crate::{
    events::event_for,
    relay_store::SQLiteRelayStore,
    route_outcome_recording::record_launch_route_outcome_jsonl,
    worker_failure_orchestration::{LiveWorkerState, WorkerFailurePorts},
    worker_failure_recovery::{apply_launch_failure_mutation, FailureAdmission},
    workflow::{lifecycle::decide_task_lifecycle, runtime::apply_task_graph_target},
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{mpsc::Sender, Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

fn field<'a>(value: &'a Value, key: &'a str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before UNIX epoch")
        .as_millis() as i64
}

fn iso8601_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Volatile daemon execution observation for the fenced failure path,
/// mirroring Node ReconcilerRuntime.live for the launch-failure contract.
/// Guarded by the daemon-wide failure mutex; worker_started flips exactly
/// once per generation like Node's live.workerStarted.
#[derive(Default)]
pub struct DaemonLiveWorkers {
    live: HashMap<String, LiveWorkerState>,
}

impl DaemonLiveWorkers {
    pub fn register(&mut self, task_id: &str, execution_id: &str) {
        self.live.insert(
            task_id.to_owned(),
            LiveWorkerState { execution_id: execution_id.to_owned(), worker_started: false },
        );
    }
    pub fn mark_started(&mut self, task_id: &str, execution_id: &str) {
        if let Some(state) = self.live.get_mut(task_id) {
            if state.execution_id == execution_id {
                state.worker_started = true;
            }
        }
    }
    pub fn remove(&mut self, task_id: &str) {
        self.live.remove(task_id);
    }
    pub fn get(&self, task_id: &str) -> Option<&LiveWorkerState> {
        self.live.get(task_id)
    }
}

/// Process-wide failure state shared between the daemon service host and
/// worker threads: launch-failure claim dedupe (Node launchFailureClaims
/// with its unref'd 60s cleanup timer), SSE subscribers and the wake
/// counter. All fields are thread-safe; the mutex is the daemon's single
/// serialization point for the volatile failure path.
pub struct DaemonFailureState {
    claims: Mutex<HashSet<String>>,
    claimed_at: Mutex<HashMap<String, Instant>>,
    subscribers: Mutex<Vec<Sender<String>>>,
    wake_count: Mutex<u64>,
}

impl DaemonFailureState {
    pub fn new() -> Self {
        Self {
            claims: Mutex::new(HashSet::new()),
            claimed_at: Mutex::new(HashMap::new()),
            subscribers: Mutex::new(Vec::new()),
            wake_count: Mutex::new(0),
        }
    }
    /// True exactly once per claim key within the 60s retention window.
    pub fn claim(&self, key: &str) -> bool {
        let now = Instant::now();
        let mut claimed_at = self
            .claimed_at
            .lock()
            .expect("daemon failure claim lock poisoned");
        claimed_at.retain(|_, at| now.duration_since(*at) < Duration::from_secs(60));
        if claimed_at.contains_key(key) {
            return false;
        }
        claimed_at.insert(key.to_owned(), now);
        self.claims
            .lock()
            .expect("daemon failure claims lock poisoned")
            .insert(key.to_owned());
        true
    }
    pub fn subscribe(&self, sender: Sender<String>) {
        self.subscribers
            .lock()
            .expect("daemon subscribers lock poisoned")
            .push(sender);
    }
    pub fn emit(&self, event: &Value) {
        let payload = event.to_string();
        self.subscribers
            .lock()
            .expect("daemon subscribers lock poisoned")
            .retain(|sender| sender.send(payload.clone()).is_ok());
    }
    pub fn wake(&self, job_id: &str, task_id: &str, reason: &str) {
        *self
            .wake_count
            .lock()
            .expect("daemon wake lock poisoned") += 1;
        let event = event_for(job_id, task_id, None, "relay.wake", "queued", reason,
            Some("orchestrator"), None, None);
        self.emit(&event);
    }
    pub fn wake_count(&self) -> u64 {
        *self.wake_count.lock().expect("daemon wake lock poisoned")
    }
}

/// Production WorkerFailurePorts over the daemon's real SQLite store and
/// `audit_path` is the decision-audit JSONL; `profile_home` is
/// CODEX_HOME for the configured Codex default no-start fallback route.
pub struct DaemonWorkerFailurePorts {
    pub db_path: PathBuf,
    pub graph_directory: PathBuf,
    /// The daemon Job scope owning this Worker generation. Unified Relay
    /// stores are scoped; opening without a scope would initialize the
    /// legacy schema against unified tables and fail.
    pub scope_job_id: Option<String>,
    pub audit_path: Option<PathBuf>,
    pub profile_home: Option<PathBuf>,
    pub policy_path: Option<PathBuf>,
    pub rules_path: Option<PathBuf>,
    pub live: Arc<Mutex<DaemonLiveWorkers>>,
    pub state: Arc<DaemonFailureState>,
}

impl DaemonWorkerFailurePorts {
    pub fn new(
        db_path: PathBuf,
        graph_directory: PathBuf,
        scope_job_id: Option<String>,
        audit_path: Option<PathBuf>,
        profile_home: Option<PathBuf>,
        live: Arc<Mutex<DaemonLiveWorkers>>,
        state: Arc<DaemonFailureState>,
    ) -> Self {
        Self {
            db_path,
            graph_directory,
            scope_job_id,
            audit_path,
            profile_home,
            policy_path:None,
            rules_path:None,
            live,
            state,
        }
    }
    pub fn with_routing_policy(mut self,policy:PathBuf,rules:PathBuf)->Self{
        self.policy_path=Some(policy);
        self.rules_path=Some(rules);
        self
    }
    fn store(&self) -> Result<SQLiteRelayStore, String> {
        SQLiteRelayStore::open_without_claim_reset(
            &self.db_path, self.scope_job_id.as_deref())
    }
}

impl WorkerFailurePorts for DaemonWorkerFailurePorts {
    fn load_job(&mut self, job_id: &str) -> Result<Value, String> {
        self.store()?
            .load_job(job_id)?
            .ok_or_else(|| format!("SQLite Job {job_id} not found"))
    }
    fn list_agents(&mut self) -> Result<Vec<Value>, String> {
        Ok(self.store()?.load_agents()?.unwrap_or_default())
    }
    fn usage_snapshot(&mut self) -> Result<Option<Value>, String> {
        // The isolated daemon has no authenticated usage provider; Node
        // leaves usageSnapshotProvider optional and undefined behaves alike.
        Ok(None)
    }
    fn has_safe_alternative(&mut self, task: Option<&Value>, _agents: &[Value],
        usage: Option<&Value>) -> Result<bool, String> {
        if let Some(task)=task.filter(|task|field(task,"adapter")=="codex") {
            let Some(home)=self.profile_home.as_ref()else{return Ok(false)};
            let profiles=crate::model_routing::codex_profile_candidates(home,usage,now_ms());
            let Some(policy_path)=self.policy_path.as_ref()else{return Ok(false)};
            let Some(rules_path)=self.rules_path.as_ref()else{return Ok(false)};
            let policy=crate::routing_policy::load_routing_policy(
                &policy_path.to_string_lossy(),&rules_path.to_string_lossy());
            let current=&task["routing"];
            let mut excluded=task.get("routingExclusions").and_then(Value::as_array)
                .cloned().unwrap_or_default();
            excluded.push(current.clone());
            return Ok(!crate::model_routing::eligible_models(
                &profiles,None,&policy["policy"],&excluded).is_empty());
        }
        Ok(false)
    }
    fn has_codex_no_start_fallback(&mut self, _task: &Value, _agents: &[Value],
        _usage: Option<&Value>) -> Result<bool, String> {
        Ok(false)
    }
    fn live_worker(&mut self, task_id: &str) -> Option<LiveWorkerState> {
        self.live
            .lock()
            .expect("daemon live workers lock poisoned")
            .get(task_id)
            .cloned()
    }
    fn claim_failure(&mut self, claim: &str) -> bool {
        self.state.claim(claim)
    }
    fn apply_transition(&mut self, job_id: &str, task_id: &str,
        execution_id: Option<&str>, admission: &FailureAdmission,
    ) -> Result<Option<Value>, String> {
        let store = self.store()?;
        let graph = self.graph_directory.clone();
        let mut receipt = None;
        store.mutate_job(job_id, |mut job| {
            let Some(index) = job["tasks"].as_array().into_iter().flatten()
                .position(|task| field(task, "id") == task_id)
            else { return Ok(job); };
            let task = job["tasks"][index].clone();
            // Execution-ID fencing: only the current leased generation may
            // commit a failure; a stale generation observes, never persists.
            if task["executionId"].as_str() != execution_id { return Ok(job); }
            let from = field(&task, "state").to_owned();
            let decision = decide_task_lifecycle(
                &graph, &task, &admission.event, &admission.facts)?;
            let mut updated = task.clone();
            if decision["accepted"] == true {
                apply_task_graph_target(&mut updated,
                    decision["target"].as_str().ok_or("Missing Graph target")?,
                    &iso8601_now(), false)?;
                // Execute Graph-selected mutation effects, including
                // `preparePlatformFallback` which must remove stale routing
                // before the next ranked Profile decision. Never invent a
                // second procedural fallback decision in the daemon.
                for action in decision["actions"].as_array().into_iter().flatten(){
                    if let Some(name)=action.as_str().filter(|s|s.starts_with("mutation.")){
                        crate::workflow::runtime::apply_task_mutation(
                            &mut updated,name,&iso8601_now())?;
                    }
                }
                apply_launch_failure_mutation(&mut updated, Some(&task),
                    admission, &decision);
                job["tasks"][index] = updated.clone();
            }
            receipt = Some(json!({"from": from, "task": updated, "decision": decision}));
            Ok(job)
        })?;
        Ok(receipt)
    }
    fn record_route_outcome(&mut self, task: &Value, message: &str,
        phase: &str, execution_id: Option<&str>, unknown_outcome: bool) {
        if let Some(path) = self.audit_path.clone() {
            record_launch_route_outcome_jsonl(&path, task, message, phase,
                execution_id, unknown_outcome);
        }
    }
    fn cancel_and_clear(&mut self, task_id: &str, execution_id: &str)
        -> Result<(), String> {
        // The browser submission owns no child process; the Browser Pool
        // lease release/quarantine belongs to the adapter path. Only the
        // volatile live observation is cleared, under execution fencing.
        let mut live = self.live.lock().expect("daemon live workers lock poisoned");
        if live.get(task_id).is_some_and(|state| state.execution_id == execution_id) {
            live.remove(task_id);
        }
        Ok(())
    }
    fn clear_terminal_waiter(&mut self, task_id: &str, execution_id: &str) {
        // Terminal waiters belong to the full Reconciler runtime, which the
        // isolated daemon path does not run; fencing is preserved by the
        // execution-ID check in cancel_and_clear.
        let _ = (task_id, execution_id);
    }
    fn emit(&mut self, event: &Value) -> Result<(), String> {
        self.state.emit(event);
        Ok(())
    }
    fn emit_detached(&mut self, event: &Value, _job_id: &str, _task_id: &str,
        _context: &str) {
        self.state.emit(event);
    }
    fn wake(&mut self, job_id: &str, task_id: &str, reason: &str) {
        self.state.wake(job_id, task_id, reason);
    }
}

/// Phase classification for a native browser Worker launch error, following
/// Node reconciler.ts: StartAckTimeout -> start-ack; LaunchFailure or
/// PreSubmissionRejection -> delivery; other executor observations map to
/// the process phase like Node's runtimeSettled error path.
pub fn classify_native_launch_phase(error: &str) -> &'static str {
    if error.contains("worker_start_timeout") || error.contains("start-ack") {
        "start-ack"
    } else if error.contains("LaunchFailure")
        || error.contains("PreSubmissionRejection")
        || error.contains("pre-submission")
        || error.contains("quarantined")
        || error.contains("uncertain")
    {
        "delivery"
    } else {
        "process"
    }
}
