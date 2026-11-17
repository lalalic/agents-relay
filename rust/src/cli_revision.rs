// Direct port of Node src/cli-revision.ts: immutable revision findings intake,
// identity-bound receipt verification, and a single Relay control effect.
use crate::cli_core_support::{arg, control, read_file_utf8};
use crate::js_text::trim_js;
use serde_json::{json, Value};
use std::collections::HashSet;

const HELP: &str = "task revise requires --repo --id --task-id --review-task-id --execution-id --head-sha --request-id --findings-file";
fn js_length(s: &str) -> usize {
    s.encode_utf16().count()
}

pub fn parse_revision_findings(source: &str) -> Result<Value, String> {
    let value: Value = serde_json::from_str(source).map_err(|_| {
        "findings-file must contain a JSON array of {id,summary,evidence?}".to_string()
    })?;
    let array = value
        .as_array()
        .ok_or("findings-file requires 1..200 identified findings")?;
    if array.is_empty() || array.len() > 200 {
        return Err("findings-file requires 1..200 identified findings".into());
    }
    let mut findings = Vec::new();
    let mut ids = HashSet::new();
    for (index, item) in array.iter().enumerate() {
        let entry = item
            .as_object()
            .ok_or_else(|| format!("finding {index} must be an object"))?;
        let id = entry.get("id").and_then(Value::as_str);
        let summary = entry.get("summary").and_then(Value::as_str);
        let evidence = entry.get("evidence");
        if id.is_none_or(|s| trim_js(s).is_empty() || js_length(s) > 160)
            || summary.is_none_or(|s| trim_js(s).is_empty() || js_length(s) > 4000)
            || evidence.is_some_and(|v| v.as_str().is_none_or(|s| js_length(s) > 10000))
        {
            return Err(format!(
                "finding {index} requires valid id, summary, optional evidence"
            ));
        }
        if entry
            .keys()
            .any(|key| !matches!(key.as_str(), "id" | "summary" | "evidence"))
        {
            return Err(format!("finding {index} contains unsupported fields"));
        }
        let id = trim_js(id.unwrap()).to_string();
        let summary = trim_js(summary.unwrap()).to_string();
        let mut clean = json!({"id":id,"summary":summary});
        if let Some(value) = evidence {
            clean["evidence"] = value.clone();
        }
        findings.push(clean);
        ids.insert(id);
    }
    if ids.len() != findings.len() {
        return Err("findings-file contains duplicate IDs".into());
    }
    Ok(json!(findings))
}
pub fn revision_request(args: &[String]) -> Result<Value, String> {
    let flags = [
        "--id",
        "--repo",
        "--task-id",
        "--review-task-id",
        "--execution-id",
        "--head-sha",
        "--request-id",
        "--findings-file",
    ];
    let values = flags
        .iter()
        .map(|flag| arg(args, flag, ""))
        .collect::<Vec<_>>();
    if values.iter().any(|s| s.is_empty() || s.starts_with("--")) {
        return Err(HELP.into());
    }
    let findings = read_file_utf8(values[7])?;
    let findings = parse_revision_findings(&findings)?;
    Ok(
        json!({"command":"task.revise","jobId":values[0],"repository":values[1],
        "taskId":values[2],"reviewTaskId":values[3],"reviewExecutionId":values[4],
        "headSha":values[5],"requestId":values[6],"findings":findings}),
    )
}
fn js_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0. && !f.is_nan()),
        Value::Array(_) | Value::Object(_) => true,
    }
}
pub fn validate_revision_receipt(request: &Value, response: Value) -> Result<Value, String> {
    let receipt = &response["request"];
    if !receipt.is_object()
        || receipt["requestId"] != request["requestId"]
        || receipt["originalTaskId"] != request["taskId"]
        || !js_truthy(&receipt["revisionTaskId"])
    {
        return Err(
            "Relay targeted revision receipt has unexpected request or Task identity".into(),
        );
    }
    let mut result = json!({"status":"durable"});
    if let Some(entries) = response.as_object() {
        for (key, value) in entries {
            result[key] = value.clone();
        }
    }
    Ok(result)
}
pub fn run_task_revise_command(args: &[String]) -> Result<Value, String> {
    let request = revision_request(args)?;
    let response = control(args, &request)?;
    validate_revision_receipt(&request, response)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn findings_validation_matches_js_contract() {
        assert_eq!(
            parse_revision_findings("null").unwrap_err(),
            "findings-file requires 1..200 identified findings"
        );
        assert_eq!(
            parse_revision_findings("{").unwrap_err(),
            "findings-file must contain a JSON array of {id,summary,evidence?}"
        );
        assert_eq!(
            parse_revision_findings("[null]").unwrap_err(),
            "finding 0 must be an object"
        );
        assert_eq!(
            parse_revision_findings(r#"[{"id":"x","summary":"s","extra":true}]"#).unwrap_err(),
            "finding 0 contains unsupported fields"
        );
        assert_eq!(
            parse_revision_findings(r#"[{"id":"x","summary":"s"},{"id":" x ","summary":"s"}]"#)
                .unwrap_err(),
            "findings-file contains duplicate IDs"
        );
        assert_eq!(
            parse_revision_findings(r#"[{"id":" a ","summary":" a ","evidence":"e"}]"#).unwrap(),
            json!([{"id":"a","summary":"a","evidence":"e"}])
        );
        assert_eq!(
            parse_revision_findings(&format!(
                r#"[{{"id":"{}","summary":"x"}}]"#,
                "🦀".repeat(81)
            ))
            .unwrap_err(),
            "finding 0 requires valid id, summary, optional evidence"
        );
    }
    #[test]
    fn receipt_validation_fences_identity() {
        let request = json!({"requestId":"r","taskId":"7"});
        let response = json!({"request":{"requestId":"r","originalTaskId":"7","revisionTaskId":"9"},"created":true});
        assert_eq!(
            validate_revision_receipt(&request, response.clone()).unwrap()["status"],
            "durable"
        );
        assert!(
            validate_revision_receipt(&request, json!({"request":{"requestId":"bad"}})).is_err()
        );
    }
}
