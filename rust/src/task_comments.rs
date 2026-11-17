// Direct port of Node src/task-comments.ts: append-only Task comments, idempotent human feedback and lossless stale-snapshot reconciliation.
use crate::{js_text::trim_js, local_merge_lock::iso8601_now, observability::js_string};
use serde_json::{json, Value};
use std::{collections::HashSet, fs::File, io::Read};

fn uuid_v4() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    File::open("/dev/urandom")
        .map_err(|e| e.to_string())?
        .read_exact(&mut bytes)
        .map_err(|e| e.to_string())?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(format!("{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],bytes[1],bytes[2],bytes[3],bytes[4],bytes[5],bytes[6],bytes[7],
        bytes[8],bytes[9],bytes[10],bytes[11],bytes[12],bytes[13],bytes[14],bytes[15]))
}
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
        _ => true,
    }
}

pub fn append_task_comment(
    job: &mut Value,
    task_id: &str,
    message: &str,
    options: &Value,
) -> Result<Value, String> {
    let job_id = job
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("undefined")
        .to_string();
    let tasks = job
        .get_mut("tasks")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| format!("Task {task_id} not found"))?;
    let Some(task) = tasks
        .iter_mut()
        .find(|task| task.get("id").and_then(Value::as_str) == Some(task_id))
    else {
        return Err(format!("Task {task_id} not found"));
    };
    let text = trim_js(message);
    if text.is_empty() {
        return Err("task comment requires nonempty --message".into());
    }
    let config = if options.is_string() {
        json!({"author":options})
    } else if options.is_object() {
        options.clone()
    } else {
        json!({"author":"cli"})
    };
    let key = config.get("idempotencyKey").and_then(Value::as_str);
    if key.is_some_and(|key| !key.is_empty()) {
        if let Some(existing) = task
            .get("comments")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|comment| comment.get("idempotencyKey").and_then(Value::as_str) == key)
        {
            return Ok(existing.clone());
        }
    }
    let id = if let Some(key) = key {
        key.to_string()
    } else {
        uuid_v4()?
    };
    let author = config
        .get("author")
        .filter(|author| !author.is_null())
        .cloned()
        .unwrap_or(json!("cli"));
    let mut comment = json!({"id":id,"text":text,"author":author,"createdAt":iso8601_now(),"jobId":job_id,"taskId":task_id});
    for field in ["kind", "executionId", "transition"] {
        if truthy(config.get(field)) {
            comment[field] = config[field].clone();
        }
    }
    if key.is_some_and(|key| !key.is_empty()) {
        comment["idempotencyKey"] = json!(key);
    }
    let object = task
        .as_object_mut()
        .ok_or_else(|| format!("Task {task_id} not found"))?;
    let previous = object
        .get("comments")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut next = previous;
    next.push(comment.clone());
    object.insert("comments".into(), json!(next));
    Ok(comment)
}

pub fn task_comment_context(task: &Value) -> String {
    let comments = task.get("comments").and_then(Value::as_array);
    let Some(comments) = comments.filter(|comments| !comments.is_empty()) else {
        return String::new();
    };
    let text = comments
        .iter()
        .map(|comment| {
            let field = |key: &str| {
                comment
                    .get(key)
                    .map(js_string)
                    .unwrap_or_else(|| "undefined".into())
            };
            format!(
                "{} ({}, {}): {}",
                field("createdAt"),
                field("author"),
                field("id"),
                field("text")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!("\n\n[Task comments — append-only supplementary context]\n{text}")
}

pub fn preserve_task_comments(previous: &[Value], incoming: &[Value]) -> Vec<Value> {
    incoming
        .iter()
        .map(|task| {
            let mut task = task.clone();
            let prior = previous
                .iter()
                .find(|candidate| candidate.get("id") == task.get("id"));
            let Some(old) = prior
                .and_then(|prior| prior.get("comments"))
                .and_then(Value::as_array)
                .filter(|comments| !comments.is_empty())
            else {
                return task;
            };
            let mut comments = old.clone();
            let mut known = comments
                .iter()
                .filter_map(|value| value.get("id"))
                .map(js_string)
                .collect::<HashSet<_>>();
            for comment in task
                .get("comments")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let id = comment
                    .get("id")
                    .map(js_string)
                    .unwrap_or_else(|| "undefined".into());
                if known.insert(id) {
                    comments.push(comment.clone());
                }
            }
            task["comments"] = json!(comments);
            task
        })
        .collect()
}
