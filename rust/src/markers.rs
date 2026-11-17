// Direct port of Node src/markers.ts: safe JSON HTML comment markers and legacy-compatible Job/Task/Plan/Agent bodies.
use crate::js_text::trim_js;
use crate::observability::{js_string, json_wire};
use regex::Regex;
use serde_json::{json, Value};
pub const JOB_MARKER: &str = "agents-relay:job:v1";
pub const TASK_MARKER: &str = "agents-relay:task:v1";
pub const PLAN_MARKER: &str = "agents-relay:plan:v1";
pub const AGENT_MARKER: &str = "agents-relay:agent:v1";
const JOB_OBJECTIVE_END: &str = "<!-- agents-relay:objective:end -->";
const TASK_INPUT_END: &str = "<!-- agents-relay:task-input:end -->";
fn str_field<'a>(record: &'a Value, key: &str) -> &'a str {
    record.get(key).and_then(Value::as_str).unwrap_or("")
}
fn js_value(record: &Value, key: &str) -> String {
    record
        .get(key)
        .map(js_string)
        .unwrap_or_else(|| "undefined".into())
}
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
        Some(Value::String(s)) => !s.is_empty(),
        _ => true,
    }
}
pub fn marker(label: &str, value: &Value) -> String {
    let serialized = json_wire(value).replace('>', r"\u003e");
    format!("<!-- {label} {serialized} -->")
}
pub fn parse_marker(body: &str, label: &str) -> Option<Value> {
    let expression = format!(r"<!--\s*{}\s+", regex::escape(label));
    let capture = Regex::new(&expression).ok()?.find(body)?;
    let mut end = body[capture.end()..]
        .find("-->")
        .map(|at| at + capture.end());
    while let Some(index) = end {
        let candidate = body[capture.end()..index].trim();
        if let Ok(json) = serde_json::from_str(candidate) {
            return Some(json);
        }
        end = body[index + 3..].find("-->").map(|at| at + index + 3);
    }
    None
}
fn section(body: &str, heading: &str) -> Option<String> {
    let start = body.find(heading)? + heading.len();
    Some(trim_js(&body[start..]).to_string())
}
fn content_before_delimiter(body: &str, heading: &str, end: &str) -> Option<String> {
    let start = body.find(heading)? + heading.len();
    let tail = &body[start..];
    let end_position = tail.find(&format!("\n{end}"))?;
    Some(tail[..end_position].to_string())
}
fn job_metadata(job: &Value) -> Value {
    let mut metadata = job.clone();
    if let Some(object) = metadata.as_object_mut() {
        for key in [
            "objective",
            "description",
            "tasks",
            "plans",
            "schedule",
            "executionMode",
            "contentOnly",
            "shortcutExecutionStartedAt",
            "shortcutRunnerContext",
            "shortcutExecutionDeadlineAt",
        ] {
            object.shift_remove(key);
        }
    }
    metadata
}
fn objective(job: &Value) -> String {
    job.get("objective")
        .and_then(Value::as_str)
        .map(trim_js)
        .filter(|text| !text.is_empty())
        .unwrap_or("_No objective recorded._")
        .into()
}
pub fn render_job_body(job: &Value) -> String {
    format!(
        "{}\n{}",
        marker(JOB_MARKER, &job_metadata(job)),
        objective(job)
    )
}
pub fn render_job_comment(job: &Value) -> String {
    format!(
        "{}\n# Agents Relay job: {}\n\n- **State:** {}\n- **PR:** #{}\n\n## Objective\n\n{}\n{}",
        marker(JOB_MARKER, &job_metadata(job)),
        js_value(job, "title"),
        js_value(job, "state"),
        js_value(job, "prNumber"),
        objective(job),
        JOB_OBJECTIVE_END
    )
}
pub fn render_task_comment(task: &Value) -> String {
    let summary = task
        .pointer("/result/summary")
        .and_then(Value::as_str)
        .map(trim_js)
        .unwrap_or("");
    let result = if summary.is_empty() {
        String::new()
    } else {
        format!("\n\n### Result\n\n{summary}")
    };
    let graph = str_field(task, "agentGraph");
    let graph = trim_js(graph);
    let graph = if graph.is_empty() {
        String::new()
    } else {
        format!("\n\n### Agent graph\n\n```mermaid\n{graph}\n```")
    };
    let mut metadata = task.clone();
    if let Some(object) = metadata.as_object_mut() {
        object.shift_remove("input");
    }
    let priority = task
        .get("priority")
        .filter(|value| !value.is_null())
        .map(js_string)
        .unwrap_or_else(|| "P2".into());
    format!(
        "{}\n## Task: {}\n\n- **State:** {}\n- **Priority:** {}\n{}\n\n### Work\n\n{}\n{}{}",
        marker(TASK_MARKER, &metadata),
        js_value(task, "id"),
        js_value(task, "state"),
        priority,
        graph,
        js_value(task, "input"),
        TASK_INPUT_END,
        result
    )
}
pub fn parse_job(body: &str) -> Option<Value> {
    let mut job = parse_marker(body, JOB_MARKER)?;
    let marker_end = body.find("-->");
    let body_objective = marker_end.and_then(|end| {
        let value = trim_js(&body[end + 3..]);
        (!value.is_empty()).then(|| value.to_string())
    });
    let chosen = job
        .get("objective")
        .filter(|value| !value.is_null())
        .cloned()
        .or_else(|| {
            job.get("description")
                .filter(|value| !value.is_null())
                .cloned()
        })
        .or_else(|| {
            content_before_delimiter(body, "\n## Objective\n\n", JOB_OBJECTIVE_END)
                .map(|value| json!(value))
        })
        .or_else(|| section(body, "\n## Objective\n").map(|value| json!(value)))
        .or_else(|| body_objective.map(|value| json!(value)));
    if let Some(object) = job.as_object_mut() {
        if let Some(value) = chosen {
            object.insert("objective".into(), value);
        } else {
            object.shift_remove("objective");
        }
        object.shift_remove("executionMode");
        object.shift_remove("schedule");
    }
    Some(job)
}
pub fn parse_task(body: &str) -> Option<Value> {
    let mut task = parse_marker(body, TASK_MARKER)?;
    let input = task
        .get("input")
        .filter(|value| !value.is_null())
        .cloned()
        .or_else(|| {
            content_before_delimiter(body, "\n### Work\n\n", TASK_INPUT_END)
                .map(|value| json!(value))
        })
        .or_else(|| {
            let work = section(body, "\n### Work\n")?;
            let suffix = task
                .pointer("/result/summary")
                .and_then(Value::as_str)
                .map(trim_js)
                .filter(|value| !value.is_empty())
                .map(|value| format!("\n\n### Result\n\n{value}"));
            Some(
                if let Some(suffix) = suffix.filter(|suffix| work.ends_with(suffix)) {
                    json!(trim_js(&work[..work.len() - suffix.len()]))
                } else {
                    json!(work)
                },
            )
        });
    let input = input?;
    if let Some(object) = task.as_object_mut() {
        object.insert("input".into(), input);
        let kind = if object.get("kind").and_then(Value::as_str) == Some("planner") {
            "planner"
        } else {
            "work"
        };
        object.insert("kind".into(), json!(kind));
    }
    Some(task)
}
pub fn render_plan_comment(plan: &Value) -> String {
    let mut metadata = plan.clone();
    if let Some(object) = metadata.as_object_mut() {
        object.shift_remove("planUrl");
    }
    let trigger = plan.get("trigger").unwrap_or(&Value::Null);
    let mut lines = vec![
        format!("- **State:** {}", js_value(plan, "status")),
        format!("- **Source:** {}", js_value(trigger, "source")),
    ];
    let array = |key: &str| {
        trigger
            .get(key)
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default()
    };
    let text_list = |items: &[Value]| items.iter().map(js_string).collect::<Vec<_>>().join(", ");
    if !array("taskIds").is_empty() {
        lines.push(format!(
            "- **Triggered tasks:** {}",
            text_list(array("taskIds"))
        ));
    }
    if truthy(trigger.get("reason")) {
        lines.push(format!("- **Reason:** {}", js_value(trigger, "reason")));
    }
    if !array("blockedHeadShas").is_empty() {
        lines.push(format!(
            "- **Blocked head(s):** {}",
            text_list(array("blockedHeadShas"))
        ));
    }
    if truthy(trigger.get("currentHeadSha")) {
        lines.push(format!(
            "- **Current head:** {}",
            js_value(trigger, "currentHeadSha")
        ));
    }
    let generated = plan
        .get("generatedTaskIds")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let generated = if generated.is_empty() {
        "- _No tasks generated._".into()
    } else {
        generated
            .iter()
            .map(|id| format!("- {}", js_string(id)))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let facts = array("facts");
    let facts = if facts.is_empty() {
        String::new()
    } else {
        format!(
            "\n\n### Change facts\n\n{}",
            facts
                .iter()
                .map(|fact| format!("- {}", js_string(fact)))
                .collect::<Vec<_>>()
                .join("\n")
        )
    };
    format!(
        "{}\n## Plan {}: {}\n\n{}{}\n\n### Assessment\n\n{}\n\n### Generated tasks\n\n{}",
        marker(PLAN_MARKER, &metadata),
        js_value(plan, "round"),
        js_value(plan, "id"),
        lines.join("\n"),
        facts,
        js_value(plan, "assessment"),
        generated
    )
}
pub fn parse_plan(body: &str) -> Option<Value> {
    let plan = parse_marker(body, PLAN_MARKER)?;
    let round = plan.get("round")?.as_f64()?;
    if !round.is_finite()
        || round.fract() != 0.0
        || !plan.get("jobId")?.is_string()
        || !plan.get("id")?.is_string()
    {
        return None;
    }
    Some(plan)
}
pub fn render_agent_comment(agent: &Value) -> String {
    format!(
        "{}\n## Registered agent {}\nRole: {}\nAvailability: {}",
        marker(AGENT_MARKER, agent),
        js_value(agent, "name"),
        js_value(agent, "role"),
        js_value(agent, "availability")
    )
}
pub fn parse_agent(body: &str) -> Option<Value> {
    parse_marker(body, AGENT_MARKER)
}
