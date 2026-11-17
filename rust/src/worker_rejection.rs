// Port of src/worker-rejection.ts: classify worker failures and safe pre-submit evidence.
use serde_json::{json, Value};
pub const REROUTABLE_WORKER_REJECTIONS: [&str; 3] = [
    "rate_limit_exceeded",
    "model_not_found",
    "provider_unavailable",
];
#[allow(non_upper_case_globals)]
pub const reroutable_worker_rejections: [&str; 3] = REROUTABLE_WORKER_REJECTIONS;
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreSubmissionRejection {
    pub classification: String,
    pub platform_evidence: String,
}
impl PreSubmissionRejection {
    pub fn from_platform_response(response: &Value) -> Option<Self> {
        if response["status"] != "rejected"
            || response["submitted"] != false
            || !response["code"].is_string()
            || !response["message"].is_string()
        {
            return None;
        }
        let code = response["code"].as_str()?;
        let classification = match code {
            "MODEL_UNAVAILABLE" | "MODEL_NOT_FOUND" => "model_unavailable",
            "MCP_LOGIN_REQUIRED" => "mcp_login_required",
            "PROJECT_SETUP_UNAVAILABLE" => "project_setup_unavailable",
            "BROWSER_WORKSPACE_UNAVAILABLE" => "browser_workspace_unavailable",
            "POOL_CAPACITY_FULL" | "POOL_WAIT_EXPIRED" => "pool_capacity_full",
            "PROVIDER_UNAVAILABLE" => "provider_unavailable",
            _ => return None,
        };
        let platform_evidence=serde_json::to_string(&json!({"status":"rejected","submitted":false,"code":code,"message":response["message"]})).ok()?;
        Some(Self {
            classification: classification.into(),
            platform_evidence,
        })
    }
}
// Node src/worker-rejection.ts uses regex alternatives with optional mixed
// `_ .-` separators. Literal substring enumerations miss several combinations.
fn matches_node_regex(pattern: &'static str, message: &str) -> bool {
    use regex::Regex;
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static CACHE: OnceLock<Mutex<HashMap<&'static str, Regex>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = cache.lock().expect("regex cache mutex poisoned");
    let regex = guard
        .entry(pattern)
        .or_insert_with(|| Regex::new(pattern).expect("valid fixed worker-rejection pattern"));
    regex.is_match(message)
}

pub fn classify_worker_rejection(message: &str) -> &'static str {
    if matches_node_regex(
        r"(?i)rate[_ .-]?limit[_ .-]?exceeded|usage limit reached|quota[_ .-]?exceeded|insufficient[_ .-]?quota",
        message,
    ) {
        "rate_limit_exceeded"
    } else if matches_node_regex(
        r"(?i)model[_ .-]?not[_ .-]?found|model (?:is )?(?:unavailable|not found|unsupported)|unsupported model",
        message,
    ) {
        "model_not_found"
    } else if matches_node_regex(
        r"(?i)provider[_ .-]?unavailable|provider (?:is )?(?:unavailable|refused)|service unavailable",
        message,
    ) {
        "provider_unavailable"
    } else {
        "worker_process_failed"
    }
}
pub fn classify_chatgpt_failure(error: &Value, phase: &str) -> Value {
    if let Some(rejection) = PreSubmissionRejection::from_platform_response(error) {
        return json!({"classification":rejection.classification,"safeToReroute":true,"evidence":rejection.platform_evidence});
    }
    let code = error["code"].as_str().unwrap_or("");
    let msg = error["message"].as_str().unwrap_or("");
    let safe = error["status"] == "rejected"
        && error["submitted"] == false
        && error["message"].is_string();
    let classification = if safe {
        match code {
            "MODEL_UNAVAILABLE" | "MODEL_NOT_FOUND" => Some("model_unavailable"),
            "MCP_LOGIN_REQUIRED" => Some("mcp_login_required"),
            "PROJECT_SETUP_UNAVAILABLE" => Some("project_setup_unavailable"),
            "BROWSER_WORKSPACE_UNAVAILABLE" => Some("browser_workspace_unavailable"),
            "POOL_CAPACITY_FULL" | "POOL_WAIT_EXPIRED" => Some("pool_capacity_full"),
            "PROVIDER_UNAVAILABLE" => Some("provider_unavailable"),
            _ => None,
        }
    } else {
        None
    };
    if let Some(c) = classification {
        return json!({"classification":c,"safeToReroute":true,"evidence":serde_json::to_string(&json!({"status":"rejected","submitted":false,"code":code,"message":msg})).unwrap()});
    }
    let evidence = if error.is_object() {
        "[object Object]".to_owned()
    } else if error.is_null() {
        "null".into()
    } else if let Some(s) = error.as_str() {
        s.to_owned()
    } else {
        error.to_string()
    };
    let c = if phase == "start-ack" {
        "start_ack_timeout"
    } else if phase == "launch" {
        "launch_failure"
    } else {
        "outcome_unknown"
    };
    json!({"classification":c,"safeToReroute":false,"evidence":evidence})
}
pub fn classify_chat_gpt_platform_failure(error: &Value, phase: &str) -> Value {
    classify_chatgpt_failure(error, phase)
}
