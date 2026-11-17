// Node provenance: src/router-evals.ts. Fixed worker/router evaluation
// scenarios and route-choice scoring; actual DecisionEngine is injected.
use serde::{Deserialize, Serialize};
use std::future::Future;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouterEvalCase {
    pub id: String,
    pub story_size: String,
    pub task: String,
    pub chatgpt_available: bool,
    pub chatgpt_running: Option<u32>,
    pub chatgpt_slots: Option<u32>,
    pub expected_worker: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouterEvalResult {
    #[serde(flatten)] pub case: RouterEvalCase,
    pub selected_worker: String,
    pub selected_route: String,
    pub pass: bool,
    pub probabilities: Option<serde_json::Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouterEvalReport {
    pub passed: usize,
    pub total: usize,
    pub results: Vec<RouterEvalResult>,
}
const CASES: [(&str, &str, &str, bool, Option<u32>, Option<u32>, &str); 10] = [
    ("small-review","S","Review a focused PR and explain any correctness issue.",true,None,None,"chatgpt"),
    ("medium-investigation","M","Investigate why a Relay job is blocked and propose a focused fix.",true,None,None,"chatgpt"),
    ("small-code-fix","S","Apply a small configuration or one-file code fix and verify it.",true,None,None,"chatgpt"),
    ("medium-browser-operation","M","Use browser and MacBridge tools to inspect state and make a bounded change.",true,None,None,"chatgpt"),
    ("medium-near-capacity","M","Complete a normal engineering task while other ChatGPT work is active.",true,Some(8),None,"chatgpt"),
    ("large-refactor","L","Implement a broad multi-file repository refactor with tests.",true,None,None,"codex"),
    ("large-test-fix-loop","L","Run a sustained code-test-debug loop across a large change.",true,None,None,"codex"),
    ("small-one-slot-left","S","Perform a short reasoning and operational task.",true,None,Some(1),"chatgpt"),
    ("workspace-exhausted","S","Review a focused issue while Browser Workspace has no free slot.",false,None,Some(0),"codex"),
    ("large-workspace-available","L","Implement a large feature even though ChatGPT workspace capacity is healthy.",true,None,None,"codex"),
];
pub fn router_eval_cases() -> Vec<RouterEvalCase> {
    CASES.iter().map(|(id, size, task, available, running, slots, expected)| RouterEvalCase {
        id: (*id).into(), story_size: (*size).into(), task: (*task).into(),
        chatgpt_available: *available, chatgpt_running: *running,
        chatgpt_slots: *slots, expected_worker: (*expected).into(),
    }).collect()
}
pub fn worker_for_route(route: &str) -> &'static str {
    if route.starts_with("chatgpt/") { "chatgpt" }
    else if route.starts_with("codex/") { "codex" }
    else { "unknown" }
}
pub async fn run_router_evals<Decide, Fut>(
    mut decide: Decide,
) -> Result<RouterEvalReport, String>
where
    Decide: FnMut(RouterEvalCase, Vec<String>) -> Fut,
    Fut: Future<Output = Result<(String, Option<serde_json::Value>), String>>,
{
    let mut results = Vec::new();
    for case in router_eval_cases() {
        let mut choices = vec!["codex/openai/default".into()];
        if case.chatgpt_available {
            choices.push("chatgpt/browser-worker/chatgpt/default".into());
        }
        let (selected_route, probabilities) = decide(case.clone(), choices).await?;
        let selected_worker = worker_for_route(&selected_route).to_string();
        let pass = selected_worker == case.expected_worker;
        results.push(RouterEvalResult {
            case, selected_worker, selected_route, pass, probabilities,
        });
    }
    Ok(RouterEvalReport {
        passed: results.iter().filter(|case| case.pass).count(),
        total: results.len(), results,
    })
}
