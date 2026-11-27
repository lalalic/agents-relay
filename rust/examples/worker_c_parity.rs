// Isolated fixture protocol for direct Node/Rust differential tests of Worker C ports.
// stdin: one JSON request per line; stdout: one JSON result per line. No live SQLite.
use agents_relay_rust2::{dashboard_data as d, events as e, feedback as f};
use serde_json::{json, Value};
use std::io::{self, BufRead};
fn run(req: &Value) -> Result<Value, String> {
    let p = &req["payload"];
    Ok(match req["op"].as_str().unwrap_or("") {
        "dashboard.search" => d::search_dashboard_jobs(
            p["jobs"].as_array().ok_or("missing jobs")?,
            p["query"].as_str().unwrap_or(""),
        ),
        "dashboard.inventory" => d::list_dashboard_job_inventory(
            p["jobs"].as_array().ok_or("missing jobs")?,
            p["repository"].as_str().unwrap_or(""),
        ),
        "dashboard.githubUsage" => d::effective_github_usage(
            p.get("snapshot").filter(|v| !v.is_null()),
            p.get("runtime").filter(|v| !v.is_null()),
        )
        .unwrap_or(Value::Null),
        "dashboard.graphs" => Value::Array(d::dashboard_workflow_graphs(std::path::Path::new(
            p["directory"].as_str().ok_or("directory missing")?,
        ))?),
        "feedback.redact" => json!(f::redact_sensitive_text(p["text"].as_str().unwrap_or(""))),
        "feedback.marker" => json!(f::marker(p["label"].as_str().unwrap_or(""), &p["value"])),
        "feedback.parseMarker" => {
            f::parse_feedback_marker(p["text"].as_str().unwrap_or("")).unwrap_or(Value::Null)
        }
        "feedback.renderMarker" => json!(f::render_feedback_marker(&p["record"])),
        "feedback.createLegacy" => {
            f::create_feedback_record(&p["submission"], Some(&p["options"]))?
        }
        "feedback.fingerprint" => json!(f::feedback_fingerprint(&p["record"])),
        "feedback.workProvenance" => f::feedback_work_provenance(&p["record"]),
        "feedback.markdown" => json!(f::render_feedback_markdown(&p["record"])),
        "feedback.provenance" => f::validate_provenance(&p["provenance"])?,
        "events.subjectToken" => json!(e::subject_token(p["value"].as_str().unwrap_or(""))?),
        "events.subjectPrefix" => json!(e::subject_prefix(p["value"].as_str().unwrap_or(""))?),
        _ => return Err(format!("unknown op: {}", req["op"])),
    })
}
fn main() {
    for line in io::stdin().lock().lines() {
        match line {
            Ok(line) => {
                let result = serde_json::from_str::<Value>(&line)
                    .map_err(|e| e.to_string())
                    .and_then(|req| run(&req));
                println!(
                    "{}",
                    match result {
                        Ok(value) => json!({"ok":true,"value":value}),
                        Err(error) => json!({"ok":false,"error":error}),
                    }
                );
            }
            Err(_) => break,
        }
    }
}
