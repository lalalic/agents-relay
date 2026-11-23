// Node provenance: src/planner-child-recovery.ts. Rebuild missing persisted
// Planner children using immutable historical plans, never replacing executions.
use serde_json::{json, Value};
use std::future::Future;

fn id(v: &Value) -> Option<&str> { v.get("id").and_then(Value::as_str) }
fn task_exists(job: &Value, task_id: &Value) -> bool {
    job.get("tasks").and_then(Value::as_array).is_some_and(|tasks|
        tasks.iter().any(|task| task.get("id") == Some(task_id)))
}
fn plan_exists(job: &Value, plan_id: &Value) -> bool {
    job.get("plans").and_then(Value::as_array).is_some_and(|plans|
        plans.iter().any(|plan| plan.get("id") == Some(plan_id)))
}

/// The callback materializes a child using the same execution-context and
/// Task factory as ordinary Planner results. It also applies any requested
/// Resolution classification, before this function persists the Task.
pub async fn recover_planner_children<Materialize, MFut, AppendPlan, PFut, SaveResolution, SFut, AppendTask, TFut>(
    job: &mut Value,
    mut materialize: Materialize,
    mut append_plan: AppendPlan,
    mut save_resolution: SaveResolution,
    mut append_task: AppendTask,
) -> Result<(), String>
where
    Materialize: FnMut(Value, Value, Value) -> MFut,
    MFut: Future<Output = Result<Value, String>>,
    AppendPlan: FnMut(Value) -> PFut,
    PFut: Future<Output = Result<(), String>>,
    SaveResolution: FnMut(Value) -> SFut,
    SFut: Future<Output = Result<(), String>>,
    AppendTask: FnMut(Value) -> TFut,
    TFut: Future<Output = Result<(), String>>,
{
    let plans = job.get("plans").and_then(Value::as_array).cloned().unwrap_or_default();
    for plan in plans {
        if plan.get("status").and_then(Value::as_str) != Some("SUCCEEDED") { continue; }
        let Some(specs) = plan.get("plannerResult")
            .and_then(|v| v.get("next_tasks")).and_then(Value::as_array) else {continue;};
        for spec in specs {
            let Some(spec_id) = spec.get("id") else {continue;};
            if task_exists(job, spec_id) {continue;}
            let child = materialize(job.clone(), plan.clone(), spec.clone()).await?;
            if spec.get("resolution").is_some_and(|v| !v.is_null()) {
                save_resolution(child.clone()).await?;
            }
            append_task(child.clone()).await?;
            job.get_mut("tasks").and_then(Value::as_array_mut)
                .ok_or("Job missing tasks array")?.push(child);
        }
    }
    let historical: Vec<Value> = job.get("tasks").and_then(Value::as_array)
        .cloned().unwrap_or_default().into_iter().filter(|task| {
        task.get("kind").and_then(Value::as_str) == Some("planner")
            && task.get("state").and_then(Value::as_str) == Some("SUCCEEDED")
            && task.get("plannerResult").is_some_and(|r| !r.is_null())
    }).collect();
    for planner in historical {
        let result = &planner["plannerResult"];
        let specs = result.get("next_tasks").and_then(Value::as_array)
            .ok_or("Persisted planner result missing next_tasks")?;
        let plan_id = planner.get("id").ok_or("Historical planner missing id")?;
        let plan = json!({
            "jobId": job.get("id"),
            "id": plan_id,
            "round": planner.get("planningRound").filter(|v| !v.is_null()).cloned().unwrap_or(json!(1)),
            "source": planner.get("planningSource").filter(|v| !v.is_null()).cloned().unwrap_or(json!("model-planner")),
            "previousPlanId": planner.get("previousPlannerTaskId"),
            "trigger": planner.get("planTrigger").filter(|v| !v.is_null()).cloned().unwrap_or(json!({"source":"continuation"})),
            "status":"SUCCEEDED",
            "guidance":planner.get("plannerGuidance"),
            "objectiveStatus":result.get("objective_status"),
            "plannerResult":result,
            "assessment":result.get("assessment"),
            "generatedTaskIds":specs.iter().filter_map(|s| s.get("id").cloned()).collect::<Vec<_>>(),
            "headSha":planner.get("planTrigger").and_then(|t| t.get("currentHeadSha"))
                .filter(|v| !v.is_null()).or_else(||job.get("headSha")),
            "attempt":planner.get("attempt"),
            "maxAttempts":planner.get("maxAttempts"),
            "executionId":null,
            "timeoutMs":planner.get("timeoutMs"),"manualPlanning":planner.get("manualPlanning"),
            "createdAt":planner.get("createdAt"),"updatedAt":planner.get("updatedAt")
        });
        if plan_exists(job, plan_id) {continue;}
        append_plan(plan.clone()).await?;
        let plans = job.get_mut("plans").and_then(Value::as_array_mut);
        if let Some(plans) = plans {plans.push(plan.clone());}
        else {job["plans"] = json!([plan.clone()]);}
        for spec in specs {
            let Some(spec_id) = spec.get("id") else {continue;};
            if task_exists(job, spec_id) {continue;}
            let child = materialize(job.clone(), plan.clone(), spec.clone()).await?;
            if spec.get("resolution").is_some_and(|v| !v.is_null()) {
                save_resolution(child.clone()).await?;
            }
            append_task(child.clone()).await?;
            job.get_mut("tasks").and_then(Value::as_array_mut)
                .ok_or("Job missing tasks array")?.push(child);
        }
    }
    Ok(())
}
