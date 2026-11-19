// Supplemental outcome-review differential: reviewerContract layering and
// parseOutcomeReviewArgs over real filesystem layouts, plus
// combineOutcomeReviews verdict precedence. No subprocess is spawned.
use serde_json::{json, Value};
use std::path::Path;

pub fn invoke(request: &Value) -> Option<Result<String, String>> {
    if request["op"] != "certOutcomeReview" {
        return None;
    }
    Some((|| {
        match request["method"].as_str().unwrap_or("") {
            "contract" => {
                // The root parameter is the Relay root: reviewer_contract
                // itself joins agents/outcome-reviewer.agent.md. Tests must
                // use the real repository root so the built-in reviewer
                // resolves, exactly like Node's module-relative ROOT.
                let relay_root = Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("..")
                    .canonicalize()
                    .unwrap_or_else(|_| Path::new(env!("CARGO_MANIFEST_DIR")).join(".."));
                match agents_relay_rust2::outcome_review::reviewer_contract(
                    request["name"].as_str().unwrap_or(""),
                    Path::new(request["projectPath"].as_str().unwrap_or("")),
                    Path::new(request["workspaceRoot"].as_str().unwrap_or("")),
                    relay_root.as_path(),
                ) {
                    Ok(found) => {
                        let is_project = std::fs::read_to_string(&found)
                            .map(|content| {
                                content.contains("# security reviewer")
                            })
                            .unwrap_or(false);
                        Ok(json!({"ok":true,"exists":true,
                            "isProject":is_project}).to_string())
                    }
                    Err(error) => {
                        Ok(json!({"ok":false,"error":error}).to_string())
                    }
                }
            }
            "parseArgs" => {
                let args: Vec<String> = request["args"]
                    .as_array()
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|v| v.as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default();
                match agents_relay_rust2::outcome_review::parse_outcome_review_args(
                    &args,
                    Path::new(request["cwd"].as_str().unwrap_or(".")),
                ) {
                    Ok(options) => {
                        Ok(json!({"ok":true,
                            "prompt":options.get("prompt")
                                .and_then(Value::as_str).unwrap_or("")
                                .chars().take(40).collect::<String>(),
                            "reviewers":options.get("reviewers").cloned()
                                .unwrap_or(json!([])),
                            "projectPath":options.get("projectPath").cloned()
                                .unwrap_or(Value::Null),
                            "output":options.get("output").cloned()
                                .unwrap_or(Value::Null)}).to_string())
                    }
                    Err(error) => {
                        Ok(json!({"ok":false,"error":error}).to_string())
                    }
                }
            }
            "combine" => Ok(json!({"ok":true,
                "value":agents_relay_rust2::outcome_review::combine_outcome_reviews(
                    request["reviews"].as_array().map(Vec::as_slice)
                        .unwrap_or(&[]))}).to_string()),
            value => Err(format!("Unknown outcome review method {value}")),
        }
    })())
}
