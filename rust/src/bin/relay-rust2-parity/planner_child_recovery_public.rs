// Original planner-child-recovery.ts public API differential: recovery of
// missing persisted Planner children from immutable historical plans and
// historical planner Tasks. Both stacks run their REAL materialize
// implementations (Rust planner::materialize_planner_child vs Node
// materializePlannerChild) with an empty-agent execution context.
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct Recorder {
    plans: Vec<Value>,
    tasks: Vec<Value>,
    resolutions: Vec<Value>,
}

pub fn invoke(request: &Value) -> Option<Result<String, String>> {
    if request["op"] != "certPlannerChildRecovery" {
        return None;
    }
    Some((|| {
        let directory = request["graphDirectory"].as_str()
            .unwrap_or("workflow").to_string();
        let recorder = Arc::new(Mutex::new(Recorder::default()));
        // The real Rust materialize path mirrors Node materializePlannerChild,
        // including agent validation over the execution context.
        let materialize = move |job: Value, plan: Value, spec: Value| {
            let directory = directory.clone();
            async move {
                agents_relay_rust2::planner::materialize_planner_child(
                    std::path::Path::new(&directory), &job, &plan, &spec,
                    &json!({"role":"planner","agents":[]}))
            }
        };
        let plan_rec = Arc::clone(&recorder);
        let append_plan = move |plan: Value| {
            let plan_rec = Arc::clone(&plan_rec);
            async move {
                plan_rec.lock().expect("recorder").plans.push(plan);
                Ok(())
            }
        };
        let save_rec = Arc::clone(&recorder);
        let save_resolution = move |task: Value| {
            let save_rec = Arc::clone(&save_rec);
            async move {
                save_rec.lock().expect("recorder").resolutions.push(task);
                Ok(())
            }
        };
        let task_rec = Arc::clone(&recorder);
        let append_task = move |task: Value| {
            let task_rec = Arc::clone(&task_rec);
            async move {
                task_rec.lock().expect("recorder").tasks.push(task);
                Ok(())
            }
        };
        // The parity binary is synchronous: drive the async recovery to
        // completion via now-or-never polling (all futures resolve
        // immediately). The mutated Job is returned through a shared slot so
        // the &mut borrow ends before serialization.
        let slot = Arc::new(Mutex::new(Value::Null));
        let slot_writer = Arc::clone(&slot);
        let mut run = move |job: Value| -> Result<(), String> {
            let mut job = job;
            let outcome = {
                let future = agents_relay_rust2::planner_child_recovery::recover_planner_children(
                    &mut job, materialize, append_plan, save_resolution, append_task);
                let mut future = std::pin::pin!(future);
                match std::future::Future::poll(
                    future.as_mut(),
                    &mut std::task::Context::from_waker(std::task::Waker::noop()),
                ) {
                    std::task::Poll::Ready(result) => result,
                    std::task::Poll::Pending => Err("recovery unexpectedly suspended".into()),
                }
            };
            outcome?;
            *slot_writer.lock().expect("slot") = job;
            Ok(())
        };
        let output = run(request["job"].clone());
        let guard = recorder.lock().expect("recorder");
        let job_out = slot.lock().expect("slot").clone();
        match output {
            Ok(()) => Ok(json!({"ok":true,
                "job":job_out,
                "appendedPlans":guard.plans,
                "appendedTasks":guard.tasks,
                "savedResolutions":guard.resolutions}).to_string()),
            Err(error) => Ok(json!({"ok":false,"error":error}).to_string()),
        }
    })())
}
