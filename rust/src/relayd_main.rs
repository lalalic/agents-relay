// Node provenance: src/relayd-main.ts. The executable entrypoint forwards
// argv to the daemon and preserves a nonzero failure exit contract.
use std::future::Future;

/// The Rust daemon owns launch and exit. Main never introduces a second
/// lifecycle state machine and does not silently fallback to Node.js.
pub async fn run_relayd_main<Run, Fut>(args: Vec<String>, run_daemon: Run) -> i32
where
    Run: FnOnce(Vec<String>) -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    match run_daemon(args).await {
        Ok(()) => 0,
        Err(error) => { eprintln!("{error}"); 1 }
    }
}
