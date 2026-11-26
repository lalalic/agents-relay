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
    let cwd = preference_root.or_else(|| {
        task.and_then(|task| task.get("routing"))
            .and_then(|route| route.get("cwd"))
            .and_then(Value::as_str)
    })?;
    resolve(cwd.into(), name.into()).await.ok().flatten()
}

/// Node resolvePlannerContext delegates to the *same* execution resolver
/// as Worker Tasks, but forces the role to planner and uses the previously
/// selected routing cwd. Agent discovery is injected, never guessed.
pub async fn resolve_planner_context<Resolve, Fut>(
    project_path: &str,
    roots: &Value,
    agents: &[Value],
    adapters: &[Value],
    resolve: Resolve,
) -> Result<Value, String>
where
    Resolve: FnOnce(String, String, Value) -> Fut,
    Fut: Future<Output = Result<Value, String>>,
{
    resolve_task_context(project_path, "planner", roots, agents, adapters, resolve).await
}
/// Resolve the actual Role execution context with the same registered Agent
/// and adapter/runtime metadata that every other entrypoint uses.
pub async fn resolve_task_context<Resolve, Fut>(
    project_path: &str,
    role: &str,
    roots: &Value,
    agents: &[Value],
    adapters: &[Value],
    resolve: Resolve,
) -> Result<Value, String>
where
    Resolve: FnOnce(String, String, Value) -> Fut,
    Fut: Future<Output = Result<Value, String>>,
{
    let runtimes: Vec<Value> = adapters
        .iter()
        .map(|adapter| {
            json!({
                // The original Reconciler wrapper forwards adapter.name only;
                // execution_context decides whether absent name becomes 'unknown'.
                "name": adapter.get("name"),
                "id": adapter.get("id"),
                "capabilities": adapter.get("capabilities").cloned().unwrap_or_else(|| json!([])),
            })
        })
        .collect();
    let mut options = roots.as_object().cloned().unwrap_or_default();
    options.insert("registeredAgents".into(), Value::Array(agents.to_vec()));
    options.insert("runtimes".into(), Value::Array(runtimes));
    resolve(project_path.into(), role.into(), Value::Object(options)).await
}

/// Host-owned discovery roots, independent of Worker transport or pool DB.
/// Live resolution uses the canonical configured workspace and AGENTS_HOME
/// (or ~/.agents). Disposable hosts must provide both fixture roots.
#[derive(Clone, Debug)]
pub struct WorkerContextRoots {
    pub workspace: std::path::PathBuf,
    pub global: std::path::PathBuf,
    pub codex_home: std::path::PathBuf,
}
impl WorkerContextRoots {
    pub fn live(workspace: &std::path::Path) -> Result<Self, String> {
        let global = std::env::var_os("AGENTS_HOME")
            .map(std::path::PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME").map(|home| std::path::PathBuf::from(home).join(".agents"))
            })
            .ok_or("Worker context requires configured AGENTS_HOME or HOME")?;
        if !workspace.is_absolute() || !global.is_absolute() {
            return Err("Worker context roots must be absolute".into());
        }
        Ok(Self {
            workspace: workspace.into(),
            global,
            codex_home: crate::model_routing::default_codex_home(),
        })
    }
    pub fn isolated(fixture: &std::path::Path) -> Self {
        Self {
            workspace: fixture.into(),
            global: fixture.into(),
            codex_home: fixture.join(".codex"),
        }
    }
}

/// Both Model adapters consume this exact canonical project context. The
/// execution checkout is separately communicated in the shared prompt.
pub fn resolve_worker_context(
    job: &Value,
    task: &Value,
    roots: &WorkerContextRoots,
    agents: &[Value],
    adapters: &[Value],
) -> Result<Value, String> {
    let project = job["projectRoot"]
        .as_str()
        .ok_or("Worker Job missing canonical projectRoot")?;
    let name = task["agentName"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or("implementation");
    let role = if crate::final_review_role::is_final_review_agent(Some(name)) {
        "reviewer"
    } else if matches!(name, "planner" | "troubleshooter") {
        name
    } else {
        "worker"
    };
    let options = json!({"workspaceRoot":roots.workspace,"globalRoot":roots.global});
    let future = resolve_task_context(
        project,
        role,
        &options,
        agents,
        adapters,
        |project, role, options| {
            std::future::ready(crate::execution_context::resolve_execution_context(
                &project, &role, &options,
            ))
        },
    );
    let mut future = std::pin::pin!(future);
    let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
    match future.as_mut().poll(&mut cx) {
        std::task::Poll::Ready(result) => result,
        std::task::Poll::Pending => {
            Err("Native Worker context resolution unexpectedly suspended".into())
        }
    }
}

/// Provider-neutral prompt assembly before any external transport starts.
/// The original Task remains immutable. Both adapters honor the same
/// canonical Agent contract and the same managed source checkout boundary.
pub fn worker_managed_prompt(
    db: &std::path::Path,
    job: &Value,
    task: &Value,
    execution_root: &std::path::Path,
    roots: &WorkerContextRoots,
    adapters: &[Value],
) -> Result<crate::agent_prompt_builder::PromptLayers, String> {
    let job_id = job["id"].as_str().ok_or("Worker Job missing id")?;
    let task_id = task["id"].as_str().ok_or("Worker Task missing id")?;
    let execution_id = task["executionId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("Worker Task missing executionId")?;
    let store = crate::relay_store::SQLiteRelayStore::open_without_claim_reset(db, Some(job_id))?;
    let agents = store.load_agents()?.unwrap_or_default();
    let mut context = resolve_worker_context(job, task, roots, &agents, adapters)?;
    let cwd = execution_root
        .to_str()
        .ok_or("Worker checkout path is not UTF-8")?;
    // Contract discovery uses the canonical project, while the prompt's
    // execution cwd uses the daemon-owned checkout.
    if task["gitDeliveryRequired"] == true {
        context["project"]["gitRoot"] = json!(cwd);
    }
    let package_root = crate::runtime_resources::package_root()?;
    let mut layers = crate::managed_worker_input::managed_worker_input_resolved(
        job,
        task,
        Some(&context),
        "production",
        &package_root,
        None,
    )?;
    if task["gitDeliveryRequired"] == true && job["projectRoot"].as_str() != Some(cwd) {
        layers.user.push_str(&format!(
            "\n\nExecution checkout (required): {cwd}. Edit, test and commit only in this checkout. Job.projectRoot identifies the primary repository, not the working checkout. Never commit directly to main.\n"
        ));
    }
    if !layers.user.contains(&format!(
        "job/{job_id}/task/{task_id}/execution/{execution_id}"
    )) {
        return Err("Native Worker prompt lacks exact execution event binding".into());
    }
    Ok(layers)
}
