// Direct port of Node src/cli-projection.ts: projection CLI validation, real Relay control POST, normalized stdout and static help.
use serde_json::{json, Value};
use std::time::Duration;
use ureq::{Agent, Error as HttpError};

fn arg(args: &[String], name: &str, fallback: &str) -> String {
    args.iter()
        .position(|arg| arg == name)
        .and_then(|index| args.get(index + 1))
        .cloned()
        .unwrap_or_else(|| fallback.to_string())
}
fn number(raw: &str) -> f64 {
    let text = raw.trim();
    if text.is_empty() {
        return 0.0;
    }
    if let Some(rest) = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
        return u64::from_str_radix(rest, 16).map_or(f64::NAN, |number| number as f64);
    }
    if let Some(rest) = text.strip_prefix("0b").or_else(|| text.strip_prefix("0B")) {
        return u64::from_str_radix(rest, 2).map_or(f64::NAN, |number| number as f64);
    }
    if let Some(rest) = text.strip_prefix("0o").or_else(|| text.strip_prefix("0O")) {
        return u64::from_str_radix(rest, 8).map_or(f64::NAN, |number| number as f64);
    }
    text.parse::<f64>().unwrap_or(f64::NAN)
}
fn number_arg(args: &[String], name: &str, fallback: i64) -> Result<i64, String> {
    if !args.iter().any(|value| value == name) {
        return Ok(fallback);
    }
    let value = number(&arg(args, name, ""));
    if !value.is_finite() || value.fract() != 0.0 || value < 0.0 || value >= i64::MAX as f64 {
        return Err(format!("{name} must be a non-negative integer"));
    }
    Ok(value as i64)
}
pub fn projection_help(action: Option<&str>) -> String {
    if action == Some("resolve") {
        "Explicitly repair one classified projection conflict.\n\nRequired: --repo LOCAL_ROOT_NAME --id JOB_ID --projection-id ID --action requeue|discard-local.".into()
    } else {
        "Inspect and explicitly repair deterministic V2 GitHub projection conflicts.\n\nUsage:\n  npx agents-relay projection conflicts --repo LOCAL_ROOT_NAME --id JOB_ID\n  npx agents-relay projection resolve --repo LOCAL_ROOT_NAME --id JOB_ID --projection-id ID --action requeue|discard-local".into()
    }
}
pub fn projection_control_command(action: &str, args: &[String]) -> Result<Value, String> {
    let job_id = arg(args, "--id", "");
    if job_id.is_empty() {
        return Err("projection commands require --id JOB_ID".into());
    }
    if matches!(action, "conflicts" | "list") {
        return Ok(json!({"command":"projection.conflicts","jobId":job_id}));
    }
    if action == "resolve" {
        let projection_id = number_arg(args, "--projection-id", 0)?;
        if projection_id <= 0 {
            return Err("projection resolve requires --projection-id ID".into());
        }
        let requested = arg(args, "--action", "requeue");
        if !matches!(
            requested.as_str(),
            "requeue" | "discard-local" | "discard_local"
        ) {
            return Err("--action must be requeue or discard-local".into());
        }
        let resolution = if requested == "requeue" {
            "requeue"
        } else {
            "discard_local"
        };
        let note = arg(args, "--note", "");
        let mut body = json!({"command":"projection.resolve","jobId":job_id,"projectionId":projection_id,"action":resolution});
        if !note.is_empty() {
            body["note"] = json!(note);
        }
        return Ok(body);
    }
    Err(format!(
        "projection {} is not supported; use conflicts or resolve",
        if action.is_empty() {
            "<action>"
        } else {
            action
        }
    ))
}
/// Perform the same HTTP POST as `relayControlCommand`, but keep the choice
/// to reach a configured local service explicit in the caller's CLI arguments.
pub fn run_projection_command(action: &str, args: &[String]) -> Result<String, String> {
    let body = projection_control_command(action, args)?;
    let host = arg(args, "--host", "127.0.0.1");
    let port = number(&arg(args, "--port", "8787"));
    if !port.is_finite() || port.fract() != 0.0 || !(1.0..=65535.0).contains(&port) {
        return Err("--port must be an integer between 1 and 65535".into());
    }
    let port = port as u16;
    let url = format!("http://{host}:{port}/api/control");
    let config = Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(20)))
        .http_status_as_error(false)
        .build();
    let agent = Agent::new_with_config(config);
    let mut response = agent
        .post(&url)
        .header("content-type", "application/json")
        .send_json(&body)
        .map_err(|error| {
            let reason = match error {
                HttpError::Timeout(_) => "This operation was aborted".into(),
                other => other.to_string(),
            };
            format!("Agents Relay service unavailable at {host}:{port}: {reason}")
        })?;
    if !(200..300).contains(&response.status().as_u16()) {
        let code = response.status().as_u16();
        let text = response.body_mut().read_to_string().unwrap_or_default();
        return Err(format!(
            "Agents Relay control command failed: {}",
            if text.is_empty() {
                format!("HTTP {code}")
            } else {
                text
            }
        ));
    }
    let output: Value = response
        .body_mut()
        .read_json()
        .map_err(|error| error.to_string())?;
    serde_json::to_string_pretty(&output).map_err(|error| error.to_string())
}
