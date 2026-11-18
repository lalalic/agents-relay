// Node provenance: src/reconciler-context.ts. Resolve execution context and
// advisory model preference without using a Job worktree-creating path.
use serde_json::{json, Value};
use std::future::Future;

/// Failure to load an advisory model preference must not disable routing.
pub async fn agent_model_preference_for_job<Resolve, Fut>(
    agent_name: Option<&str>,
    preference_root: Option<&str>,
    task: Option<&Value>,
    mut resolve: Resolve,
) -> Option<Value>
where
    Resolve: FnMut(String, String) -> Fut,
    Fut: Future<Output = Result<Option<Value>, String>>,
{
    let name = agent_name.filter(|name| !name.is_empty())?;
    let cwd = preference_root.or_else(||
        task.and_then(|task| task.get("routing")).and_then(|route| route.get("cwd")).and_then(Value::as_str))?;
    resolve(cwd.into(), name.into()).await.ok().flatten()
}

/// Node resolvePlannerContext delegates to the *same* execution resolver
/// as Worker Tasks, but forces the role to planner and uses the previously
/// selected routing cwd. Agent discovery is injected, never guessed.
pub async fn resolve_planner_context<Resolve,Fut>(
    project_path:&str,roots:&Value,agents:&[Value],adapters:&[Value],resolve:Resolve,
)->Result<Value,String>
where Resolve:FnOnce(String,String,Value)->Fut,
      Fut:Future<Output=Result<Value,String>>,
{
    resolve_task_context(project_path,"planner",roots,agents,adapters,resolve).await
}
/// Resolve the actual Role execution context with the same registered Agent
/// and adapter/runtime metadata that every other entrypoint uses.
pub async fn resolve_task_context<Resolve, Fut>(
    project_path: &str, role: &str,
    roots: &Value, agents: &[Value], adapters: &[Value],
    resolve: Resolve,
) -> Result<Value, String>
where
    Resolve: FnOnce(String, String, Value) -> Fut,
    Fut: Future<Output = Result<Value, String>>,
{
    let runtimes: Vec<Value> = adapters.iter().map(|adapter| json!({
        "name": adapter.get("name"),
        "id": adapter.get("id"),
        "capabilities": adapter.get("capabilities").cloned().unwrap_or_else(|| json!([])),
    })).collect();
    let mut options = roots.as_object().cloned().unwrap_or_default();
    options.insert("registeredAgents".into(), Value::Array(agents.to_vec()));
    options.insert("runtimes".into(), Value::Array(runtimes));
    resolve(project_path.into(), role.into(), Value::Object(options)).await
}
