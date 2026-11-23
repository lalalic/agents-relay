// src/troubleshooter-fallback.ts bounded fallback reducer. SQLite caller owns
// mutateJob transaction and idempotent commit. Escalation is Graph-authorized
// and transactionally persisted; downstream human notification is separate.
use crate::local_merge_lock::iso8601_now;
use crate::workflow::lifecycle::dispatch_task_lifecycle_sync;
use serde_json::{json, Value};
use std::path::Path;
pub fn fallback_failed_troubleshooters(
    _root:&Path,_job:&mut Value,
)->Result<Vec<String>,String>{
    // The Troubleshooter never has an automatic alternate-model retry.
    // An unresolved one-shot execution is handed to escalation.
    Ok(Vec::new())
}
/// Retained compatibility entry point: no retry mutation is ever scheduled.
pub fn fallback_failed_troubleshooters_atomic<W, E>(
    store: &mut crate::relay_workflow_operations::SQLiteWorkflowOperations<'_, W, E>,
    graph_dir: &Path,
    job_id: &str,
) -> Result<Vec<String>, String>
where
    W: FnMut(&Value, &str) -> Result<(), String>,
    E: FnMut(&Value, &str) -> Result<(), String>,
{
    let mut queued = Vec::new();
    store.mutate_job(job_id, |mut job| {
        queued = fallback_failed_troubleshooters(graph_dir, &mut job)?;
        Ok(job)
    })?;
    Ok(queued)
}

/// Durable human action-gate candidates. The Core must still submit these
/// through the authoritative task-recovery escalation API; merely identifying
/// a candidate is not an escalation nor an authorized human response.
pub fn exhausted_troubleshooter_escalations(job: &Value) -> Vec<Value> {
    let tasks = job["tasks"].as_array().cloned().unwrap_or_default();
    let plans = job["plans"].as_array().cloned().unwrap_or_default();
    tasks.iter().filter_map(|recovery| {
        if recovery["agentName"] != "troubleshooter" || recovery["state"] != "FAILED"
            || recovery["attempt"].as_i64().unwrap_or(0)
                < 1
            || recovery.get("escalation").is_some_and(|v| !v.is_null())
        { return None; }
        let original = tasks.iter().find(|task| task["id"] == recovery["parentTaskId"]);
        let plan = plans.iter().find(|plan| plan["id"] == recovery["recoveryPlanId"]);
        if !original.is_some_and(|task| task["state"] == "FAILED")
            && !plan.is_some_and(|plan| plan["status"] == "FAILED")
        { return None; }
        if original.is_some_and(|task| {
            task["resolution"]["path"] == "same_job_dependency"
                && matches!(task["resolution"]["state"].as_str(), Some("waiting" | "active"))
        }) { return None; }
        let subject = if let Some(original) = original {
            format!("Task {}", original["id"].as_str().unwrap_or("undefined"))
        } else {
            format!("Plan {}", plan?["id"].as_str().unwrap_or("undefined"))
        };
        let failure = original.and_then(|original| original["error"].as_str()
            .or_else(|| original["failureReason"].as_str()))
            .or_else(|| plan.and_then(|plan| plan["error"].as_str()))
            .unwrap_or("unknown");
        let last = recovery["error"].as_str()
            .or_else(|| recovery["failureReason"].as_str())
            .unwrap_or("unknown");
        let recovery_id = recovery["id"].as_str().unwrap_or("undefined");
        Some(json!({
            "taskId": recovery["id"],
            "requiredAction":format!("Inspect {subject} and Troubleshooter {recovery_id}; correct provider/runtime or supply a concrete recovery decision and supporting evidence."),
            "resolutionCondition":format!("User supplies a corrective action or verified recovery instructions for {subject}."),
            "context":format!("One-shot Troubleshooter {recovery_id} could not produce a verified resolution after {} execution(s). Last failure: {last}. Original {subject}: {failure}.",
                recovery["attempt"]),
        }))
    }).collect()
}

/// Public Node escalateExhaustedTroubleshooters effect boundary. Candidates
/// remain facts, not workflow decisions. The caller MUST bind request to
/// the authoritative task-recovery API so a returned non-duplicate means a
/// durable human-action gate, not merely an attempted notification.
///
/// A single snapshot controls the bounded loop, matching Node. Any load or
/// escalation failure aborts without marking subsequent Tasks escalated.
pub fn escalate_exhausted_troubleshooters<Load, Request>(
    job_id: &str,
    mut load: Load,
    mut request: Request,
) -> Result<Vec<String>, String>
where
    Load: FnMut(&str) -> Result<Value, String>,
    Request: FnMut(&str, &str, &Value) -> Result<bool, String>,
{
    let snapshot = load(job_id)?;
    let candidates = exhausted_troubleshooter_escalations(&snapshot);
    let mut escalated = Vec::new();
    for candidate in candidates {
        let id = candidate["taskId"]
            .as_str()
            .ok_or("escalation Task ID missing")?;
        if !request(job_id, id, &candidate)? {
            escalated.push(id.to_owned());
        }
    }
    Ok(escalated)
}

#[cfg(test)]
mod wave4_escalation_tests {
    use super::*;
    #[test]
    fn escalation_submits_real_effects_and_ignores_exact_duplicate_receipts() {
        let snapshot = json!({"tasks":[
            {"id":"1","agentName":"implementation","state":"FAILED","error":"missing provider"},
            {"id":"2","agentName":"troubleshooter","state":"FAILED","attempt":3,"maxAttempts":3,
             "parentTaskId":"1","error":"provider down"},
            {"id":"3","agentName":"troubleshooter","state":"FAILED","attempt":4,"maxAttempts":3,
             "parentTaskId":"1","failureReason":"model not supported"},
            {"id":"4","agentName":"troubleshooter","state":"RUNNING","attempt":3,"maxAttempts":3,"parentTaskId":"1"}
        ]});
        let mut delivered = vec![];
        let result = escalate_exhausted_troubleshooters(
            "job",
            |id| {
                assert_eq!(id, "job");
                Ok(snapshot.clone())
            },
            |id, task, payload| {
                assert_eq!(id, "job");
                assert!(payload["context"]
                    .as_str()
                    .unwrap()
                    .contains("Last failure"));
                assert!(payload["requiredAction"].as_str().unwrap().contains(task));
                delivered.push(task.to_owned());
                Ok(task == "3") // 3 was already escalated in the authoritative store
            },
        )
        .unwrap();
        assert_eq!(delivered, ["2", "3"]);
        assert_eq!(result, ["2"]);
    }
    #[test]
    fn escalation_transport_failure_stops_later_requests() {
        let snapshot = json!({"tasks":[
            {"id":"1","agentName":"implementation","state":"FAILED"},
            {"id":"2","agentName":"troubleshooter","state":"FAILED","attempt":3,"maxAttempts":3,"parentTaskId":"1"},
            {"id":"3","agentName":"troubleshooter","state":"FAILED","attempt":3,"maxAttempts":3,"parentTaskId":"1"}
        ]});
        let mut calls = 0;
        let err = escalate_exhausted_troubleshooters(
            "job",
            |_| Ok(snapshot.clone()),
            |_, _, _| {
                calls += 1;
                Err("durable gate write rejected".into())
            },
        )
        .unwrap_err();
        assert_eq!(err, "durable gate write rejected");
        assert_eq!(calls, 1);
    }
}

/// Public Node escalateExhaustedTroubleshooters effect on the authoritative
/// SQLite store. Recheck candidate eligibility inside the write transaction;
/// Task Resolution and Task Lifecycle Graphs authorize both mutations. The
/// escalation event is committed to the SQLite publication outbox with the
/// Job, never emitted from a speculative read or a provider submission.
pub fn escalate_exhausted_troubleshooters_atomic<W, E>(
    store: &mut crate::relay_workflow_operations::SQLiteWorkflowOperations<'_, W, E>,
    graph_dir: &Path,
    job_id: &str,
) -> Result<Vec<String>, String>
where
    W: FnMut(&Value, &str) -> Result<(), String>,
    E: FnMut(&Value, &str) -> Result<(), String>,
{
    use rusqlite::{params, OptionalExtension};
    use sha2::{Digest, Sha256};
    let raw: Option<String> = store
        .db
        .query_row(
            "SELECT json FROM job_snapshot WHERE job_id=?1",
            params![job_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let snapshot: Value =
        serde_json::from_str(&raw.ok_or_else(|| format!("Unknown Job {job_id}"))?)
            .map_err(|e| e.to_string())?;
    let candidates = exhausted_troubleshooter_escalations(&snapshot);
    let mut escalated = Vec::new();
    for candidate in candidates {
        let recovery_id = candidate["taskId"]
            .as_str()
            .ok_or("missing troubleshooter task ID")?
            .to_string();
        let mut created = false;
        store.commit_workflow_mutation_with_events(job_id, |mut current| {
            let recovery_index=current["tasks"].as_array().into_iter().flatten()
                .position(|task|task["id"]==recovery_id)
                .ok_or_else(||format!("Task {recovery_id} is not a Troubleshooter recovery"))?;
            let recovery=current["tasks"][recovery_index].clone();
            if recovery["agentName"]!="troubleshooter"
                || recovery["state"]!="FAILED"
                || recovery["attempt"].as_i64().unwrap_or(0)<1
                || !recovery["escalation"].is_null() {
                return Ok((current,vec![]));
            }
            if current["state"]=="CANCELLED" || current["state"]=="COMPLETED" {
                return Err(format!("Job {} is terminal",current["id"].as_str().unwrap_or("")));
            }
            let original_index=current["tasks"].as_array().into_iter().flatten().position(|task|
                !recovery["parentTaskId"].is_null() && task["id"]==recovery["parentTaskId"]);
            let plan=current["plans"].as_array().into_iter().flatten().find(|plan|
                !recovery["recoveryPlanId"].is_null() && plan["id"]==recovery["recoveryPlanId"]).cloned();
            let original=original_index.map(|index|current["tasks"][index].clone());
            if !original.as_ref().is_some_and(|task|task["state"]=="FAILED")
                && !plan.as_ref().is_some_and(|plan|plan["status"]=="FAILED") {
                return Err(format!("Troubleshooter {recovery_id} has no current FAILED original Task or Plan"));
            }
            if original.as_ref().is_some_and(|task|task["resolution"]["path"]=="same_job_dependency"
                && matches!(task["resolution"]["state"].as_str(),Some("active"|"waiting"))) {
                return Ok((current,vec![]));
            }
            let request_action=candidate["requiredAction"].as_str().ok_or("missing escalation action")?.trim();
            let condition=candidate["resolutionCondition"].as_str().ok_or("missing escalation condition")?.trim();
            let context=candidate["context"].as_str().ok_or("missing escalation context")?.trim();
            if request_action.is_empty() || condition.is_empty() || context.is_empty() {
                return Err("Escalation requires action, condition and diagnostic context".into());
            }
            let original_execution=original.as_ref().map(|v|&v["executionId"])
                .filter(|v|!v.is_null()).or_else(||plan.as_ref().map(|v|&v["executionId"]));
            let fingerprint_data=json!([request_action,condition,context,original_execution.cloned().unwrap_or(Value::Null)]);
            let fingerprint=format!("{:x}",Sha256::digest(fingerprint_data.to_string().as_bytes()));
            let at=iso8601_now();
            if let Some(index)=original_index {
                let proposal=json!({"path":"escalation_gate","targetTaskId":current["tasks"][index]["id"],
                    "recoveryExecutionId":recovery["executionId"],"rootCause":context,"solution":request_action});
                let mut action_seen=false;
                let decision=crate::workflow::task_resolution::dispatch_task_resolution_sync(
                    graph_dir,&current["tasks"][index],&proposal,&json!("troubleshooter"),|action| {
                        if action!="resolution.createEscalationGate" { return Err(format!("Unexpected resolution action {action}")); }
                        action_seen=true; Ok(())
                    })?;
                if decision["accepted"]!=true || !action_seen {
                    return Err(format!("Task resolution graph rejected escalation for {}",current["tasks"][index]["id"]));
                }
                current["tasks"][index]["resolution"]=
                    crate::workflow::task_resolution::materialize_resolution(&proposal,&json!("troubleshooter"),&at);
            }
            let task=&mut current["tasks"][recovery_index];
            let transition=dispatch_task_lifecycle_sync(graph_dir,task,"task.blocked",
                &json!({"recoverableExecution":true}),&at)?;
            if transition["accepted"]!=true {
                return Err(format!("Troubleshooter {recovery_id} cannot be blocked"));
            }
            let id=crate::events::random_uuid();
            let mut escalation=json!({"id":id,"fingerprint":fingerprint,
                "requiredAction":request_action,"resolutionCondition":condition,"context":context,
                "status":"pending","requestedAt":at,
                "notification":{"status":"pending","channel":"relay-event","requestedAt":at}});
            if let Some(ref original)=original {
                escalation["originalTaskId"]=original["id"].clone();
                if !original["executionId"].is_null() {
                    escalation["originalExecutionId"]=original["executionId"].clone();
                }
            }
            if let Some(ref plan)=plan {escalation["originalPlanId"]=plan["id"].clone();}
            if !recovery["executionId"].is_null(){escalation["recoveryExecutionId"]=recovery["executionId"].clone();}
            task["escalation"]=escalation;
            task["error"]=json!(format!("Waiting for human action: {request_action}"));
            task["failureReason"]=json!("human_action_required");
            task["executionId"]=Value::Null;
            task["updatedAt"]=json!(at);
            current["updatedAt"]=json!(at);
            let mut event=crate::events::event_for(job_id,&recovery_id,original.as_ref().and_then(|task|task["id"].as_str()),
                "escalation.requested","blocked",&format!("Human action required: {request_action}"),Some("user"),
                Some(json!({"escalationId":id,"originalTaskId":original.as_ref().map(|v|v["id"].clone()),
                    "originalPlanId":plan.as_ref().map(|v|v["id"].clone()),
                    "requiredAction":request_action,"resolutionCondition":condition,"notificationStatus":"pending"})),
                Some(json!({"agent":"relay","component":"agents-relay"})));
            event["event_id"]=json!(format!("escalation/{id}"));
            created=true;
            Ok((current,vec![json!({"key":event["event_id"],"event":event})]))
        })?;
        if created {
            escalated.push(recovery_id);
        }
    }
    Ok(escalated)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn filters_unrelated() {
        let mut job = json!({"tasks":[]});
        assert!(fallback_failed_troubleshooters(Path::new("/tmp"), &mut job)
            .unwrap()
            .is_empty());
    }
}
