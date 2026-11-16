//! Original Node Planner semantics for an in-progress Plan: local aliases are
//! transient, global Task IDs and the complete dependency DAG are committed
//! in the *same* SQLite transaction as the Plan and Job snapshot.
use super::{
    ids::{allocate_entity_id_in_tx, EntityKind},
    ledger::reserve_authorized_action_tx,
    native_task::{activate_draft_job, graph_task_state, task_value, validate_spec},
    ActionIdentity, NativePlannerApply, NativeTaskSpec, RelayAuthority,
};
use crate::graph::{Decision, Graph, GraphInput};
use chrono::DateTime;
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

const APPLY_GRAPH: &str = include_str!("../../../workflow/force-restate-validation.mmd");

fn required<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v[key]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| format!("Planner next_tasks {key} must be nonempty"))
}
fn normalize_task(v: &Value, index: usize) -> Result<Value, String> {
    let alias = required(v, "id")?;
    if alias.len() > 128 || alias.contains(char::is_whitespace) {
        return Err("Planner local Task ID is oversized or contains whitespace".into());
    }
    let title = required(v, "title")?;
    let word_count = title.split_whitespace().count();
    if !(5..=8).contains(&word_count) {
        return Err(format!(
            "Planner next_tasks[{index}].title must contain 5–8 words (got {word_count})"
        ));
    }
    let input = required(v, "input")?;
    if input.len() > 1_048_576 || title.len() > 200 {
        return Err("Planner child input/title exceeds allowed size".into());
    }
    let role = v
        .get("agentName")
        .and_then(Value::as_str)
        .unwrap_or("implementation");
    if role.trim().is_empty()
        || role.len() > 128
        || !role
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("invalid Planner agentName".into());
    }
    if matches!(
        role,
        "reviewer" | "final-reviewer" | "job-acceptance-reviewer"
    ) {
        return Err("Final Reviewer is Relay-owned and cannot be planned as a child".into());
    }
    if v.get("agentGraph").is_some_and(|x| !x.is_null())
        || v.get("resolution").is_some_and(|x| !x.is_null())
        || v.get("continuation").is_some_and(|x| !x.is_null())
    {
        return Err(
            "Planner child agentGraph/resolution/continuation requires additional graph authority"
                .into(),
        );
    }
    let adapter = v.get("adapter").and_then(Value::as_str).unwrap_or("codex");
    if adapter != "codex" {
        return Err("Planner child adapter is not supported by the native Model manifest".into());
    }
    let output = v.get("output").ok_or("Planner child output is required")?;
    let output_kind = required(output, "kind")?;
    if !matches!(output_kind, "task_pr" | "file")
        || (output_kind == "file" && output["path"].as_str().is_none_or(str::is_empty))
    {
        return Err("Planner child output kind/path is invalid".into());
    }
    let priority = v.get("priority").and_then(Value::as_str).unwrap_or("P2");
    let size = v.get("storySize").and_then(Value::as_str).unwrap_or("M");
    if !matches!(priority, "P0" | "P1" | "P2" | "P3") || !matches!(size, "S" | "M" | "L") {
        return Err("Planner child priority or storySize invalid".into());
    }
    let attempts = v.get("maxAttempts").and_then(Value::as_i64).unwrap_or(3);
    let budget = v
        .get("timeoutMs")
        .and_then(Value::as_i64)
        .unwrap_or(match size {
            "S" => 300_000,
            "M" => 900_000,
            _ => 2_700_000,
        });
    if !(1..=100).contains(&attempts) || !(1..=86_400_000).contains(&budget) {
        return Err("Planner child maxAttempts or timeoutMs invalid".into());
    }
    let deps = v.get("dependencies").cloned().unwrap_or_else(|| json!([]));
    let dep_array = deps
        .as_array()
        .ok_or("Planner dependencies must be an array")?;
    if dep_array
        .iter()
        .any(|d| d.as_str().is_none_or(str::is_empty))
    {
        return Err("Planner dependencies must be nonempty Task IDs".into());
    }
    let parent = v.get("parentTaskId").cloned().unwrap_or(Value::Null);
    if !parent.is_null() && parent.as_str().is_none_or(str::is_empty) {
        return Err("Planner parentTaskId must be a Task alias or null".into());
    }
    if v.get("routing").is_some_and(|x| !x.is_null())
        || v.get("workerSelection").is_some_and(|x| !x.is_null())
    {
        return Err("Planner cannot supply a forged Model route; manifest selects worker".into());
    }
    let mut normalized = v.clone();
    normalized["priority"] = json!(priority);
    normalized["storySize"] = json!(size);
    normalized["adapter"] = json!(adapter);
    normalized["maxAttempts"] = json!(attempts);
    normalized["timeoutMs"] = json!(budget);
    normalized["dependencies"] = deps;
    normalized["parentTaskId"] = parent;
    normalized["agentName"] = json!(role);
    Ok(normalized)
}

fn validate_tree(specs: &[Value], job: &Value) -> Result<(), String> {
    let aliases: HashSet<&str> = specs.iter().map(|v| v["id"].as_str().unwrap()).collect();
    if aliases.len() != specs.len() {
        return Err("duplicate Planner Task alias".into());
    }
    if specs.len() > 64 {
        return Err("Planner may not materialize more than 64 children in one round".into());
    }
    let current: HashSet<&str> = job["tasks"]
        .as_array()
        .ok_or("Job Tasks missing")?
        .iter()
        .filter_map(|v| v["id"].as_str())
        .collect();
    let mut roles = HashSet::new();
    let mut edges: HashMap<&str, Vec<&str>> = HashMap::new();
    for spec in specs {
        let id = spec["id"].as_str().unwrap();
        let role = spec["agentName"].as_str().unwrap();
        if !roles.insert(role) {
            return Err(format!(
                "duplicate effective Agent role {role} in one Planner round"
            ));
        }
        if let Some(parent) = spec["parentTaskId"].as_str() {
            if parent == id || (!aliases.contains(parent) && !current.contains(parent)) {
                return Err(format!("invalid Planner parentTaskId {parent}"));
            }
        }
        let deps = spec["dependencies"]
            .as_array()
            .ok_or("invalid Task dependencies")?;
        for d in deps {
            let dep = d.as_str().ok_or("invalid dependency")?;
            if dep == id || (!aliases.contains(dep) && !current.contains(dep)) {
                return Err(format!("unknown Planner dependency {dep}"));
            }
            edges.entry(id).or_default().push(dep);
        }
        let unique: HashSet<&str> = deps.iter().filter_map(Value::as_str).collect();
        if unique.len() != deps.len() {
            return Err(format!("duplicate dependency on Planner Task {id}"));
        }
    }
    fn visit<'a>(
        id: &'a str,
        edges: &HashMap<&'a str, Vec<&'a str>>,
        aliases: &HashSet<&str>,
        stack: &mut HashSet<&'a str>,
        done: &mut HashSet<&'a str>,
    ) -> Result<(), String> {
        if done.contains(id) {
            return Ok(());
        }
        if !stack.insert(id) {
            return Err(format!("Planner dependency cycle includes {id}"));
        }
        for dep in edges.get(id).into_iter().flatten() {
            if aliases.contains(dep) {
                visit(dep, edges, aliases, stack, done)?
            }
        }
        stack.remove(id);
        done.insert(id);
        Ok(())
    }
    let (mut stack, mut done) = (HashSet::new(), HashSet::new());
    for id in &aliases {
        visit(id, &edges, &aliases, &mut stack, &mut done)?
    }
    if job["tasks"].as_array().is_some_and(|tasks| {
        tasks
            .iter()
            .any(|t| t["state"] == "FAILED" && t.get("resolution").is_none_or(Value::is_null))
    }) {
        return Err(
            "unresolved FAILED Task requires Graph-owned resolution before new sibling work".into(),
        );
    }
    Ok(())
}

impl RelayAuthority {
    pub fn apply_native_child_plan(
        &mut self,
        job_id: &str,
        plan_id: &str,
        execution_id: &str,
        proposal: &Value,
        at: &str,
    ) -> Result<NativePlannerApply, String> {
        DateTime::parse_from_rfc3339(at).map_err(|_| "invalid Planner timestamp")?;
        if proposal["objective_status"] != "in_progress" {
            return Err("Planner children require in_progress".into());
        }
        let candidate = proposal["next_tasks"]
            .as_array()
            .ok_or("Planner next_tasks must be an array")?;
        if candidate.is_empty() {
            return Err("in_progress Plan requires executable children".into());
        }
        if proposal["assessment"]
            .as_str()
            .is_none_or(|s| s.trim().is_empty())
        {
            return Err("Planner assessment required".into());
        }
        if proposal["unblocks"]
            .as_array()
            .is_none_or(|a| !a.is_empty())
            || proposal
                .get("history_cleanup")
                .is_some_and(|v| !v.is_null() && v.as_array().is_none_or(|a| a.is_empty()))
        {
            return Err(
                "Planner cross-Job unblock / history mutation requires separate Graph authority"
                    .into(),
            );
        }
        let normalized = candidate
            .iter()
            .enumerate()
            .map(|(i, v)| normalize_task(v, i))
            .collect::<Result<Vec<_>, _>>()?;
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
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let mut job: Value =
            serde_json::from_str(&raw.ok_or_else(|| format!("Unknown Job {job_id}"))?)
                .map_err(|e| e.to_string())?;
        let plans = job["plans"].as_array().ok_or("Job plans missing")?;
        let plan = plans
            .iter()
            .find(|p| p["id"] == plan_id)
            .ok_or("unknown Plan")?;
        if plan["status"] == "SUCCEEDED" && plan["appliedExecutionId"] == execution_id {
            if plan["appliedCandidateFingerprint"] != fingerprint {
                return Err("Plan replay contains a changed candidate".into());
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
        if plan["status"] != "PLANNING"
            || plan["executionId"] != execution_id
            || plan["leaseOwner"].as_str().is_none_or(str::is_empty)
            || plan["attempt"].as_i64().unwrap_or(0) < 1
            || matches!(job["state"].as_str(), Some("COMPLETED" | "CANCELLED"))
        {
            return Err("stale or unauthorized Planner generation".into());
        }
        validate_tree(&normalized, &job)?;
        let repository = job["repository"]
            .as_str()
            .ok_or("Job repository missing")?
            .to_owned();
        let mut ids = HashMap::<String, String>::new();
        for item in &normalized {
            let alias = required(item, "id")?.to_owned();
            let key = format!("plan:{job_id}:{plan_id}:{alias}");
            let id = allocate_entity_id_in_tx(
                &tx,
                &repository,
                EntityKind::Task,
                Some(&key),
                &HashSet::new(),
            )?;
            ids.insert(alias, id);
        }
        let mut result = proposal.clone();
        let result_specs = result["next_tasks"]
            .as_array_mut()
            .ok_or("Planner next_tasks missing")?;
        let mut children = Vec::with_capacity(normalized.len());
        for (index, spec) in normalized.iter().enumerate() {
            let alias = required(spec, "id")?;
            let id = ids.get(alias).ok_or("allocated Task alias missing")?;
            let mut mapped = spec.clone();
            mapped["id"] = json!(id);
            if let Some(parent) = spec["parentTaskId"].as_str() {
                mapped["parentTaskId"] =
                    json!(ids.get(parent).map(String::as_str).unwrap_or(parent));
            }
            let deps = spec["dependencies"]
                .as_array()
                .ok_or("dependencies missing")?
                .iter()
                .map(|v| {
                    let dep = v.as_str().ok_or("invalid dependency")?;
                    Ok(ids.get(dep).map(String::as_str).unwrap_or(dep).to_owned())
                })
                .collect::<Result<Vec<String>, String>>()?;
            mapped["dependencies"] = json!(deps);
            if let Some(validity) = spec["dependencyValidity"].as_object() {
                let mut mapped_validity = serde_json::Map::new();
                for (key, value) in validity {
                    mapped_validity.insert(
                        ids.get(key).map(String::as_str).unwrap_or(key).to_owned(),
                        value.clone(),
                    );
                }
                mapped["dependencyValidity"] = Value::Object(mapped_validity);
            }
            result_specs[index] = mapped.clone();
            let output_kind = match mapped["output"]["kind"].as_str() {
                Some("task_pr") => "task-pr",
                Some("file") => "file",
                _ => return Err("Task output kind invalid".into()),
            };
            let title = required(&mapped, "title")?;
            let input = required(&mapped, "input")?;
            let story = mapped["storySize"].as_str().unwrap();
            let priority = mapped["priority"].as_str().unwrap();
            let role = mapped["agentName"].as_str().unwrap();
            let output_path = mapped["output"]["path"].as_str();
            let parent = mapped["parentTaskId"].as_str();
            let validity = mapped.get("dependencyValidity").filter(|v| v.is_object());
            let spec_task = NativeTaskSpec {
                job_id,
                title: Some(title),
                input,
                output_kind,
                output_path,
                priority,
                story_size: story,
                parent_task_id: parent,
                dependencies: &deps,
                dependency_validity: validity,
                draft: true,
                at,
                agent_name: Some(role),
                review_head_sha: None,
                routing: None,
                worker_selection: None,
            };
            validate_spec(&spec_task)?;
            let mut task = task_value(&spec_task, job_id, id);
            task["maxAttempts"] = mapped["maxAttempts"].clone();
            task["timeoutMs"] = mapped["timeoutMs"].clone();
            task["planningDecisionId"] = json!(plan_id);
            task["planningSource"] = plan["source"].clone();
            task["planningRound"] = plan["round"].clone();
            if let Some(path) = mapped.get("projectName") {
                task["projectName"] = path.clone();
            }
            children.push(task);
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
            ("objectiveSatisfied".into(), false),
            ("forwardConvergenceValid".into(), true),
        ]);
        let mut state = "idle".to_owned();
        let mut commit = None;
        for _ in 0..15 {
            let decision = graph.decide(&state, input.clone(), &guards)?;
            match decision {
                Decision::Accepted {
                    target, actions, ..
                } => {
                    if actions.iter().any(|a| a.id == "plan.apply.commit") {
                        commit = Some(Decision::Accepted {
                            accepted: true,
                            source: state.clone(),
                            target: target.clone(),
                            actions,
                        })
                    }
                    if !target.starts_with("check_") {
                        break;
                    }
                    state = target;
                }
                rejected => return Err(format!("Plan Apply Graph rejected: {rejected:?}")),
            }
        }
        let decision = commit.ok_or("Plan Apply Graph did not authorize commit")?;
        let identity = ActionIdentity {
            job_id: job_id.into(),
            task_id: plan_id.into(),
            execution_id: execution_id.into(),
            lease_owner: plan["leaseOwner"].as_str().unwrap().into(),
            attempt: plan["attempt"].as_i64().unwrap(),
            generation: plan["attempt"].as_i64().unwrap(),
            graph: "force-restate-validation".into(),
            action_id: "plan.apply.commit".into(),
            attempt_key: format!("planner:{job_id}:{plan_id}:{execution_id}:apply"),
        };
        if !reserve_authorized_action_tx(&tx, &identity, &decision, "plan.apply.commit", at)? {
            return Err(
                "Planner action ledger already reserved without an exact committed Plan".into(),
            );
        }
        let existing = job["tasks"].as_array().ok_or("Job Tasks missing")?;
        if children
            .iter()
            .any(|t| existing.iter().any(|x| x["id"] == t["id"]))
        {
            return Err("new Planner Task ID collides with an existing Task".into());
        }
        job["tasks"]
            .as_array_mut()
            .ok_or("Tasks missing")?
            .extend(children);
        let after = job.clone();
        let len = job["tasks"].as_array().unwrap().len();
        for index in len - normalized.len()..len {
            let task = job["tasks"].as_array_mut().unwrap().get_mut(index).unwrap();
            graph_task_state(task, &after, false)?;
        }
        let plan = job["plans"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|p| p["id"] == plan_id)
            .unwrap();
        plan["status"] = json!("SUCCEEDED");
        plan["objectiveStatus"] = json!("in_progress");
        plan["assessment"] = proposal["assessment"].clone();
        plan["plannerResult"] = result;
        plan["appliedCandidateFingerprint"] = json!(fingerprint);
        plan["generatedTaskIds"] = json!(plan["plannerResult"]["next_tasks"]
            .as_array()
            .ok_or("committed Planner Task IDs missing")?
            .iter()
            .map(|task| task["id"].clone())
            .collect::<Vec<_>>());
        plan["executionId"] = Value::Null;
        plan["leaseOwner"] = Value::Null;
        plan["leaseExpiresAt"] = Value::Null;
        plan["appliedExecutionId"] = json!(execution_id);
        plan["updatedAt"] = json!(at);
        activate_draft_job(&mut job)?;
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
