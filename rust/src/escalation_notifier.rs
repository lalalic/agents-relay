// Node provenance: src/escalation-notifier.ts. Provider receipt IDs, never
// mere HTTP acknowledgement, authorize human-notification completion.
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::{Duration, SystemTime};
use url::Url;

#[derive(Debug, Clone)]
pub struct EscalationNotifierConfig {
    pub url: Url,
    pub token: Option<String>,
}
fn now_iso(now: SystemTime) -> String {
    DateTime::<Utc>::from(now).to_rfc3339_opts(SecondsFormat::Millis, true)
}
pub fn escalation_notifier_from_environment(
    env: &HashMap<String,String>,
) -> Result<Option<EscalationNotifierConfig>,String> {
    let Some(raw)=env.get("AGENTS_RELAY_ESCALATION_NOTIFY_URL")
        .map(String::as_str).map(str::trim).filter(|s|!s.is_empty())
    else {return Ok(None);};
    let url=Url::parse(raw).map_err(|e|e.to_string())?;
    let loopback = matches!(url.host_str(),Some("localhost"|"127.0.0.1"|"::1"|"[::1]"));
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some()
        || !(url.scheme()=="https" || (url.scheme()=="http" && loopback)) {
        return Err("Escalation notifier requires HTTPS or a loopback HTTP endpoint without URL credentials".into());
    }
    let token=env.get("AGENTS_RELAY_ESCALATION_NOTIFY_TOKEN")
        .map(String::as_str).map(str::trim).filter(|s|!s.is_empty()).map(str::to_owned);
    Ok(Some(EscalationNotifierConfig{url,token}))
}
pub fn receipt_valid(value: &Value) -> bool {
    value.get("channel").and_then(Value::as_str).is_some_and(|s|!s.trim().is_empty())
        && value.get("deliveryId").and_then(Value::as_str).is_some_and(|s|!s.trim().is_empty())
        && value.get("deliveredAt").and_then(Value::as_str)
            .is_some_and(|s|DateTime::parse_from_rfc3339(s).is_ok())
}
pub fn retry_delay_ms(attempts: u32) -> u64 {
    (60_000u64.saturating_mul(1u64 << attempts.saturating_sub(1).min(6))).min(3_600_000)
}
pub fn pending(escalation: &Value) -> bool {
    escalation.get("status").and_then(Value::as_str)==Some("pending")
        && escalation.get("notification").and_then(|n|n.get("status")).and_then(Value::as_str)
            !=Some("delivered")
}
pub fn notification_request(job_id: &str, task: &Value) -> Result<Value,String> {
    let escalation=task.get("escalation").ok_or("Task missing escalation")?;
    let escalation_id=escalation.get("id").and_then(Value::as_str)
        .ok_or("Escalation identity is required")?;
    let task_id=task.get("id").and_then(Value::as_str).ok_or("Task identity is required")?;
    Ok(json!({
        "jobId":job_id,"taskId":task_id,"escalationId":escalation_id,
        "idempotencyKey":format!("escalation/{escalation_id}"),
        "requiredAction":escalation.get("requiredAction"),"resolutionCondition":escalation.get("resolutionCondition"),
        "context":escalation.get("context")
    }))
}
/// Native HTTP adapter: disallow redirects and demand a verified provider
/// receipt with explicit `delivered: true`. Response status alone is not proof.
pub fn send_escalation_notification(
    config: &EscalationNotifierConfig, request: &Value,
) -> Result<Value,String> {
    let idempotency=request.get("idempotencyKey").and_then(Value::as_str)
        .ok_or("Escalation idempotencyKey missing")?;
    let client=ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(10)))
        .max_redirects(0)
        .build().new_agent();
    let mut outgoing=client.post(config.url.as_str())
        .header("Content-Type","application/json")
        .header("Idempotency-Key",idempotency);
    if let Some(token)=&config.token {
        outgoing=outgoing.header("Authorization",&format!("Bearer {token}"));
    }
    let mut response=outgoing.send_json(request).map_err(|error|error.to_string())?;
    if !(200..300).contains(&response.status().as_u16()) {
        return Err(format!("Notification endpoint HTTP {}",response.status()));
    }
    let value:Value=response.body_mut().read_json()
        .map_err(|error|error.to_string())?;
    if value.get("delivered")!=Some(&Value::Bool(true)) || !receipt_valid(&value) {
        return Err("Notification endpoint did not provide a verified delivery ID".into());
    }
    Ok(json!({"channel":value.get("channel"),"deliveryId":value.get("deliveryId"),"deliveredAt":value.get("deliveredAt")}))
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct NotificationCounts {pub delivered:usize,pub pending:usize,pub failed:usize}

/// Each returned per-task mutation MUST be committed with an immutable
/// escalation ID fence inside the authoritative SQLite Job transaction.
#[derive(Debug, Clone)]
pub enum NotificationMutation {
    MissingChannel,
    Delivered{receipt:Value},
    Failed{message:String,attempts:u32,last_attempt_at:String,next_attempt_at:String},
}

pub fn candidate_notifications(job: &Value) -> Vec<Value> {
    job.get("tasks").and_then(Value::as_array).into_iter().flatten()
        .filter(|task|task.get("agentName").and_then(Value::as_str)==Some("troubleshooter")
            && task.get("escalation").is_some_and(pending))
        .cloned().collect()
}

/// The Store passes an atomic guarded commit function. A caller must not
/// treat HTTP transport errors as successful notification.
pub fn deliver_pending_escalations<Notify, Commit>(
    job: &Value,
    job_id: &str,
    now: SystemTime,
    notifier: Option<Notify>,
    mut commit: Commit,
    has_atomic_mutation: bool,
) -> Result<NotificationCounts,String>
where Notify: Fn(&Value)->Result<Value,String>,
      Commit: FnMut(&str,&str,NotificationMutation)->Result<(),String>,
{
    let candidates=candidate_notifications(job);
    if !candidates.is_empty() && !has_atomic_mutation {
        if notifier.is_some() {
            return Err("Escalation delivery with an actual notifier requires atomic SQLite mutation".into());
        }
        return Ok(NotificationCounts{pending:candidates.len(),..Default::default()});
    }
    let mut counts=NotificationCounts::default();
    for task in &candidates {
        let escalation=&task["escalation"];
        let Some(task_id)=task.get("id").and_then(Value::as_str) else {continue;};
        let Some(escalation_id)=escalation.get("id").and_then(Value::as_str) else {continue;};
        let notification=escalation.get("notification");
        let future_attempt=notification.and_then(|n|n.get("nextAttemptAt"))
            .and_then(Value::as_str).and_then(|s|DateTime::parse_from_rfc3339(s).ok())
            .is_some_and(|time|time.timestamp_millis()
                > DateTime::<Utc>::from(now).timestamp_millis());
        if future_attempt {counts.pending+=1;continue;}
        let Some(ref notify)=notifier else {
            if notification.and_then(|n|n.get("lastError")).and_then(Value::as_str)
                !=Some("Notification delivery channel is not configured") {
                commit(task_id,escalation_id,NotificationMutation::MissingChannel)?;
            }
            counts.pending+=1;
            continue;
        };
        let request=notification_request(job_id,task)?;
        match notify(&request).and_then(|receipt| {
            if receipt_valid(&receipt) {Ok(receipt)}
            else {Err("Notifier returned no verifiable delivery receipt".into())}
        }) {
            Ok(receipt)=>{
                commit(task_id,escalation_id,NotificationMutation::Delivered{receipt})?;
                counts.delivered+=1;
            },
            Err(message)=>{
                let attempts=notification.and_then(|n|n.get("attempts"))
                    .and_then(Value::as_u64).unwrap_or(0).saturating_add(1)
                    .min(u32::MAX as u64) as u32;
                let next=now+Duration::from_millis(retry_delay_ms(attempts));
                commit(task_id,escalation_id,NotificationMutation::Failed{
                    message,attempts,last_attempt_at:now_iso(now),next_attempt_at:now_iso(next)
                })?;
                counts.failed+=1;
            }
        }
    }
    Ok(counts)
}
