// Direct port of Node src/reconciler-pause.ts: cancel only executions already invalidated by durable pause state.
use serde_json::Value;

fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
        _ => true,
    }
}

/// The caller owns cancellation effects. This function only enumerates the
/// paused generation identities stored in the authoritative Job snapshot.
pub fn cancel_paused_generations(
    job: &Value,
    mut cancel_task: impl FnMut(&str, &str),
    mut cancel_plan: impl FnMut(&str),
) -> Result<(), String> {
    if !js_truthy(job.get("pause")) {
        return Ok(());
    }
    let tasks = job
        .get("tasks")
        .and_then(Value::as_array)
        .ok_or_else(|| "job.tasks is not iterable".to_string())?;
    for task in tasks {
        if js_truthy(task.get("pausedExecution")) {
            let task_id = task
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("undefined");
            let execution_id = task
                .get("pausedExecution")
                .and_then(|x| x.get("id"))
                .and_then(Value::as_str)
                .unwrap_or("undefined");
            cancel_task(task_id, execution_id);
        }
    }
    if let Some(plans) = job.get("plans").and_then(Value::as_array) {
        for plan in plans {
            if js_truthy(plan.get("pausedExecutionId")) {
                let plan_id = plan
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("undefined");
                cancel_plan(plan_id);
            }
        }
    }
    Ok(())
}
