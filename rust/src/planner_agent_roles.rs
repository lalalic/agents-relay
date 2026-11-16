// Direct port of Node src/planner-agent-roles.ts: enforce one newly planned Task per effective Agent role.
use crate::final_review_role::is_final_review_agent;
use crate::js_text::trim_js;
use serde_json::Value;
use std::collections::HashMap;

pub fn validate_planner_agent_roles(specs: &[Value]) -> Result<(), String> {
    let mut owners = HashMap::<String, String>::new();
    for spec in specs {
        let role = spec["agentName"]
            .as_str()
            .map(trim_js)
            .filter(|role| !role.is_empty())
            .unwrap_or("implementation");
        let id = spec["id"].as_str().unwrap_or("undefined");
        if is_final_review_agent(Some(role)) {
            return Err(format!("Task {id} must not plan job-acceptance-reviewer: Relay creates the immutable-head Final Review gate automatically"));
        }
        if let Some(previous) = owners.get(role) {
            return Err(format!("Tasks {previous} and {id} have duplicate effective Agent role {role}; consolidate all phases into one Task owned by that Agent in this Plan round. Future rounds may reuse the role for genuine revisions."));
        }
        owners.insert(role.to_string(), id.to_string());
    }
    Ok(())
}
