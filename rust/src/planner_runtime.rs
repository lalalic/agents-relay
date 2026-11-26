// Node provenance: src/planner-runtime.ts. Deterministic Plan execution
// leases, durable Task creation, rollback and Troubleshooter admission.
// All workflow actions are selected by existing Mermaid Plan Graph policies.
use crate::{
    events::{event_for, random_uuid},
    local_merge_lock::iso8601_now,
    planner::{
        materialize_planner_child, parse_planner_result, validate_planner_hierarchy,
        validate_planner_lifecycle_ownership, validate_planner_progress,
        validate_planner_resolution_materialization,
    },
    planner_task_ids::assign_planner_task_ids,
    workflow::{policy_graph::choose_policy, task_resolution::attach_resolution_ownership},
};
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    future::Future,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
fn field<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn plan_index(job: &Value, plan_id: &str) -> Option<usize> {
    job.get("plans")
        .and_then(Value::as_array)
        .and_then(|plans| plans.iter().position(|p| field(p, "id") == plan_id))
}
fn task_ids(job: &Value) -> HashSet<String> {
    job.get("tasks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|t| field(t, "id").to_owned())
        .collect()
}
fn actions(decision: &Value) -> Vec<String> {
    decision
        .get("actions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|a| a.get("id").and_then(Value::as_str))
        .map(str::to_owned)
        .collect()
}
fn graph_action(
    directory: &Path,
    state: &str,
    event: &str,
    facts: &Value,
    expected: &str,
) -> Result<Value, String> {
    // Plan lease/settlement is distinct from Job-wide planner.reconcile.
    // Dispatch against the Plan execution Graph, not planner-orchestration.
    let decision = choose_policy(directory, "plan-execution", state, event, facts, 14, |s| {
        s.starts_with("check_")
    })?;
    if decision.get("accepted") != Some(&Value::Bool(true))
        || !actions(&decision).iter().any(|action| action == expected)
    {
        return Err(format!(
            "Planner Graph rejected {event} at {state} (required action {expected})"
        ));
    }
    Ok(decision)
}
fn next_time(previous: &str, proposed: &str) -> String {
    let before = DateTime::parse_from_rfc3339(previous)
        .ok()
        .map(|v| v.timestamp_millis())
        .unwrap_or(0);
    let after = DateTime::parse_from_rfc3339(proposed)
        .ok()
        .map(|v| v.timestamp_millis())
        .unwrap_or(0);
    DateTime::<Utc>::from_timestamp_millis(before.saturating_add(1).max(after))
        .map(|t| t.to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or_else(iso8601_now)
}
pub fn claim_plan_execution(
    directory: &Path,
    job: &Value,
    plan_id: &str,
    owner: &str,
    execution_id: &str,
    now: &str,
) -> Result<Value, String> {
    let mut candidate = job.clone();
    let idx = plan_index(&candidate, plan_id).ok_or_else(|| format!("Plan {plan_id} not found"))?;
    let plan = &candidate["plans"][idx];
    let state = field(plan, "status");
    let available = field(plan, "executionId").is_empty();
    let facts = json!({
        "claimAvailable":available,
        "retryAvailable":plan.get("attempt").and_then(Value::as_u64).unwrap_or(0)
            <plan.get("maxAttempts").and_then(Value::as_u64).unwrap_or(3),
        "activeJob":field(&candidate,"state")=="ACTIVE",
        "notPaused":candidate.get("pause").is_none_or(Value::is_null)
    });
    graph_action(
        directory,
        state,
        "planner.claim",
        &facts,
        "planner.reserveLease",
    )?;
    let plan = &mut candidate["plans"][idx];
    plan["executionId"] = json!(execution_id);
    plan["attempt"] = json!(plan.get("attempt").and_then(Value::as_u64).unwrap_or(0) + 1);
    plan["updatedAt"] = json!(now);
    Ok(candidate)
}
fn execution_current(job: &Value, plan_id: &str, execution_id: &str) -> bool {
    plan_index(job, plan_id).is_some_and(|index| {
        let plan = &job["plans"][index];
        field(plan, "status") == "PLANNING" && field(plan, "executionId") == execution_id
    })
}
pub fn settlement_result(
    graph_directory: &Path,
    job: &Value,
    plan_id: &str,
    execution_id: &str,
    planner_result: &Value,
    context: &Value,
    now: &str,
) -> Result<Value, String> {
    if !execution_current(job, plan_id, execution_id) {
        return Err("Stale Planner execution cannot apply Plan".into());
    }
    let mut candidate = job.clone();
    let normalized = parse_planner_result(planner_result)?;
    validate_planner_progress(&candidate, &normalized)?;
    let next = normalized
        .get("next_tasks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    validate_planner_hierarchy(&candidate, &next)?;
    validate_planner_lifecycle_ownership(&candidate, &next)?;
    validate_planner_resolution_materialization(&candidate, &next)?;
    let existing = task_ids(&candidate);
    let plans = candidate
        .get("plans")
        .and_then(Value::as_array)
        .ok_or("Job Plans missing")?;
    let plan = plans
        .iter()
        .find(|p| field(p, "id") == plan_id)
        .ok_or("Plan disappeared")?
        .clone();
    let mut appended = Vec::new();
    for spec in &next {
        let id = field(spec, "id");
        if existing.contains(id) {
            return Err(format!(
                "Planner Task {id} conflicts with an existing Job Task"
            ));
        }
        let child = materialize_planner_child(graph_directory, &candidate, &plan, spec, context)?;
        if let Some(resolution) = spec.get("resolution").filter(|v| !v.is_null()) {
            candidate["tasks"] = json!(candidate
                .get("tasks")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default());
            attach_resolution_ownership(
                graph_directory,
                &mut candidate,
                &child,
                resolution,
                &json!("planner"),
                now,
            )?;
        }
        candidate
            .get_mut("tasks")
            .and_then(Value::as_array_mut)
            .ok_or("Job Task array missing")?
            .push(child.clone());
        appended.push(child);
    }
    graph_action(
        graph_directory,
        "PLANNING",
        "planner.succeeded",
        &json!({"executionCurrent":true,
            "resultValid":true}),
        "planner.persistSuccess",
    )?;
    let idx = plan_index(&candidate, plan_id).ok_or("Plan disappeared")?;
    let changed = &mut candidate["plans"][idx];
    changed["status"] = json!("SUCCEEDED");
    changed["objectiveStatus"] = normalized
        .get("objective_status")
        .cloned()
        .unwrap_or(Value::Null);
    changed["assessment"] = normalized.get("assessment").cloned().unwrap_or(Value::Null);
    changed["plannerResult"] = normalized.clone();
    changed["generatedTaskIds"] = json!(appended
        .iter()
        .filter_map(|t| t.get("id"))
        .collect::<Vec<_>>());
    changed["appliedExecutionId"] = json!(execution_id);
    changed["executionId"] = Value::Null;
    changed["updatedAt"] = json!(now);
    candidate["updatedAt"] = json!(now);
    let saved_plan = candidate["plans"][idx].clone();
    Ok(json!({"job":candidate,"plan":saved_plan,
        "children":appended,"result":normalized}))
}
pub fn fail_plan_execution(
    directory: &Path,
    job: &Value,
    plan_id: &str,
    execution_id: &str,
    error: &str,
    now: &str,
) -> Result<Value, String> {
    if !execution_current(job, plan_id, execution_id) {
        return Ok(job.clone());
    }
    let mut candidate = job.clone();
    let idx = plan_index(&candidate, plan_id).ok_or("Plan disappeared")?;
    let plan = &candidate["plans"][idx];
    let attempts = plan.get("attempt").and_then(Value::as_u64).unwrap_or(0);
    let max = plan.get("maxAttempts").and_then(Value::as_u64).unwrap_or(3);
    let decision = choose_policy(
        directory,
        "planner-orchestration",
        "PLANNING",
        "planner.failed",
        &json!({
            "executionCurrent":true,"retryAvailable":attempts<max,
            "maxAttempts":max,"attempts":attempts,
        }),
        14,
        |s| s.starts_with("check_"),
    )?;
    if decision.get("accepted") != Some(&Value::Bool(true)) {
        return Err("Planner Graph did not accept failed execution".into());
    }
    let plan = &mut candidate["plans"][idx];
    let terminal = field(&decision, "target") == "FAILED";
    plan["status"] = json!(if terminal { "FAILED" } else { "PLANNING" });
    plan["error"] = json!(error);
    plan["assessment"] = json!(format!("Planning failed: {error}"));
    plan["executionId"] = Value::Null;
    plan["updatedAt"] = json!(now);
    candidate["updatedAt"] = json!(now);
    Ok(candidate)
}
pub struct PlannerExecutionPorts<Load, Save, Launch, Emit> {
    pub load: Load,
    pub save: Save,
    pub launch: Launch,
    pub emit: Emit,
}
pub async fn run_planner_execution<Load, LFut, Save, SFut, Launch, AFut, Emit, EFut>(
    graph_dir: &Path,
    job_id: &str,
    plan_id: &str,
    owner: &str,
    timeout_ms: u64,
    cancelled: &AtomicBool,
    mut ports: PlannerExecutionPorts<Load, Save, Launch, Emit>,
) -> Result<Value, String>
where
    Load: FnMut(&str) -> LFut,
    LFut: Future<Output = Result<Value, String>>,
    Save: FnMut(Value) -> SFut,
    SFut: Future<Output = Result<Value, String>>,
    Launch: FnMut(Value, Value, &AtomicBool) -> AFut,
    AFut: Future<Output = Result<Value, String>>,
    Emit: FnMut(Value) -> EFut,
    EFut: Future<Output = Result<(), String>>,
{
    if cancelled.load(Ordering::Acquire) {
        return Err("Planner execution cancelled".into());
    }
    let job = (ports.load)(job_id).await?;
    let execution_id = random_uuid();
    let lease = claim_plan_execution(
        graph_dir,
        &job,
        plan_id,
        owner,
        &execution_id,
        &iso8601_now(),
    )?;
    let claimed = (ports.save)(lease).await?;
    let plan = claimed
        .get("plans")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|p| field(p, "id") == plan_id)
        .ok_or("Claimed Plan missing")?
        .clone();
    (ports.emit)(event_for(
        job_id,
        plan_id,
        None,
        "planner.started",
        "running",
        "Planner execution started",
        Some("orchestrator"),
        Some(json!({"executionId":execution_id})),
        Some(json!({"agent":"planner","component":"agents-relay"})),
    ))
    .await?;
    let launched = (ports.launch)(claimed.clone(), plan.clone(), cancelled).await;
    match launched {
        Ok(output) => {
            if cancelled.load(Ordering::Acquire) {
                return Err("Planner execution cancelled".into());
            }
            let current = (ports.load)(job_id).await?;
            let result = settlement_result(
                graph_dir,
                &current,
                plan_id,
                &execution_id,
                &output,
                &json!({}),
                &iso8601_now(),
            )?;
            let next = (ports.save)(result["job"].clone()).await?;
            (ports.emit)(event_for(
                job_id,
                plan_id,
                None,
                "planner.completed",
                "succeeded",
                "Planner round committed",
                Some("orchestrator"),
                Some(json!({
                    "executionId":execution_id,
                    "objectiveStatus":result.pointer("/result/objective_status"),
                    "generatedTaskIds":result.pointer("/plan/generatedTaskIds")
                })),
                Some(json!({"agent":"planner","component":"agents-relay"})),
            ))
            .await?;
            Ok(next)
        }
        Err(error) => {
            let current = (ports.load)(job_id).await?;
            let failed = fail_plan_execution(
                graph_dir,
                &current,
                plan_id,
                &execution_id,
                &error,
                &iso8601_now(),
            )?;
            let updated = (ports.save)(failed).await?;
            (ports.emit)(event_for(
                job_id,
                plan_id,
                None,
                "planner.failed",
                "failed",
                &error,
                Some("orchestrator"),
                Some(json!({"executionId":execution_id})),
                Some(json!({"agent":"planner","component":"agents-relay"})),
            ))
            .await?;
            Ok(updated)
        }
    }
}
/// Node PlannerApplyValidationError: retain the structured typed diagnosis
/// while preserving its stable JSON message and nonretryable fencing phase.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlannerApplyValidationError {
    pub phase: String,
    pub issues: Vec<String>,
    pub retryable: bool,
}
impl PlannerApplyValidationError {
    pub const CODE: &'static str = "PLAN_APPLY_VALIDATION_FAILED";
    pub const NAME: &'static str = "PlannerApplyValidationError";
    pub fn new(phase: &str, issues: Vec<String>, retryable: Option<bool>) -> Self {
        Self {
            phase: phase.into(),
            issues,
            retryable: retryable.unwrap_or(phase != "fencing"),
        }
    }
    pub fn message(&self) -> String {
        let issues = serde_json::to_string(&self.issues).unwrap_or_else(|_| "[]".into());
        format!(
            r#"{{"code":"PLAN_APPLY_VALIDATION_FAILED","phase":"{}","retryable":{},"issues":{}}}"#,
            self.phase, self.retryable, issues
        )
    }
}
impl std::fmt::Display for PlannerApplyValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}
impl std::error::Error for PlannerApplyValidationError {}

/// Node activateCommittedPlannerWork mutates the candidate Job only after
/// canonical Job Graph selects DRAFT->ACTIVE for an actual QUEUED child Task.
/// Not a new state machine: it reuses the shared Graph lifecycle dispatcher.
pub fn activate_committed_planner_work(
    graph_directory: &Path,
    job: &mut Value,
    now: &str,
) -> Result<bool, String> {
    if field(job, "state") != "DRAFT"
        || !job
            .get("tasks")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .any(|task| field(task, "state") == "QUEUED")
    {
        return Ok(false);
    }
    let decision = crate::workflow::lifecycle::dispatch_job_lifecycle_sync(
        graph_directory,
        job,
        "activate",
        &json!({}),
        now,
    )?;
    if decision.get("accepted") != Some(&Value::Bool(true)) {
        return Err(format!(
            "Job {} activation rejected after planning",
            field(job, "id")
        ));
    }
    Ok(true)
}

/// Node drainPlannerUnblocks: preserve every unacknowledged cross-Job unblock
/// intent in the authoritative SQLite Plan. External registration is injected
/// and must be idempotent; success is acknowledged only by a fresh atomic
/// mutateJob transaction, never by replacing a possibly stale Plan snapshot.
pub fn drain_planner_unblocks(
    store: &crate::relay_store::SQLiteRelayStore,
    job_id: &str,
    plan_id: &str,
    mut register: Option<&mut dyn FnMut(&str, &Value) -> Result<(), String>>,
    mutate_available: bool,
) -> Result<Vec<String>, String> {
    let job = store
        .load_job(job_id)?
        .ok_or_else(|| format!("Job {job_id} not found"))?;
    let pending = job
        .get("plans")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|plan| field(plan, "id") == plan_id)
        .and_then(|plan| plan.get("pendingUnblocks"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if pending.is_empty() {
        return Ok(Vec::new());
    }
    let registrar = register
        .as_mut()
        .ok_or("Blocker registration unavailable")?;
    let mut acknowledged = HashSet::new();
    for item in &pending {
        if registrar(job_id, item).is_ok() {
            acknowledged.insert(serde_json::to_string(item).map_err(|e| e.to_string())?);
        }
    }
    if !acknowledged.is_empty() {
        if !mutate_available {
            return Err(
                "Atomic SQLite mutation is required to acknowledge planner unblocks".into(),
            );
        }
        store.mutate_job(job_id, |mut current| {
            let fresh = current
                .get_mut("plans")
                .and_then(Value::as_array_mut)
                .and_then(|plans| plans.iter_mut().find(|plan| field(plan, "id") == plan_id));
            if let Some(fresh) = fresh {
                if let Some(pending) = fresh
                    .get("pendingUnblocks")
                    .and_then(Value::as_array)
                    .filter(|pending| !pending.is_empty())
                {
                    let remaining = pending
                        .iter()
                        .filter(|item| {
                            serde_json::to_string(item)
                                .ok()
                                .as_ref()
                                .is_none_or(|key| !acknowledged.contains(key))
                        })
                        .cloned()
                        .collect::<Vec<_>>();
                    if remaining.is_empty() {
                        if let Some(object) = fresh.as_object_mut() {
                            object.remove("pendingUnblocks");
                        }
                    } else {
                        fresh["pendingUnblocks"] = json!(remaining);
                    }
                    fresh["updatedAt"] = json!(iso8601_now());
                }
            }
            Ok(current)
        })?;
    }
    let refreshed = store
        .load_job(job_id)?
        .ok_or_else(|| format!("Job {job_id} not found"))?;
    let remaining = refreshed
        .get("plans")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|plan| field(plan, "id") == plan_id)
        .and_then(|plan| plan.get("pendingUnblocks"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    fn js_text(value: Option<&Value>) -> String {
        match value {
            None => "undefined".into(),
            Some(Value::Null) => "null".into(),
            Some(Value::String(value)) => value.clone(),
            Some(value) => value.to_string(),
        }
    }
    Ok(remaining
        .iter()
        .map(|item| {
            format!(
                "{}#{}:{}:{}",
                js_text(item.get("repository")),
                js_text(item.get("prNumber")),
                js_text(item.get("jobId")),
                js_text(item.get("taskId"))
            )
        })
        .collect())
}

/// Node retryPendingPlannerUnblocks: visit only succeeded Plans with pending
/// intents, and apply the same durable acknowledgment operation per Plan.
pub fn retry_pending_planner_unblocks(
    store: &crate::relay_store::SQLiteRelayStore,
    job_id: &str,
    mut register: Option<&mut dyn FnMut(&str, &Value) -> Result<(), String>>,
    mutate_available: bool,
) -> Result<(), String> {
    let job = store
        .load_job(job_id)?
        .ok_or_else(|| format!("Job {job_id} not found"))?;
    let plans = job
        .get("plans")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|plan| {
            field(plan, "status") == "SUCCEEDED"
                && plan
                    .get("pendingUnblocks")
                    .and_then(Value::as_array)
                    .is_some_and(|items| !items.is_empty())
        })
        .filter_map(|plan| plan.get("id").and_then(Value::as_str))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    for plan_id in plans {
        let registrar = register
            .as_mut()
            .map(|register| &mut **register as &mut dyn FnMut(&str, &Value) -> Result<(), String>);
        drain_planner_unblocks(store, job_id, &plan_id, registrar, mutate_available)?;
    }
    Ok(())
}

// Node public host invocation while shared native policy methods remain in
// this module. Store effects are supplied by the active runtime owner.
pub use crate::planner_runtime_public::{finish_planner, PlannerFinishPorts};

// Node launchPlanExecution: owned lifecycle, slot fence and Planner callback.
pub use crate::planner_launch_public::{launch_plan_execution, PlannerLaunchPorts};

#[cfg(test)]
mod plan_execution_lifecycle_graph_tests {
    use super::*;
    fn graph() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow")
    }
    #[test]
    fn plan_claim_succeed_and_retry_or_fail_are_graph_authorized() {
        let directory = graph();
        let claim = graph_action(
            &directory,
            "PLANNING",
            "planner.claim",
            &json!({"claimAvailable":true,"retryAvailable":true,
                "activeJob":true,"notPaused":true}),
            "planner.reserveLease",
        )
        .unwrap();
        assert_eq!(claim["target"], "PLANNING");
        assert!(graph_action(
            &directory,
            "PLANNING",
            "planner.claim",
            &json!({"claimAvailable":false,"retryAvailable":true,
                "activeJob":true,"notPaused":true}),
            "planner.reserveLease"
        )
        .is_err());

        let success = graph_action(
            &directory,
            "PLANNING",
            "planner.succeeded",
            &json!({"executionCurrent":true,"resultValid":true}),
            "planner.persistSuccess",
        )
        .unwrap();
        assert_eq!(success["target"], "SUCCEEDED");
        let retry = crate::workflow::policy_graph::choose_policy(
            &directory,
            "plan-execution",
            "PLANNING",
            "planner.failed",
            &json!({"executionCurrent":true,"retryAvailable":true}),
            14,
            |_| false,
        )
        .unwrap();
        assert_eq!(retry["target"], "PLANNING");
        let failed = crate::workflow::policy_graph::choose_policy(
            &directory,
            "plan-execution",
            "PLANNING",
            "planner.failed",
            &json!({"executionCurrent":true,"retryAvailable":false}),
            14,
            |_| false,
        )
        .unwrap();
        assert_eq!(failed["target"], "FAILED");
        let unavailable = crate::workflow::policy_graph::choose_policy(
            &directory,
            "plan-execution",
            "PLANNING",
            "planner.unavailable",
            &json!({"executionCurrent":true}),
            14,
            |_| false,
        )
        .unwrap();
        assert_eq!(unavailable["target"], "FAILED");
    }
}
