// Direct port of Node src/planner-history-cleanup.ts: parse and validate cleanup evidence.
use crate::js_text::trim_js;
use serde_json::{Map, Value};
use std::collections::HashSet;

fn record<'a>(value: &'a Value, field: &str) -> Result<&'a Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| format!("Planner {field} must be an object"))
}

fn required_text(value: Option<&Value>, field: &str) -> Result<String, String> {
    let text = value
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Planner {field} must be a non-empty string"))?;
    if trim_js(text).is_empty() {
        return Err(format!("Planner {field} must be a non-empty string"));
    }
    Ok(text.to_owned())
}

pub fn parse_planner_history_cleanup(value: &Value) -> Result<Option<Vec<Value>>, String> {
    let rows = value
        .as_array()
        .ok_or_else(|| "Planner history_cleanup must be an array when provided".to_owned())?;
    let mut ids = HashSet::new();
    let mut output = Vec::with_capacity(rows.len());
    for (index, item) in rows.iter().enumerate() {
        let field = format!("history_cleanup[{index}]");
        let row = record(item, &field)?;
        let task_id = required_text(row.get("taskId"), &format!("{field}.taskId"))?;
        let outcome = row
            .get("outcome")
            .and_then(Value::as_str)
            .unwrap_or("undefined");
        let evidence = required_text(row.get("evidence"), &format!("{field}.evidence"))?;
        let reason = required_text(row.get("reason"), &format!("{field}.reason"))?;
        if !["superseded", "invalid", "cancelled_review", "unresolved"].contains(&outcome) {
            return Err(format!("Planner {field}.outcome is invalid"));
        }
        if !ids.insert(task_id.clone()) {
            return Err(format!(
                "Planner history_cleanup contains duplicate Task {task_id}"
            ));
        }
        // Node checks only `=== undefined`: an explicit JSON null is invalid.
        let target = row
            .get("targetTaskId")
            .map(|value| required_text(Some(value), &format!("{field}.targetTaskId")))
            .transpose()?;
        if matches!(outcome, "superseded" | "invalid") && target.is_none() {
            return Err(format!(
                "Planner {field}.targetTaskId is required for {outcome}"
            ));
        }
        let mut clean = Map::new();
        clean.insert("taskId".into(), Value::String(task_id));
        clean.insert("outcome".into(), Value::String(outcome.into()));
        clean.insert("evidence".into(), Value::String(evidence));
        clean.insert("reason".into(), Value::String(reason));
        if let Some(target) = target {
            clean.insert("targetTaskId".into(), Value::String(target));
        }
        output.push(Value::Object(clean));
    }
    Ok(Some(output))
}
