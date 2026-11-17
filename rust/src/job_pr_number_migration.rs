// Direct port of Node src/job-pr-number-migration.ts: normalize legacy PR number field and missing Task titles without changing other Job facts.
use crate::{js_text::trim_js, observability::json_wire, task_title::derive_task_title};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
/// Decode JSON wire text like JavaScript JSON.parse, which permits lone
/// UTF-16 surrogate escapes. Keep unpaired code units in the same private-use
/// scalar encoding already used by observability::json_wire so they round-trip
/// to the identical JSON escapes on SQLite writes. Proper surrogate pairs
/// remain untouched and are decoded to the original Unicode scalar.
pub fn parse_js_json(raw: &str) -> Result<Value, String> {
    fn hex_digit(value: u8) -> Option<u16> {
        match value {
            b'0'..=b'9' => Some(u16::from(value - b'0')),
            b'a'..=b'f' => Some(u16::from(value - b'a') + 10),
            b'A'..=b'F' => Some(u16::from(value - b'A') + 10),
            _ => None,
        }
    }
    fn unit(input: &[u8], index: usize) -> Option<u16> {
        if index + 6 > input.len() || input[index] != b'\\' || input[index + 1] != b'u' {
            return None;
        }
        let mut value = 0u16;
        for digit in &input[index + 2..index + 6] {
            value = value * 16 + hex_digit(*digit)?;
        }
        Some(value)
    }
    let bytes = raw.as_bytes();
    let mut output = String::with_capacity(raw.len());
    let mut i = 0usize;
    let mut in_string = false;
    while i < bytes.len() {
        if bytes[i] == b'"' {
            in_string = !in_string;
            output.push('"');
            i += 1;
            continue;
        }
        if in_string && bytes[i] == b'\\' {
            if let Some(code) = unit(bytes, i) {
                if (0xD800..=0xDBFF).contains(&code) {
                    if let Some(low) = unit(bytes, i + 6) {
                        if (0xDC00..=0xDFFF).contains(&low) {
                            output.push_str(&raw[i..i + 12]);
                            i += 12;
                            continue;
                        }
                    }
                }
                if (0xD800..=0xDFFF).contains(&code) {
                    let marker = char::from_u32(0xF0000 + u32::from(code - 0xD800))
                        .ok_or("invalid surrogate placeholder")?;
                    output.push(marker);
                    i += 6;
                    continue;
                }
                output.push_str(&raw[i..i + 6]);
                i += 6;
                continue;
            }
            if i + 1 < bytes.len() {
                output.push_str(&raw[i..i + 2]);
                i += 2;
                continue;
            }
        }
        let ch = raw[i..]
            .chars()
            .next()
            .ok_or("invalid JSON character boundary")?;
        output.push(ch);
        i += ch.len_utf8();
    }
    serde_json::from_str(&output).map_err(|error| error.to_string())
}
fn valid_integer(value: Option<&Value>) -> Option<f64> {
    let n = value?.as_f64()?;
    (n.is_finite() && n.fract() == 0.0).then_some(n)
}
fn utf16_title(input: &str, fallback: &str) -> String {
    char::decode_utf16(derive_task_title(input, fallback))
        .map(|entry| match entry {
            Ok(ch) => ch,
            Err(err) => {
                char::from_u32(0xF0000 + (err.unpaired_surrogate() as u32 - 0xD800)).unwrap_or('�')
            }
        })
        .collect()
}
pub fn normalize_legacy_job_pr_number(input: &Value) -> Value {
    let mut job = input.clone();
    let legacy = input
        .get("externalPrNumber")
        .and_then(|value| valid_integer(Some(value)))
        .filter(|n| *n > 0.0);
    if let Some(object) = job.as_object_mut() {
        let existing = valid_integer(object.get("prNumber"));
        if existing.is_none_or(|n| n <= 0.0) {
            if let Some(legacy) = legacy {
                object.insert("prNumber".into(), json!(legacy as i64));
            }
        }
        object.remove("externalPrNumber");
        if let Some(tasks) = object.get_mut("tasks").and_then(Value::as_array_mut) {
            for task in tasks {
                let needs_title = task
                    .get("title")
                    .and_then(Value::as_str)
                    .is_none_or(|title| trim_js(title).is_empty());
                if needs_title {
                    let fallback = task
                        .get("agentName")
                        .and_then(Value::as_str)
                        .filter(|name| !name.is_empty())
                        .map_or_else(|| "Task".to_string(), |name| format!("{name} task"));
                    let title = utf16_title(
                        task.get("input").and_then(Value::as_str).unwrap_or(""),
                        &fallback,
                    );
                    if let Some(object) = task.as_object_mut() {
                        object.insert("title".into(), json!(title));
                    }
                }
            }
        }
    }
    job
}
pub fn migrate_legacy_job_pr_numbers(db: &Connection) -> Result<(), String> {
    let mut select = db
        .prepare("SELECT job_id,json FROM job_snapshot")
        .map_err(|error| error.to_string())?;
    let rows = select
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(select);
    let mut update = db
        .prepare("UPDATE job_snapshot SET json=? WHERE job_id=?")
        .map_err(|error| error.to_string())?;
    for (id, raw) in rows {
        let job = parse_js_json(&raw)?;
        let normalized = normalize_legacy_job_pr_number(&job);
        let encoded = json_wire(&normalized);
        if encoded != raw {
            update
                .execute(params![encoded, id])
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}
