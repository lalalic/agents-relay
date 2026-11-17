// Node provenance: src/dashboard.ts server-side API routes and the serial
// rust2 Dashboard backend. The already-merged dashboard.rs remains the sole
// PWA/static/SSE HTTP transport; this adapter supplies ONLY backend semantics.
// All lifecycle writes must be performed by the injected Graph/SQLite services.
use crate::{
    dashboard::{DashboardBackend, DashboardRequest, DashboardResponse},
    dashboard_data::{
        dashboard_workflow_graphs, effective_github_usage, list_dashboard_job_inventory,
        search_dashboard_jobs,
    },
    dashboard_workflow_inspection::inspect_workflow_symbol,
    github_webhook::{parse_github_webhook, verify_github_webhook, DeliveryDeduper},
    routing_policy::{load_execution_router_rules, save_execution_router_rules},
    runtime_summary::summarize_runtime,
};
use regex::Regex;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{
        mpsc::{self, Receiver},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use url::Url;

fn timestamp_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}
pub const MAX_ROUTER_RULES_BODY: usize = 64 * 1024;
const WEBHOOK_DEDUP_TTL_MS: i64 = 10 * 60 * 1000;
const WEBHOOK_DEDUP_MAX_ENTRIES: usize = 1000;

fn field<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn json_response(status: u16, value: &Value) -> DashboardResponse {
    DashboardResponse::new(
        status,
        "application/json",
        "no-store",
        value.to_string().into_bytes(),
    )
}
fn text_response(status: u16, text: impl Into<String>) -> DashboardResponse {
    DashboardResponse::new(
        status,
        "text/plain; charset=utf-8",
        "no-store",
        text.into().into_bytes(),
    )
}
fn allowed_job_id(id: &str) -> bool {
    static JOB_ID: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    JOB_ID
        .get_or_init(|| Regex::new(r"^[A-Za-z0-9_.-]+$").unwrap())
        .is_match(id)
}
fn query(parsed: &Url, key: &str) -> Option<String> {
    parsed
        .query_pairs()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.into_owned())
}
fn target(parsed: &Url) -> (Option<String>, Option<u64>) {
    (
        query(parsed, "repo").filter(|v| !v.is_empty()),
        query(parsed, "pr")
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|n| *n > 0),
    )
}
fn parse_json(req: &DashboardRequest<'_>) -> Result<Value, String> {
    serde_json::from_slice(req.body).map_err(|error| format!("Invalid JSON: {error}"))
}
fn allowed_method(req: &DashboardRequest<'_>, method: &str) -> bool {
    req.method == method
}

/// Native implementation of the original Dashboard business backend.
/// Implementations MUST use the existing Graph actions, canonical SQLite
/// transactions and event bus; returning an HTTP receipt is not a Task ACK.
pub trait DashboardApiServices: Send + 'static {
    fn discovered_jobs(&mut self, force: bool) -> Result<Vec<Value>, String>;
    fn exact_job(
        &mut self,
        job_id: &str,
        repository: Option<&str>,
        pr: Option<u64>,
    ) -> Result<Option<Value>, String>;
    fn control(&mut self, body: &Value) -> Result<Value, String>;
    fn job_action(&mut self, job_id: &str, action: &str) -> Result<Value, String>;
    fn task_command(&mut self, body: &Value) -> Result<Value, String>;
    fn task_action(&mut self, job_id: &str, task_id: &str, action: &str) -> Result<Value, String>;
    fn job_set_state(&mut self, job_id: &str, state: &str, target: &Value)
        -> Result<Value, String>;
    fn task_set_state(
        &mut self,
        job_id: &str,
        task_id: &str,
        state: &str,
        target: &Value,
    ) -> Result<Value, String>;
    fn events(
        &mut self,
        job_id: &str,
        task_id: Option<&str>,
        limit: i64,
    ) -> Result<Vec<Value>, String>;
    /// Must return only after durable event wake/inbox handling succeeds.
    fn github_webhook(&mut self, event: &Value) -> Result<(), String>;
    fn router_test(&mut self, job_id: &str, task_id: &str) -> Result<Value, String>;
    fn decision_audit(&mut self) -> Result<Vec<Value>, String>;
    fn runtime_status(&mut self) -> Value;
    fn account_usage(&mut self) -> Result<Value, String>;
    fn github_usage(&mut self) -> Result<Option<Value>, String>;
    fn subscribe_events(&mut self) -> Receiver<String>;
    /// Host-neutral hook for the existing server-side QA endpoint.
    fn troubleshooter_qa(
        &mut self,
        _req: &DashboardRequest<'_>,
    ) -> Result<DashboardResponse, String> {
        Err("Troubleshooter QA service unavailable".into())
    }
}

#[derive(Clone, Debug)]
pub struct DashboardApiOptions {
    pub graph_directory: PathBuf,
    pub router_rules_path: PathBuf,
    pub webhook_secret: Option<String>,
    pub webhook_repositories: HashSet<String>,
    pub webhook_job_id: Option<String>,
    pub webhook_pr_number: Option<u64>,
}
pub struct NativeDashboardApi<S: DashboardApiServices> {
    services: Mutex<S>,
    options: DashboardApiOptions,
    last_known_jobs: Mutex<Option<Vec<Value>>>,
    webhook_deliveries: Mutex<DeliveryDeduper>,
}
impl<S: DashboardApiServices> NativeDashboardApi<S> {
    pub fn new(options: DashboardApiOptions, services: S) -> Self {
        Self {
            options,
            services: Mutex::new(services),
            last_known_jobs: Mutex::new(None),
            webhook_deliveries: Mutex::new(DeliveryDeduper::new(
                WEBHOOK_DEDUP_TTL_MS,
                WEBHOOK_DEDUP_MAX_ENTRIES,
            )),
        }
    }
    fn discovered(&self, services: &mut S, force: bool) -> Result<Vec<Value>, String> {
        match services.discovered_jobs(force) {
            Ok(jobs) => {
                *self
                    .last_known_jobs
                    .lock()
                    .map_err(|_| "Dashboard cache poisoned")? = Some(jobs.clone());
                Ok(jobs)
            }
            Err(error) if !force => self
                .last_known_jobs
                .lock()
                .map_err(|_| "Dashboard cache poisoned")?
                .clone()
                .ok_or(error),
            Err(error) => Err(error),
        }
    }
    fn webhook(&self, services: &mut S, req: &DashboardRequest<'_>) -> DashboardResponse {
        let Some(secret) = self.options.webhook_secret.as_deref() else {
            return text_response(401, "Invalid signature");
        };
        let signature = req.headers.get("x-hub-signature-256").map(String::as_str);
        if !verify_github_webhook(secret, req.body, signature) {
            return text_response(401, "Invalid signature");
        }
        let headers = json!(req.headers);
        let Some(event) = parse_github_webhook(&headers, req.body) else {
            return text_response(202, "Ignored");
        };
        let repository = field(&event, "repository");
        if !self.options.webhook_repositories.contains(repository)
            || self.options.webhook_job_id.as_ref().is_some_and(|scope| {
                event
                    .get("jobId")
                    .and_then(Value::as_str)
                    .is_some_and(|actual| actual != scope)
            })
            || self.options.webhook_pr_number.is_some_and(|expected| {
                event
                    .get("pullRequest")
                    .and_then(Value::as_u64)
                    .is_some_and(|actual| actual != expected)
            })
        {
            return text_response(202, "Ignored");
        }
        let delivery = field(&event, "deliveryId");
        let now = timestamp_millis();
        let duplicate = self
            .webhook_deliveries
            .lock()
            .ok()
            .is_some_and(|seen| seen.has(delivery, now));
        if duplicate {
            return text_response(202, "Duplicate");
        }
        // An authenticated webhook must never be deduplicated before its
        // authoritative wake succeeds. Failed receipts remain retryable.
        if services.github_webhook(&event).is_err() {
            return text_response(503, "Webhook handling unavailable; redelivery required");
        }
        if let Ok(mut seen) = self.webhook_deliveries.lock() {
            if !delivery.is_empty() {
                seen.accept(delivery, now);
            }
        }
        text_response(202, "Accepted")
    }
    fn route(&self, services: &mut S, req: &DashboardRequest<'_>) -> DashboardResponse {
        let address = format!("http://127.0.0.1{}", req.target);
        let parsed = match Url::parse(&address) {
            Ok(parsed) => parsed,
            Err(_) => return text_response(400, "Invalid URL"),
        };
        let path = parsed.path();
        if path == "/webhooks/github" && allowed_method(req, "POST") {
            return self.webhook(services, req);
        }
        let response = (|| -> Result<DashboardResponse, String> {
            Ok(match path {
                "/api/graph-symbol" => {
                    if !allowed_method(req, "GET") {
                        return Ok(text_response(405, "Method not allowed"));
                    }
                    let result = inspect_workflow_symbol(
                        &self.options.graph_directory,
                        query(&parsed, "graph").as_deref().unwrap_or(""),
                        query(&parsed, "kind").as_deref().unwrap_or(""),
                        query(&parsed, "name").as_deref().unwrap_or(""),
                    );
                    json_response(
                        if result.is_some() { 200 } else { 404 },
                        &result.unwrap_or(json!({"error":"No canonical graph symbol found"})),
                    )
                }
                "/api/troubleshooter-qa" => services.troubleshooter_qa(req)?,
                "/api/graphs" => json_response(
                    200,
                    &json!(dashboard_workflow_graphs(&self.options.graph_directory)?),
                ),
                "/api/jobs" => {
                    let force = query(&parsed, "refresh").as_deref() == Some("1");
                    let jobs = self.discovered(services, force)?;
                    let body = if query(&parsed, "inventory").as_deref() == Some("1") {
                        list_dashboard_job_inventory(
                            &jobs,
                            query(&parsed, "repo").as_deref().unwrap_or(""),
                        )
                    } else {
                        search_dashboard_jobs(&jobs, parsed.query().unwrap_or(""))
                    };
                    json_response(200, &body)
                }
                "/api/job" => {
                    let jobs = self.discovered(services, false)?;
                    let id = query(&parsed, "id")
                        .or_else(|| {
                            jobs.first()
                                .and_then(|job| job.get("id"))
                                .and_then(Value::as_str)
                                .map(str::to_owned)
                        })
                        .ok_or("Managed job not found")?;
                    if !allowed_job_id(&id) {
                        return Ok(text_response(400, "Invalid job id"));
                    }
                    let (repo, pr) = target(&parsed);
                    let exact = services.exact_job(&id, repo.as_deref(), pr)?;
                    let chosen = exact
                        .or_else(|| {
                            jobs.into_iter().find(|job| {
                                field(job, "id") == id
                                    && repo
                                        .as_deref()
                                        .is_none_or(|repo| field(job, "repository") == repo)
                                    && pr.is_none_or(|pr| {
                                        job.get("prNumber").and_then(Value::as_u64) == Some(pr)
                                    })
                            })
                        })
                        .ok_or("Managed job not found")?;
                    json_response(200, &chosen)
                }
                "/api/events" => {
                    let id = query(&parsed, "job").unwrap_or_default();
                    if !allowed_job_id(&id) {
                        return Ok(text_response(400, "Invalid job id"));
                    }
                    let limit = query(&parsed, "limit")
                        .and_then(|n| n.parse::<i64>().ok())
                        .unwrap_or(60);
                    json_response(
                        200,
                        &json!(services.events(&id, query(&parsed, "task").as_deref(), limit)?),
                    )
                }
                "/api/status" => json_response(200, &services.runtime_status()),
                "/api/runtime-summary" => json_response(
                    200,
                    &summarize_runtime(&self.discovered(services, false)?, timestamp_millis()),
                ),
                "/api/usage" => {
                    let mut account = services.account_usage()?;
                    let status = services.runtime_status();
                    let github = services.github_usage().ok().flatten();
                    if let Some(map) = account.as_object_mut() {
                        map.insert(
                            "githubEffective".into(),
                            json!(effective_github_usage(
                                github.as_ref(),
                                status.get("runtimeRateUsage")
                            )),
                        );
                        map.insert("githubStatus".into(), status);
                    }
                    json_response(200, &account)
                }
                "/api/decision-audit" => {
                    if !allowed_method(req, "GET") {
                        return Ok(text_response(405, "Method not allowed"));
                    }
                    let mut audits = services.decision_audit()?;
                    audits.reverse();
                    audits.truncate(30);
                    json_response(200, &json!(audits))
                }
                "/api/router-test" => {
                    if !allowed_method(req, "POST") {
                        return Ok(text_response(405, "Method not allowed"));
                    }
                    let body = parse_json(req)?;
                    let (job, task) = (field(&body, "jobId"), field(&body, "taskId"));
                    if job.is_empty() || task.is_empty() {
                        return Ok(text_response(400, "Select a Job and Task first"));
                    }
                    json_response(200, &services.router_test(job, task)?)
                }
                "/api/execution-router-rules" => {
                    if allowed_method(req, "GET") {
                        json_response(
                            200,
                            &load_execution_router_rules(
                                &self.options.router_rules_path.to_string_lossy(),
                            ),
                        )
                    } else if allowed_method(req, "PUT") {
                        if req.body.len() > MAX_ROUTER_RULES_BODY {
                            return Ok(text_response(413, "Execution router rules exceed 64 KiB"));
                        }
                        let raw = std::str::from_utf8(req.body).map_err(|e| e.to_string())?;
                        json_response(
                            200,
                            &save_execution_router_rules(
                                raw,
                                &self.options.router_rules_path.to_string_lossy(),
                            )?,
                        )
                    } else {
                        return Ok(text_response(405, "Method not allowed"));
                    }
                }
                "/api/control" => {
                    if !allowed_method(req, "POST") {
                        return Ok(text_response(404, "Control API unavailable"));
                    }
                    json_response(200, &services.control(&parse_json(req)?)?)
                }
                "/api/task-command" => {
                    if !allowed_method(req, "POST") {
                        return Ok(text_response(404, "Task command unavailable"));
                    }
                    let body = parse_json(req)?;
                    let job = field(&body, "jobId");
                    let task = field(&body, "taskId");
                    let action = field(&body, "action");
                    let well_formed = match action {
                        "create" => body.get("task").is_some_and(Value::is_object),
                        "update" => {
                            !task.is_empty()
                                && body.get("task").is_some_and(Value::is_object)
                                && !field(&body, "expectedUpdatedAt").is_empty()
                        }
                        "retry" | "cancel" => !task.is_empty(),
                        _ => false,
                    };
                    if !allowed_job_id(job) || !well_formed {
                        return Ok(text_response(409, "Task command unavailable"));
                    }
                    json_response(200, &services.task_command(&body)?)
                }
                "/api/job-action" => {
                    let id = query(&parsed, "id").unwrap_or_default();
                    let action = query(&parsed, "action").unwrap_or_default();
                    if !allowed_method(req, "POST")
                        || !allowed_job_id(&id)
                        || !matches!(action.as_str(), "start" | "reconcile" | "cancel")
                    {
                        return Ok(text_response(404, "Job action unavailable"));
                    }
                    json_response(200, &services.job_action(&id, &action)?)
                }
                "/api/task-action" => {
                    let id = query(&parsed, "id").unwrap_or_default();
                    let task = query(&parsed, "task").unwrap_or_default();
                    let action = query(&parsed, "action").unwrap_or_default();
                    if !allowed_method(req, "POST")
                        || !allowed_job_id(&id)
                        || task.is_empty()
                        || !matches!(action.as_str(), "retry" | "cancel")
                    {
                        return Ok(text_response(404, "Task action unavailable"));
                    }
                    json_response(200, &services.task_action(&id, &task, &action)?)
                }
                "/api/job-state" => {
                    let id = query(&parsed, "id").unwrap_or_default();
                    let state = query(&parsed, "state").unwrap_or_default();
                    if !allowed_method(req, "POST")
                        || !allowed_job_id(&id)
                        || !matches!(
                            state.as_str(),
                            "DRAFT" | "ACTIVE" | "COMPLETED" | "CANCELLED"
                        )
                    {
                        return Ok(text_response(404, "Job state override unavailable"));
                    }
                    let (repo, pr) = target(&parsed);
                    json_response(
                        200,
                        &services.job_set_state(
                            &id,
                            &state,
                            &json!({"repository":repo,"prNumber":pr}),
                        )?,
                    )
                }
                "/api/task-state" => {
                    let id = query(&parsed, "id").unwrap_or_default();
                    let task = query(&parsed, "task").unwrap_or_default();
                    let state = query(&parsed, "state").unwrap_or_default();
                    if !allowed_method(req, "POST")
                        || !allowed_job_id(&id)
                        || task.is_empty()
                        || !matches!(
                            state.as_str(),
                            "DRAFT"
                                | "QUEUED"
                                | "RUNNING"
                                | "AWAITING_DECISION"
                                | "BLOCKED"
                                | "SUCCEEDED"
                                | "FAILED"
                                | "CANCELLED"
                        )
                    {
                        return Ok(text_response(404, "Task state override unavailable"));
                    }
                    let (repo, pr) = target(&parsed);
                    json_response(
                        200,
                        &services.task_set_state(
                            &id,
                            &task,
                            &state,
                            &json!({"repository":repo,"prNumber":pr}),
                        )?,
                    )
                }
                _ => text_response(404, "Not found"),
            })
        })();
        match response {
            Ok(response) => response,
            Err(error) => {
                let status = match path {
                    "/api/job" => 404,
                    "/api/usage" | "/api/troubleshooter-qa" => 503,
                    "/api/control" | "/api/task-command" | "/api/job-action"
                    | "/api/task-action" | "/api/job-state" | "/api/task-state" => 409,
                    "/api/graphs"
                    | "/api/graph-symbol"
                    | "/api/execution-router-rules"
                    | "/api/router-test"
                    | "/api/decision-audit" => 500,
                    _ => 502,
                };
                text_response(status, error)
            }
        }
    }
}
impl<S: DashboardApiServices> DashboardBackend for NativeDashboardApi<S> {
    fn api(&self, req: DashboardRequest<'_>) -> DashboardResponse {
        match self.services.lock() {
            Ok(mut services) => self.route(&mut services, &req),
            Err(_) => text_response(503, "Dashboard API backend unavailable"),
        }
    }
    fn subscribe_events(&self) -> Receiver<String> {
        self.services
            .lock()
            .map(|mut services| services.subscribe_events())
            .unwrap_or_else(|_| mpsc::channel().1)
    }
}
