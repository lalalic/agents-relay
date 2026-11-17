// Node provenance: src/model-redecision.ts. Classify durable failure evidence
// independently of Task.error. Model routing itself remains a separate effect.
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureClassification {
    ModelProviderRuntime,
    WorkerToolInfrastructure,
    SemanticTask,
    TimeoutUnknown,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FailureEvidence {
    pub classification: FailureClassification,
    pub summary: String,
    pub sources: Vec<String>,
}
pub fn classify_failure_evidence(
    events: &[Value], logs: &[String], _task_error: Option<&str>,
) -> FailureEvidence {
    let mut records: Vec<String> = events.iter().map(|event| {
        let ty = event.get("type").and_then(Value::as_str).unwrap_or("");
        let message = event.get("message").and_then(Value::as_str).unwrap_or("");
        let data = event.get("data").filter(|data| !data.is_null())
            .cloned().unwrap_or_else(|| serde_json::json!({}));
        format!("{ty} {message} {data}")
    }).collect();
    records.extend(logs.iter().cloned());
    let text = records.join("\n").to_lowercase();
    let has = |pattern: &str| Regex::new(pattern).expect("static failure pattern").is_match(&text);
    let model = has("model|provider|laya|launch|auth|credential|configuration|incompatible|rate.?limit|quota|unavailable");
    let infra = has("worker|tool|daemon|relay|network|socket|nats|checkout|filesystem");
    let semantic = has("assert|test failed|implementation|compile|typescript|syntax|semantic");
    let timeout = has("timeout|timed out|deadline");
    let (classification, summary) = if model && !infra {
        (FailureClassification::ModelProviderRuntime,
         "Durable events/logs indicate the selected model/provider/runtime path failed.")
    } else if infra {
        (FailureClassification::WorkerToolInfrastructure,
         "Durable events/logs indicate worker, tool, or infrastructure failure unrelated to model choice.")
    } else if semantic {
        (FailureClassification::SemanticTask,
         "Durable events/logs indicate meaningful task execution failed semantically.")
    } else if timeout {
        (FailureClassification::TimeoutUnknown,
         "Timeout evidence is insufficient to attribute failure to model choice.")
    } else if events.is_empty() && logs.is_empty() {
        (FailureClassification::TimeoutUnknown,
         "No durable event or log evidence was supplied.")
    } else {
        (FailureClassification::TimeoutUnknown,
         "Failure attribution is unknown from the available evidence.")
    };
    FailureEvidence {
        classification,
        summary: summary.into(),
        sources: vec!["task.events".into(), "worker.logs".into()],
    }
}
