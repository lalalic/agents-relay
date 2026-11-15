//! Guarded native Task creation. This concrete persistence effect is available
//! only to the isolated development CLI; the Task Lifecycle and Job Lifecycle
//! graphs select initial Task/Job states.
use super::ids::{allocate_entity_id_in_tx, EntityKind};
use super::RelayAuthority;
use crate::dispatch::ActionPorts;
use crate::graph::{Decision, Graph, GraphInput};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

const TASK_GRAPH: &str = include_str!("../../../workflow/task-lifecycle.mmd");
const JOB_GRAPH: &str = include_str!("../../../workflow/job-lifecycle.mmd");

struct CreationTaskPorts<'a> {
    task: &'a mut Value,
}
impl ActionPorts for CreationTaskPorts<'_> {
    fn persist_transition(&mut self, _source: &str, target: &str) -> Result<(), String> {
        self.task["state"] = json!(target);
        Ok(())
    }
    fn execute_action(&mut self, action_id: &str, _input: &GraphInput) -> Result<Value, String> {
        match action_id {
            "mutation.clearError" => self.task["error"] = Value::Null,
            "mutation.clearFailureReason" => self.task["failureReason"] = Value::Null,
            _ => return Err(format!("unsupported Task creation action {action_id}")),
        }
        Ok(json!({"ok":true,"payloads":{}}))
    }
    fn publish_event(&mut self, event_id: &str, _payload: &Value) -> Result<(), String> {
        Err(format!("unexpected Task creation event {event_id}"))
    }
}

pub struct NativeTaskSpec<'a> {
    pub job_id: &'a str,
    pub title: Option<&'a str>,
    pub input: &'a str,
    pub output_kind: &'a str,
    pub output_path: Option<&'a str>,
    pub priority: &'a str,
    pub story_size: &'a str,
    pub parent_task_id: Option<&'a str>,
    pub dependencies: &'a [String],
    pub dependency_validity: Option<&'a Value>,
    pub draft: bool,
    pub at: &'a str,
}

pub struct NativeCreatedTask {
    pub task_id: String,
    pub task: Value,
    pub created: bool,
}

fn validate_spec(spec: &NativeTaskSpec<'_>) -> Result<(), String> {
    if spec.job_id.is_empty() || spec.job_id.len() > 256 {
        return Err("invalid Job ID".into());
    }
    if spec.input.trim().is_empty() || spec.input.len() > 1_048_576 {
        return Err("Task input must be non-empty and at most 1 MB".into());
    }
    if spec.title.is_some_and(|title| title.len() > 200) {
        return Err("Task title must be at most 200 bytes".into());
    }
    if !matches!(spec.output_kind, "task-pr" | "file") {
        return Err("Task output must be task-pr or file".into());
    }
    if spec.output_kind == "file" && spec.output_path.is_none_or(str::is_empty) {
        return Err("--output file requires --output-path".into());
    }
    if !matches!(spec.priority, "P0" | "P1" | "P2" | "P3") {
        return Err("--priority must be P0, P1, P2, or P3".into());
    }
    if !matches!(spec.story_size, "S" | "M" | "L") {
        return Err("--story-size must be S, M, or L".into());
    }
    if spec.dependencies.iter().any(String::is_empty) {
        return Err("dependency Task IDs must be non-empty".into());
    }
    let unique: HashSet<&str> = spec.dependencies.iter().map(String::as_str).collect();
    if unique.len() != spec.dependencies.len() {
        return Err("duplicate dependency Task ID".into());
    }
    if let Some(validity) = spec.dependency_validity {
        let entries = validity
            .as_object()
            .ok_or("--dependency-validity must be a JSON object")?;
        for (task_id, policy) in entries {
            if !unique.contains(task_id.as_str()) {
                return Err(format!(
                    "dependency-validity key {task_id} must identify a declared dependency"
                ));
            }
            if !matches!(policy.as_str(), Some("order-only" | "revalidate" | "rerun")) {
                return Err(format!(
                    "dependency-validity[{task_id}] must be order-only, revalidate, or rerun"
                ));
            }
        }
    }
    chrono::DateTime::parse_from_rfc3339(spec.at).map_err(|_| "invalid Task timestamp")?;
    Ok(())
}

fn dependencies_satisfied(job: &Value, dependencies: &[String]) -> Result<bool, String> {
    let tasks = job["tasks"]
        .as_array()
        .ok_or("Job tasks must be an array")?;
    let mut satisfied = true;
    for dependency in dependencies {
        let task = tasks
            .iter()
            .find(|task| task["id"].as_str() == Some(dependency))
            .ok_or_else(|| format!("unknown dependency Task {dependency}"))?;
        if task["state"] != "SUCCEEDED" {
            satisfied = false;
        }
    }
    Ok(satisfied)
}

fn graph_task_state(task: &mut Value, job: &Value, draft: bool) -> Result<(), String> {
    if draft {
        return Ok(());
    }
    let satisfied = task["dependencies"]
        .as_array()
        .ok_or("Task dependencies must be an array")?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .ok_or("invalid dependency Task ID")
        })
        .collect::<Result<Vec<_>, _>>()?;
    let graph = Graph::parse(TASK_GRAPH)?;
    let mut ports = CreationTaskPorts { task };
    graph.dispatch(
        "DRAFT",
        GraphInput {
            transport: "event".into(),
            id: "reconcile".into(),
            payload: json!({"taskId":ports.task["id"]}),
        },
        &HashMap::from([(
            "dependenciesSatisfied".to_owned(),
            dependencies_satisfied(job, &satisfied)?,
        )]),
        &mut ports,
    )?;
    Ok(())
}

fn activate_draft_job(job: &mut Value) -> Result<(), String> {
    if job["state"] != "DRAFT" {
        return Ok(());
    }
    let graph = Graph::parse(JOB_GRAPH)?;
    let decision = graph.decide(
        "DRAFT",
        GraphInput {
            transport: "event".into(),
            id: "activate".into(),
            payload: json!({}),
        },
        &HashMap::new(),
    )?;
    let Decision::Accepted { target, .. } = decision else {
        return Err("canonical Job Graph denied activation".into());
    };
    job["state"] = json!(target);
    job["runtimeStatus"] = json!("RUNNING");
    Ok(())
}

fn derive_title(input: &str) -> String {
    let first = input
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("Task");
    let heading_marks = first
        .chars()
        .take_while(|character| *character == '#')
        .count();
    let title = if (1..=6).contains(&heading_marks)
        && first
            .chars()
            .nth(heading_marks)
            .is_some_and(char::is_whitespace)
    {
        first[heading_marks..].trim_start()
    } else if first
        .chars()
        .next()
        .is_some_and(|character| matches!(character, '-' | '*' | '+'))
        && first.chars().nth(1).is_some_and(char::is_whitespace)
    {
        first[1..].trim_start()
    } else {
        let digits = first.chars().take_while(char::is_ascii_digit).count();
        if digits > 0
            && first
                .chars()
                .nth(digits)
                .is_some_and(|character| matches!(character, '.' | ')'))
            && first
                .chars()
                .nth(digits + 1)
                .is_some_and(char::is_whitespace)
        {
            first[digits + 2..].trim_start()
        } else {
            first
        }
    };
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() {
        return "Task".into();
    }
    if title.chars().count() <= 96 {
        title
    } else {
        format!(
            "{}...",
            title.chars().take(93).collect::<String>().trim_end()
        )
    }
}

fn task_value(spec: &NativeTaskSpec<'_>, job_id: &str, task_id: &str) -> Value {
    let title = spec
        .title
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| derive_title(spec.input));
    let output = if spec.output_kind == "file" {
        json!({"kind":"file","path":spec.output_path})
    } else {
        json!({"kind":"task_pr"})
    };
    let mut task = json!({
        "id":task_id,"jobId":job_id,"title":title,"kind":"work",
        "priority":spec.priority,"storySize":spec.story_size,
        "parentTaskId":spec.parent_task_id,"dependencies":spec.dependencies,
        "capabilities":[],"workerRequirements":{"capabilities":[]},
        "adapter":"codex","input":spec.input,"output":output,
        "attempt":0,"maxAttempts":3,"leaseOwner":null,"leaseExpiresAt":null,
        "executionId":null,"threadId":null,"result":null,"error":null,
        "timeoutMs":0,"createdAt":spec.at,"updatedAt":spec.at,"state":"DRAFT"
    });
    if let Some(validity) = spec.dependency_validity {
        if !validity.as_object().is_some_and(|map| map.is_empty()) {
            task["dependencyValidity"] = validity.clone();
        }
    }
    task
}

impl RelayAuthority {
    pub fn create_native_task(
        &mut self,
        spec: NativeTaskSpec<'_>,
    ) -> Result<NativeCreatedTask, String> {
        validate_spec(&spec)?;
        let mut allocated_id = None;
        let committed = self.commit_job_with_tx(spec.job_id, spec.at, |tx, original| {
            if matches!(original["state"].as_str(), Some("COMPLETED" | "CANCELLED")) {
                return Err(format!(
                    "Cannot create Task on terminal Job {} ({})",
                    spec.job_id, original["state"]
                ));
            }
            let repository = original["repository"]
                .as_str()
                .filter(|value| !value.is_empty())
                .ok_or("Job repository identity missing")?;
            if let Some(parent) = spec.parent_task_id.filter(|value| !value.is_empty()) {
                if !original["tasks"]
                    .as_array()
                    .is_some_and(|tasks| tasks.iter().any(|task| task["id"] == parent))
                {
                    return Err(format!("unknown parent Task {parent}"));
                }
            }
            let _ = dependencies_satisfied(original, spec.dependencies)?;
            let id =
                allocate_entity_id_in_tx(tx, repository, EntityKind::Task, None, &HashSet::new())?;
            allocated_id = Some(id.clone());
            let task = task_value(&spec, spec.job_id, &id);
            let mut next = original.clone();
            let mut created = task;
            graph_task_state(&mut created, original, spec.draft)?;
            next["tasks"]
                .as_array_mut()
                .ok_or("Job tasks must be an array")?
                .push(created);
            activate_draft_job(&mut next)?;
            next["updatedAt"] = json!(spec.at);
            Ok((next, vec![]))
        })?;
        let task_id = allocated_id.ok_or("Task ID allocation missing")?;
        let created = committed.job["tasks"]
            .as_array()
            .and_then(|tasks| tasks.iter().find(|task| task["id"] == task_id))
            .cloned()
            .ok_or("created Task missing after commit")?;
        Ok(NativeCreatedTask {
            task_id,
            task: created,
            created: true,
        })
    }
}
