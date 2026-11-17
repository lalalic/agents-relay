// Direct mechanics port of src/reconcile-coordinator.ts. A per-Job FIFO mailbox
// batches event wakeups and protects the consumer from concurrent same-Job drains.
// No lifecycle policy: the Graph/SQLite consumer owns all durable transitions.
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{mpsc, Arc, Condvar, Mutex},
    thread,
};
type Consume = dyn Fn(&str, &[Value]) -> Result<(), String> + Send + Sync + 'static;
type Reporter = dyn Fn(&str, &Value) + Send + Sync + 'static;
#[derive(Debug)]
struct PendingSignal {
    signal: Value,
    response: Option<mpsc::Sender<Result<(), String>>>,
}
#[derive(Debug, Default)]
struct Mailbox {
    pending: Vec<PendingSignal>,
    running: bool,
    scheduled: bool,
}
#[derive(Debug, Default)]
struct State {
    mailboxes: HashMap<String, Mailbox>,
    /// Explicit Rust caller turn boundary, equivalent to a single Node stack
    /// before its queueMicrotask checkpoint.
    turn_depth: usize,
}
#[derive(Debug, Default)]
struct Shared {
    state: Mutex<State>,
    idle: Condvar,
}
enum WaitMode {
    Processing,
    Detached,
    Observed,
}

/// A turn batches synchronous accept calls before dispatch; drop it before
/// receiving the processing reply. Nested turns release at the outer boundary.
pub struct ReconcileTurn {
    owner: ReconcileCoordinator,
}
impl Drop for ReconcileTurn {
    fn drop(&mut self) {
        let jobs = {
            let mut state = self.owner.shared.state.lock().expect("mailboxes");
            state.turn_depth = state.turn_depth.saturating_sub(1);
            if state.turn_depth > 0 {
                return;
            }
            let mut jobs = Vec::new();
            for (job, mailbox) in &mut state.mailboxes {
                if !mailbox.running && !mailbox.scheduled && !mailbox.pending.is_empty() {
                    mailbox.scheduled = true;
                    jobs.push(job.clone());
                }
            }
            jobs
        };
        for job in jobs {
            let worker = self.owner.clone();
            thread::spawn(move || worker.drain(&job));
        }
    }
}
#[derive(Clone)]
pub struct ReconcileCoordinator {
    shared: Arc<Shared>,
    consume: Arc<Consume>,
    report_error: Option<Arc<Reporter>>,
}
impl ReconcileCoordinator {
    pub fn new(
        consume: impl Fn(&str, &[Value]) -> Result<(), String> + Send + Sync + 'static,
        report_error: Option<Arc<Reporter>>,
    ) -> Self {
        Self {
            shared: Arc::new(Shared::default()),
            consume: Arc::new(consume),
            report_error,
        }
    }
    pub fn begin_turn(&self) -> ReconcileTurn {
        self.shared.state.lock().expect("mailboxes").turn_depth += 1;
        ReconcileTurn {
            owner: self.clone(),
        }
    }
    pub fn accept(&self, signal: Value) -> mpsc::Receiver<Result<(), String>> {
        self.enqueue(signal, WaitMode::Processing)
    }
    pub fn accept_transport(&self, signal: Value) -> mpsc::Receiver<Result<(), String>> {
        self.enqueue(signal, WaitMode::Detached)
    }
    pub fn accept_observed(&self, signal: Value) -> mpsc::Receiver<Result<(), String>> {
        self.enqueue(signal, WaitMode::Observed)
    }
    pub fn is_idle(&self) -> bool {
        self.shared
            .state
            .lock()
            .expect("mailboxes")
            .mailboxes
            .values()
            .all(|m| !m.running && !m.scheduled && m.pending.is_empty())
    }
    pub fn settle(&self) {
        let mut lock = self.shared.state.lock().expect("mailboxes");
        while lock
            .mailboxes
            .values()
            .any(|m| m.running || m.scheduled || !m.pending.is_empty())
        {
            lock = self.shared.idle.wait(lock).expect("mailboxes");
        }
    }
    fn enqueue(&self, signal: Value, mode: WaitMode) -> mpsc::Receiver<Result<(), String>> {
        let job = signal
            .get("jobId")
            .and_then(Value::as_str)
            .unwrap_or("undefined")
            .to_string();
        let (sender, receiver) = mpsc::channel();
        let mut should_schedule = false;
        {
            let mut state = self.shared.state.lock().expect("mailboxes");
            let in_turn = state.turn_depth > 0;
            let mailbox = state.mailboxes.entry(job.clone()).or_default();
            let wait = match mode {
                WaitMode::Processing => true,
                WaitMode::Detached => false,
                WaitMode::Observed => !mailbox.running,
            };
            mailbox.pending.push(PendingSignal {
                signal,
                response: if wait { Some(sender.clone()) } else { None },
            });
            if !wait {
                let _ = sender.send(Ok(()));
            }
            if !mailbox.running && !mailbox.scheduled && !in_turn {
                mailbox.scheduled = true;
                should_schedule = true;
            }
        }
        if should_schedule {
            let worker = self.clone();
            // Thread scheduling provides one queued drain per Job and retains
            // transport FIFO; it does not presume that wakeups are durable state.
            thread::spawn(move || worker.drain(&job));
        }
        receiver
    }
    fn drain(&self, job: &str) {
        {
            let mut state = self.shared.state.lock().expect("mailboxes");
            let Some(mailbox) = state.mailboxes.get_mut(job) else {
                return;
            };
            if mailbox.running {
                return;
            }
            mailbox.running = true;
            mailbox.scheduled = false;
        }
        loop {
            let pending = {
                let mut state = self.shared.state.lock().expect("mailboxes");
                match state.mailboxes.get_mut(job) {
                    Some(m) => std::mem::take(&mut m.pending),
                    None => return,
                }
            };
            if pending.is_empty() {
                break;
            }
            let signals = pending.iter().map(|p| p.signal.clone()).collect::<Vec<_>>();
            let outcome = (self.consume)(job, &signals);
            for item in pending {
                match (&outcome, item.response) {
                    (Ok(()), Some(sender)) => {
                        let _ = sender.send(Ok(()));
                    }
                    (Err(error), Some(sender)) => {
                        let _ = sender.send(Err(error.clone()));
                    }
                    (Err(error), None) => {
                        if let Some(report) = &self.report_error {
                            report(error, &item.signal);
                        }
                    }
                    _ => {}
                }
            }
        }
        let mut state = self.shared.state.lock().expect("mailboxes");
        if let Some(mailbox) = state.mailboxes.get_mut(job) {
            mailbox.running = false;
            if mailbox.pending.is_empty() {
                state.mailboxes.remove(job);
            } else {
                mailbox.scheduled = true;
                let worker = self.clone();
                let job = job.to_owned();
                thread::spawn(move || worker.drain(&job));
            }
        }
        if state
            .mailboxes
            .values()
            .all(|m| !m.running && !m.scheduled && m.pending.is_empty())
        {
            self.shared.idle.notify_all();
        }
    }
}
