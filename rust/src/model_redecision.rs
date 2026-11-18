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

use crate::{
    decision_audit::outcome_for_decision,
    model_routing::{discover_model_candidates,route_model},
    usage::UsageSnapshotProvider,
};
use serde_json::json;
use std::path::Path;

/// Re-route only: never retry, clear an execution generation, or alter a Task
/// lifecycle. The usage snapshot, model discovery and Graph policy are the
/// same production ports as the regular model router.
pub fn redecide_failed_task<Update,Audit>(
    task:&Value,worker:&Value,registered:&[Value],
    usage_provider:&dyn UsageSnapshotProvider,evidence:&Value,
    codex_home:&Path,now_ms:i64,
    policy_path:&str,rules_path:&str,
    decision_mode:Option<&str>,proposed_choice:Option<&str>,
    decision_evidence:Option<&Value>,audit_store_enabled:bool,
    mut update_routing:Update,mut append_audit:Audit,
)->Result<Value,String>
where
    Update:FnMut(&Value,&Value)->Result<(),String>,
    Audit:FnMut(&Value)->Result<(),String>,
{
    if evidence.get("classification").and_then(Value::as_str)
        !=Some("model_provider_runtime") {
        return Err("Model re-decision requires model/provider/runtime evidence".into());
    }
    let usage=crate::usage::read_usage_snapshot(usage_provider)?;
    let candidates=discover_model_candidates(
        worker,registered,Some(&usage),codex_home,now_ms);
    let prior=task.get("routing").filter(|value|!value.is_null());
    let mut facts=json!({
        "kind":task.get("kind").and_then(Value::as_str).unwrap_or("work"),
        "prior_routing":prior,
        "fresh_usage_generated_at":usage.get("generatedAt")
    });
    for key in ["capabilities","taskCapabilities","workerCapabilities","input"] {
        if let Some(value)=task.get(key){facts[key]=value.clone();}
    }
    let mut options=json!({"taskFacts":facts.clone(),"priorFailure":evidence});
    if let Some(mode)=decision_mode{options["decisionMode"]=json!(mode);}
    if let Some(prior)=prior {
        if let Some(id)=prior.get("decisionId") {
            options["priorDecisionId"]=id.clone();
        }
        let mut excluded=json!({});
        for key in ["provider","model","profile"] {
            if let Some(value)=prior.get(key){excluded[key]=value.clone();}
        }
        options["excludedRoutes"]=json!([excluded]);
    }else{options["excludedRoutes"]=json!([]);}
    let mut result=route_model(worker,&candidates,&options,
        policy_path,rules_path,proposed_choice,decision_evidence,None)?;
    let routing=result.get("routing")
        .ok_or("Model router did not return a routing decision")?.clone();
    let policy=crate::routing_policy::load_routing_policy(policy_path,rules_path);
    let excluded=options.get("excludedRoutes").and_then(Value::as_array)
        .map(Vec::as_slice).unwrap_or(&[]);
    let eligible=crate::model_routing::eligible_models(
        &candidates,options.get("constraints"),&policy["policy"],excluded);
    let worker_audit=json!({
        "id":worker.get("workerId"),"adapter":worker.get("adapter"),
        "capabilities":worker.get("capabilities"),
    });
    let contract=json!({"question":"model-profile-selection",
        "task":facts,"constraints":{},"excludedRoutes":excluded});
    let mut decision_audit=crate::decision_audit::make_decision_audit(
        Some(task),&worker_audit,&contract,&policy,
        &candidates,&eligible,&result["candidate"],&routing,
        prior.and_then(|route|route.get("decisionId")).and_then(Value::as_str),
        Some(evidence));
    // Node serializes missing optional Task IDs as undefined (omitted), not
    // null, in this audit. Preserve that observable JSON wire contract.
    if task.get("executionId").is_none(){
        for pointer in ["/correlation","/task"]{
            if let Some(map)=decision_audit.pointer_mut(pointer).and_then(Value::as_object_mut){
                map.remove("execution_id");
            }
        }
    }
    if let Some(fallback)=decision_audit.get_mut("fallback")
        .and_then(Value::as_object_mut){
        if fallback.get("reason").is_some_and(Value::is_null){
            fallback.remove("reason");
        }
    }
    result["routing"]["decisionId"]=decision_audit["decision_id"].clone();
    result["audit"]=decision_audit.clone();
    if audit_store_enabled {append_audit(&decision_audit)?;}
    update_routing(task,&result["routing"])?;
    if audit_store_enabled {
        if let Some(id)=prior.and_then(|route|route.get("decisionId"))
            .and_then(Value::as_str) {
            let summary=evidence.get("summary").and_then(Value::as_str).unwrap_or("");
            let audit=outcome_for_decision(id,"provider_failure",summary,
                Some(&json!({"classification":"model_provider_runtime",
                    "fresh_usage_generated_at":usage.get("generatedAt")})));
            append_audit(&audit)?;
        }
    }
    let mut output=result;
    output["freshUsageGeneratedAt"]=usage.get("generatedAt")
        .cloned().unwrap_or(Value::Null);
    Ok(output)
}
