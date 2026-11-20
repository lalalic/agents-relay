// Original decision-audit.ts public API differential: reason redaction,
// reason-code classification, route result extraction, recent route joining
// (latest terminal outcome per execution attempt, global ordering), the
// JSONL store over real files, outcomeForDecision/taskAuditFacts, and both
// audit record builders over fixture inputs. No network; timestamps and
// UUID fields are normalized by the harness on both stacks.
use agents_relay_rust2::decision_audit::{
    self, audit_input_hash, decision_audit_id, outcome_for_decision,
    recent_execution_route_results, route_reason, route_result,
    router_reason_code, task_audit_facts, JsonlDecisionAuditStore,
};
use serde_json::{json, Value};
use std::path::PathBuf;

fn scratch() -> PathBuf {
    let dir = std::env::temp_dir()
        .join(format!("rust2-da-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("scratch");
    dir
}

pub fn invoke(request: &Value) -> Option<Result<String, String>> {
    if request["op"] != "certDecisionAudit" {
        return None;
    }
    Some((|| {
        match request["method"].as_str().unwrap_or("") {
            "routeReason" => Ok(json!(route_reason(
                    request["value"].as_str().unwrap_or(""))).to_string()),
            "reasonCode" => Ok(json!(router_reason_code(
                    request["kind"].as_str().unwrap_or(""),
                    request["summary"].as_str().unwrap_or(""))).to_string()),
            "routeResult" => {
                let records = request["records"].as_array().cloned()
                    .unwrap_or_default();
                let limit = request["limit"].as_u64().unwrap_or(10) as usize;
                let joined = recent_execution_route_results(&records,limit);
                Ok(json!(joined.first().cloned()
                    .unwrap_or(Value::Null)).to_string())
            }
            "recentRoutes" => {
                let records = request["records"].as_array().cloned()
                    .unwrap_or_default();
                let limit = request["limit"].as_u64().unwrap_or(10) as usize;
                Ok(json!(recent_execution_route_results(
                    &records,limit)).to_string())
            }
            "jsonlStore" => {
                let dir = scratch();
                let path = dir.join("audit.jsonl");
                if let Some(raw) = request["rawFile"].as_str() {
                    std::fs::write(&path, raw).map_err(|e| e.to_string())?;
                }
                let store = JsonlDecisionAuditStore::new(&path);
                for record in request["appends"].as_array()
                    .map(Vec::as_slice).unwrap_or(&[]) {
                    store.append(record).map_err(|e| e.to_string())?;
                }
                let read = store.read();
                let routes = store.read_recent_routes(
                    request["limit"].as_u64().unwrap_or(10) as usize);
                let _ = std::fs::remove_dir_all(&dir);
                Ok(json!({"read":read,
                    "routes":routes}).to_string())
            }
            "outcomeForDecision" => {
                let outcome = outcome_for_decision(
                    request["decisionId"].as_str().unwrap_or(""),
                    request["kind"].as_str().unwrap_or(""),
                    request["summary"].as_str().unwrap_or(""),
                    request.get("evidence").filter(|v| !v.is_null()));
                Ok(json!({"outcome":outcome}).to_string())
            }
            "taskAuditFacts" => Ok(task_audit_facts(
                    request.get("task").filter(|v| !v.is_null())).to_string()),
            "makeDecisionAudit" => {
                let record = decision_audit::make_decision_audit(
                    request.get("task").filter(|v| !v.is_null()),
                    &request["worker"], &request["contract"],
                    &request["policy"],
                    request["candidates"].as_array().map(Vec::as_slice)
                        .unwrap_or(&[]),
                    request["eligible"].as_array().map(Vec::as_slice)
                        .unwrap_or(&[]),
                    &request["selected"], &request["routing"],
                    request["priorDecisionId"].as_str(),
                    request.get("priorFailure").filter(|v| !v.is_null()),
                );
                Ok(record.to_string())
            }
            "makeExecutionDecisionAudit" => {
                let record = decision_audit::make_execution_decision_audit(
                    request.get("task").filter(|v| !v.is_null()),
                    request["workers"].as_array().map(Vec::as_slice)
                        .unwrap_or(&[]),
                    &request["requirements"],
                    request["evaluations"].as_array().map(Vec::as_slice)
                        .unwrap_or(&[]),
                    request["workerGates"].as_array().map(Vec::as_slice)
                        .unwrap_or(&[]),
                    &request["selected"], &request["contract"],
                    &request["policy"], &request["routing"],
                    request["stages"].as_array().map(Vec::as_slice)
                        .unwrap_or(&[]),
                );
                Ok(record.to_string())
            }
            "ids" => {
                let id = decision_audit_id();
                let hash = audit_input_hash(&request["record"]);
                Ok(json!({"id":id,"hash":hash}).to_string())
            }
            value => Err(format!("Unknown decision audit method {value}")),
        }
    })())
}
