// Direct port of Node src/github-runtime-usage.ts: read-only rate-limit interpretation and gh response header parsing.
use crate::{js_text::trim_js, observability::slice_utf16_wire};
use chrono::{DateTime, NaiveDate, NaiveDateTime, SecondsFormat, TimeZone, Utc};
use regex::Regex;
use serde_json::{json, Value};
use std::sync::OnceLock;

fn number(value: Option<&Value>) -> Option<f64> {
    let s = value?.as_str()?;
    if s.is_empty() {
        return None;
    }
    let value = trim_js(s);
    let parsed = if value.is_empty() {
        Some(0.0)
    } else if let Some(hex) = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
    {
        u64::from_str_radix(hex, 16).ok().map(|x| x as f64)
    } else if let Some(binary) = value
        .strip_prefix("0b")
        .or_else(|| value.strip_prefix("0B"))
    {
        u64::from_str_radix(binary, 2).ok().map(|x| x as f64)
    } else {
        value.parse::<f64>().ok()
    };
    parsed.filter(|n| n.is_finite())
}
fn json_number(value: Option<f64>) -> Value {
    match value {
        Some(n) if n.fract() == 0.0 && n >= i64::MIN as f64 && n < i64::MAX as f64 => {
            json!(n as i64)
        }
        Some(n) => json!(n),
        None => Value::Null,
    }
}
fn header_number(headers: &Value, key: &str) -> Option<f64> {
    number(headers.get(key))
}
fn iso_from_millis(ms: f64) -> Result<String, String> {
    if !ms.is_finite() || ms.abs() > 8_640_000_000_000_000.0 {
        return Err("Invalid time value".into());
    }
    let milliseconds = ms.trunc() as i64;
    let timestamp = Utc
        .timestamp_millis_opt(milliseconds)
        .single()
        .ok_or("Invalid time value")?;
    Ok(timestamp.to_rfc3339_opts(SecondsFormat::Millis, true))
}
fn iso_date_parse(s: &str) -> Result<i64, String> {
    if let Ok(value) = DateTime::parse_from_rfc3339(s) {
        return Ok(value.timestamp_millis());
    }
    if let Ok(value) = NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S") {
        return Ok(value.and_utc().timestamp_millis());
    }
    if let Ok(value) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return Ok(value
            .and_hms_opt(0, 0, 0)
            .ok_or("Invalid time value")?
            .and_utc()
            .timestamp_millis());
    }
    Err("Invalid time value".into())
}
fn reason_regex() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| Regex::new("(?i)rate limit|secondary rate|graphql_rate_limit").unwrap())
}
fn secondary_regex() -> &'static Regex {
    static VALUE: OnceLock<Regex> = OnceLock::new();
    VALUE.get_or_init(|| Regex::new("(?i)secondary rate").unwrap())
}
fn short_reason(value: &Value) -> String {
    let mut fragments = Vec::new();
    for key in ["body", "stderr"] {
        if let Some(text) = value
            .get(key)
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
        {
            fragments.push(text);
        }
    }
    let full = fragments.join("\n");
    // JS String.slice() measures UTF-16 code units rather than scalar values.
    // A partial surrogate is normalized to the replacement glyph for native
    // diagnostic strings; ordinary UTF-8 text stays exact.
    slice_utf16_wire(&full, 2000)
}
pub fn empty_github_runtime_rate_usage() -> Value {
    json!({"resources":{},"rejection":null})
}
pub fn observe_runtime_rate_limit(
    channel: &str,
    response: &Value,
    observed_at: &str,
) -> Result<Value, String> {
    let headers = &response["headers"];
    let resource = match headers["x-ratelimit-resource"].as_str() {
        Some("core") => "core",
        Some("graphql") => "graphql",
        Some("search") => "search",
        _ if channel == "graphql" => "graphql",
        _ => "core",
    };
    let reason = short_reason(response);
    let status = response
        .get("status")
        .filter(|value| !value.is_null())
        .and_then(Value::as_f64);
    let throttled = status == Some(429.0) || reason_regex().is_match(&reason);
    let available = if throttled {
        Value::Bool(false)
    } else if let Some(code) = status {
        json!((200.0..300.0).contains(&code))
    } else {
        Value::Null
    };
    let reset = header_number(headers, "x-ratelimit-reset");
    let reset_at = if let Some(value) = reset {
        json!(iso_from_millis(value * 1000.0)?)
    } else {
        Value::Null
    };
    let headers_captured = [
        "x-ratelimit-limit",
        "x-ratelimit-remaining",
        "x-ratelimit-reset",
        "x-ratelimit-resource",
    ]
    .iter()
    .any(|name| headers.get(name).is_some());
    Ok(json!({
        "resource":resource,"observedAt":observed_at,"status":response["status"],
        "available":available,"throttled":throttled,
        "limit":json_number(header_number(headers,"x-ratelimit-limit")),
        "used":json_number(header_number(headers,"x-ratelimit-used")),
        "remaining":json_number(header_number(headers,"x-ratelimit-remaining")),
        "reset":json_number(reset),"resetAt":reset_at,
        "retryAfterSeconds":json_number(header_number(headers,"retry-after")),
        "reason":if throttled{json!(reason)}else{Value::Null},
        "headersCaptured":headers_captured,
    }))
}
pub fn runtime_rejection(observation: &Value) -> Result<Value, String> {
    if observation["throttled"] != true {
        return Ok(Value::Null);
    }
    let reason = observation["reason"].as_str().unwrap_or("");
    let remaining = observation
        .get("remaining")
        .filter(|x| !x.is_null())
        .and_then(Value::as_f64);
    let retry = observation
        .get("retryAfterSeconds")
        .filter(|x| !x.is_null())
        .and_then(Value::as_f64);
    let kind = if remaining == Some(0.0) {
        "primary"
    } else if secondary_regex().is_match(reason)
        || retry.is_some()
        || (reason.to_ascii_lowercase().contains("rate limit")
            && remaining.is_some_and(|n| n > 0.0))
    {
        "secondary"
    } else {
        "unknown"
    };
    let cooldown = if let Some(retry) = retry {
        let observed = iso_date_parse(observation["observedAt"].as_str().unwrap_or(""))?;
        json!(iso_from_millis(observed as f64 + retry * 1000.0)?)
    } else {
        Value::Null
    };
    Ok(json!({
        "resource":observation["resource"],"kind":kind,"observedAt":observation["observedAt"],
        "status":observation["status"],"retryAfterSeconds":observation["retryAfterSeconds"],
        "cooldownUntil":cooldown,"reason":observation["reason"].as_str().unwrap_or("GitHub rate-limit rejection"),
    }))
}
fn header_boundary() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"\r?\n\r?\n").unwrap())
}
fn header_status() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"HTTP/[\d.]+\s+(\d{3})").unwrap())
}
fn header_lines() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"\r?\n").unwrap())
}
pub fn parse_github_cli_headers(output: &str, had_headers: bool) -> Value {
    if !had_headers {
        return json!({"status":null,"headers":{},"body":output});
    }
    let Some(boundary) = header_boundary().find(output) else {
        return json!({"status":null,"headers":{},"body":output});
    };
    let head = &output[..boundary.start()];
    let status = header_status()
        .captures(head)
        .and_then(|cap| cap.get(1))
        .and_then(|match_| match_.as_str().parse::<i64>().ok());
    let mut headers = serde_json::Map::new();
    for line in header_lines().split(head).skip(1) {
        let Some(separator) = line.find(':') else {
            continue;
        };
        if separator == 0 {
            continue;
        }
        let key = trim_js(&line[..separator]).to_lowercase();
        let value = trim_js(&line[separator + 1..]);
        headers.insert(key, json!(value));
    }
    let body = &output[boundary.end()..];
    json!({"status":status,"headers":headers,"body":body})
}
