//! Explicit local Model Worker receipt protocol for an isolated single-node
//! executor. This is NOT a model router nor a production Codex integration.
//! Unlike Script, a model process exiting zero is never sufficient: it must
//! publish a separately correlated `task.completed` receipt with the exact
//! Worker/Model routing decision previously recorded on the Task.
use crate::authority::ScriptClaim;
use crate::native_receipt::read_bounded_json;
use serde_json::Value;
use std::path::Path;

pub fn verified_model_receipt(path: &Path, claim: &ScriptClaim) -> Result<Value, String> {
    if claim.adapter != "codex" {
        return Err("Model receipt requested for non-Model claim".into());
    }
    let selection = claim
        .worker_selection
        .as_ref()
        .ok_or("Model Worker Router selection missing")?;
    if selection["adapter"] != "codex" || selection["workerId"].as_str().is_none_or(str::is_empty) {
        return Err("Model Worker Router selection invalid".into());
    }
    let route = claim
        .routing
        .as_ref()
        .ok_or("Model route missing from durable claim")?;
    let provider = route
        .get("provider")
        .and_then(Value::as_str)
        .ok_or("Model provider missing")?;
    let model = route
        .get("model")
        .and_then(Value::as_str)
        .ok_or("Model name missing")?;
    if provider.is_empty() || model.is_empty() {
        return Err("Model route incomplete".into());
    }
    let receipt = read_bounded_json(path, "model terminal task event receipt")?;
    if receipt["type"] != "task.completed"
        || receipt["jobId"] != claim.job_id
        || receipt["taskId"] != claim.task_id
        || receipt["executionId"] != claim.execution_id
        || receipt["leaseOwner"] != claim.owner
        || receipt["attempt"] != claim.attempt
        || receipt["adapter"] != "codex"
        || receipt["routing"] != *route
        || receipt["workerSelection"] != *selection
        || receipt["status"] != "COMPLETED"
        || !receipt["output"].is_object()
    {
        return Err(
            "Model terminal event does not match current execution, route or completion status"
                .into(),
        );
    }
    let summary = receipt["summary"]
        .as_str()
        .ok_or("Model terminal event missing summary")?
        .trim();
    if summary.is_empty() || summary.len() > 2048 {
        return Err("invalid Model terminal summary".into());
    }
    Ok(receipt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authority::tests::setup;
    use crate::authority::{RelayAuthority, ScriptClaimRequest};
    use serde_json::json;
    use std::fs;
    #[test]
    fn model_receipt_requires_bound_identity_route_and_event_type() {
        let (_dir, path) = setup();
        let mut store = RelayAuthority::open_existing(&path).unwrap();
        store
            .commit_job("91", "2026-11-13T20:00:01Z", |old| {
                let mut new = old.clone();
                new["updatedAt"] = json!("2026-11-13T20:00:01Z");
                let task = &mut new["tasks"][0];
                task["adapter"] = json!("codex");
                task["routing"] = json!({"provider":"test-provider","model":"test-model",
                "decidedBy":"test-model-router","decidedAt":"2026-11-13T20:00:00Z"});
            task["workerSelection"]=json!({"workerId":"codex","adapter":"codex",
                "selectedBy":"test-worker-router","selectedAt":"2026-11-13T20:00:00Z","capabilities":[]});
                task["dependencies"] = json!([]);
                task["maxAttempts"] = json!(3);
                task["attempt"] = json!(0);
                task["executionId"] = Value::Null;
                task["leaseOwner"] = Value::Null;
                Ok((new, vec![]))
            })
            .unwrap();
        let claim = store
            .claim_queued_codex(&ScriptClaimRequest {
                job_id: "91",
                task_id: "101",
                execution_id: "model-gen1",
                owner: "isolated",
                at: "2026-11-13T20:00:02Z",
                lease_expires_at: "2099-01-01T00:00:00Z",
            })
            .unwrap()
            .unwrap();
        let evidence = path.parent().unwrap().join("terminal.json");
        let mut good = json!({"type":"task.completed","jobId":"91","taskId":"101",
            "executionId":"model-gen1","leaseOwner":"isolated","attempt":1,
            "adapter":"codex","routing":claim.routing,"workerSelection":claim.worker_selection,
            "status":"COMPLETED",
            "summary":"Verified by Model Worker","output":{"artifact":"ok"}});
        fs::write(&evidence, serde_json::to_vec(&good).unwrap()).unwrap();
        assert!(verified_model_receipt(&evidence, &claim).is_ok());
        for (key, bad) in [
            ("executionId", json!("stale")),
            ("type", json!("exit-0")),
            ("routing", json!({"provider":"other","model":"test-model"})),
            ("status", json!("SUBMITTED")),
            ("attempt", json!(2)),
        ] {
            let original = good[key].clone();
            good[key] = bad;
            fs::write(&evidence, serde_json::to_vec(&good).unwrap()).unwrap();
            assert!(
                verified_model_receipt(&evidence, &claim).is_err(),
                "bad {key} accepted"
            );
            good[key] = original;
        }
    }
}
