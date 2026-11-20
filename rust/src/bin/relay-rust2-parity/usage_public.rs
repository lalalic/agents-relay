// rust/src/bin/relay-rust2-parity/usage_public.rs
// Direct differential for src/usage.ts parsing/observation layers:
// CodexSessionUsageReader telemetry scan over real fixture files,
// BrowserWorkspaceUsageReader capacity parsing from probe output,
// Z.ai / DeepSeek / OpenRouter 2xx payload decoding and the app-server
// response projection. No network and no real provider tokens.
use agents_relay_rust2::usage::{
    account_usage_from_zai, codex_app_server_usage_response,
    codex_session_usage, deepseek_credit_from_payload,
    openrouter_credit_from_payload, parse_browser_workspace_capacity,
    rate_limits_from_line,
};
use serde_json::{json, Value};
use std::path::Path;

fn normalize_generated_at(value: &mut Value) {
    if let Some(object) = value.as_object_mut() {
        if object.contains_key("generatedAt") {
            object.insert("generatedAt".into(), json!("NORMALIZED"));
        }
    }
}

pub fn invoke(request: &Value) -> Result<Option<String>, String> {
    if request["op"] != "usagePublicParity" {
        return Ok(None);
    }
    let method = request["method"].as_str().unwrap_or("");
    Ok(Some(match method {
        "rateLimitsFromLine" => json!(rate_limits_from_line(
            request["line"].as_str().unwrap_or(""))).to_string(),
        "codexSessionUsage" => {
            let mut value = codex_session_usage(
                Path::new(request["codexHome"].as_str().unwrap_or("")),
                request["lookbackDays"].as_i64().unwrap_or(8),
                request["now"].as_i64().unwrap_or(0),
            );
            normalize_generated_at(&mut value);
            value.to_string()
        }
        "codexAppServerResponse" => {
            let mut value = codex_app_server_usage_response(
                &request["response"]);
            normalize_generated_at(&mut value);
            value.to_string()
        }
        "parseBrowserWorkspaceCapacity" => {
            let value = parse_browser_workspace_capacity(
                request["output"].as_str().unwrap_or(""),
                request["observedAt"].as_str().unwrap_or(""),
                request["staleAfterMs"].as_i64().unwrap_or(900_000),
                request["exitCode"].as_i64().unwrap_or(0) as i32,
            );
            value.to_string()
        }
        // Node account_usage_from_zai decodes an already-fetched 2xx payload.
        "zaiPayload" => {
            let mut value = account_usage_from_zai(&request["payload"]);
            normalize_generated_at(&mut value);
            value.to_string()
        }
        "deepseekPayload" => {
            let mut value = deepseek_credit_from_payload(
                &request["payload"]);
            normalize_generated_at(&mut value);
            value.to_string()
        }
        "openrouterPayload" => {
            let mut value = openrouter_credit_from_payload(
                &request["payload"]);
            normalize_generated_at(&mut value);
            value.to_string()
        }
        _ => return Err(format!("Unknown usagePublicParity method {method}")),
    }))
}
