// Direct port of Node src/github-webhook.ts: authenticated HMAC webhook envelope, trusted package publication markers, and timestamp-bounded idempotent delivery.
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};

pub const PACKAGE_FAILED_MARKER: &str = "agents-relay:package-publish-failed:v1";
pub const PACKAGE_PUBLISHED_MARKER: &str = "agents-relay:package-published:v1";
fn string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}
fn valid_sha(value: &str) -> bool {
    (7..=40).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_hexdigit())
}
fn numeric_string(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit())
}
fn markup(body: &Value, marker: &str) -> Option<Value> {
    let body = body.as_str()?;
    let prefix = format!("<!-- {marker} ");
    let start = body.find(&prefix)? + prefix.len();
    let end = body[start..].find(" -->")? + start;
    serde_json::from_str(&body[start..end]).ok()
}
pub fn parse_package_publish_failure_marker(body: &Value) -> Option<Value> {
    let data = markup(body, PACKAGE_FAILED_MARKER)?;
    let run_id = string(&data, "runId")?;
    let attempt = data.get("attempt")?.as_f64()?;
    let sha = string(&data, "sha")?;
    let stage = string(&data, "stage")?;
    if !numeric_string(run_id)
        || !attempt.is_finite()
        || attempt.fract() != 0.0
        || attempt < 1.0
        || !valid_sha(sha)
        || stage.is_empty()
    {
        return None;
    }
    let mut value = json!({"runId":run_id,"attempt":attempt as i64,"sha":sha,"stage":stage});
    if let Some(id) = string(&data, "jobId").filter(|id| !id.is_empty()) {
        value["jobId"] = json!(id);
    }
    Some(value)
}
pub fn parse_package_publication_marker(body: &Value) -> Option<Value> {
    let data = markup(body, PACKAGE_PUBLISHED_MARKER)?;
    let package = string(&data, "package").filter(|value| !value.is_empty())?;
    let version = string(&data, "version").filter(|value| !value.is_empty())?;
    let mut result = json!({"package":package,"version":version,
        "registry":data.get("registry").filter(|v|v.is_string()).cloned().unwrap_or(Value::Null),
        "sha":data.get("sha").filter(|v|v.is_string()).cloned().unwrap_or(Value::Null)});
    if let Some(id) = string(&data, "jobId").filter(|id| !id.is_empty()) {
        result["jobId"] = json!(id);
    }
    Some(result)
}
pub fn verify_github_webhook(secret: &str, body: &[u8], signature: Option<&str>) -> bool {
    if secret.is_empty() {
        return false;
    }
    let Some(signature) = signature.filter(|signature| signature.starts_with("sha256=")) else {
        return false;
    };
    let mut key = [0u8; 64];
    let src = secret.as_bytes();
    if src.len() > 64 {
        key[..32].copy_from_slice(&Sha256::digest(src));
    } else {
        key[..src.len()].copy_from_slice(src);
    }
    let mut inner = [0x36u8; 64];
    let mut outer = [0x5cu8; 64];
    for i in 0..64 {
        inner[i] ^= key[i];
        outer[i] ^= key[i];
    }
    let mut hash = Sha256::new();
    hash.update(inner);
    hash.update(body);
    let digest = hash.finalize();
    let mut hash = Sha256::new();
    hash.update(outer);
    hash.update(digest);
    let hex = hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let expected = format!("sha256={hex}");
    if expected.len() != signature.len() {
        return false;
    }
    let mut difference = 0u8;
    for (a, b) in expected.as_bytes().iter().zip(signature.as_bytes()) {
        difference |= a ^ b;
    }
    difference == 0
}
fn valid_date(value: Option<&Value>) -> Option<String> {
    let date = value?.as_str()?;
    DateTime::parse_from_rfc3339(date).ok().map(|dt| {
        dt.with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Millis, true)
    })
}
fn header(headers: &Value, key: &str) -> String {
    match headers.get(key) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Array(rows)) => rows
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(","),
        _ => String::new(),
    }
}
fn pull_request_facts(payload: &Value, action: &str) -> Option<Value> {
    if !matches!(action, "synchronize" | "closed") {
        return None;
    }
    let pr = payload.get("pull_request")?;
    let head = pr.get("head")?;
    let ref_name = string(head, "ref").filter(|value| !value.is_empty())?;
    let sha = string(head, "sha").filter(|value| !value.is_empty())?;
    let state = if action == "synchronize" {
        "OPEN"
    } else if pr.get("merged") == Some(&Value::Bool(true)) {
        "MERGED"
    } else {
        "CLOSED"
    };
    let mut facts = json!({"state":state,"head":{"ref":ref_name,"sha":sha}});
    if let Some(timestamp) = valid_date(pr.get("updated_at")) {
        facts["observedAt"] = json!(timestamp);
    }
    Some(facts)
}
fn positive_integer(value: Option<&Value>) -> Option<i64> {
    let parsed = match value {
        None | Some(Value::Null) => 0.0,
        Some(Value::String(s)) => s.parse::<f64>().ok()?,
        Some(value) => value.as_f64()?,
    };
    if parsed.is_finite() && parsed > 0.0 && parsed.fract() == 0.0 && parsed <= (i64::MAX as f64) {
        Some(parsed as i64)
    } else {
        None
    }
}
pub fn parse_github_webhook(headers: &Value, body: &[u8]) -> Option<Value> {
    let delivery_id = header(headers, "x-github-delivery");
    let event = header(headers, "x-github-event");
    if delivery_id.is_empty()
        || !matches!(
            event.as_str(),
            "pull_request" | "issue_comment" | "commit_comment"
        )
    {
        return None;
    }
    let payload: Value = serde_json::from_slice(body).ok()?;
    let repository = payload
        .get("repository")
        .and_then(|r| string(r, "full_name"))
        .filter(|name| !name.is_empty())?;
    let action = payload.get("action").and_then(Value::as_str);
    let action_value = action.map_or(Value::Null, |action| json!(action));
    if event == "commit_comment" || event == "issue_comment" {
        let comment = payload.get("comment");
        let trusted = comment
            .and_then(|comment| comment.get("user"))
            .and_then(|user| string(user, "login"))
            == Some("github-actions[bot]");
        let message = comment
            .and_then(|comment| comment.get("body"))
            .cloned()
            .unwrap_or(Value::Null);
        let publication = if trusted {
            parse_package_publication_marker(&message)
        } else {
            None
        };
        let failure = if trusted {
            parse_package_publish_failure_marker(&message)
        } else {
            None
        };
        let job_id = publication
            .as_ref()
            .and_then(|item| string(item, "jobId"))
            .or_else(|| failure.as_ref().and_then(|item| string(item, "jobId")));
        if publication.is_none() && failure.is_none() {
            return None;
        }
        let issue = payload.get("issue");
        let pull_request = if event == "issue_comment" {
            let number = positive_integer(issue.and_then(|issue| issue.get("number")))?;
            if issue
                .and_then(|issue| issue.get("pull_request"))
                .is_some_and(|value| !value.is_null() && value != false)
            {
                json!(number)
            } else if job_id.is_some() {
                Value::Null
            } else {
                return None;
            }
        } else {
            job_id?;
            Value::Null
        };
        let mut record = json!({"deliveryId":delivery_id,"event":event,"action":action_value,"repository":repository,
            "pullRequest":pull_request,"publication":publication,"pullRequestFacts":Value::Null});
        if let Some(job_id) = job_id {
            record["jobId"] = json!(job_id);
        }
        if let Some(created_at) = valid_date(comment.and_then(|comment| comment.get("created_at")))
        {
            record["publicationObservedAt"] = json!(created_at);
        }
        if let Some(failure) = failure {
            record["publishFailure"] = failure;
        }
        return Some(record);
    }
    let pr = payload.get("pull_request");
    let number = positive_integer(pr.and_then(|pr| pr.get("number")))?;
    let facts = pull_request_facts(&payload, action.unwrap_or(""))?;
    Some(
        json!({"deliveryId":delivery_id,"event":event,"action":action_value,"repository":repository,
        "pullRequest":number,"publication":Value::Null,"pullRequestFacts":facts}),
    )
}
pub struct DeliveryDeduper {
    ttl_ms: i64,
    max_entries: usize,
    seen: HashMap<String, i64>,
    order: VecDeque<String>,
}
impl DeliveryDeduper {
    pub fn new(ttl_ms: i64, max_entries: usize) -> Self {
        Self {
            ttl_ms,
            max_entries,
            seen: HashMap::new(),
            order: VecDeque::new(),
        }
    }
    pub fn has(&self, id: &str, now: i64) -> bool {
        self.seen.get(id).is_some_and(|expires| *expires > now)
    }
    pub fn accept(&mut self, id: &str, now: i64) -> bool {
        self.order
            .retain(|key| self.seen.get(key).is_some_and(|expires| *expires > now));
        self.seen.retain(|_, expires| *expires > now);
        if self.seen.contains_key(id) {
            return false;
        }
        self.seen
            .insert(id.to_owned(), now.saturating_add(self.ttl_ms));
        self.order.push_back(id.to_owned());
        while self.seen.len() > self.max_entries {
            if let Some(first) = self.order.pop_front() {
                self.seen.remove(&first);
            }
        }
        true
    }
}
