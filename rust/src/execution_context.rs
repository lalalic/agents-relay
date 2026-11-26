// Node provenance: src/execution-context.ts. Runtime invocation context,
// layered project/parent/shared/global instructions, visible skills/agents
// and selected Agent Markdown. Uses the already-portered native cli_context
// filesystem scanner; no Node subprocess or browser client code is changed.
use crate::{
    agent_content_resolver::{agent_source_layers, resolve_agent_markdown},
    cli_context::resolve_context,
};
use serde_json::{json, Value};
use std::collections::HashSet;

fn field<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn values<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v.get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}
fn strings(v: &Value, key: &str) -> Vec<String> {
    values(v, key)
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}
pub use crate::runtime_resources::bundled_agents_root;
fn select_by_name(items: &[Value], names: &[String], kind: &str) -> Result<Vec<Value>, String> {
    if names.is_empty() {
        return Ok(items.to_vec());
    }
    names
        .iter()
        .map(|name| {
            items
                .iter()
                .find(|item| field(item, "name") == name)
                .cloned()
                .ok_or_else(|| {
                    format!(
                        "Explicit {kind} {name} is not visible in the resolved execution context"
                    )
                })
        })
        .collect()
}
pub fn resolve_execution_context(
    project_path: &str,
    role: &str,
    options: &Value,
) -> Result<Value, String> {
    if !matches!(
        role,
        "orchestrator" | "planner" | "reviewer" | "troubleshooter" | "worker" | "nested-worker"
    ) {
        return Err(format!("Unknown execution role {role}"));
    }
    let skills = strings(options, "explicitSkills");
    let agents = strings(options, "explicitAgents");
    // Selected registered Agents are merged below, so restricting built-in
    // discovery by explicitAgents here would incorrectly reject an Agent
    // registered only in SQLite. Apply that filter AFTER the merged list.
    let mut context = resolve_context(
        project_path,
        role,
        options.get("workspaceRoot").and_then(Value::as_str),
        options.get("globalRoot").and_then(Value::as_str),
        &skills,
        &[],
    )?;
    let mut agent_map: Vec<Value> = values(&context, "agents").to_vec();
    let registered = values(options, "registeredAgents");
    for registration in registered {
        let id = field(registration, "name");
        if id.is_empty() {
            continue;
        }
        if !agent_map.iter().any(|a| field(a, "name") == id) {
            let mut agent = json!({
                "name":id,"source":"registry",
                "capabilities":registration.get("capabilities")
                    .cloned().unwrap_or(json!([])),
                "trustDomains":registration.pointer("/routing/trustDomains")
                    .cloned().unwrap_or(json!([])),
                "delegation":[],"restrictions":registration.get("boundaries")
                    .cloned().unwrap_or(json!([])),
                "registration":registration
            });
            if let Some(description) = registration.get("responsibility") {
                agent["description"] = description.clone();
            }
            if let Some(runtime) = registration.pointer("/runtime/adapter") {
                agent["runtime"] = runtime.clone();
            }
            agent_map.push(agent);
        } else if let Some(existing) = agent_map.iter_mut().find(|a| field(a, "name") == id) {
            existing["registration"] = registration.clone();
        }
    }
    agent_map.sort_by(|a, b| field(a, "name").cmp(field(b, "name")));
    context["agents"] = json!(select_by_name(&agent_map, &agents, "agent")?);
    let runtimes: Vec<Value> = values(options, "runtimes")
        .iter()
        .map(|r| {
            json!({"name":r.get("name").filter(|name|!name.is_null())
            .or_else(||r.get("adapter").filter(|name|!name.is_null()))
            .unwrap_or(&json!("unknown")),
            "id":r.get("id"),"capabilities":r.get("capabilities"),
            "source":"runtime"})
        })
        .collect();
    context["runtimes"] = json!(runtimes);
    Ok(context)
}
pub fn resolve_agent_model_preference(
    project_path: &str,
    agent_name: &str,
    options: &Value,
) -> Result<Option<Value>, String> {
    let workspace = options
        .get("workspaceRoot")
        .and_then(Value::as_str)
        .or_else(|| None);
    let global = options
        .get("globalRoot")
        .and_then(Value::as_str)
        .or_else(|| None);
    let layers = agent_source_layers(
        project_path,
        &json!({
            "workspaceRoot":workspace,"globalRoot":global
        }),
    );
    let agent = resolve_agent_markdown(
        agent_name,
        &bundled_agents_root()?,
        project_path,
        Some(&layers),
    )?;
    let model = agent
        .pointer("/metadata/model")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let reasoning = agent
        .pointer("/metadata/reasoning")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    if model.is_none() && reasoning.is_none() {
        return Ok(None);
    }
    let mut result = json!({});
    if let Some(model) = model {
        result["model"] = json!(model);
    }
    if let Some(reasoning) = reasoning {
        result["reasoning"] = json!(reasoning);
    }
    Ok(Some(result))
}
pub fn resolve_agent_contract(context: &Value, agent_name: &str) -> Result<Value, String> {
    let agent = values(context, "agents")
        .iter()
        .find(|agent| field(agent, "name") == agent_name)
        .ok_or_else(|| {
            format!("Agent {agent_name} is not visible in the resolved execution context")
        })?;
    if field(agent, "path").is_empty() {
        return Err(format!(
            "Agent {agent_name} has no readable Markdown contract"
        ));
    }
    let project = field(&context["project"], "path");
    let layers = agent_source_layers(project, &context["project"]);
    let resolved =
        resolve_agent_markdown(agent_name, &bundled_agents_root()?, project, Some(&layers))?;
    if field(&resolved, "content").trim().is_empty() {
        return Err(format!("Agent {agent_name} Markdown contract is empty"));
    }
    Ok(json!({
        "agent":agent,
        "definition":resolved.get("content"),
        "hash":resolved.get("hash"),
        "sources":resolved.get("sources")
    }))
}
