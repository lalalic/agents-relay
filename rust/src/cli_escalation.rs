// Node provenance: src/cli-escalation.ts. Parse only operator-controlled
// escalation executors; Task text never becomes a shell command.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EscalationCommand {
    pub executable: String,
    pub prefix_args: Vec<String>,
}
const CONFIG_ERROR: &str =
    "AGENTS_RELAY_ESCALATION_COMMAND must be an absolute executable or JSON argv array";

pub fn escalation_command(env: &HashMap<String, String>) -> Result<Option<EscalationCommand>, String> {
    let Some(raw) = env.get("AGENTS_RELAY_ESCALATION_COMMAND")
        .map(String::as_str).map(str::trim).filter(|raw| !raw.is_empty())
    else { return Ok(None); };
    let args: Vec<String> = if raw.starts_with('[') {
        let parsed: Value = serde_json::from_str(raw).map_err(|_| CONFIG_ERROR)?;
        let array = parsed.as_array().ok_or(CONFIG_ERROR)?;
        array.iter().map(|value| value.as_str().map(str::to_owned)
            .ok_or(CONFIG_ERROR.to_string())).collect::<Result<Vec<_>,_>>()?
    } else { vec![raw.to_string()] };
    if args.is_empty() || args.len() > 12 || !Path::new(&args[0]).is_absolute()
        || args.iter().any(|arg| arg.is_empty() || arg.len() > 4096
            || arg.bytes().any(|byte| matches!(byte, b'\n' | b'\r' | 0)))
    { return Err(CONFIG_ERROR.into()); }
    Ok(Some(EscalationCommand {
        executable: args[0].clone(), prefix_args: args[1..].to_vec(),
    }))
}
pub fn escalation_executor_args(
    handoff_path: &str, policy_path: Option<&str>, cwd: Option<&str>,
) -> Vec<String> {
    let mut args = vec!["--handoff-file".into(), handoff_path.into()];
    if let Some(path) = policy_path.filter(|path| !path.is_empty()) {
        args.extend(["--on-needs-user-file".into(), path.into()]);
    }
    if let Some(cwd) = cwd.filter(|cwd| !cwd.is_empty()) {
        args.extend(["--cwd".into(), cwd.into()]);
    }
    args
}
pub fn handoff_text(request: &Value) -> String {
    let field = |name: &str| request.get(name).and_then(Value::as_str)
        .unwrap_or("").trim().to_owned();
    let mut content = format!("# Intent\n{}\n\n# Blocked on\n{}\n",
        field("intent"), field("blockedOn"));
    let context = field("context");
    if !context.is_empty() { content.push_str(&format!("\n# Context\n{context}\n")); }
    content
}
pub fn failed_escalation(summary: &str) -> Value {
    json!({"status": "failed", "summary": summary, "reason": summary})
}
/// Valid output must be a single unambiguous structured result, not a
/// success inferred from exit code or printed diagnostic text.
pub fn parse_escalation_output(exit_code: Option<i32>, stdout: &str, exceeded: bool) -> Value {
    if exceeded { return failed_escalation("Escalation executor output exceeded limit"); }
    if exit_code != Some(0) {
        return failed_escalation(&format!("Escalation executor failed (exit {})",
            exit_code.map(|code| code.to_string()).unwrap_or_else(|| "signal".into())));
    }
    let Ok(result) = serde_json::from_str::<Value>(stdout.trim()) else {
        return failed_escalation("Escalation executor returned invalid JSON");
    };
    let status = result.get("status").and_then(Value::as_str);
    let summary = result.get("summary").and_then(Value::as_str);
    if !matches!(status, Some("resolved" | "failed" | "needs_user"))
        || !summary.is_some_and(|summary| !summary.trim().is_empty())
    { return failed_escalation("Escalation executor returned invalid result contract"); }
    result
}
