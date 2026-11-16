//! Manual Planner rounds against the actual original planner-trigger.mmd.
//! This is a verified execution-bound Plan request: the caller subsequently
//! submits a candidate through `plan apply`, never through free-form text.
use super::RelayAuthority;
use crate::graph::{Decision, Graph, GraphInput};
use chrono::{DateTime, Duration};
use serde_json::{json, Value};
use std::collections::HashMap;

const TRIGGER: &str = include_str!("../../../workflow/planner-trigger.mmd");

fn trigger_source(job: &Value, manual: bool) -> Result<String, String> {
    let no_plans = job["plans"].as_array().is_none_or(|plans| plans.is_empty());
    let prior_legacy = job["tasks"]
        .as_array()
        .is_some_and(|tasks| tasks.iter().any(|t| t["kind"] == "planner"));
    let needs_review = job["review"]["outcome"] == "changes_required";
    let unblocks = job.get("changeCycle").is_some_and(|v| !v.is_null())
        || job["tasks"].as_array().is_some_and(|tasks| {
            tasks
                .iter()
                .any(|t| t.get("unblock").is_some_and(|v| !v.is_null()))
        });
    if unblocks {
        return Err("unblock-triggered Planner requires bound cross-Job blocker evidence".into());
    }
    let graph = Graph::parse(TRIGGER)?;
    let input = GraphInput {
        transport: "event".into(),
        id: "plan.requested".into(),
        payload: json!({}),
    };
    let guards = HashMap::from([
        ("manualPlan".into(), manual),
        ("hasUnblock".into(), false),
        // A verified changes_required Review is a stronger, more specific
        // trigger than first-use planning. Without this guard fact the Graph
        // would classify an objective-only Job's first corrective Plan as
        // initial, and the canonical reviewPlanReady gate could never accept
        // its revision child evidence for a fresh immutable-head Review.
        (
            "initialPlan".into(),
            no_plans && !prior_legacy && !needs_review,
        ),
        ("reviewRequired".into(), needs_review),
    ]);
    let mut state = "idle".to_owned();
    for _ in 0..8 {
        let decision = graph.decide(&state, input.clone(), &guards)?;
        let Decision::Accepted { target, .. } = decision else {
            return Err("Planner Trigger Graph rejected Plan request".into());
        };
        if !target.starts_with("check_") {
            if !matches!(
                target.as_str(),
                "initial" | "manual" | "review" | "continuation"
            ) {
                return Err("unexpected Planner Trigger Graph target".into());
            }
            return Ok(target);
        }
        state = target;
    }
    Err("Planner Trigger Graph did not terminate".into())
}

impl RelayAuthority {
    pub fn request_native_plan(
        &mut self,
        job_id: &str,
        guidance: Option<&str>,
        manual: bool,
        at: &str,
    ) -> Result<Value, String> {
        let now = DateTime::parse_from_rfc3339(at).map_err(|_| "invalid Planner time")?;
        if guidance.is_some_and(|s| s.trim().is_empty() || s.len() > 16_000) {
            return Err("Planner guidance must be nonempty and at most 16000 bytes".into());
        }
        // An exact replay is read-only. `commit_job` requires a strictly
        // newer updatedAt and therefore must never be used for a no-op.
        // A concurrent changed generation is still fenced by the callback.
        if let Some(current) = self.read_job(job_id)? {
            if let Some(active) = current["plans"]
                .as_array()
                .and_then(|plans| plans.iter().find(|p| p["status"] == "PLANNING"))
            {
                if active["manualPlanning"] == manual && active["guidance"] == json!(guidance) {
                    return Ok(json!({"jobId":job_id,"planId":active["id"],
                        "executionId":active["executionId"],"idempotent":true,"plan":active}));
                }
            }
        }
        let execution_id = format!("planner-{}", uuid::Uuid::new_v4());
        let lease_owner = format!("rust-planner:{}", uuid::Uuid::new_v4());
        let guidance = guidance.map(str::to_owned);
        let mut result = None;
        self.commit_job(job_id,at,|prior|{
            if !matches!(prior["state"].as_str(),Some("ACTIVE"|"DRAFT"))
                || prior.get("pause").is_some_and(|v|!v.is_null()) {
                return Err("Plan request requires an unpaused, nonterminal Job".into())
            }
            let plans=prior["plans"].as_array().ok_or("Job Plan list missing")?;
            if let Some(active)=plans.iter().find(|p|p["status"]=="PLANNING") {
                if active["manualPlanning"]==manual && active["guidance"]==json!(guidance) {
                    result=Some(json!({"jobId":job_id,"planId":active["id"],"executionId":active["executionId"],"idempotent":true,"plan":active}));
                    return Ok((prior.clone(),vec![]))
                }
                return Err("a different Planner generation is already active".into());
            }
            if plans.iter().any(|p|p["status"]=="FAILED" && p.get("resolution").is_none_or(Value::is_null)) {
                return Err("failed Planner round requires verified Troubleshooter resolution".into());
            }
            // A second Plan during a currently executing Task is not a valid
            // convergence point. Node's ordinary Reconciler waits for work.
            if !plans.is_empty() && prior["tasks"].as_array().is_some_and(|tasks|tasks.iter().any(|t|
                matches!(t["state"].as_str(),Some("DRAFT"|"QUEUED"|"RUNNING"|"AWAITING_DECISION")))) {
                return Err("next Planner round must wait for active implementation Tasks".into());
            }
            let previous=plans.last();
            let round=plans.iter().filter_map(|p|p["round"].as_i64()).max().unwrap_or(0)+1;
            if round>1000 {return Err("Planner round limit exceeded".into())}
            let id=format!("plan-{round}");
            if plans.iter().any(|p|p["id"]==id) || prior["tasks"].as_array().is_some_and(|tasks|tasks.iter().any(|t|t["id"]==id)) {
                return Err("Planner round ID collides with existing entity".into());
            }
            let trigger=trigger_source(prior,manual)?;
            let trigger_details = if trigger == "review" {
                let review_id=prior["review"]["taskId"].as_str()
                    .filter(|id|!id.is_empty())
                    .ok_or("review-triggered Plan needs a durable bound Reviewer Task")?;
                json!({"source":"review","reviewTaskId":review_id,
                    "reason":"Final Review requested changes",
                    "facts":["Address persisted Final Review findings"]})
            } else {json!({"source":trigger})};
            let expires=(now+Duration::minutes(15)).to_rfc3339();
            let prior_head=prior["headSha"].clone();
            let plan=json!({
                "jobId":job_id,"id":id,"round":round,"source":"model-planner",
                "previousPlanId":previous.map_or(Value::Null,|p|p["id"].clone()),
                "trigger":trigger_details,"status":"PLANNING","guidance":guidance,
                "assessment":"Planning in progress.","generatedTaskIds":[],
                "headSha":prior_head,"attempt":1,"maxAttempts":if manual {1}else{3},
                "leaseOwner":lease_owner,"leaseExpiresAt":expires,"executionId":execution_id,
                "timeoutMs":900_000,"manualPlanning":manual,"createdAt":at,"updatedAt":at,
            });
            let mut next=prior.clone();
            next["plans"].as_array_mut().ok_or("Plans missing")?.push(plan.clone());
            next["updatedAt"]=json!(at);
            result=Some(json!({"jobId":job_id,"planId":id,"executionId":execution_id,"idempotent":false,"plan":plan}));
            Ok((next,vec![]))
        })?;
        result.ok_or("Plan request result missing".into())
    }
}
