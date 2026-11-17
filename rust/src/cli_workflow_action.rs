// Node provenance: src/cli-workflow-action.ts; validates Graph-authorized action IDs and delegates effects.
use std::future::Future;
use std::pin::Pin;

pub fn workflow_operation(args: &[String]) -> Result<String, String> {
    let value = |flag: &str| {
        args.iter()
            .position(|arg| arg == flag)
            .and_then(|i| args.get(i + 1))
            .map(String::as_str)
            .unwrap_or("")
    };
    let operation = match value("--action") {
        "task.retry" => "retry",
        "task.recover" => "recover",
        "task.cancel" => "cancel",
        "task.unblock" => "unblock",
        "task.escalate" => "escalate",
        "task.resume-troubleshooter" => "resume-troubleshooter",
        _ => {
            return Err(
                "workflow action requires a supported Graph-authorized task Action ID".into(),
            )
        }
    };
    if ["--repo", "--id", "--task-id"]
        .iter()
        .any(|flag| value(flag).is_empty())
    {
        return Err("workflow action requires --repo, --id and --task-id".into());
    }
    Ok(operation.into())
}

pub type EffectFuture<'a> = Pin<Box<dyn Future<Output = ()> + 'a>>;
pub async fn run_workflow_action<'a, F>(args: &[String], execute: F) -> Result<(), String>
where
    F: FnOnce(String) -> EffectFuture<'a>,
{
    let operation = workflow_operation(args)?;
    execute(operation).await;
    Ok(())
}
