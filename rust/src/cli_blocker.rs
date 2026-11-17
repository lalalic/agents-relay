// Direct port of Node src/cli-blocker.ts: CLI admission, durable blocker commands,
// and exact dependent task identity. No independent workflow policy is added.
use crate::cli_core_support::{arg, control, has_arg, job, repository, text_option};
use serde_json::{json, Value};

#[derive(Debug)]
pub enum BlockerEffect {
    Control(Value),
    Job(String),
    Resolve(String),
}
pub fn blocker_effect(
    action: &str,
    args: &[String],
    stdin: Option<&str>,
) -> Result<BlockerEffect, String> {
    if !matches!(action, "add" | "ensure" | "resolve" | "show") {
        return Err(crate::cli_help::usage.to_string());
    }
    if action == "ensure" {
        if has_arg(args, "--project-path") {
            return Err(
                "Blocker Job --project-path is removed; use its independent Git root".into(),
            );
        }
        let dependent_repository = repository(args)?;
        let job_id = arg(args, "--id", "");
        let target = arg(args, "--target-repo", "");
        let request_id = arg(args, "--request-id", "");
        let dependent_task = arg(args, "--dependent-task", "");
        let reason = arg(args, "--reason", "");
        let title = arg(args, "--title", "");
        let objective = text_option(args, "--objective", "--objective-file", stdin)?;
        let origin = arg(args, "--origin", "troubleshooter");
        let resolution = arg(args, "--resolution", "merge");
        if [job_id, target, request_id, dependent_task, title, reason]
            .iter()
            .any(|v| v.is_empty())
        {
            return Err("blocker ensure requires --id, --target-repo, --request-id, --dependent-task, --title, and --reason".into());
        }
        if objective.trim().is_empty() {
            return Err(
                "blocker ensure requires --objective-file PATH|- or --objective MARKDOWN".into(),
            );
        }
        if !has_arg(args, "--authorized") {
            return Err("blocker ensure requires explicit --authorized".into());
        }
        if !matches!(origin, "planner" | "troubleshooter") {
            return Err("--origin must be planner or troubleshooter".into());
        }
        if !matches!(resolution, "merge" | "verified") {
            return Err("--resolution must be merge or verified".into());
        }
        return Ok(BlockerEffect::Control(
            json!({"command":"blocker.ensure","jobId":job_id,"request":{
                "requestId":request_id,"targetRepository":target,"dependentRepository":dependent_repository,
                "dependentJobId":job_id,"dependentTaskId":dependent_task,"reason":reason,"title":title,
                "objective":objective,"resolutionMode":resolution,"origin":origin,"authorized":true
            }}),
        ));
    }
    repository(args)?;
    let id = arg(args, "--id", "");
    if id.is_empty() {
        return Err("blocker commands require --repo and --id for the blocker Job".into());
    }
    if action == "show" {
        return Ok(BlockerEffect::Job(id.into()));
    }
    if action == "resolve" {
        return Ok(BlockerEffect::Resolve(id.into()));
    }
    let dependent_job = arg(args, "--dependent-job", "");
    let dependent_task = arg(args, "--dependent-task", "");
    if dependent_job.is_empty() || dependent_task.is_empty() {
        return Err("blocker add requires --dependent-job and --dependent-task".into());
    }
    let resolution = arg(args, "--resolution", "merge");
    if !matches!(resolution, "merge" | "verified") {
        return Err("--resolution must be merge or verified".into());
    }
    Ok(BlockerEffect::Control(
        json!({"command":"blocker.add","jobId":id,
        "dependentJobId":dependent_job,"dependentTaskId":dependent_task,"resolutionMode":resolution}),
    ))
}
pub fn run_blocker_command(
    action: &str,
    args: &[String],
    stdin: Option<&str>,
) -> Result<Value, String> {
    match blocker_effect(action, args, stdin)? {
        BlockerEffect::Control(body) => control(args, &body),
        BlockerEffect::Job(id) => job(args, &id),
        BlockerEffect::Resolve(id) => {
            let result = control(
                args,
                &json!({"command":"blocker.resolve","jobId":id,"resolution":"verified"}),
            )?;
            let mut value = json!({"blocker":id,"resolution":"verified"});
            if let Some(map) = result.as_object() {
                for (key, item) in map {
                    value[key] = item.clone();
                }
            }
            Ok(value)
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }
    #[test]
    fn rejects_unsafe_unbound_operations() {
        assert!(
            blocker_effect("ensure", &args(&["--project-path", "x"]), None)
                .unwrap_err()
                .contains("removed")
        );
        assert!(blocker_effect("ensure", &args(&["--repo", "toy"]), None)
            .unwrap_err()
            .contains("requires --id"));
        assert!(
            blocker_effect("add", &args(&["--repo", "toy", "--id", "6"]), None)
                .unwrap_err()
                .contains("dependent-job")
        );
        assert_eq!(
            blocker_effect("show", &args(&["--repo", "toy", "--id", "6"]), None).err(),
            None
        );
    }
    #[test]
    fn ensure_requests_are_bound_and_authorized() {
        let args = args(&[
            "--repo",
            "toy",
            "--id",
            "6",
            "--target-repo",
            "core",
            "--request-id",
            "r",
            "--dependent-task",
            "8",
            "--reason",
            "fail",
            "--title",
            "repair",
            "--objective",
            "finish",
            "--authorized",
        ]);
        let BlockerEffect::Control(value) = blocker_effect("ensure", &args, None).unwrap() else {
            panic!("wrong effect")
        };
        assert_eq!(value["request"]["dependentRepository"], "toy");
        assert_eq!(value["request"]["origin"], "troubleshooter");
        assert_eq!(value["request"]["authorized"], true);
    }
}
