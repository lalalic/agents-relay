// Node provenance: src/dashboard.ts server-side API routes and the serial
// rust2 Dashboard backend. The already-merged dashboard.rs remains the sole
// PWA/static/SSE HTTP transport; this adapter supplies ONLY backend semantics.
// All lifecycle writes must be performed by the injected Graph/SQLite services.
use crate::{
    dashboard::{DashboardBackend, DashboardRequest, DashboardResponse},
    dashboard_mobile::{
        project_mobile_jobs,project_mobile_tasks,project_mobile_activity,project_mobile_job,mobile_pause_capability,
        valid_mobile_identity,
    },
    dashboard_data::{
        dashboard_workflow_graphs, list_dashboard_job_inventory, search_dashboard_jobs,
    },
    dashboard_neo_threads::{project_jobs, project_thread_links, sessions_directory},
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
        Arc,Mutex,
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
fn target(parsed:&Url)->Option<String>{
    query(parsed,"repo").filter(|v|!v.is_empty())
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
    /// A clone with read-only observation ports, not a second lifecycle owner.
    /// The original route still enforces identity, methods and redaction.
    fn detached_observations(&self)->Option<Self> where Self:Sized{None}
    /// Only an explicitly read-only, indexed store may bypass whole-store
    /// inventory discovery for an immutable /api/job?id= lookup. This never
    /// changes admission for mutable/legacy production APIs or id-less GET.
    fn supports_indexed_readonly_job(&self)->bool{false}
    fn supports_indexed_job(&self)->bool{self.supports_indexed_readonly_job()}
    fn discovered_jobs(&mut self, force: bool) -> Result<Vec<Value>, String>;
    fn search_jobs(&mut self,_query:&str)->Option<Result<Value,String>>{None}
    fn runtime_jobs(&mut self)->Result<Vec<Value>,String>{self.discovered_jobs(false)}
    fn exact_job(
        &mut self,
        job_id: &str,
        repository: Option<&str>,
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
    fn routing_usage(&mut self) -> Result<Value,String>{self.account_usage()}
    fn github_usage(&mut self) -> Result<Option<Value>, String>;
    /// A request-local facade may submit mutations through a single owner.
    /// Never clone a mutable standalone/fixture host as a second owner.
    fn independent_requests(&self)->bool{false}
    fn event_subscription(&self)->Option<Arc<dyn Fn()->Receiver<String>+Send+Sync>>{None}
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
    /// The same pinned Skill file read by a Troubleshooter execution.
    pub troubleshooter_qa_path: PathBuf,
    pub webhook_secret: Option<String>,
    pub webhook_repositories: HashSet<String>,
    pub webhook_job_id: Option<String>,
}
pub struct NativeDashboardApi<S: DashboardApiServices> {
    services: Mutex<S>,
    observations: Mutex<Option<S>>,
    event_subscription:Option<Arc<dyn Fn()->Receiver<String>+Send+Sync>>,
    independent_requests:bool,
    options: DashboardApiOptions,
    last_known_jobs: Mutex<Option<Vec<Value>>>,
    webhook_deliveries: Mutex<DeliveryDeduper>,
}
impl<S: DashboardApiServices> NativeDashboardApi<S> {
    pub fn new(options: DashboardApiOptions, services: S) -> Self {
        let observations=services.detached_observations();
        let event_subscription=services.event_subscription();
        let independent_requests=services.independent_requests();
        Self {
            options,
            observations:Mutex::new(observations),event_subscription,independent_requests,
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
    pub(crate) fn mobile(&self,services:&mut S,req:&DashboardRequest<'_>,parsed:&Url)
        ->DashboardResponse{
        let path=parsed.path();
        let id=query(parsed,"id").unwrap_or_default();
        let repo=query(parsed,"repo").unwrap_or_default();
        let identity=valid_mobile_identity(&json!(id),&json!(repo));
        let valid_get=allowed_method(req,"GET")&&identity;
        let result=(||->Result<Value,String>{
            match path{
                "/api/mobile/jobs" if allowed_method(req,"GET")=>{
                    let js_num=|name:&str,default:&str|{
                        let value=query(parsed,name).unwrap_or_else(||default.into());
                        let raw=value.trim();
                        if raw.is_empty(){return 0.0;}
                        if let Some(n)=raw.strip_prefix("0x").or_else(||raw.strip_prefix("0X")){
                            return u64::from_str_radix(n,16).map(|v|v as f64).unwrap_or(f64::NAN);
                        }
                        if let Some(n)=raw.strip_prefix("0b").or_else(||raw.strip_prefix("0B")){
                            return u64::from_str_radix(n,2).map(|v|v as f64).unwrap_or(f64::NAN);
                        }
                        if let Some(n)=raw.strip_prefix("0o").or_else(||raw.strip_prefix("0O")){
                            return u64::from_str_radix(n,8).map(|v|v as f64).unwrap_or(f64::NAN);
                        }
                        raw.parse::<f64>().unwrap_or(f64::NAN)
                    };
                    let offset=js_num("offset","0");
                    let limit=js_num("limit","20");
                    let jobs=self.discovered(services,false)?;
                    project_mobile_jobs(&json!(jobs),offset,limit)
                },
                "/api/mobile/job-tasks" if valid_get=>{
                    let job=services.exact_job(&id,Some(&repo))?
                        .ok_or("Job unavailable")?;
                    project_mobile_tasks(&job,&json!(id),&json!(repo))
                },
                "/api/mobile/job-activity" if valid_get=>{
                    // EventBus history is keyed only by Job ID; a scoped
                    // request is NOT authorization if another repository has
                    // the same ID. Verify unique owner BEFORE reading events.
                    let rows=services.discovered_jobs(true)?;
                    if rows.iter().filter(|job|field(job,"id")==id).count()!=1{
                        return Err("Ambiguous Job ID".into());
                    }
                    let job=services.exact_job(&id,Some(&repo))?
                        .ok_or("Job unavailable")?;
                    if field(&job,"id")!=id||field(&job,"repository")!=repo{
                        return Err("Job identity mismatch".into());
                    }
                    let history=services.events(&id,None,100)?;
                    Ok(json!({"jobId":id,"repository":repo,
                        "events":project_mobile_activity(&json!(history))}))
                },
                "/api/mobile/job-pause"|"/api/mobile/job-resume" if allowed_method(req,"POST")=>{
                    if req.body.len()>8192{return Err("Job action request too large".into())}
                    let input:Value=serde_json::from_slice(req.body).map_err(|_|"Invalid JSON")?;
                    let bound_id=field(&input,"id");
                    let bound_repo=field(&input,"repository");
                    if !valid_mobile_identity(&input["id"],&input["repository"]){return Err("Invalid Job identity".into())}
                    let pause=path=="/api/mobile/job-pause";
                    let rows=services.discovered_jobs(true)?;
                    let owned=rows.iter().filter(|job|field(job,"id")==bound_id).collect::<Vec<_>>();
                    if owned.len()!=1||field(owned[0],"repository")!=bound_repo{
                        return Err("Job unavailable or ambiguous".into());
                    }
                    let before=services.exact_job(bound_id,Some(bound_repo))?.ok_or("Job unavailable")?;
                    if field(&before,"id")!=bound_id||field(&before,"repository")!=bound_repo
                        ||!mobile_pause_capability(&before,pause){return Err("Job action unavailable".into())}
                    services.control(&json!({"command":if pause{"job.pause"}else{"job.resume"},"jobId":bound_id,"repository":bound_repo}))?;
                    let after=services.exact_job(bound_id,Some(bound_repo))?.ok_or("Job action readback not confirmed")?;
                    if field(&after,"id")!=bound_id||field(&after,"repository")!=bound_repo
                        ||after.get("pause").is_some_and(|v|!v.is_null())!=pause
                        ||(pause&&!mobile_pause_capability(&after,false)){
                        return Err("Job action readback not confirmed".into());
                    }
                    project_mobile_job(&after).ok_or("Job action readback not confirmed".into())
                },
                "/api/mobile/job-cancel" if allowed_method(req,"POST")=>{
                    if req.body.len()>8192{return Err("Cancel request too large".into())}
                    let input:Value=serde_json::from_slice(req.body)
                        .map_err(|e|format!("Invalid JSON: {e}"))?;
                    let bound_id=field(&input,"id");
                    let bound_repo=field(&input,"repository");
                    if !valid_mobile_identity(&input["id"],&input["repository"]){
                        return Err("Invalid Job identity".into());
                    }
                    // The underlying Graph cancel control accepts ID only.
                    // Do NOT mutate if ID belongs to more than one repository.
                    let rows=services.discovered_jobs(true)?;
                    let owned=rows.iter().filter(|job|field(job,"id")==bound_id)
                        .collect::<Vec<_>>();
                    if owned.len()!=1||field(owned[0],"repository")!=bound_repo
                        ||!matches!(field(owned[0],"state"),"DRAFT"|"ACTIVE"){
                        return Err("Job not cancellable without a unique Job ID".into());
                    }
                    services.job_action(bound_id,"cancel")?;
                    let after=services.exact_job(bound_id,Some(bound_repo))?
                        .ok_or("CANCELLED readback not confirmed")?;
                    if field(&after,"id")!=bound_id||field(&after,"repository")!=bound_repo
                        ||field(&after,"state")!="CANCELLED"{
                        return Err("CANCELLED readback not confirmed".into());
                    }
                    Ok(json!({"id":bound_id,"repository":bound_repo,"status":"cancelled"}))
                },
                _=>Err("__MOBILE_NOT_FOUND__".into()),
            }
        })();
        match result{
            Ok(value)=>json_response(200,&value),
            Err(error) if error=="__MOBILE_NOT_FOUND__"=>
                text_response(404,"Mobile API unavailable"),
            Err(error)=>json_response(409,&json!({"error":error})),
        }
    }
    fn route(&self, services: &mut S, req: &DashboardRequest<'_>) -> DashboardResponse {
        let address = format!("http://127.0.0.1{}", req.target);
        let parsed = match Url::parse(&address) {
            Ok(parsed) => parsed,
            Err(_) => return text_response(400, "Invalid URL"),
        };
        let path = parsed.path();
        // A live-store shadow can only observe SQLite. Reject non-GET
        // methods before routing, including routes that accidentally
        // return an ordinary read response for POST /api/job or /api/jobs.
        // Do not rely on individual effects to notice a shadow request.
        if services.supports_indexed_readonly_job() && req.method != "GET" {
            return text_response(405,"Read-only shadow forbids HTTP mutations");
        }
        if path.starts_with("/api/mobile/"){
            return crate::dashboard_mobile::handle_mobile_dashboard_request(
                self,services,req,&parsed);
        }
        if path == "/webhooks/github" && allowed_method(req, "POST") {
            return self.webhook(services, req);
        }
        let response = (|| -> Result<DashboardResponse, String> {
            Ok(match path {
                "/api/execution-report" => {
                    if !crate::dashboard_report::private_request(req) {
                        return Ok(text_response(403,"Detailed reports require the local JEL Viewer"));
                    }
                    if !matches!(req.method,"GET"|"POST") {
                        return Ok(text_response(405,"Method not allowed"));
                    }
                    let id=query(&parsed,"job").ok_or("Job ID required")?;
                    let repo=target(&parsed).ok_or("Repository required")?;
                    if !allowed_job_id(&id){return Ok(text_response(400,"Invalid Job ID"));}
                    let task=query(&parsed,"task");
                    let Some(job)=services.exact_job(&id,Some(&repo))? else {
                        return Ok(text_response(404,"Job not found"));
                    };
                    if field(&job,"id")!=id||field(&job,"repository")!=repo{
                        return Ok(text_response(404,"Job identity mismatch"));
                    }
                    crate::dashboard_report::handle(req,&job,task.as_deref())
                }
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
                "/api/troubleshooter-qa" => {
                    let response = crate::troubleshooter_qa_api::handle_troubleshooter_qa(
                        &self.options.troubleshooter_qa_path,
                        crate::troubleshooter_qa_api::Request {
                            method: req.method.to_owned(),
                            content_type: req.headers.get("content-type").cloned(),
                            body: req.body.to_vec(),
                        },
                    );
                    let content_type = if response.headers.iter()
                        .any(|(name, _)| name.eq_ignore_ascii_case("content-type")) {
                        "application/json"
                    } else { "text/plain; charset=utf-8" };
                    DashboardResponse::new(response.status, content_type, "no-store", response.body)
                }
                "/api/graphs" => json_response(
                    200,
                    &json!(dashboard_workflow_graphs(&self.options.graph_directory)?),
                ),
                "/api/jobs" => {
                    if !allowed_method(req,"GET"){return Ok(text_response(405,"Method not allowed"));}
                    let force = query(&parsed, "refresh").as_deref() == Some("1");
                    let full=query(&parsed,"inventory").as_deref()==Some("1");
                    if !full{
                        if let Some(Ok(mut result))=services.search_jobs(parsed.query().unwrap_or("")){
                            project_thread_links(&mut result, sessions_directory().as_deref());
                            return Ok(json_response(200,&result));
                        }
                        // Legacy JSON encoding or read errors retain the
                        // original parser and non-forced inventory fallback.
                    }
                    let mut jobs = self.discovered(services, force)?;
                    project_jobs(&mut jobs, sessions_directory().as_deref());
                    let body = if full {
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
                    if !allowed_method(req,"GET"){return Ok(text_response(405,"Method not allowed"));}
                    let supplied_id=query(&parsed,"id");
                    let jobs=if supplied_id.is_some()
                        &&services.supports_indexed_job(){
                        // The shadow's exact scoped SQLite load is indexed;
                        // avoid parsing every live Job merely to resolve one
                        // immutable, explicitly supplied ID.
                        Vec::new()
                    }else{self.discovered(services,false)?};
                    let id = supplied_id
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
                    let repo = target(&parsed);
                    let exact = services.exact_job(&id, repo.as_deref())?;
                    let mut chosen = exact
                        .or_else(|| {
                            jobs.into_iter().find(|job| {
                                field(job, "id") == id
                                    && repo
                                        .as_deref()
                                        .is_none_or(|repo| field(job, "repository") == repo)

                            })
                        })
                        .ok_or("Managed job not found")?;
                    project_thread_links(&mut chosen, sessions_directory().as_deref());
                    json_response(200, &chosen)
                }
                "/api/events" => {
                    if !allowed_method(req,"GET"){return Ok(text_response(405,"Method not allowed"));}
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
                "/api/status" => {
                    if !allowed_method(req,"GET"){return Ok(text_response(405,"Method not allowed"));}
                    json_response(200,&services.runtime_status())
                },
                "/api/runtime-summary" => {
                    if !allowed_method(req,"GET"){return Ok(text_response(405,"Method not allowed"));}
                    json_response(200,&summarize_runtime(&services.runtime_jobs()?,timestamp_millis()))
                },
                "/api/usage" => {
                    if !allowed_method(req,"GET"){return Ok(text_response(405,"Method not allowed"));}
                    if query(&parsed,"scope").as_deref()==Some("routing"){
                        return Ok(json_response(200,&services.routing_usage()?));
                    }
                    let mut account = services.account_usage()?;
                    if let Some(map) = account.as_object_mut() {
                        map.remove("githubEffective");
                        map.remove("githubStatus");
                        if let Some(credits) = map.get_mut("credits").and_then(Value::as_array_mut) {
                            credits.retain(|credit| credit.get("id").and_then(Value::as_str) != Some("deepseek"));
                        }
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
                    let repo = target(&parsed);
                    json_response(
                        200,
                        &services.job_set_state(
                            &id,
                            &state,
                            &json!({"repository":repo}),
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
                    let repo = target(&parsed);
                    json_response(
                        200,
                        &services.task_set_state(
                            &id,
                            &task,
                            &state,
                            &json!({"repository":repo}),
                        )?,
                    )
                }
                _ => text_response(404, "Not found"),
            })
        })();
        match response {
            Ok(response) => response,
            Err(error) => {
                if matches!(error.as_str(),"Daemon control queue busy; retry later"|"Daemon service unavailable"|"Daemon control receipt unavailable"){
                    return text_response(503,error);
                }
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
        // Clone the request facade and drop the template lock before routing.
        // Mutable standalone hosts retain their original serialization.
        let parsed=Url::parse(&format!("http://127.0.0.1{}",req.target)).ok();
        let path=parsed.as_ref().map(Url::path).unwrap_or("");
        // Q&A and routing rule reads/writes retain their existing serialized
        // file access. Canonical lifecycle commands use independent facades.
        let owner_command=self.independent_requests && req.method=="POST" && matches!(path,
            "/api/control"|"/api/task-command"|"/api/job-action"|"/api/task-action"|
            "/api/job-state"|"/api/task-state"|"/api/mobile/job-cancel"|"/api/mobile/job-pause"|"/api/mobile/job-resume");
        if owner_command || matches!((req.method,path),
            ("GET","/api/events"|"/api/usage"|"/api/decision-audit"|"/api/jobs"|"/api/job"|
                "/api/runtime-summary"|"/api/status"|"/api/mobile/jobs"|"/api/mobile/job-tasks"|"/api/mobile/job-activity"|
                "/api/graphs"|"/api/graph-symbol")
            |("GET"|"POST","/api/execution-report")
            |("POST","/api/router-test")){
            let detached=self.observations.lock().ok().and_then(|template|
                template.as_ref().and_then(DashboardApiServices::detached_observations));
            if let Some(mut reader)=detached{return self.route(&mut reader,&req);}
        }
        match self.services.lock() {
            Ok(mut services) => self.route(&mut services, &req),
            Err(_) => text_response(503, "Dashboard API backend unavailable"),
        }
    }
    fn subscribe_events(&self) -> Receiver<String> {
        if let Some(subscribe)=&self.event_subscription{return subscribe();}
        self.services
            .lock()
            .map(|mut services| services.subscribe_events())
            .unwrap_or_else(|_| mpsc::channel().1)
    }
}
