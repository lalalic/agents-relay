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

/// Original Node startServiceExternalActionFlusher public contract: the
/// enabled projection is flushed immediately, retried on a periodic timer,
/// triggers reconciliation only after positive projected changes, and sends
/// every asynchronous failure to an observational sink. This adapter binds
/// caller-owned Store/Reconciler methods; it never launches a provider by
/// default or changes durable state from a timer receipt.
pub fn start_service_external_action_flusher_with_ports<Flush,Reconcile,Report>(
    is_local_authority:bool,no_github:bool,interval:Duration,
    flush_once:Flush,reconcile:Reconcile,record_error:Report,
)->Option<FlusherHandle>
where
    Flush:Fn()->Result<usize,String>+Send+Sync+'static,
    Reconcile:Fn()->Result<(),String>+Send+Sync+'static,
    Report:Fn(&str)+Send+Sync+'static,
{
    // Match the Node no-op stop closure: disabled stores never even invoke
    // their external projection port.
    if !is_local_authority||no_github{return None;}
    let tick=move||{
        let result=flush_once().and_then(|projected|{
            if projected>0{reconcile()?;}Ok(())
        });
        if let Err(error)=result{record_error(&error);}
    };
    start_service_external_action_flusher(true,false,interval,tick)
}
