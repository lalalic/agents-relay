// Direct port of Node src/job-execution-slot.ts: only sibling DAG workers may share a Job's active slot.
use serde_json::Value;

fn field_is_non_null(value: &Value, key: &str) -> bool {
    // JavaScript compares !== null, so an absent property still counts as non-null.
    value.get(key) != Some(&Value::Null)
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Number(number)) => number.as_f64() != Some(0.0),
        Some(Value::String(text)) => !text.is_empty(),
        _ => true,
    }
}

fn occupies_slot(task: &Value) -> bool {
    if truthy(task.get("agentGraph"))
        && task
            .pointer("/result/data/dag/version")
            .and_then(Value::as_f64)
            == Some(1.0)
    {
        return false;
    }
    let state = task["state"].as_str().unwrap_or("");
    state != "AWAITING_DECISION"
        && (state == "RUNNING"
            || (field_is_non_null(task, "executionId")
                && !["SUCCEEDED", "FAILED", "CANCELLED"].contains(&state)))
}

fn planner_occupies(job: &Value, plan_id: Option<&str>) -> bool {
    job["plans"].as_array().is_some_and(|plans| {
        plans.iter().any(|plan| {
            plan["id"].as_str() != plan_id
                && field_is_non_null(plan, "executionId")
                && plan["status"] == "PLANNING"
        })
    })
}

pub fn job_has_active_execution(job: &Value, task_id: Option<&str>, plan_id: Option<&str>) -> bool {
    job["tasks"].as_array().is_some_and(|tasks| {
        tasks
            .iter()
            .any(|task| task["id"].as_str() != task_id && occupies_slot(task))
    }) || planner_occupies(job, plan_id)
}

pub fn job_has_conflicting_execution(job: &Value, candidate: &Value) -> bool {
    if !truthy(candidate.get("dagNode")) {
        return job_has_active_execution(job, candidate["id"].as_str(), None);
    }
    if planner_occupies(job, None) {
        return true;
    }
    job["tasks"].as_array().is_some_and(|tasks| {
        tasks.iter().any(|task| {
            task["id"] != candidate["id"]
                && occupies_slot(task)
                && task.pointer("/dagNode/parentTaskId")
                    != candidate.pointer("/dagNode/parentTaskId")
        })
    })
}
