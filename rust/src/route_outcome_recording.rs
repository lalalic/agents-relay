// Direct port of src/route-outcome-recording.ts: observational audit after
// committed Graph/SQLite transitions, best-effort only.
use crate::events::random_uuid;
use regex::Regex;
use serde_json::{json, Value};

fn matches(message: &str, pattern: &str) -> bool {
    Regex::new(pattern)
        .expect("fixed audit regex")
        .is_match(message)
}
pub fn classify_routing_failure(message: &str, fallback: &str) -> String {
    if matches(
        message,
        r"(?i)invalid (?:api|public) key|(?:authentication|authorization) failed|401 unauthorized",
    ) {
        "auth_config_failure".into()
    } else if matches(
        message,
        r"(?i)stream disconnected|response\.completed|rate[_ .-]?limit(?:[_ .-]?exceeded)?|quota exceeded|provider[_ .-]?unavailable|model[_ .-]?(?:unavailable|not[_ .-]?found)|service unavailable",
    ) {
        "provider_failure".into()
    } else if matches(message, r"(?i)timeout|timed out|deadline exceeded") {
        "timeout".into()
    } else {
        fallback.to_owned()
    }
}
fn route_reason(message: &str) -> String {
    let space = Regex::new(r"\s+")
        .unwrap()
        .replace_all(message, " ")
        .to_string();
    let bearer = Regex::new(r"(?i)\b(Bearer\s+)[A-Za-z0-9._~-]+")
        .unwrap()
        .replace_all(&space, r"${1}[redacted]")
        .to_string();
    let secret=Regex::new(r"(?i)\b((?:api[_ -]?key|secret|password|access[_ -]?token|token|credential|authorization)\s*[:=]\s*)[^\s,;]+").unwrap()
        .replace_all(&bearer,r"${1}[redacted]").to_string();
    // Node String.slice(0,240) uses UTF-16 code units.
    let mut units = 0;
    secret
        .chars()
        .take_while(|c| {
            let next = units + c.len_utf16();
            if next > 240 {
                return false;
            }
            units = next;
            true
        })
        .collect()
}
fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn record<F>(
    task: &Value,
    kind: &str,
    reason: &str,
    evidence: &Value,
    now: &str,
    uuid: &str,
    mut append: F,
) -> Option<Value>
where
    F: FnMut(&Value) -> Result<(), String>,
{
    let decision = task
        .pointer("/routing/decisionId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())?;
    let route = &task["routing"];
    let worker = task["workerSelection"]["workerId"]
        .as_str()
        .unwrap_or_else(|| text(task, "adapter"));
    let mut extra = json!({
        "job_id":task["jobId"],"task_id":task["id"],"attempt":task["attempt"],
        "route":{"worker":worker,"adapter":task["adapter"],"provider":route["provider"],
            "model":route["model"],"profile":route["profile"],"reasoning":route["reasoning"]}
    });
    if let (Some(to), Some(from)) = (extra.as_object_mut(), evidence.as_object()) {
        for (key, value) in from {
            to.insert(key.clone(), value.clone());
        }
    }
    let result = json!({
        "record_type":"outcome","schema_version":5,"outcome_id":uuid,
        "decision_id":decision,"timestamp":now,"kind":kind,
        "summary":route_reason(reason),"evidence":extra
    });
    if let Err(error) = append(&result) {
        eprintln!("[agents-relay] route outcome audit unavailable: {error}");
    }
    Some(result)
}
pub fn record_route_outcome<F>(
    task: &Value,
    kind: &str,
    reason: &str,
    evidence: &Value,
    append: F,
) -> Option<Value>
where
    F: FnMut(&Value) -> Result<(), String>,
{
    record(
        task,
        kind,
        reason,
        evidence,
        &crate::local_merge_lock::iso8601_now(),
        &random_uuid(),
        append,
    )
}
/// Explicit clock and outcome ID are only used by deterministic fixture ports.
pub fn record_route_outcome_at<F>(
    task: &Value,
    kind: &str,
    reason: &str,
    evidence: &Value,
    now: &str,
    uuid: &str,
    append: F,
) -> Option<Value>
where
    F: FnMut(&Value) -> Result<(), String>,
{
    record(task, kind, reason, evidence, now, uuid, append)
}
pub fn terminal_route_arguments(
    event: &Value,
    execution_id: Option<&str>,
) -> (String, String, Value) {
    let kind = match text(event, "type") {
        "task.completed" => "success",
        "task.cancelled" => "cancelled",
        "task.blocked" => "blocked",
        _ => {
            return {
                let reason = format!(
                    "{} {}",
                    text(event, "message"),
                    text(&event["data"], "reason")
                );
                let kind = classify_routing_failure(&reason, "task_failure");
                (
                    kind,
                    terminal_reason(event),
                    json!({"execution_id":execution_id,"event_type":event["type"]}),
                )
            }
        }
    };
    (
        kind.into(),
        terminal_reason(event),
        json!({"execution_id":execution_id,"event_type":event["type"]}),
    )
}
fn terminal_reason(event: &Value) -> String {
    if text(event, "type") == "task.completed" {
        return "task.completed".into();
    }
    let message = text(event, "message");
    let data = text(&event["data"], "reason");
    let list = [data, message]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();
    if list.is_empty() {
        text(event, "type").into()
    } else {
        list.join(": ")
    }
}
pub fn launch_route_arguments(
    task: &Value,
    message: &str,
    phase: &str,
    execution_id: Option<&str>,
    unknown: bool,
) -> (String, String, Value) {
    let kind = if unknown {
        "outcome_unknown".into()
    } else {
        classify_routing_failure(
            message,
            if phase == "launch" {
                "launch_failure"
            } else {
                "runtime_failure"
            },
        )
    };
    (
        kind,
        format!("worker_{phase}_failure: {message}"),
        json!({"phase":phase,"execution_id":execution_id,"target_state":task["state"],"outcome_unknown":unknown}),
    )
}
pub fn watchdog_route_arguments(evidence: &Value) -> (String, String, Value) {
    let kind = if evidence["failedExit"] == true {
        classify_routing_failure(text(evidence, "rawError"), "runtime_failure")
    } else {
        "timeout".into()
    };
    let reason = format!(
        "{}: {}",
        evidence["failureReason"]
            .as_str()
            .unwrap_or("watchdog_failed"),
        text(evidence, "failureMessage")
    );
    (
        kind,
        reason,
        json!({"execution_id":evidence["executionId"],"watchdog":true,"exit_code":evidence["exitCode"]}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn classification_preserves_fallback_and_auth_precedence() {
        assert_eq!(
            classify_routing_failure("invalid api key rate limit", "task_failure"),
            "auth_config_failure"
        );
        assert_eq!(
            classify_routing_failure("stream disconnected", "task_failure"),
            "provider_failure"
        );
        assert_eq!(
            classify_routing_failure("deadline exceeded", "launch_failure"),
            "timeout"
        );
        assert_eq!(
            classify_routing_failure("oops", "task_failure"),
            "task_failure"
        );
    }
    #[test]
    fn outcome_audit_redacts_and_never_propagates_append_errors() {
        let task = json!({"jobId":"4","id":"3","adapter":"chatgpt","attempt":1,
            "routing":{"decisionId":"d1","provider":"OpenRouter","model":"test"}});
        let value = record_route_outcome_at(
            &task,
            "task_failure",
            "Bearer superSecret token=secret1",
            &json!({}),
            "now",
            "uuid",
            |_| Err("offline".into()),
        )
        .unwrap();
        assert_eq!(value["decision_id"], "d1");
        assert!(value["summary"]
            .as_str()
            .unwrap()
            .contains("Bearer [redacted]"));
        assert!(!value.to_string().contains("superSecret"));
    }
}

// Public Graph-selected audit effects. The store append is deliberately
// best-effort and occurs after the authoritative durable transition.
pub fn record_terminal_route_outcome<F>(
    task: &Value,
    event: &Value,
    execution_id: Option<&str>,
    append: F,
) -> Option<Value>
where
    F: FnMut(&Value) -> Result<(), String>,
{
    let (kind, reason, evidence) = terminal_route_arguments(event, execution_id);
    record_route_outcome(task, &kind, &reason, &evidence, append)
}

pub fn record_launch_route_outcome<F>(
    task: &Value,
    message: &str,
    phase: &str,
    execution_id: Option<&str>,
    unknown_outcome: bool,
    append: F,
) -> Option<Value>
where
    F: FnMut(&Value) -> Result<(), String>,
{
    let (kind, reason, evidence) =
        launch_route_arguments(task, message, phase, execution_id, unknown_outcome);
    record_route_outcome(task, &kind, &reason, &evidence, append)
}

pub fn record_watchdog_route_outcome<F>(task: &Value, watchdog: &Value, append: F) -> Option<Value>
where
    F: FnMut(&Value) -> Result<(), String>,
{
    let (kind, reason, evidence) = watchdog_route_arguments(watchdog);
    record_route_outcome(task, &kind, &reason, &evidence, append)
}

#[cfg(test)]
mod native_audit_effect_tests {
    use super::*;
    #[test]
    fn all_public_audit_effects_preserve_order_and_ignore_append_failure() {
        let task = json!({"jobId":"9","id":"21","adapter":"chatgpt","attempt":1,
            "state":"ACTIVE","routing":{"decisionId":"decision-21","provider":"fake","model":"test"}});
        let mut kinds = Vec::new();
        record_terminal_route_outcome(&task, &json!({"type":"task.completed"}), Some("ex"), |r| {
            kinds.push(r["kind"].as_str().unwrap().to_string());
            Ok(())
        });
        record_launch_route_outcome(
            &task,
            "deadline exceeded",
            "launch",
            Some("ex"),
            false,
            |r| {
                kinds.push(r["kind"].as_str().unwrap().to_string());
                Ok(())
            },
        );
        record_watchdog_route_outcome(
            &task,
            &json!({"executionId":"ex","failedExit":true,
            "rawError":"invalid api key","failureMessage":"failed","exitCode":1}),
            |r| {
                kinds.push(r["kind"].as_str().unwrap().to_string());
                Err("offline".into())
            },
        );
        assert_eq!(kinds, ["success", "timeout", "auth_config_failure"]);
        let mut called = false;
        let missing = json!({"id":"99","adapter":"chatgpt"});
        assert!(record_terminal_route_outcome(
            &missing,
            &json!({"type":"task.completed"}),
            None,
            |_| {
                called = true;
                Ok(())
            }
        )
        .is_none());
        assert!(!called);
    }
}
