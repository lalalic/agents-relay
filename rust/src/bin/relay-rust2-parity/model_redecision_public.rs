// Original model-redecision.ts public API differential: classifyFailureEvidence
// keyword precedence over event/log fixtures (the pure half of this module;
// redecideFailedTask shares the model-routing pipeline covered by that row's
// differentials and is exercised here through its admission guard).
use agents_relay_rust2::model_redecision::classify_failure_evidence;
use serde_json::{json, Value};

pub fn invoke(request: &Value) -> Option<Result<String, String>> {
    if request["op"] != "certModelRedecision" {
        return None;
    }
    Some((|| {
        match request["method"].as_str().unwrap_or("") {
            "classify" => {
                let events: Vec<Value> = request["events"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                let logs: Vec<String> = request["logs"]
                    .as_array()
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|v| v.as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default();
                let task_error = request["taskError"].as_str();
                let evidence =
                    classify_failure_evidence(&events, &logs, task_error);
                let classification = match evidence.classification {
                    agents_relay_rust2::model_redecision::FailureClassification::ModelProviderRuntime => "model_provider_runtime",
                    agents_relay_rust2::model_redecision::FailureClassification::WorkerToolInfrastructure => "worker_tool_infrastructure",
                    agents_relay_rust2::model_redecision::FailureClassification::SemanticTask => "semantic_task",
                    agents_relay_rust2::model_redecision::FailureClassification::TimeoutUnknown => "timeout_unknown",
                };
                Ok(json!({"ok":true,
                    "classification":classification,
                    "summary":evidence.summary,
                    "sources":evidence.sources}).to_string())
            }
            value => Err(format!("Unknown model redecision method {value}")),
        }
    })())
}
