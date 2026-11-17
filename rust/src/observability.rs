// Direct port of Node src/observability.ts: read-only structured records, redaction, failure classification and async-scoped correlation.
use crate::{js_text::trim_js, local_merge_lock::iso8601_now};
use regex::Regex;
use serde_json::{json, Map, Number, Value};
use std::{
    cell::RefCell,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex, OnceLock, RwLock},
    task::{Context, Poll},
};

pub const OBSERVABILITY_MAX_STRING: usize = 512;
pub const OBSERVABILITY_MAX_ITEMS: usize = 20;
pub const OBSERVABILITY_MAX_DEPTH: usize = 4;
pub const OBSERVABILITY_REDACTED: &str = "[redacted]";

fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(value) => value.to_string(),
        Value::String(value) => value.clone(),
        Value::Number(value) => {
            if let Some(num) = value.as_f64() {
                if num.is_finite() && num.fract() == 0.0 && num.abs() < 1e21 {
                    return format!("{num:.0}");
                }
            }
            value.to_string()
        }
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if item.is_null() {
                    String::new()
                } else {
                    js_string(item)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}
fn js_number(value: Option<&Value>) -> Option<f64> {
    match value {
        None => None,
        Some(Value::Null) => Some(0.0),
        Some(Value::Bool(value)) => Some(if *value { 1.0 } else { 0.0 }),
        Some(Value::Number(value)) => value.as_f64(),
        Some(Value::String(value)) => {
            let text = trim_js(value);
            if text.is_empty() {
                return Some(0.0);
            }
            if let Some(hex) = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
                return i64::from_str_radix(hex, 16)
                    .ok()
                    .map(|number| number as f64);
            }
            if let Some(binary) = text.strip_prefix("0b").or_else(|| text.strip_prefix("0B")) {
                return i64::from_str_radix(binary, 2)
                    .ok()
                    .map(|number| number as f64);
            }
            text.parse::<f64>().ok()
        }
        Some(Value::Array(_)) => js_string(value?).parse::<f64>().ok(),
        Some(Value::Object(_)) => None,
    }
}
fn js_number_finite(value: Option<&Value>) -> Option<f64> {
    js_number(value).filter(|number| number.is_finite())
}
fn finite_number(number: f64) -> Value {
    Number::from_f64(number)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}
fn sensible_number(number: f64) -> Value {
    if number.is_finite()
        && number.fract() == 0.0
        && number >= i64::MIN as f64
        && number < (i64::MAX as f64)
    {
        json!(number as i64)
    } else {
        finite_number(number)
    }
}

pub fn error_message(error: &Value, as_error: bool) -> String {
    if as_error {
        // JavaScript `new Error()` has an empty message, not the usual
        // `[object Object]` representation of a plain object.
        return error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
    }
    if let Some(message) = error.get("message").and_then(Value::as_str) {
        return message.to_string();
    }
    js_string(error)
}
fn failure_status(error: &Value) -> Option<f64> {
    if !error.is_object() {
        return None;
    }
    for candidate in [
        error.get("status"),
        error.get("statusCode"),
        error.pointer("/response/status"),
    ] {
        if let Some(value) = candidate
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
        {
            return Some(value);
        }
    }
    None
}
fn header_value(headers: Option<&Value>, name: &str) -> Option<String> {
    let object = headers?.as_object()?;
    object
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| js_string(value))
}
fn failure_retry_after_ms(error: &Value) -> Option<f64> {
    if !error.is_object() {
        return None;
    }
    if let Some(value) = js_number_finite(error.get("retryAfter")).filter(|value| *value > 0.0) {
        return Some(value * 1000.0);
    }
    if let Some(value) = js_number_finite(error.get("retryAfterMs")).filter(|value| *value > 0.0) {
        return Some(value);
    }
    for headers in [error.pointer("/response/headers"), error.get("headers")] {
        let value = header_value(headers, "retry-after");
        let next = js_number_finite(value.as_ref().map(|_| &Value::Null));
        let _ = next;
        if let Some(value) = value {
            if let Some(seconds) =
                js_number_finite(Some(&Value::String(value))).filter(|seconds| *seconds > 0.0)
            {
                return Some(seconds * 1000.0);
            }
        }
    }
    None
}
fn regex_conflict() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new("(?i)already exists with a different definition")
            .expect("fixed conflict pattern")
    })
}
fn regex_network() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"\b(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EPIPE|UND_ERR)\b")
            .expect("fixed network error pattern")
    })
}
fn regex_transient() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(||Regex::new("(?i)fetch failed|network|socket hang up|rate limit|secondary rate|temporarily unavailable").expect("fixed retryable failure pattern"))
}

pub fn classify_failure(error: &Value, as_error: bool) -> Value {
    let reason = error_message(error, as_error);
    let status = failure_status(error);
    let retry_after = failure_retry_after_ms(error);
    let mut result = Map::new();
    result.insert("classification".into(), json!("terminal"));
    result.insert("reason".into(), json!(reason));
    if let Some(status) = status {
        result.insert("status".into(), sensible_number(status));
    }
    if let Some(retry_after) = retry_after {
        result.insert("retryAfterMs".into(), sensible_number(retry_after));
    }
    let classification = if regex_conflict().is_match(&reason) || status == Some(409.0) {
        "conflict"
    } else if status == Some(429.0)
        || status.is_some_and(|status| status >= 500.0)
        || retry_after.is_some()
        || regex_network().is_match(&reason)
        || regex_transient().is_match(&reason)
    {
        "transient"
    } else {
        "terminal"
    };
    result.insert("classification".into(), json!(classification));
    Value::Object(result)
}

fn sensitive_key() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(||Regex::new(r"(?i)(secret|token|password|passwd|authorization|cookie|credential|api[_-]?key|private[_-]?key|bearer|prompt)").expect("fixed redacted key regex"))
}
fn bulk_key() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?i)^(payload|input|body|diff|patch|content|messages?)$")
            .expect("fixed bulk key regex")
    })
}
fn length_utf16(text: &str) -> usize {
    text.encode_utf16().count()
}
// Native Rust strings cannot contain an unpaired UTF-16 surrogate. For exact
// Node JSON-wire parity, map it to a reserved supplementary private-use scalar
// until final JSON serialization restores the literal `\uD800` escape.
const SURROGATE_MARKER_START: u32 = 0xF0000;
fn marker_to_utf16(ch: char) -> Option<u16> {
    let point = ch as u32;
    (SURROGATE_MARKER_START..SURROGATE_MARKER_START + 0x800)
        .contains(&point)
        .then(|| (0xD800 + point - SURROGATE_MARKER_START) as u16)
}
fn slice_utf16_wire(text: &str, max: usize) -> String {
    let units = text.encode_utf16().take(max);
    char::decode_utf16(units)
        .map(|item| match item {
            Ok(ch) => ch,
            Err(err) => {
                char::from_u32(SURROGATE_MARKER_START + (err.unpaired_surrogate() as u32 - 0xD800))
                    .expect("valid surrogate placeholder")
            }
        })
        .collect()
}
/// Serialize a JSON value containing internal surrogate placeholders as valid
/// JSON UTF-16 escape sequences. A Node consumer sees the exact source string.
pub fn json_wire(value: &Value) -> String {
    use std::fmt::Write;
    let encoded = value.to_string();
    if !encoded.chars().any(|ch| marker_to_utf16(ch).is_some()) {
        return encoded;
    }
    let mut result = String::with_capacity(encoded.len());
    for ch in encoded.chars() {
        if let Some(unit) = marker_to_utf16(ch) {
            let _ = write!(result, "\\u{unit:04x}");
        } else {
            result.push(ch);
        }
    }
    result
}
/// Render a native Rust scalar string safely when consumers do not need the
/// UTF-16 JSON representation (e.g. terminal and UI text rendering).
pub fn renderable_observation(value: &Value) -> Value {
    match value {
        Value::String(s) => json!(s
            .chars()
            .map(|ch| if marker_to_utf16(ch).is_some() {
                '\u{fffd}'
            } else {
                ch
            })
            .collect::<String>()),
        Value::Array(items) => json!(items.iter().map(renderable_observation).collect::<Vec<_>>()),
        Value::Object(entries) => {
            let mut result = Map::new();
            for (key, v) in entries {
                result.insert(key.clone(), renderable_observation(v));
            }
            Value::Object(result)
        }
        _ => value.clone(),
    }
}

fn sanitize_observation_value_inner(value: &Value, depth: usize) -> Value {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => value.clone(),
        Value::String(value) => {
            let len = length_utf16(value);
            if len > OBSERVABILITY_MAX_STRING {
                json!(format!(
                    "{}…(+{})",
                    slice_utf16_wire(value, OBSERVABILITY_MAX_STRING),
                    len - OBSERVABILITY_MAX_STRING
                ))
            } else {
                json!(value)
            }
        }
        Value::Array(values) => {
            let mut kept = values
                .iter()
                .take(OBSERVABILITY_MAX_ITEMS)
                .map(|item| sanitize_observation_value_inner(item, depth + 1))
                .collect::<Vec<_>>();
            if values.len() > OBSERVABILITY_MAX_ITEMS {
                kept.push(json!(format!(
                    "+{} more",
                    values.len() - OBSERVABILITY_MAX_ITEMS
                )));
            }
            Value::Array(kept)
        }
        Value::Object(values) => {
            if depth >= OBSERVABILITY_MAX_DEPTH {
                return json!("[truncated]");
            }
            let mut filtered = Map::new();
            for (key, item) in values {
                if key == "__proto__" {
                    continue;
                }
                let next = if sensitive_key().is_match(key) {
                    json!(OBSERVABILITY_REDACTED)
                } else if bulk_key().is_match(key)
                    && item
                        .as_str()
                        .is_some_and(|text| length_utf16(text) > OBSERVABILITY_MAX_STRING)
                {
                    json!(format!(
                        "[omitted {} chars]",
                        length_utf16(item.as_str().unwrap_or(""))
                    ))
                } else {
                    sanitize_observation_value_inner(item, depth + 1)
                };
                filtered.insert(key.clone(), next);
            }
            Value::Object(filtered)
        }
    }
}
pub fn sanitize_observation_value(value: &Value, depth: usize) -> Value {
    sanitize_observation_value_inner(value, depth)
}
pub fn sanitize_observation_data(data: Option<&Value>) -> Option<Value> {
    match data {
        None | Some(Value::Null) | Some(Value::Bool(false)) => None,
        Some(Value::String(text)) if text.is_empty() => None,
        Some(Value::Number(number)) if number.as_f64() == Some(0.0) => None,
        Some(value) => Some(sanitize_observation_value_inner(value, 0)),
    }
}

thread_local! {static CORRELATION:RefCell<Vec<Value>> = const {RefCell::new(Vec::new())};}
fn merge_correlation(first: &Value, second: &Value) -> Value {
    let mut merged = first.as_object().cloned().unwrap_or_default();
    if let Some(second) = second.as_object() {
        for (key, value) in second {
            merged.insert(key.clone(), value.clone());
        }
    }
    Value::Object(merged)
}
pub fn current_observability_correlation() -> Value {
    CORRELATION.with(|storage| {
        storage
            .borrow()
            .last()
            .cloned()
            .unwrap_or_else(|| json!({}))
    })
}
struct ContextGuard;
impl ContextGuard {
    fn push(correlation: Value) -> Self {
        CORRELATION.with(|storage| storage.borrow_mut().push(correlation));
        Self
    }
}
impl Drop for ContextGuard {
    fn drop(&mut self) {
        CORRELATION.with(|storage| {
            storage.borrow_mut().pop();
        });
    }
}
pub fn with_observability_correlation<T>(correlation: &Value, work: impl FnOnce() -> T) -> T {
    let value = merge_correlation(&current_observability_correlation(), correlation);
    let _guard = ContextGuard::push(value);
    work()
}
/// AsyncLocalStorage equivalent across suspension: enter the captured context
/// before *each* poll and restore the parent when the future yields, so two
/// concurrent futures cannot leak Task/Execution correlation to each other.
pub struct CorrelationFuture<F> {
    correlation: Value,
    inner: F,
}
impl<F: Future> Future for CorrelationFuture<F> {
    type Output = F::Output;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        // The wrapped future's address is never changed while pinned.
        let this = unsafe { self.get_unchecked_mut() };
        let _guard = ContextGuard::push(this.correlation.clone());
        unsafe { Pin::new_unchecked(&mut this.inner) }.poll(cx)
    }
}
pub fn with_observability_correlation_future<F: Future>(
    correlation: &Value,
    work: F,
) -> CorrelationFuture<F> {
    CorrelationFuture {
        correlation: merge_correlation(&current_observability_correlation(), correlation),
        inner: work,
    }
}

pub type ObservabilitySink = Arc<dyn Fn(Value) + Send + Sync>;
#[derive(Clone)]
pub struct RelayObservability {
    sink: ObservabilitySink,
    pub minimum_level: String,
}
impl RelayObservability {
    pub fn new(sink: ObservabilitySink, minimum_level: &str) -> Self {
        Self {
            sink,
            minimum_level: minimum_level.into(),
        }
    }
    pub fn silent() -> Self {
        Self::new(Arc::new(|_| {}), "error")
    }
    pub fn stderr(minimum_level: &str) -> Self {
        Self::new(
            Arc::new(|record| {
                let _ = std::io::Write::write_all(
                    &mut std::io::stderr(),
                    format!("{}\n", record).as_bytes(),
                );
            }),
            minimum_level,
        )
    }
    pub fn from_environment(env: &Value) -> Self {
        let configured = env
            .get("AGENTS_RELAY_OBSERVABILITY")
            .filter(|value| !value.is_null())
            .or_else(|| env.get("RELAY_OBSERVABILITY_LEVEL"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let configured = trim_js(configured).to_ascii_lowercase();
        if ["silent", "off", "none", "0", "false"].contains(&configured.as_str()) {
            return Self::silent();
        }
        let level = if ["debug", "info", "warn", "error"].contains(&configured.as_str()) {
            configured.as_str()
        } else {
            "info"
        };
        Self::stderr(level)
    }
    fn rank(value: &str) -> Option<i32> {
        match value {
            "debug" => Some(0),
            "info" => Some(1),
            "warn" => Some(2),
            "error" => Some(3),
            _ => None,
        }
    }
    pub fn is_enabled(&self, level: &str) -> bool {
        matches!((Self::rank(level),Self::rank(&self.minimum_level)),(Some(level),Some(minimum)) if level>=minimum)
    }
    pub fn record_at(&self, input: &Value, timestamp: &str) {
        let level = input.get("level").and_then(Value::as_str).unwrap_or("info");
        if !self.is_enabled(level) {
            return;
        }
        let mut correlation = current_observability_correlation();
        correlation = merge_correlation(&correlation, &input["correlation"]);
        let mut row = json!({"ts":timestamp,"stage":input["stage"],"event":input["event"],
            "level":level,"outcome":input.get("outcome").and_then(Value::as_str).unwrap_or("succeeded"),
            "message":input["message"],"correlation":correlation});
        if input
            .get("transition")
            .is_some_and(|value| !value.is_null() && value != &Value::Bool(false))
        {
            row["transition"] = input["transition"].clone();
        }
        if let Some(data) = sanitize_observation_data(input.get("data")) {
            row["data"] = data;
        }
        (self.sink)(row);
    }
    pub fn record(&self, input: &Value) {
        self.record_at(input, &iso8601_now());
    }
}
fn active() -> &'static RwLock<RelayObservability> {
    static GLOBAL: OnceLock<RwLock<RelayObservability>> = OnceLock::new();
    GLOBAL.get_or_init(|| RwLock::new(RelayObservability::silent()))
}
pub fn observability() -> RelayObservability {
    active().read().expect("observation lock").clone()
}
pub fn set_observability(observer: RelayObservability) {
    *active().write().expect("observation lock") = observer;
}
pub fn collect_observations(records: Arc<Mutex<Vec<Value>>>) -> ObservabilitySink {
    Arc::new(move |record| records.lock().expect("record sink lock").push(record))
}
