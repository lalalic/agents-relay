// Direct port of Node src/worker-start-ack.ts. An acknowledgement only accepts
// task.started bound to job/task AND server-issued execution source; it is not a timer receipt.
use serde_json::Value;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    time::{Duration, Instant},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartAckTimeout(pub String);
impl std::fmt::Display for StartAckTimeout {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for StartAckTimeout {}

type Listener = Arc<dyn Fn(&Value) + Send + Sync>;
type Unsubscribe = Arc<dyn Fn() + Send + Sync>;
/// Adapter boundary: EventBus transport delivers independently sourced events;
/// this module never fabricates task.started or Task success.
pub trait WorkerEventBus {
    fn subscribe(&mut self, job_id: &str, on_event: Listener) -> Result<Unsubscribe, String>;
}
struct AckState {
    settled: bool,
    outcome: Option<Result<(), StartAckTimeout>>,
}
struct AckShared {
    state: Mutex<AckState>,
    signal: Condvar,
}
/// Drop stops only the subscribed listener; it never cancels another worker.
pub struct WorkerStartAck {
    shared: Arc<AckShared>,
    unsub: Unsubscribe,
    stopped: AtomicBool,
    task_id: String,
    deadline: Instant,
}
impl WorkerStartAck {
    /// Wait accepts a correlated start, or reports Node's worker_start_timeout.
    pub fn wait(&self) -> Result<(), StartAckTimeout> {
        let mut lock = self.shared.state.lock().expect("ack mutex");
        while !lock.settled {
            let remaining = self.deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                lock.settled = true;
                lock.outcome = Some(Err(StartAckTimeout(format!(
                    "Task {} worker_start_timeout: no worker task.started start-ack",
                    self.task_id
                ))));
                break;
            }
            let (next, _) = self
                .shared
                .signal
                .wait_timeout(lock, remaining)
                .expect("ack condvar");
            lock = next;
        }
        let result = lock.outcome.clone().unwrap_or(Ok(()));
        drop(lock);
        if result
            .as_ref()
            .err()
            .is_some_and(|err| err.0.contains("worker_start_timeout"))
        {
            (self.unsub)();
        }
        result
    }
    pub fn stop(&self) {
        if self.stopped.swap(true, Ordering::AcqRel) {
            return;
        }
        let mut lock = self.shared.state.lock().expect("ack mutex");
        if !lock.settled {
            lock.settled = true;
            lock.outcome = Some(Err(StartAckTimeout(format!(
                "Task {} worker_start_cancelled: start-ack owner closed",
                self.task_id
            ))));
            self.shared.signal.notify_all();
        }
        drop(lock);
        (self.unsub)();
    }
}
impl Drop for WorkerStartAck {
    fn drop(&mut self) {
        self.stop();
    }
}

pub fn create_worker_start_ack(
    bus: &mut impl WorkerEventBus,
    job_id: &str,
    task_id: &str,
    source_id: &str,
    timeout_ms: u64,
) -> Result<WorkerStartAck, String> {
    let shared = Arc::new(AckShared {
        state: Mutex::new(AckState {
            settled: false,
            outcome: None,
        }),
        signal: Condvar::new(),
    });
    let (job, task, source) = (
        job_id.to_string(),
        task_id.to_string(),
        source_id.to_string(),
    );
    let receiver = Arc::clone(&shared);
    let unsubscribe = bus.subscribe(
        job_id,
        Arc::new(move |event: &Value| {
            if event["type"] != "task.started"
                || event["job_id"] != job
                || event["task_id"] != task
                || event["source"]["id"] != source
            {
                return;
            }
            let mut lock = receiver.state.lock().expect("ack mutex");
            if !lock.settled {
                lock.settled = true;
                lock.outcome = Some(Ok(()));
                receiver.signal.notify_all();
            }
        }),
    )?;
    Ok(WorkerStartAck {
        shared,
        unsub: unsubscribe,
        stopped: AtomicBool::new(false),
        task_id: task_id.into(),
        deadline: Instant::now() + Duration::from_millis(timeout_ms),
    })
}
