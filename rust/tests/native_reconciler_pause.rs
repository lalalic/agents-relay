// Native regressions for Node src/reconciler-pause.ts: only durable paused generations and ordered callback side-effect contracts.
use agents_relay_rust2::reconciler_pause::cancel_paused_generations;
use serde_json::{json, Value};
use std::cell::RefCell;
fn calls(job: &Value) -> Result<Vec<Value>, String> {
    let trace = RefCell::new(Vec::new());
    cancel_paused_generations(
        job,
        |task, execution| {
            trace
                .borrow_mut()
                .push(json!({"type":"task","task":task,"execution":execution}))
        },
        |plan| trace.borrow_mut().push(json!({"type":"plan","plan":plan})),
    )?;
    Ok(trace.into_inner())
}
#[test]
fn no_durable_pause_never_cancels_any_execution() {
    for pause in [Value::Null, json!(false), json!(0), json!("")] {
        let job = json!({"pause":pause,"tasks":[{"id":"1","pausedExecution":{"id":"exec"}}],"plans":[{"id":"p","pausedExecutionId":"e"}]});
        assert!(calls(&job).unwrap().is_empty());
    }
}
#[test]
fn selects_only_existing_paused_generations_and_orders_task_before_plan() {
    let job = json!({"pause":{"at":"2026-11-16T21:00:00Z"},"tasks":[
        {"id":"10","pausedExecution":{"id":"e10"}},
        {"id":"11","pausedExecution":null},
        {"id":"12","pausedExecution":{"id":"e12"}},
        {"id":"13"}
    ],"plans":[{"id":"p0","pausedExecutionId":""},{"id":"p1","pausedExecutionId":"pe1"}]});
    assert_eq!(
        calls(&job).unwrap(),
        vec![
            json!({"type":"task","task":"10","execution":"e10"}),
            json!({"type":"task","task":"12","execution":"e12"}),
            json!({"type":"plan","plan":"p1"})
        ]
    );
}
#[test]
fn missing_plans_are_optional_but_missing_tasks_fail_when_paused() {
    assert_eq!(
        calls(&json!({"pause":true,"tasks":[]})).unwrap(),
        Vec::<Value>::new()
    );
    assert_eq!(
        calls(&json!({"pause":true})).unwrap_err(),
        "job.tasks is not iterable"
    );
    assert!(calls(&json!({"pause":false})).unwrap().is_empty());
}
