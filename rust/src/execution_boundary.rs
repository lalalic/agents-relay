// Node provenance: src/execution-boundary.ts; serializes async work by job/task generation key.
use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, OnceLock};
use std::task::{Context, Poll, Waker};

#[derive(Default)]
struct Gate {
    held: bool,
    waiters: Vec<Waker>,
}
static GATES: OnceLock<Mutex<HashMap<String, Arc<Mutex<Gate>>>>> = OnceLock::new();
fn gates() -> &'static Mutex<HashMap<String, Arc<Mutex<Gate>>>> {
    GATES.get_or_init(|| Mutex::new(HashMap::new()))
}
struct Permit {
    key: String,
    gate: Arc<Mutex<Gate>>,
}
impl Drop for Permit {
    fn drop(&mut self) {
        let mut gate = self.gate.lock().unwrap();
        gate.held = false;
        for w in gate.waiters.drain(..) {
            w.wake();
        }
        let mut all = gates().lock().unwrap();
        if Arc::strong_count(&self.gate) == 2 {
            all.remove(&self.key);
        }
    }
}
struct Acquire {
    key: String,
    gate: Arc<Mutex<Gate>>,
}
impl Future for Acquire {
    type Output = Permit;
    fn poll(self: std::pin::Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Permit> {
        let mut g = self.gate.lock().unwrap();
        if !g.held {
            g.held = true;
            Poll::Ready(Permit {
                key: self.key.clone(),
                gate: self.gate.clone(),
            })
        } else {
            g.waiters.push(cx.waker().clone());
            Poll::Pending
        }
    }
}
pub async fn with_execution_boundary<T, F>(job_id: &str, task_id: &str, work: F) -> T
where
    F: Future<Output = T>,
{
    let key = format!("{job_id}/{task_id}");
    let gate = {
        let mut all = gates().lock().unwrap();
        all.entry(key.clone())
            .or_insert_with(|| Arc::new(Mutex::new(Gate::default())))
            .clone()
    };
    let _permit = Acquire { key, gate }.await;
    work.await
}
