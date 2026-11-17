// Direct port of Node src/store-task-definition.ts: immutable Task/Plan field snapshots and deterministic same-ID definition conflict diagnosis.
use crate::observability::json_wire;
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;
#[derive(Clone, Debug)]
pub struct DurableDefinitionConflictError {
    pub name: &'static str,
    pub deterministic: bool,
    pub kind: String,
    pub operation: String,
    pub job_id: String,
    pub subject_id: String,
    pub local: Value,
    pub remote: Value,
    pub diverging_fields: Vec<String>,
}
impl DurableDefinitionConflictError {
    pub fn new(
        kind: &str,
        operation: &str,
        job_id: &str,
        subject_id: &str,
        local: &Value,
        remote: &Value,
        diverging_fields: &[String],
    ) -> Self {
        Self {
            name: "DurableDefinitionConflictError",
            deterministic: true,
            kind: kind.into(),
            operation: operation.into(),
            job_id: job_id.into(),
            subject_id: subject_id.into(),
            local: local.clone(),
            remote: remote.clone(),
            diverging_fields: diverging_fields.to_vec(),
        }
    }
}
impl std::fmt::Display for DurableDefinitionConflictError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} {} already exists with a different definition",
            if self.kind == "task" { "Task" } else { "Plan" },
            self.subject_id
        )
    }
}
impl std::error::Error for DurableDefinitionConflictError {}
pub fn is_durable_definition_conflict(error: &Value) -> bool {
    error.get("name").and_then(Value::as_str) == Some("DurableDefinitionConflictError")
}
fn field(input: &Value, key: &str, out: &mut Map<String, Value>) {
    if let Some(value) = input.get(key) {
        out.insert(key.into(), value.clone());
    }
}
fn immutable_task_definition(task: &Value) -> Value {
    let mut object = Map::new();
    for key in [
        "jobId",
        "id",
        "priority",
        "projectName",
        "agentName",
        "agentGraph",
        "planningDecisionId",
        "planningSource",
        "planningRound",
        "plannerGuidance",
        "manualPlanning",
        "parentTaskId",
        "dependencies",
        "capabilities",
        "workerRequirements",
        "workerSelection",
        "adapter",
        "input",
        "attachments",
        "output",
        "review",
        "maxAttempts",
        "timeoutMs",
    ] {
        field(task, key, &mut object);
    }
    object.insert(
        "storySize".into(),
        task.get("storySize")
            .filter(|value| !value.is_null())
            .cloned()
            .unwrap_or(json!("M")),
    );
    object.insert(
        "kind".into(),
        task.get("kind")
            .filter(|value| !value.is_null())
            .cloned()
            .unwrap_or(json!("work")),
    );
    object.insert(
        "chatgptTabClosePolicy".into(),
        task.get("chatgptTabClosePolicy")
            .filter(|value| !value.is_null())
            .cloned()
            .unwrap_or(json!("after-terminal")),
    );
    object.insert(
        "continuation".into(),
        task.get("continuation").cloned().unwrap_or(Value::Null),
    );
    if let Some(routing) = task
        .get("routing")
        .filter(|value| !value.is_null() && value != &&Value::Bool(false))
    {
        let mut selected = Map::new();
        for key in [
            "provider",
            "model",
            "profile",
            "reasoning",
            "cwd",
            "projectId",
        ] {
            field(routing, key, &mut selected);
        }
        object.insert("routing".into(), Value::Object(selected));
    }
    Value::Object(object)
}
pub fn plan_definition(plan: &Value) -> Value {
    let mut output = plan.clone();
    if let Some(object) = output.as_object_mut() {
        object.shift_remove("planUrl");
    }
    output
}
fn same_js_json(left: &Value, right: &Value) -> bool {
    json_wire(left) == json_wire(right)
}
pub fn same_task_definition(left: &Value, right: &Value) -> bool {
    same_js_json(
        &immutable_task_definition(left),
        &immutable_task_definition(right),
    )
}
pub fn same_plan_definition(left: &Value, right: &Value) -> bool {
    same_js_json(&plan_definition(left), &plan_definition(right))
}
pub fn diverging_definition_fields(kind: &str, left: &Value, right: &Value) -> Vec<String> {
    let l = if kind == "task" {
        immutable_task_definition(left)
    } else {
        plan_definition(left)
    };
    let r = if kind == "task" {
        immutable_task_definition(right)
    } else {
        plan_definition(right)
    };
    let lhs = l.as_object();
    let rhs = r.as_object();
    let keys = lhs
        .into_iter()
        .flat_map(|obj| obj.keys())
        .chain(rhs.into_iter().flat_map(|obj| obj.keys()))
        .cloned()
        .collect::<BTreeSet<_>>();
    keys.into_iter()
        .filter(|key| {
            let a = lhs.and_then(|obj| obj.get(key));
            let b = rhs.and_then(|obj| obj.get(key));
            match (a, b) {
                (None, None) => false,
                (Some(a), Some(b)) => !same_js_json(a, b),
                _ => true,
            }
        })
        .collect()
}
pub fn task_definition_divergence(left: &Value, right: &Value) -> Vec<String> {
    diverging_definition_fields("task", left, right)
}
pub fn plan_definition_divergence(left: &Value, right: &Value) -> Vec<String> {
    diverging_definition_fields("plan", left, right)
}
pub fn is_task_for_job(task: &Value, job_id: &str, sole_trusted_job: bool) -> bool {
    task.get("jobId").and_then(Value::as_str) == Some(job_id)
        || (task
            .get("jobId")
            .is_none_or(|value| value.is_null() || value.as_str() == Some(""))
            && sole_trusted_job)
}
