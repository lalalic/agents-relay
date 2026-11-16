// New differential CLI: exposes verified Node source-module ports to isolated Rust/Node fixture comparisons.
use agents_relay_rust2::{
    cli_local_merge_config::configure_local_git_merge,
    dependency_validity::validate_dependency_validity,
    final_review_role::is_final_review_agent,
    github_binding_order::order_github_binding_candidates,
    github_branch_projection::authoritative_branch_push_args,
    job_execution_slot::{job_has_active_execution, job_has_conflicting_execution},
    planned_review_head::bind_planned_review_head,
    planner_agent_roles::validate_planner_agent_roles,
    planner_history_cleanup::parse_planner_history_cleanup,
    planner_task_title::required_planner_task_title,
    projection_failure_dedupe::ProjectionFailureDeduplicator,
    review_revision_merge::preserve_review_revision_history,
    task_title::{derive_task_title, json_string_from_utf16},
    terminal_event_recovery::{
        terminal_recovery_eligible, terminal_recovery_prompt, TerminalRecoveryFacts,
    },
};
use serde_json::{json, Value};
use std::io::{self, BufRead};

fn invoke(request: &Value) -> Result<String, String> {
    let op = request["op"].as_str().ok_or("missing op")?;
    match op {
        "isFinalReviewAgent" => {
            Ok(json!(is_final_review_agent(request["name"].as_str())).to_string())
        }
        "validatePlannerAgentRoles" => {
            let specs = request["specs"]
                .as_array()
                .ok_or("specs must be an array")?;
            validate_planner_agent_roles(specs)?;
            Ok(Value::Null.to_string())
        }
        "jobHasActiveExecution" => Ok(json!(job_has_active_execution(
            &request["job"],
            request["except"]["taskId"].as_str(),
            request["except"]["planId"].as_str(),
        ))
        .to_string()),
        "jobHasConflictingExecution" => Ok(json!(job_has_conflicting_execution(
            &request["job"],
            &request["candidate"],
        ))
        .to_string()),
        "deriveTaskTitle" => Ok(json_string_from_utf16(&derive_task_title(
            request["input"].as_str().unwrap_or(""),
            request["fallback"].as_str().unwrap_or("Task"),
        ))),
        "requiredPlannerTaskTitle" => Ok(json!(required_planner_task_title(
            &request["value"],
            request["index"].as_i64().unwrap_or(0)
        )?)
        .to_string()),
        "validateDependencyValidity" => {
            let deps = request["dependencies"]
                .as_array()
                .ok_or("dependencies must be an array")?
                .iter()
                .map(|x| x.as_str().unwrap_or("").to_owned())
                .collect::<Vec<_>>();
            match validate_dependency_validity(
                &deps,
                &request["value"],
                request["field"].as_str().unwrap_or("dependencyValidity"),
            )? {
                Some(result) => Ok(Value::Object(result).to_string()),
                None => Ok(Value::Null.to_string()),
            }
        }
        "terminalRecoveryEligible" => {
            let facts = &request["facts"];
            Ok(json!(terminal_recovery_eligible(&TerminalRecoveryFacts {
                has_session: facts["hasSession"].as_bool().unwrap_or(false),
                has_thread: facts["hasThread"].as_bool().unwrap_or(false),
                terminal_observed: facts["terminalObserved"].as_bool().unwrap_or(false),
                recovery_attempts: facts["recoveryAttempts"].as_f64().unwrap_or(f64::NAN),
                outcome_uncertain: facts["outcomeUncertain"].as_bool().unwrap_or(false),
                cancelled: facts["cancelled"].as_bool().unwrap_or(false),
            }))
            .to_string())
        }
        "terminalRecoveryPrompt" => Ok(json!(terminal_recovery_prompt(
            request["executionId"].as_str().unwrap_or("")
        ))
        .to_string()),
        "authoritativeBranchPushArgs" => Ok(json!(authoritative_branch_push_args(
            request["sourceRef"].as_str().unwrap_or(""),
            request["branch"].as_str().unwrap_or(""),
            request["remoteHeadSha"].as_str(),
            request["remoteTreeMatchesBase"].as_bool().unwrap_or(false),
        ))
        .to_string()),
        "configureLocalGitMerge" => {
            let mut job = request["job"].clone();
            configure_local_git_merge(
                &mut job,
                request["source"].as_str().unwrap_or(""),
                request["target"].as_str().unwrap_or(""),
                request["localOnly"].as_bool().unwrap_or(false),
            )?;
            Ok(job.to_string())
        }
        "preserveReviewRevisionHistory" => {
            let mut merged = request["merged"].clone();
            preserve_review_revision_history(&request["local"], &mut merged);
            Ok(merged.to_string())
        }
        "orderGitHubBindingCandidates" => Ok(json!(order_github_binding_candidates(
            request["items"]
                .as_array()
                .ok_or("items must be an array")?,
        ))
        .to_string()),
        "parsePlannerHistoryCleanup" => {
            let result = match request.get("value") {
                Some(value) => parse_planner_history_cleanup(value)?,
                None => None,
            };
            Ok(json!(result).to_string())
        }
        "projectionFailureShouldReport" => {
            let report = PROJECTION_FAILURE_DEDUPLICATOR.with(|dedupe| {
                dedupe.borrow_mut().should_report(
                    request["jobId"].as_str().unwrap_or(""),
                    request["updatedAt"].as_str().unwrap_or(""),
                    request["reason"].as_str().unwrap_or(""),
                    request["classification"].as_str().unwrap_or(""),
                )
            });
            Ok(json!(report).to_string())
        }
        "resetProjectionFailureDeduplicator" => {
            PROJECTION_FAILURE_DEDUPLICATOR.with(|dedupe| dedupe.borrow_mut().reset());
            Ok(Value::Null.to_string())
        }
        "bindPlannedReviewHead" => {
            let mut task = request["task"].clone();
            bind_planned_review_head(&mut task, request["localHeadSha"].as_str())?;
            Ok(json!({"task": task, "saveCalls": 1}).to_string())
        }
        _ => Err(format!("unknown operation: {op}")),
    }
}

thread_local! {
    static PROJECTION_FAILURE_DEDUPLICATOR: std::cell::RefCell<ProjectionFailureDeduplicator> =
        std::cell::RefCell::new(ProjectionFailureDeduplicator::default());
}

fn main() {
    for line in io::stdin().lock().lines() {
        let output = match line {
            Ok(line) => match serde_json::from_str::<Value>(&line) {
                Ok(request) => match invoke(&request) {
                    Ok(raw_json) => format!(r#"{{"ok":true,"value":{raw_json}}}"#),
                    Err(message) => json!({"ok":false,"error":message}).to_string(),
                },
                Err(error) => json!({"ok":false,"error":error.to_string()}).to_string(),
            },
            Err(error) => json!({"ok":false,"error":error.to_string()}).to_string(),
        };
        println!("{output}");
    }
}
