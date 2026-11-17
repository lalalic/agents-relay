// Direct port of Node src/local-commit-events.ts: publish independent cloned committed Job views to dashboard subscribers, after SQLite commit.
use serde_json::Value;
use std::sync::{Arc, Mutex, OnceLock};

pub type LocalCommitListener = Arc<dyn Fn(Value) + Send + Sync + 'static>;
#[derive(Default)]
struct SubscriptionTable {
    next_id: u64,
    listeners: Vec<(u64, LocalCommitListener)>,
}
#[derive(Default)]
pub struct LocalCommitBus {
    inner: Mutex<SubscriptionTable>,
}
impl LocalCommitBus {
    pub fn new() -> Self {
        Self::default()
    }
    /// A Set, not a multiset: registering an identical callback twice is one listener.
    pub fn subscribe(&self, listener: LocalCommitListener) -> u64 {
        let mut inner = self.inner.lock().expect("local commit subscriptions lock");
        if let Some((id, _)) = inner
            .listeners
            .iter()
            .find(|(_, existing)| Arc::ptr_eq(existing, &listener))
        {
            return *id;
        }
        inner.next_id += 1;
        let id = inner.next_id;
        inner.listeners.push((id, listener));
        id
    }
    pub fn unsubscribe(&self, id: u64) {
        self.inner
            .lock()
            .expect("local commit subscriptions lock")
            .listeners
            .retain(|(value, _)| *value != id);
    }
    pub fn publish(&self, job: &Value) {
        // JS Set iterators observe new additions and skip removed callbacks.
        // Releasing the lock before notification permits subscribers to adjust
        // subscriptions reentrantly without deadlocking the dispatcher.
        let mut last = 0u64;
        loop {
            let current = {
                let inner = self.inner.lock().expect("local commit subscriptions lock");
                inner
                    .listeners
                    .iter()
                    .find(|(id, _)| *id > last)
                    .map(|(id, listener)| (*id, Arc::clone(listener)))
            };
            let Some((id, listener)) = current else { break };
            last = id;
            listener(job.clone());
        }
    }
}
fn global_bus() -> &'static Arc<LocalCommitBus> {
    static BUS: OnceLock<Arc<LocalCommitBus>> = OnceLock::new();
    BUS.get_or_init(|| Arc::new(LocalCommitBus::new()))
}
pub fn publish_local_commit(job: &Value) {
    global_bus().publish(job);
}
pub fn subscribe_local_commits(listener: LocalCommitListener) -> impl Fn() + Send + Sync + 'static {
    let bus = Arc::clone(global_bus());
    let id = bus.subscribe(listener);
    move || bus.unsubscribe(id)
}
