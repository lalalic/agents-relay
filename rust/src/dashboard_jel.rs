// Direct port of Node src/dashboard-jel.ts: read-only durable JEL-to-Mermaid projection with exact task lineage, diagnostics and timing.
use chrono::{DateTime, Datelike, NaiveDate, NaiveDateTime, Timelike};
use regex::Regex;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    sync::OnceLock,
    time::{SystemTime, UNIX_EPOCH},
};

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
        Some(Value::String(s)) => !s.is_empty(),
        _ => true,
    }
}
fn js_integer(raw: Option<&Value>) -> Option<i64> {
    let value = raw?;
    if let Some(exact) = value.as_i64() {
        return Some(exact);
    }
    let float = value.as_f64()?;
    if float.is_finite()
        && float.fract() == 0.0
        && float >= i64::MIN as f64
        && float < i64::MAX as f64
    {
        Some(float as i64)
    } else {
        None
    }
}
fn js_strict_equal(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (Some(Value::Number(a)), Some(Value::Number(b))) => a.as_f64() == b.as_f64(),
        _ => left == right,
    }
}
fn js_value_string(value: &Value) -> String {
    if let Some(number) = js_integer(Some(value)) {
        return number.to_string();
    }
    if let Some(string) = value.as_str() {
        return string.to_string();
    }
    value.to_string()
}
fn field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}
fn nonempty<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    field(value, key).filter(|text| !text.is_empty())
}
fn js_trim(s: &str) -> &str {
    crate::js_text::trim_js(s)
}
// A Node String.slice can bisect an astral letter's UTF-16 surrogate pair.
// Rust String cannot represent an unpaired surrogate, so use one-to-one
// supplementary Private Use markers in the internal diagram only. The public
// renderer replaces them with U+FFFD; JSON wire output emits the exact high
// surrogate escape, preserving Node behavior for the external consumer.
const SURROGATE_MARKER_START: u32 = 0xF0000;
fn is_surrogate_marker(ch: char) -> bool {
    (SURROGATE_MARKER_START..SURROGATE_MARKER_START + 1024).contains(&(ch as u32))
}
fn allow_len(s: &str, max: usize) -> String {
    let mut len = 0usize;
    let mut result = String::new();
    for ch in s.chars() {
        let width = if is_surrogate_marker(ch) {
            1
        } else {
            ch.len_utf16()
        };
        if len + width > max {
            if len + 1 == max && width == 2 {
                let mut units = [0u16; 2];
                ch.encode_utf16(&mut units);
                let high = units[0] as u32;
                let marker = char::from_u32(SURROGATE_MARKER_START + high - 0xD800)
                    .expect("valid surrogate marker");
                result.push(marker);
            }
            break;
        }
        result.push(ch);
        len += width;
    }
    result
}

fn safe(value: &str) -> String {
    static URL: OnceLock<Regex> = OnceLock::new();
    static INVALID: OnceLock<Regex> = OnceLock::new();
    let url=URL.get_or_init(||Regex::new(r"(?i)https?://[^\x09-\x0D\x20\u{00A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]*").expect("constant JS-url sanitizer"));
    let invalid = INVALID.get_or_init(|| {
        Regex::new(r"[^\p{L}\p{N} _./()—:-]").expect("constant JEL title sanitizer")
    });
    let no_url = url.replace_all(value, "");
    allow_len(invalid.replace_all(&no_url, "").as_ref(), 100)
}

fn parse_js_date(text: &str) -> Option<i64> {
    if let Ok(date) = DateTime::parse_from_rfc3339(text) {
        return Some(date.timestamp_millis());
    }
    if let Ok(date) = DateTime::parse_from_rfc2822(text) {
        return Some(date.timestamp_millis());
    }
    // ECMA Date.parse uses the local timezone for ISO date-times without an
    // explicit offset. A date-only YYYY-MM-DD, by contrast, is interpreted UTC.
    fn local_time(date: NaiveDateTime) -> Option<i64> {
        let mut parts = unsafe { std::mem::zeroed::<libc::tm>() };
        parts.tm_year = date.year() - 1900;
        parts.tm_mon = i32::try_from(date.month()).ok()? - 1;
        parts.tm_mday = i32::try_from(date.day()).ok()?;
        parts.tm_hour = i32::try_from(date.hour()).ok()?;
        parts.tm_min = i32::try_from(date.minute()).ok()?;
        parts.tm_sec = i32::try_from(date.second()).ok()?;
        parts.tm_isdst = -1;
        let stamp = unsafe { libc::mktime(&mut parts) };
        (stamp as i64)
            .checked_mul(1000)?
            .checked_add(i64::from(date.and_utc().timestamp_subsec_millis()))
    }
    for pattern in [
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
    ] {
        if let Ok(date) = NaiveDateTime::parse_from_str(text, pattern) {
            return local_time(date);
        }
    }
    if let Ok(date) = NaiveDate::parse_from_str(text, "%Y-%m-%d") {
        return date
            .and_hms_opt(0, 0, 0)
            .map(|time| time.and_utc().timestamp_millis());
    }
    None
}
fn instant(raw: Option<&Value>, now: i64) -> Option<i64> {
    let text = raw?.as_str().filter(|text| !text.is_empty())?;
    let parsed = parse_js_date(text)?;
    (parsed <= now).then_some(parsed)
}
fn elapsed_ms(from: Option<i64>, to: Option<i64>) -> String {
    let (Some(from), Some(to)) = (from, to) else {
        return "—".into();
    };
    if to < from {
        return "—".into();
    }
    let seconds = (to - from) / 1000;
    if seconds < 60 {
        return format!("{seconds}s");
    }
    let minutes = seconds / 60;
    if minutes < 60 {
        return format!("{minutes}m{:02}s", seconds % 60);
    }
    let hours = minutes / 60;
    if hours < 24 {
        return format!("{hours}h{:02}m", minutes % 60);
    }
    format!("{}d{:02}h", hours / 24, hours % 24)
}
fn elapsed(start: Option<&Value>, end: Option<&Value>, now: i64) -> String {
    let from = instant(start, now);
    let to = if end.and_then(Value::as_str) == Some("NOW") {
        Some(now)
    } else {
        instant(end, now)
    };
    elapsed_ms(from, to)
}
fn terminal_task(task: &Value) -> bool {
    matches!(
        field(task, "state"),
        Some("SUCCEEDED" | "FAILED" | "CANCELLED")
    )
}
fn work_elapsed(indices: &[usize], tasks: &[Value], now: i64) -> String {
    if indices.is_empty() {
        return "—".into();
    }
    let starts = indices
        .iter()
        .filter_map(|&index| instant(tasks[index].get("createdAt"), now))
        .collect::<Vec<_>>();
    if starts.len() != indices.len() {
        return "—".into();
    }
    let ends = indices
        .iter()
        .filter_map(|&index| instant(tasks[index].get("updatedAt"), now))
        .collect::<Vec<_>>();
    let to = if indices.iter().all(|&index| terminal_task(&tasks[index]))
        && ends.len() == indices.len()
    {
        ends.iter().copied().max()
    } else {
        Some(now)
    };
    elapsed_ms(starts.iter().copied().min(), to)
}
fn add_node(lines: &mut Vec<String>, id: &str, label: &str, time: &str) {
    lines.push(format!(
        "  {id}[\"{} ({})\"]",
        allow_len(&safe(label), 80),
        safe(time)
    ));
}
fn add_edge(lines: &mut Vec<String>, from: &str, to: &str, reason: &str) {
    let label = if reason.is_empty() {
        String::new()
    } else {
        format!("|{}|", safe(reason))
    };
    lines.push(format!("  {from} -->{label} {to}"));
}
fn task_node_id(index: usize) -> String {
    format!("task_{index}")
}
fn task_name(task: &Value, default: &str) -> String {
    for key in ["title", "agentName", "id"] {
        if let Some(value) = nonempty(task, key) {
            let text = if key == "id" { value } else { js_trim(value) };
            if !text.is_empty() {
                return text.to_string();
            }
        }
    }
    default.to_string()
}
fn task_elapsed(task: &Value, now: i64) -> String {
    let end = if terminal_task(task) {
        task.get("updatedAt")
    } else {
        Some(&Value::String("NOW".into()))
    };
    let name = field(task, "agentName").unwrap_or("");
    let coordinator = field(task, "kind")
        .unwrap_or("")
        .eq_ignore_ascii_case("coordinator")
        || (name.to_ascii_lowercase().contains("coordinator") && !truthy(task.get("dagNode")))
        || truthy(task.get("agentGraph"));
    if !coordinator {
        let attempt = task.get("attempt");
        if let Some(history) = task.get("executionHistory").and_then(Value::as_array) {
            if let Some(last) = history
                .iter()
                .rev()
                .find(|record| js_strict_equal(record.get("attempt"), attempt))
            {
                let run = elapsed(last.get("startedAt"), end, now);
                if run != "—" {
                    return run;
                }
            }
        }
    }
    elapsed(task.get("createdAt"), end, now)
}
fn task_nodes(lines: &mut Vec<String>, stage: &str, work: &[usize], tasks: &[Value], now: i64) {
    let by_id = work
        .iter()
        .filter_map(|&index| nonempty(&tasks[index], "id").map(|id| (id.to_string(), index)))
        .collect::<HashMap<_, _>>();
    for &index in work {
        let task = &tasks[index];
        let id = task_node_id(index);
        add_node(
            lines,
            &id,
            &task_name(task, "Task"),
            &task_elapsed(task, now),
        );
        if field(task, "state") == Some("FAILED") {
            lines.push(format!("  class {id} jelFailed"));
        } else if task
            .get("attempt")
            .and_then(Value::as_f64)
            .is_some_and(|value| value > 1.0)
        {
            lines.push(format!("  class {id} jelRetry"));
        }
        let parent = field(task, "parentTaskId").and_then(|name| by_id.get(name).copied());
        if let Some(parent) = parent {
            add_edge(lines, &task_node_id(parent), &id, "DAG child");
        } else {
            lines.push(format!("  {stage} -.-> {id}"));
        }
        if let Some(dependencies) = task.get("dependencies").and_then(Value::as_array) {
            for dep in dependencies {
                if let Some(upstream) = dep.as_str().and_then(|name| by_id.get(name)) {
                    if Some(*upstream) != parent {
                        add_edge(lines, &task_node_id(*upstream), &id, "depends");
                    }
                }
            }
        }
    }
}
fn diagnostic(
    lines: &mut Vec<String>,
    suffix: &str,
    kind: &str,
    label: &str,
    time: &str,
    origin: Option<usize>,
    execute_id: &str,
) {
    let prefix = format!("  {kind}_{suffix}_");
    let count = lines
        .iter()
        .filter(|line| line.starts_with(&prefix))
        .count();
    let id = format!("{kind}_{suffix}_{count}");
    add_node(lines, &id, label, time);
    lines.push(format!(
        "  {} -.-> {id}",
        origin
            .map(task_node_id)
            .unwrap_or_else(|| execute_id.to_string())
    ));
    let mut parts = kind.chars();
    let class = format!(
        "jel{}{}",
        parts.next().unwrap_or('x').to_ascii_uppercase(),
        parts.as_str()
    );
    lines.push(format!("  class {id} {class}"));
}
fn diagnostics(
    lines: &mut Vec<String>,
    execute_id: &str,
    suffix: &str,
    work: &[usize],
    troubleshoot: &[usize],
    tasks: &[Value],
    now: i64,
) {
    let mut failed = HashSet::new();
    for &index in work {
        let task = &tasks[index];
        if field(task, "state") == Some("FAILED") {
            let attempt = task
                .get("attempt")
                .filter(|value| !value.is_null())
                .map(js_value_string)
                .unwrap_or_else(|| "?".into());
            failed.insert(format!(
                "{}:{attempt}",
                nonempty(task, "id").unwrap_or("unknown")
            ));
            diagnostic(
                lines,
                suffix,
                "failed",
                "Failed",
                &elapsed(task.get("createdAt"), task.get("updatedAt"), now),
                Some(index),
                execute_id,
            );
        }
        if let Some(attempt) = task
            .get("attempt")
            .and_then(|value| js_integer(Some(value)))
            .filter(|value| *value > 1)
        {
            let last = task
                .get("executionHistory")
                .and_then(Value::as_array)
                .and_then(|history| {
                    history
                        .iter()
                        .rev()
                        .find(|item| js_integer(item.get("attempt")) == Some(attempt))
                });
            let end = if terminal_task(task) {
                task.get("updatedAt")
            } else {
                None
            };
            let duration = if terminal_task(task) {
                elapsed(last.and_then(|item| item.get("startedAt")), end, now)
            } else {
                elapsed_ms(
                    instant(last.and_then(|item| item.get("startedAt")), now),
                    Some(now),
                )
            };
            diagnostic(
                lines,
                suffix,
                "retry",
                "Retry",
                &duration,
                Some(index),
                execute_id,
            );
        }
    }
    for &index in troubleshoot {
        let task = &tasks[index];
        let parent = field(task, "parentTaskId").and_then(|id| {
            work.iter()
                .copied()
                .find(|index| field(&tasks[*index], "id") == Some(id))
        });
        if let Some(parent) = parent {
            if let Some(attempt) = task
                .get("recoveryForAttempt")
                .and_then(|value| js_integer(Some(value)))
                .filter(|attempt| *attempt > 0)
            {
                let key = format!(
                    "{}:{attempt}",
                    nonempty(&tasks[parent], "id").unwrap_or("unknown")
                );
                if failed.insert(key) {
                    diagnostic(
                        lines,
                        suffix,
                        "failed",
                        "Failed",
                        "—",
                        Some(parent),
                        execute_id,
                    );
                }
            }
        }
        diagnostic(
            lines,
            suffix,
            "troubleshooter",
            &task_name(task, "Troubleshooter"),
            &work_elapsed(&[index], tasks, now),
            parent,
            execute_id,
        );
    }
}
fn finish(mut lines: Vec<String>) -> String {
    lines.push(
        "  classDef jelFailed fill:#fee2e2,stroke:#b91c1c,color:#991b1b,stroke-width:2px".into(),
    );
    lines.push(
        "  classDef jelRetry fill:#ede9fe,stroke:#7c3aed,color:#5b21b6,stroke-width:2px".into(),
    );
    lines.push(
        "  classDef jelTroubleshooter fill:#fef3c7,stroke:#b45309,color:#92400e,stroke-width:2px"
            .into(),
    );
    lines.push(
        "  classDef jelReviewer fill:#dbeafe,stroke:#2563eb,color:#1e40af,stroke-width:2px".into(),
    );
    lines.join("\n")
}

fn job_jel_diagram_internal_at(job: &Value, now: i64) -> String {
    let mut lines = vec!["flowchart LR".into()];
    let tasks = job
        .get("tasks")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let plans = job
        .get("plans")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let job_end = if matches!(field(job, "state"), Some("COMPLETED" | "CANCELLED")) {
        job.get("updatedAt")
    } else {
        None
    };
    let job_end_time = if matches!(field(job, "state"), Some("COMPLETED" | "CANCELLED")) {
        instant(job_end, now)
    } else {
        Some(now)
    };
    let first_plan = plans.first().and_then(|plan| nonempty(plan, "createdAt"));
    let first_task = tasks
        .iter()
        .filter_map(|task| nonempty(task, "createdAt"))
        .min();
    let first = first_plan.or(first_task);
    let first_start = if let Some(first) = first {
        parse_js_date(first).filter(|stamp| *stamp <= now)
    } else {
        job_end_time
    };
    add_node(
        &mut lines,
        "created",
        "Create",
        &elapsed_ms(instant(job.get("createdAt"), now), first_start),
    );
    let rounds = if plans.is_empty() {
        vec![serde_json::json!({"id":"","round":1,"status":"NOT STARTED","generatedTaskIds":[]})]
    } else {
        plans.to_vec()
    };
    let mut previous = "created".to_string();
    let mut allocated = HashSet::<String>::new();
    for (i, plan) in rounds.iter().enumerate() {
        let number = plan
            .get("round")
            .and_then(|value| js_integer(Some(value)))
            .filter(|value| *value > 0)
            .unwrap_or(i as i64 + 1);
        let suffix = (i + 1).to_string();
        let plan_id = format!("plan_{suffix}");
        let execute_id = format!("execute_{suffix}");
        let review_id = format!("review_{suffix}");
        let mut assigned = plan
            .get("generatedTaskIds")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect::<HashSet<_>>();
        let candidates = (0..tasks.len())
            .filter(|&index| {
                !matches!(
                    field(&tasks[index], "agentName"),
                    Some("reviewer" | "job-acceptance-reviewer" | "troubleshooter")
                )
            })
            .collect::<Vec<_>>();
        if !plans.is_empty() {
            for &index in &candidates {
                let task = &tasks[index];
                if (task.get("planningDecisionId") == plan.get("id"))
                    || task
                        .get("planningRound")
                        .and_then(|value| js_integer(Some(value)))
                        == Some(number)
                {
                    assigned.insert(field(task, "id").unwrap_or("").to_string());
                }
            }
            for _ in 0..candidates.len() {
                let mut changed = false;
                for &index in &candidates {
                    let task = &tasks[index];
                    if let Some(parent) = nonempty(task, "parentTaskId") {
                        let id = field(task, "id").unwrap_or("");
                        if assigned.contains(parent) && assigned.insert(id.to_string()) {
                            changed = true;
                        }
                    }
                }
                if !changed {
                    break;
                }
            }
        }
        let work = candidates
            .into_iter()
            .filter(|&index| {
                if plans.is_empty() {
                    return true;
                }
                let id = field(&tasks[index], "id").unwrap_or("");
                !allocated.contains(id) && (assigned.contains(id) || i == rounds.len() - 1)
            })
            .collect::<Vec<_>>();
        for &index in &work {
            if let Some(id) = nonempty(&tasks[index], "id") {
                allocated.insert(id.to_string());
            }
        }
        if !plans.is_empty() {
            let to = if field(plan, "status") == Some("PLANNING") {
                Some(now)
            } else {
                instant(plan.get("updatedAt"), now)
            };
            add_node(
                &mut lines,
                &plan_id,
                &format!("Plan {number}"),
                &elapsed_ms(instant(plan.get("createdAt"), now), to),
            );
        }
        add_node(
            &mut lines,
            &execute_id,
            &format!("Execute {number}"),
            &work_elapsed(&work, tasks, now),
        );
        let ids = work
            .iter()
            .filter_map(|&index| nonempty(&tasks[index], "id"))
            .collect::<HashSet<_>>();
        let troubleshoot = (0..tasks.len())
            .filter(|&index| {
                let task = &tasks[index];
                field(task, "agentName") == Some("troubleshooter")
                    && (nonempty(task, "parentTaskId").is_some_and(|parent| ids.contains(parent))
                        || (plan.get("id").is_some()
                            && task.get("planningDecisionId") == plan.get("id"))
                        || plans.is_empty())
            })
            .collect::<Vec<_>>();
        task_nodes(&mut lines, &execute_id, &work, tasks, now);
        diagnostics(
            &mut lines,
            &execute_id,
            &suffix,
            &work,
            &troubleshoot,
            tasks,
            now,
        );
        let next_plan = plans.get(i + 1);
        let review_tasks = (0..tasks.len())
            .filter(|&index| {
                let task = &tasks[index];
                if !matches!(
                    field(task, "agentName"),
                    Some("job-acceptance-reviewer" | "reviewer")
                ) {
                    return false;
                }
                if plans.is_empty() {
                    return true;
                }
                let Some(created) = instant(task.get("createdAt"), now) else {
                    return false;
                };
                let Some(start) = instant(plan.get("createdAt"), now) else {
                    return false;
                };
                if created < start {
                    return false;
                }
                let Some(next) = next_plan.and_then(|next| nonempty(next, "createdAt")) else {
                    return true;
                };
                parse_js_date(next)
                    .filter(|date| *date <= now)
                    .is_some_and(|date| created < date)
            })
            .collect::<Vec<_>>();
        add_node(
            &mut lines,
            &review_id,
            &format!("Final Review {number}"),
            &work_elapsed(&review_tasks, tasks, now),
        );
        for &index in &review_tasks {
            let task = &tasks[index];
            let id = task_node_id(index);
            add_node(
                &mut lines,
                &id,
                &task_name(task, "Final Review"),
                &task_elapsed(task, now),
            );
            lines.push(format!("  {review_id} -.-> {id}"));
            lines.push(format!(
                "  class {id} {}",
                if field(task, "state") == Some("FAILED") {
                    "jelFailed"
                } else {
                    "jelReviewer"
                }
            ));
        }
        if !plans.is_empty() {
            add_edge(
                &mut lines,
                &previous,
                &plan_id,
                if i > 0
                    && plan.pointer("/trigger/source").and_then(Value::as_str) == Some("review")
                {
                    "changes required"
                } else {
                    ""
                },
            );
            add_edge(&mut lines, &plan_id, &execute_id, "");
        } else {
            add_edge(&mut lines, &previous, &execute_id, "");
        }
        add_edge(&mut lines, &execute_id, &review_id, "");
        previous = review_id;
    }
    let local_status = job.pointer("/localMerge/status").and_then(Value::as_str);
    let publication_version = job.pointer("/publication/version");
    let merge = if local_status == Some("failed") {
        "FAILED"
    } else if local_status == Some("succeeded")
        || field(job, "githubState") == Some("MERGED")
        || truthy(publication_version)
    {
        "DONE"
    } else if field(job, "state") == Some("COMPLETED") {
        "NOT RECORDED"
    } else {
        "PENDING"
    };
    let merge_start = if job.pointer("/review/outcome").and_then(Value::as_str) == Some("approved")
    {
        job.pointer("/review/updatedAt")
    } else {
        None
    };
    let merge_end = if merge == "DONE" {
        job.pointer("/localMerge/updatedAt")
            .filter(|item| truthy(Some(item)))
            .or_else(|| job.get("mergedAt"))
    } else {
        None
    };
    let merge_end_time = if merge == "PENDING" && truthy(merge_start) {
        Some(now)
    } else {
        instant(merge_end, now)
    };
    add_node(
        &mut lines,
        "merge",
        "Merge",
        &elapsed_ms(instant(merge_start, now), merge_end_time),
    );
    add_node(
        &mut lines,
        "finished",
        "Job",
        &elapsed_ms(instant(job.get("createdAt"), now), job_end_time),
    );
    add_edge(&mut lines, &previous, "merge", "");
    add_edge(&mut lines, "merge", "finished", "");
    finish(lines)
}

/// Native renderable output: invalid JS surrogate slices display as U+FFFD.
pub fn job_jel_diagram_at(job: &Value, now: i64) -> String {
    job_jel_diagram_internal_at(job, now)
        .chars()
        .map(|ch| {
            if is_surrogate_marker(ch) {
                '\u{fffd}'
            } else {
                ch
            }
        })
        .collect()
}

/// Exact JSON transport, including a `\uD800`-style JS lone surrogate when
/// a title gets cut between UTF-16 halves at the 80-unit display boundary.
pub fn job_jel_diagram_json_wire_at(job: &Value, now: i64) -> String {
    let raw = job_jel_diagram_internal_at(job, now);
    if !raw.chars().any(is_surrogate_marker) {
        return serde_json::to_string(&raw).expect("valid Mermaid string");
    }
    let mut output = String::from("\"");
    let mut segment = String::new();
    let flush = |output: &mut String, segment: &mut String| {
        if segment.is_empty() {
            return;
        }
        let encoded = serde_json::to_string(segment).expect("valid UTF-8 fragment");
        output.push_str(&encoded[1..encoded.len() - 1]);
        segment.clear();
    };
    for ch in raw.chars() {
        if is_surrogate_marker(ch) {
            flush(&mut output, &mut segment);
            output.push_str(&format!(
                "\\u{:04x}",
                0xD800 + (ch as u32 - SURROGATE_MARKER_START)
            ));
        } else {
            segment.push(ch);
        }
    }
    flush(&mut output, &mut segment);
    output.push('"');
    output
}

pub fn job_jel_diagram(job: &Value) -> String {
    job_jel_diagram_at(job, now_ms())
}
