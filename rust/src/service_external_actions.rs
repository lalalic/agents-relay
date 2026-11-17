// Node provenance: src/service-external-actions.ts. Flush external projection
// effects only when the local store has a GitHub-backed adapter enabled.
use std::future::Future;
use std::sync::mpsc::{self, Sender};
use std::thread::{self, JoinHandle};
use std::time::Duration;

/// The projection callback must use the existing transactional outbox; no
/// external effect may determine the authoritative SQLite Job lifecycle.
pub async fn flush_service_external_actions<Flush, FFut, Reconcile, RFut>(
    is_local_authority: bool,
    no_github: bool,
    flush_once: Flush,
    reconcile: Reconcile,
) -> Result<usize, String>
where
    Flush: FnOnce() -> FFut,
    FFut: Future<Output = Result<usize, String>>,
    Reconcile: FnOnce() -> RFut,
    RFut: Future<Output = Result<(), String>>,
{
    if !is_local_authority || no_github { return Ok(0); }
    let projected = flush_once().await?;
    if projected > 0 { reconcile().await?; }
    Ok(projected)
}

pub struct FlusherHandle {
    cancel: Sender<()>,
    thread: Option<JoinHandle<()>>,
}
impl FlusherHandle {
    pub fn stop(mut self) {
        let _ = self.cancel.send(());
        if let Some(thread) = self.thread.take() { let _ = thread.join(); }
    }
}
impl Drop for FlusherHandle {
    fn drop(&mut self) {
        let _ = self.cancel.send(());
        if let Some(thread) = self.thread.take() { let _ = thread.join(); }
    }
}
/// The adapter's tick callback owns its own async executor. It reports
/// failures through the configured observability sink rather than panicking.
pub fn start_service_external_action_flusher<Tick>(
    is_local_authority: bool,
    no_github: bool,
    interval: Duration,
    tick: Tick,
) -> Option<FlusherHandle>
where Tick: Fn() + Send + 'static {
    if !is_local_authority || no_github { return None; }
    tick();
    let (cancel, receiver) = mpsc::channel();
    let thread = thread::spawn(move || {
        while receiver.recv_timeout(interval).is_err() { tick(); }
    });
    Some(FlusherHandle { cancel, thread: Some(thread) })
}
