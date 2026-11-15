//! Narrow native Planner effects. Planning policy is graph-selected; this
//! currently supports only an evidence-free task tree when the objective is
//! explicitly satisfied. Rich child materialization remains fail-closed.
use super::{ledger::reserve_authorized_action_tx, ActionIdentity, RelayAuthority};
use crate::graph::{Decision, Graph, GraphInput};
use chrono::DateTime;
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

const APPLY_GRAPH: &str = include_str!("../../../workflow/force-restate-validation.mmd");

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePlannerApply {
    pub job_id: String,
    pub plan_id: String,
    pub execution_id: String,
    pub idempotent: bool,
    pub job: Value,
}

impl RelayAuthority {
    pub fn apply_native_satisfied_plan(
        &mut self,
        job_id: &str,
        plan_id: &str,
        execution_id: &str,
        proposal: &Value,
        at: &str,
    ) -> Result<NativePlannerApply, String> {
        DateTime::parse_from_rfc3339(at).map_err(|_| "invalid Planner timestamp")?;
        let proposed = proposal["next_tasks"]
            .as_array()
            .ok_or("Planner next_tasks must be an array")?;
        validate_proposed_dag(proposed)?;
        if !proposed.is_empty() {
            return Err(
                "native plan apply cannot materialize next_tasks yet; no partial Plan was written"
                    .into(),
            );
        }
        if proposal["unblocks"]
            .as_array()
            .is_none_or(|v| !v.is_empty())
        {
            return Err(
                "native plan apply cannot register cross-Job unblocks; no partial Plan was written"
                    .into(),
            );
        }
        if proposal
            .get("history_cleanup")
            .is_some_and(|v| !v.is_null() && v.as_array().is_none_or(|a| !a.is_empty()))
        {
            return Err(
                "native plan apply does not support history_cleanup; no partial Plan was written"
                    .into(),
            );
        }
        let fingerprint = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(proposal).map_err(|e| e.to_string())?)
        );
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let raw: Option<String> = tx
            .query_row(
                "SELECT json FROM job_snapshot WHERE job_id=?1",
                [job_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let mut job: Value =
            serde_json::from_str(&raw.ok_or_else(|| format!("Unknown Job {job_id}"))?)
                .map_err(|e| e.to_string())?;
        if proposal["objective_status"] != "satisfied" {
            return Err("native plan apply supports only objective_status=satisfied; in_progress requires child materialization".into());
        }
        if proposal["assessment"]
            .as_str()
            .is_none_or(|s| s.trim().is_empty())
        {
            return Err("Planner assessment must be nonempty".into());
        }
        let implementation = job["tasks"]
            .as_array()
            .ok_or("Job tasks must be an array")?
            .iter()
            .filter(|task| {
                task["kind"] != "planner"
                    && task["agentName"] != "reviewer"
                    && task["agentName"] != "final-reviewer"
                    && task["agentName"] != "troubleshooter"
            })
            .collect::<Vec<_>>();
        let objective_satisfied = !implementation.is_empty()
            && implementation
                .iter()
                .all(|task| task["state"] == "SUCCEEDED");
        if !objective_satisfied {
            return Err("objective_status=satisfied requires at least one durable implementation Task and all such Tasks SUCCEEDED".into());
        }
        let graph = Graph::parse(APPLY_GRAPH)?;
        let input = GraphInput {
            transport: "event".into(),
            id: "plan.apply".into(),
            payload: json!({}),
        };
        let guards = HashMap::from([
            ("forceRestateRequested".into(), false),
            ("historyConsistencyValid".into(), true),
            ("normalHistoryMutationAbsent".into(), true),
            ("objectiveSatisfied".into(), objective_satisfied),
            ("forwardConvergenceValid".into(), true),
        ]);
        let mut state = "idle".to_owned();
        let mut decision = None;
        for _ in 0..12 {
            match graph.decide(&state, input.clone(), &guards)? {
                Decision::Accepted {
                    target, actions, ..
                } => {
                    if !actions.is_empty() {
                        decision = Some(Decision::Accepted {
                            accepted: true,
                            source: state.clone(),
                            target: target.clone(),
                            actions,
                        });
                    }
                    if !target.starts_with("check_") {
                        break;
                    }
                    state = target;
                }
                rejected => {
                    return Err(format!(
                        "Plan Apply graph rejected: {}",
                        serde_json::to_string(&rejected).unwrap_or_default()
                    ))
                }
            }
        }
        let decision = decision.ok_or("Plan Apply graph did not select commit")?;
        if !matches!(&decision,Decision::Accepted{actions,..} if actions.iter().any(|action|action.id=="plan.apply.commit"))
        {
            return Err("Plan Apply graph did not select commit".into());
        }
        let plans = job["plans"]
            .as_array_mut()
            .ok_or("Job plans must be an array")?;
        let plan = plans
            .iter_mut()
            .find(|p| p["id"] == plan_id)
            .ok_or_else(|| format!("Plan {plan_id} not found in Job {job_id}"))?;
        if plan["status"] == "SUCCEEDED" && plan["appliedExecutionId"] == execution_id {
            if plan["appliedCandidateFingerprint"] != fingerprint {
                return Err("Plan execution already applied a different candidate".into());
            }
            tx.commit().map_err(|e| e.to_string())?;
            return Ok(NativePlannerApply {
                job_id: job_id.into(),
                plan_id: plan_id.into(),
                execution_id: execution_id.into(),
                idempotent: true,
                job,
            });
        }
        if plan["status"] != "PLANNING" || plan["executionId"] != execution_id {
            return Err(format!(
                "stale Plan execution {plan_id}/{execution_id}; current status/execution is {}/{}",
                plan["status"], plan["executionId"]
            ));
        }
        let owner = plan["leaseOwner"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("active Plan has no leaseOwner")?;
        let attempt = plan["attempt"].as_i64().unwrap_or(0);
        let identity = ActionIdentity {
            job_id: job_id.into(),
            task_id: plan_id.into(),
            execution_id: execution_id.into(),
            lease_owner: owner.into(),
            attempt,
            generation: attempt,
            graph: "force-restate-validation".into(),
            action_id: "plan.apply.commit".into(),
            attempt_key: format!("planner:{job_id}:{plan_id}:{execution_id}:apply"),
        };
        let inserted =
            reserve_authorized_action_tx(&tx, &identity, &decision, "plan.apply.commit", at)?;
        if !inserted {
            return Err("Planner apply action ledger already contains this execution without a durable matching Plan result".into());
        }
        plan["status"] = json!("SUCCEEDED");
        plan["objectiveStatus"] = json!("satisfied");
        plan["assessment"] = proposal["assessment"].clone();
        plan["plannerResult"] = proposal.clone();
        plan["appliedCandidateFingerprint"] = json!(fingerprint);
        plan["generatedTaskIds"] = json!([]);
        plan["executionId"] = Value::Null;
        plan["leaseOwner"] = Value::Null;
        plan["leaseExpiresAt"] = Value::Null;
        plan["appliedExecutionId"] = json!(execution_id);
        plan["updatedAt"] = json!(at);
        job["updatedAt"] = json!(at);
        tx.execute("UPDATE workflow_action_trace SET outcome='Verified' WHERE attempt_key=?1 AND outcome='Unknown'",[&identity.attempt_key]).map_err(|e|e.to_string())?;
        tx.execute(
            "UPDATE job_snapshot SET json=?1,updated_at=?2 WHERE job_id=?3",
            params![
                serde_json::to_string(&job).map_err(|e| e.to_string())?,
                at,
                job_id
            ],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(NativePlannerApply {
            job_id: job_id.into(),
            plan_id: plan_id.into(),
            execution_id: execution_id.into(),
            idempotent: false,
            job,
        })
    }
}

fn validate_proposed_dag(tasks: &[Value]) -> Result<(), String> {
    let mut ids = std::collections::HashSet::new();
    for task in tasks {
        let id = task["id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("Planner Task requires a nonempty id")?;
        if !ids.insert(id.to_owned()) {
            return Err(format!("duplicate Planner Task ID {id}"));
        }
    }
    let mut edges = HashMap::<String, Vec<String>>::new();
    for task in tasks {
        let id = task["id"].as_str().ok_or("Planner Task requires id")?;
        let deps = task
            .get("dependencies")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut seen = std::collections::HashSet::new();
        for dep in deps {
            let dep = dep
                .as_str()
                .ok_or("Planner dependency IDs must be strings")?;
            if !seen.insert(dep.to_owned()) {
                return Err(format!("duplicate dependency {dep} for Planner Task {id}"));
            }
            if !ids.contains(dep) {
                return Err(format!("unknown Planner dependency {dep}; native apply requires dependencies to name Tasks in this candidate"));
            }
            if dep == id {
                return Err(format!(
                    "Planner dependency cycle: Task {id} depends on itself"
                ));
            }
            edges.entry(id.into()).or_default().push(dep.into());
        }
    }
    fn visit(
        id: &str,
        edges: &HashMap<String, Vec<String>>,
        visiting: &mut std::collections::HashSet<String>,
        done: &mut std::collections::HashSet<String>,
    ) -> Result<(), String> {
        if done.contains(id) {
            return Ok(());
        }
        if !visiting.insert(id.into()) {
            return Err(format!("Planner dependency cycle includes Task {id}"));
        }
        for dep in edges.get(id).into_iter().flatten() {
            visit(dep, edges, visiting, done)?
        }
        visiting.remove(id);
        done.insert(id.into());
        Ok(())
    }
    let mut visiting = std::collections::HashSet::new();
    let mut done = std::collections::HashSet::new();
    for id in &ids {
        visit(id, &edges, &mut visiting, &mut done)?
    }
    Ok(())
}
