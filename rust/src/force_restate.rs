// Direct port of src/force-restate.ts. The canonical planning Graph has
// already authorized Force Restate. Delegate to the existing manual Plan Apply
// action with forceRestate=true; do not create a second planning policy.
use std::future::Future;
pub async fn execute_force_restate<Store, Launch, Apply, Fut, Output>(
    store: Store,
    job_id: &str,
    guidance: Option<&str>,
    timeout_ms: u64,
    launch_planner: Launch,
    execute_manual_plan: Apply,
) -> Result<Output, String>
where
    Apply: FnOnce(Store, &str, Option<&str>, u64, Launch, bool) -> Fut,
    Fut: Future<Output = Result<Output, String>>,
{
    execute_manual_plan(store, job_id, guidance, timeout_ms, launch_planner, true).await
}
#[cfg(test)]
mod tests {
    use super::execute_force_restate;
    use std::{
        future::Future,
        pin::pin,
        task::{Context, Poll, Waker},
    };
    fn run<T>(future: impl Future<Output = T>) -> T {
        let mut value = pin!(future);
        let mut context = Context::from_waker(Waker::noop());
        match value.as_mut().poll(&mut context) {
            Poll::Ready(done) => done,
            Poll::Pending => {
                panic!("native fake manual Plan apply must resolve without external I/O")
            }
        }
    }
    #[test]
    fn exact_manual_plan_contract_forces_restate_and_propagates_result() {
        let mut called = false;
        let result = run(execute_force_restate(
            7usize,
            "44",
            Some("replace all"),
            22000,
            (),
            |store, id, guidance, timeout, _, force| {
                called = true;
                assert_eq!(store, 7);
                assert_eq!(id, "44");
                assert_eq!(guidance, Some("replace all"));
                assert_eq!(timeout, 22000);
                assert!(force);
                let id = id.to_string();
                async move { Ok::<_, String>((id, timeout)) }
            },
        ));
        assert!(called);
        assert_eq!(result.unwrap(), ("44".to_string(), 22000));
        let result: Result<(), String> = run(execute_force_restate(
            (),
            "job",
            None,
            10,
            (),
            |_, _, _, _, _, force| {
                assert!(force);
                async { Err("manual Plan apply unavailable".into()) }
            },
        ));
        assert_eq!(result, Err("manual Plan apply unavailable".into()));
    }
}
