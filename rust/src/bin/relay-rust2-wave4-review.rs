//! Worker B exclusive head-to-head adapter. No live store, CLI providers or network.
use agents_relay_rust2::{outcome_review, review_replan, reviewer_thread};
use serde_json::{json, Value};
use std::{
    io::{self, BufRead},
    path::Path,
};
fn check(v: &Value) -> Result<Value, String> {
    let job = &v["job"];
    let graph = Path::new(v["graph"].as_str().unwrap_or("workflow"));
    match v["op"].as_str().unwrap_or("") {
        "reviewWorkSettled" => Ok(json!(review_replan::review_work_settled(graph, job)?)),
        "reviewNeedsReplan" => Ok(json!(review_replan::review_needs_replan(job))),
        "reviewPlanReady" => Ok(json!(review_replan::review_plan_ready(job))),
        "parseOutcomeReviewArgs" => {
            let args = v["args"]
                .as_array()
                .ok_or("args required")?
                .iter()
                .map(|x| x.as_str().unwrap_or("").to_string())
                .collect::<Vec<_>>();
            outcome_review::parse_outcome_review_args(
                &args,
                Path::new(v["cwd"].as_str().unwrap_or(".")),
            )
        }
        "combineOutcomeReviews" => Ok(outcome_review::combine_outcome_reviews(
            v["reviews"].as_array().ok_or("reviews required")?,
        )),
        "resolveReviewerThreadDestination" => {
            reviewer_thread::resolve_reviewer_thread_destination(job)
        }
        "normalizeThreadId" => Ok(json!(reviewer_thread::normalize_thread_id(
            &v["value"],
            v["label"].as_str().unwrap_or("thread ID")
        )?)),
        "prepareReviewerThreadDelivery" => {
            reviewer_thread::prepare_reviewer_thread_delivery(job, &v["task"])
        }
        "chatgptThreadRequirements" => Ok(reviewer_thread::chatgpt_thread_requirements(
            &v["configured"],
        )),
        "runtimeReviewer" => {
            let args = v["args"]
                .as_array()
                .ok_or("args required")?
                .iter()
                .map(|x| x.as_str().unwrap_or("").to_string())
                .collect::<Vec<_>>();
            reviewer_thread::runtime_reviewer(&args)
        }
        "prepareRevisionThreadDelivery" => {
            let mut child = v["task"].clone();
            let result = reviewer_thread::prepare_revision_thread_delivery(job, &mut child)?;
            Ok(json!({"result":result,"task":child}))
        }
        _ => Err("unknown operation".into()),
    }
}
fn main() {
    for line in io::stdin().lock().lines() {
        let result = line
            .map_err(|e| e.to_string())
            .and_then(|s| serde_json::from_str::<Value>(&s).map_err(|e| e.to_string()))
            .and_then(|v| check(&v));
        println!(
            "{}",
            match result {
                Ok(value) => json!({"ok":true,"value":value}),
                Err(error) => json!({"ok":false,"error":error}),
            }
        );
    }
}
