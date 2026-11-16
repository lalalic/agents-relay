// Direct port of Node src/planner-task-title.ts: require a nonempty JS string with exactly 5–8 words.
use crate::js_text::{is_js_whitespace, trim_js};
use serde_json::Value;

pub fn required_planner_task_title(value: &Value, index: i64) -> Result<String, String> {
    let Some(raw) = value.as_str() else {
        return Err(format!("Planner next_tasks[{index}].title is required"));
    };
    let title = trim_js(raw);
    if title.is_empty() {
        return Err(format!("Planner next_tasks[{index}].title is required"));
    }
    let words = title
        .split(is_js_whitespace)
        .filter(|word| !word.is_empty())
        .count();
    if !(5..=8).contains(&words) {
        return Err(format!(
            "Planner next_tasks[{index}].title must contain 5–8 words (got {words})"
        ));
    }
    Ok(title.to_string())
}
