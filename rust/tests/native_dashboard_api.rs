// Node provenance: src/dashboard.ts server-side business routes. This tests
// the serial Rust API backend grafted into the already-merged PWA transport,
// using disposable service callbacks and a real loopback HTTP listener.
// No production Job store, WebHelm session, or external GitHub calls are used.
use agents_relay_rust2::{
    dashboard::{serve_dashboard, DashboardBackend, DashboardRequest, DashboardResponse},
    dashboard_api::{DashboardApiOptions, DashboardApiServices, NativeDashboardApi},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
#[derive(Default)]
struct FixtureServices {
    calls: Arc<Mutex<Vec<Value>>>,
    fail_refresh: Arc<AtomicBool>,
    fail_webhook: Arc<AtomicBool>,
    duplicate_mobile_id: Arc<AtomicBool>,
    report_fixture: Option<Value>,
    apply_pause_control: bool,
}
impl FixtureServices {
    fn log(&self, method: &str, value: Value) -> Value {
        self.calls
            .lock()
            .unwrap()
            .push(json!({"method":method,"value":value}));
        value
    }
}
fn jobs() -> Vec<Value> {
    vec![
        json!({"id":"101","repository":"toy/repo","title":"Alpha",
            "state":"ACTIVE","priority":"P2","prNumber":17,
            "createdAt":"2026-11-15T00:00:00.000Z",
            "updatedAt":"2026-11-17T00:00:00.000Z","tasks":[],"plans":[]}),
        json!({"id":"102","repository":"toy/repo","title":"Bravo",
            "state":"COMPLETED","priority":"P1","prNumber":18,
            "createdAt":"2026-11-14T00:00:00.000Z",
            "updatedAt":"2026-11-16T00:00:00.000Z","tasks":[],"plans":[]}),
        json!({"id":"103","repository":"other/repo","title":"Charlie",
            "state":"CANCELLED","priority":"P2","prNumber":19,
            "createdAt":"2026-11-13T00:00:00.000Z",
            "updatedAt":"2026-11-15T00:00:00.000Z","tasks":[],"plans":[]}),
    ]
}
impl DashboardApiServices for FixtureServices {
    fn discovered_jobs(&mut self, force: bool) -> Result<Vec<Value>, String> {
        self.log("discovered", json!({"force":force}));
        if force && self.fail_refresh.load(Ordering::Acquire) {
            return Err("authoritative sqlite unavailable".into());
        }
        let mut result=self.report_fixture.clone().map(|j|vec![j]).unwrap_or_else(jobs);
        if self.duplicate_mobile_id.load(Ordering::Acquire){
            let mut other=result[0].clone();
            other["repository"]=json!("other/repo");
            result.push(other);
        }
        Ok(result)
    }
    fn exact_job(
        &mut self,
        id: &str,
        repo: Option<&str>,
    ) -> Result<Option<Value>, String> {
        self.log("exact", json!({"id":id,"repository":repo}));
        Ok(self.report_fixture.clone().map(|j|vec![j]).unwrap_or_else(jobs).into_iter().find(|job| {
            job["id"] == id
                && repo.is_none_or(|r| job["repository"] == r)
        }))
    }
    fn control(&mut self, body: &Value) -> Result<Value, String> {
        let receipt=self.log("control", body.clone());
        if self.apply_pause_control {
            if let Some(job)=self.report_fixture.as_mut(){
                if body["command"]=="job.pause"{job["pause"]=json!({"generation":1});}
                if body["command"]=="job.resume"{job.as_object_mut().unwrap().remove("pause");}
            }
        }
        Ok(receipt)
    }
    fn job_action(&mut self, id: &str, action: &str) -> Result<Value, String> {
        Ok(self.log("job_action", json!({"id":id,"action":action})))
    }
    fn task_command(&mut self, body: &Value) -> Result<Value, String> {
        Ok(self.log("task_command", body.clone()))
    }
    fn task_action(&mut self, id: &str, task: &str, action: &str) -> Result<Value, String> {
        Ok(self.log("task_action", json!({"id":id,"task":task,"action":action})))
    }
    fn job_set_state(&mut self, id: &str, state: &str, target: &Value) -> Result<Value, String> {
        Ok(self.log("job_state", json!({"id":id,"state":state,"target":target})))
    }
    fn task_set_state(
        &mut self,
        id: &str,
        task: &str,
        state: &str,
        target: &Value,
    ) -> Result<Value, String> {
        Ok(self.log(
            "task_state",
            json!({"id":id,"task":task,
            "state":state,"target":target}),
        ))
    }
    fn events(&mut self, id: &str, task: Option<&str>, limit: i64) -> Result<Vec<Value>, String> {
        if task==Some("simulate-history-timeout"){
            return Err("Dashboard event history unavailable: timeout".into());
        }
        Ok(vec![
            self.log("events", json!({"id":id,"task":task,"limit":limit}))
        ])
    }
    fn github_webhook(&mut self, event: &Value) -> Result<(), String> {
        self.log("github_webhook", event.clone());
        if self.fail_webhook.swap(false, Ordering::AcqRel) {
            return Err("simulated SQLite wake rollback".into());
        }
        Ok(())
    }
    fn router_test(&mut self, id: &str, task: &str) -> Result<Value, String> {
        Ok(self.log("router_test", json!({"id":id,"task":task})))
    }
    fn decision_audit(&mut self) -> Result<Vec<Value>, String> {
        Ok((0..40).map(|i| json!({"order":i})).collect())
    }
    fn runtime_status(&mut self) -> Value {
        json!({"limited":false,"cooldownUntil":null})
    }
    fn account_usage(&mut self) -> Result<Value, String> {
        Ok(json!({"providers":[],"credits":[
            {"id":"deepseek","label":"DeepSeek","credits":{"available":true}},
            {"id":"openrouter","label":"OpenRouter","credits":{"available":true}}
        ],"githubEffective":{"remaining":1},"githubStatus":{"calls":1}}))
    }
    fn github_usage(&mut self) -> Result<Option<Value>, String> {
        self.log("github_usage", json!({}));
        Ok(None)
    }
    fn subscribe_events(&mut self) -> Receiver<String> {
        mpsc::channel().1
    }
}
fn fixture() -> (
    Arc<NativeDashboardApi<FixtureServices>>,
    Arc<Mutex<Vec<Value>>>,
    Arc<AtomicBool>,
    Arc<AtomicBool>,
) {
    let services = FixtureServices::default();
    let calls = services.calls.clone();
    let fail_refresh = services.fail_refresh.clone();
    let fail_webhook = services.fail_webhook.clone();
    let options = DashboardApiOptions {
        graph_directory: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../workflow"),
        router_rules_path: std::env::temp_dir()
            .join(format!("rust2-dashboard-api-rules-{}", std::process::id())),
        troubleshooter_qa_path: PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../skills/agents-relay/troubleshooter-qa.md"),
        webhook_secret: Some("local-fixture-secret".into()),
        webhook_repositories: HashSet::from(["toy/repo".into()]),
        webhook_job_id: None,
    };
    (
        Arc::new(NativeDashboardApi::new(options, services)),
        calls,
        fail_refresh,
        fail_webhook,
    )
}
fn call(
    backend: &NativeDashboardApi<FixtureServices>,
    method: &str,
    url: &str,
    body: Option<Value>,
) -> DashboardResponse {
    let bytes = body.map(|v| v.to_string().into_bytes()).unwrap_or_default();
    backend.api(DashboardRequest {
        method,
        target: url,
        body: &bytes,
        headers: &HashMap::new(),
    })
}
fn data(result: DashboardResponse) -> Value {
    serde_json::from_slice(&result.body).unwrap()
}
#[test]
fn event_history_timeout_is_an_http_error_not_successful_empty_event_feed(){
    let (backend,_,_,_)=fixture();
    let response=call(&backend,"GET",
        "/api/events?job=101&task=simulate-history-timeout&limit=60",None);
    assert_eq!(response.status,502);
    assert_ne!(response.body,b"[]");
    assert!(String::from_utf8_lossy(&response.body)
        .contains("Dashboard event history unavailable"));
}
#[test]
fn dynamic_dashboard_routes_converge_on_service_backend() {
    let (backend, calls, fail_refresh, _) = fixture();
    let listing = call(&backend, "GET", "/api/jobs?status=ACTIVE", None);
    assert_eq!(listing.status, 200);
    let selected = data(listing);
    assert_eq!(selected["total"], 1);
    assert_eq!(selected["jobs"][0]["id"], "101");
    assert_eq!(
        data(call(
            &backend,
            "GET",
            "/api/jobs?inventory=1&repo=toy%2Frepo",
            None
        ))["total"],
        2
    );
    assert_eq!(
        data(call(
            &backend,
            "GET",
            "/api/job?id=101&repo=toy%2Frepo",
            None
        ))["id"],
        "101"
    );
    assert_eq!(
        call(&backend, "GET", "/api/job?id=101&repo=other%2Frepo", None).status,
        404
    );
    assert_eq!(
        data(call(
            &backend,
            "GET",
            "/api/events?job=101&task=2&limit=7",
            None
        ))[0]["limit"],
        7
    );
    assert_eq!(
        call(&backend, "GET", "/api/events?job=bad%20id", None).status,
        400
    );
    assert_eq!(
        data(call(&backend, "GET", "/api/status", None))["limited"],
        false
    );
    assert_eq!(
        data(call(&backend, "GET", "/api/usage", None))["providers"],
        json!([])
    );
    let usage=data(call(&backend,"GET","/api/usage",None));
    assert_eq!(usage["credits"].as_array().unwrap().len(),1);
    assert_eq!(usage["credits"][0]["id"],"openrouter");
    assert!(usage.get("githubEffective").is_none());
    assert!(usage.get("githubStatus").is_none());
    let routing=data(call(&backend,"GET","/api/usage?scope=routing",None));
    assert!(routing["credits"].as_array().unwrap().iter().any(|v|v["id"]=="deepseek"));
    assert!(!calls.lock().unwrap().iter().any(|row|row["method"]=="github_usage"),
        "Dashboard Usage must not collect GitHub delivery/runtime telemetry");
    assert_eq!(
        data(call(&backend, "GET", "/api/decision-audit", None))
            .as_array()
            .unwrap()
            .len(),
        30
    );
    assert_eq!(
        data(call(&backend, "GET", "/api/runtime-summary", None))
            .get("jobs")
            .is_some(),
        false
    ); // Source schema is authoritative.
    fail_refresh.store(true, Ordering::Release);
    assert_eq!(
        call(&backend, "GET", "/api/jobs?refresh=1", None).status,
        502
    );
    // An ordinary poll can use the last known inventory if SQLite briefly
    // drops; explicit Refresh MUST report backend failure.
    assert_eq!(
        call(&backend, "GET", "/api/jobs?status=ACTIVE", None).status,
        200
    );
    let recorded = calls.lock().unwrap();
    assert!(recorded
        .iter()
        .any(|item| item["method"] == "discovered" && item["value"]["force"] == true));
}
#[test]
fn dashboard_commands_validate_before_invoking_sqlite_graph_actions() {
    let (backend, calls, _, _) = fixture();
    assert_eq!(call(&backend, "GET", "/api/control", None).status, 404);
    let command = json!({"command":"job.reconcile","jobId":"101"});
    assert_eq!(
        data(call(
            &backend,
            "POST",
            "/api/control",
            Some(command.clone())
        )),
        command
    );
    assert_eq!(
        call(
            &backend,
            "POST",
            "/api/task-command",
            Some(json!({"jobId":"101","action":"update"}))
        )
        .status,
        409
    );
    assert_eq!(
        data(call(
            &backend,
            "POST",
            "/api/task-action?id=101&task=2&action=retry",
            None
        ))["action"],
        "retry"
    );
    assert_eq!(
        call(
            &backend,
            "POST",
            "/api/task-action?id=101&task=2&action=execute",
            None
        )
        .status,
        404
    );
    assert_eq!(
        call(
            &backend,
            "POST",
            "/api/job-state?id=101&state=UNKNOWN",
            None
        )
        .status,
        404
    );
    assert_eq!(
        data(call(
            &backend,
            "POST",
            "/api/task-state?id=101&task=2&state=BLOCKED&repo=toy%2Frepo",
            None
        ))["target"]["repository"],
        "toy/repo"
    );
    assert_eq!(
        data(call(
            &backend,
            "POST",
            "/api/router-test",
            Some(json!({"jobId":"101","taskId":"2"}))
        ))["task"],
        "2"
    );
    assert_eq!(
        call(&backend, "POST", "/api/router-test", Some(json!({}))).status,
        400
    );
    assert_eq!(
        call(
            &backend,
            "PUT",
            "/api/execution-router-rules",
            Some(json!({"value":"large"}))
        )
        .status,
        200
    );
    assert!(calls
        .lock()
        .unwrap()
        .iter()
        .any(|item| item["method"] == "task_state"));
}

#[test]
fn mobile_http_redacts_jobs_and_scopes_task_activity_and_cancel(){
    let (backend,calls,_,_)=fixture();
    let listing=call(&backend,"GET","/api/mobile/jobs?offset=0&limit=1",None);
    assert_eq!(listing.status,200);
    assert_eq!(listing.cache_control,"no-store");
    let response=data(listing);
    assert_eq!(response["total"],3);
    assert_eq!(response["jobs"][0]["id"],"101");
    assert_eq!(response["jobs"][0]["repository"],"toy/repo");
    assert!(response["hasMore"].as_bool().unwrap());
    assert_eq!(response["nextOffset"],1);
    for bad in ["-1","1.5","21","nan","Infinity"]{
        let path=if bad=="21"{
            format!("/api/mobile/jobs?offset=0&limit={bad}")
        }else{format!("/api/mobile/jobs?offset={bad}&limit=20")};
        let response=call(&backend,"GET",&path,None);
        assert_eq!(response.status,409,"wrong paging {bad}");
        assert_eq!(data(response)["error"],"Invalid paging");
    }
    assert_eq!(call(&backend,"GET",
        "/api/mobile/job-tasks?id=101&repo=../wrong",None).status,404);
    assert_eq!(call(&backend,"GET",
        "/api/mobile/job-tasks?id=101&repo=other/repo",None).status,409);
    let tasks=data(call(&backend,"GET",
        "/api/mobile/job-tasks?id=101&repo=toy%2Frepo",None));
    assert_eq!(tasks["jobId"],"101");
    assert_eq!(tasks["repository"],"toy/repo");
    assert_eq!(tasks["tasks"],json!([]));
    let activity=data(call(&backend,"GET",
        "/api/mobile/job-activity?id=101&repo=toy%2Frepo",None));
    assert_eq!(activity["events"],json!([]));
    let before=calls.lock().unwrap().iter().filter(|row|
        row["method"]=="job_action").count();
    assert_eq!(call(&backend,"POST","/api/mobile/job-cancel",
        Some(json!({"id":"101","repository":"other/repo"}))).status,409);
    assert_eq!(calls.lock().unwrap().iter().filter(|row|
        row["method"]=="job_action").count(),before,
        "wrong owner must never call cancellation");
    assert_eq!(call(&backend,"POST","/api/mobile/job-pause",Some(json!({"id":"101","repository":"toy/repo"}))).status,409, "Unconfirmed pause is not success");
    let unverified=call(&backend,"POST","/api/mobile/job-cancel",
        Some(json!({"id":"101","repository":"toy/repo"})));
    assert_eq!(unverified.status,409,
        "HTTP success receipt is not proof of CANCELLED Graph/SQLite commit");
    assert_eq!(data(unverified)["error"],"CANCELLED readback not confirmed");
    assert_eq!(calls.lock().unwrap().iter().filter(|row|
        row["method"]=="job_action").count(),before+1);
    assert_eq!(call(&backend,"GET","/api/mobile/unknown",None).status,404);
}
#[test]
fn mobile_jel_returns_canonical_generator_and_only_scoped_lifecycle_facts(){
    let mut job=jobs()[1].clone();
    job["objective"]=json!("private objective");
    job["tasks"]=json!([{"id":"t1","title":"Review","agentName":"reviewer","state":"SUCCEEDED","attempt":1,"input":"private prompt","threadId":"private thread","executionHistory":[{"attempt":1,"startedAt":"2026-11-15T00:00:00Z","result":"private result"}]}]);
    let service=FixtureServices{report_fixture:Some(job),..Default::default()};
    let options=DashboardApiOptions{graph_directory:PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../workflow"),router_rules_path:std::env::temp_dir().join("mobile-jel-test"),troubleshooter_qa_path:PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../skills/agents-relay/troubleshooter-qa.md"),webhook_secret:None,webhook_repositories:HashSet::new(),webhook_job_id:None};
    let backend=NativeDashboardApi::new(options,service);
    let receipt=data(call(&backend,"GET","/api/mobile/job-jel?id=102&repo=toy%2Frepo",None));
    assert_eq!(receipt["schema"],"relay.jel.v1");assert_eq!(receipt["job"]["id"],"102");
    assert_eq!(receipt["generator"],include_str!("../../dashboard/jel-function.js").trim_end());
    assert_eq!(receipt["job"]["tasks"][0]["executionHistory"][0]["startedAt"],"2026-11-15T00:00:00Z");
    assert!(!receipt.to_string().contains("private "));
    assert_eq!(call(&backend,"GET","/api/mobile/job-jel?id=102&repo=other%2Frepo",None).status,409);
    assert_eq!(call(&backend,"POST","/api/mobile/job-jel?id=102&repo=toy%2Frepo",None).status,404);
    let (backend,_,_,_)=fixture();
    assert_eq!(call(&backend,"GET","/api/mobile/job-jel?id=101&repo=toy%2Frepo",None).status,409);
}

#[test]
fn mobile_pause_resume_use_scoped_control_and_require_durable_readback(){
    let service=FixtureServices{report_fixture:Some(jobs()[0].clone()),apply_pause_control:true,..Default::default()};
    let calls=service.calls.clone();
    let options=DashboardApiOptions{
        graph_directory:PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../workflow"),
        router_rules_path:std::env::temp_dir().join("mobile-pause-test"),
        troubleshooter_qa_path:PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../skills/agents-relay/troubleshooter-qa.md"),
        webhook_secret:None,webhook_repositories:HashSet::new(),webhook_job_id:None,
    };
    let backend=NativeDashboardApi::new(options,service);
    let body=json!({"id":"101","repository":"toy/repo"});
    assert_eq!(call(&backend,"POST","/api/mobile/job-resume",Some(body.clone())).status,409);
    assert_eq!(call(&backend,"POST","/api/mobile/job-pause",Some(json!({"id":"101","repository":"other/repo"}))).status,409);
    assert_eq!(call(&backend,"GET","/api/mobile/job-pause",None).status,404);
    let paused=data(call(&backend,"POST","/api/mobile/job-pause",Some(body.clone())));
    assert_eq!(paused["status"],"PAUSED");assert_eq!(paused["pausable"],false);assert_eq!(paused["recoverable"],true);
    assert_eq!(call(&backend,"POST","/api/mobile/job-pause",Some(body.clone())).status,409);
    let resumed=data(call(&backend,"POST","/api/mobile/job-resume",Some(body)));
    assert_eq!(resumed["pausable"],true);assert_eq!(resumed["recoverable"],false);
    let log=calls.lock().unwrap();let commands=log.iter().filter(|row|row["method"]=="control").map(|row|row["value"].clone()).collect::<Vec<_>>();
    assert_eq!(commands,vec![json!({"command":"job.pause","jobId":"101","repository":"toy/repo"}),json!({"command":"job.resume","jobId":"101","repository":"toy/repo"})]);
}

#[test]
fn mobile_http_cross_repo_collision_fails_closed_before_event_history_or_mutation(){
    let service=FixtureServices{
        duplicate_mobile_id:Arc::new(AtomicBool::new(true)),
        ..FixtureServices::default()
    };
    let calls=service.calls.clone();
    let options=DashboardApiOptions{
        graph_directory:PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../workflow"),
        router_rules_path:std::env::temp_dir().join(format!(
            "rust2-mobile-collision-{}",std::process::id())),
        troubleshooter_qa_path:PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../skills/agents-relay/troubleshooter-qa.md"),
        webhook_secret:None,webhook_repositories:HashSet::new(),
        webhook_job_id:None,
    };
    let backend=NativeDashboardApi::new(options,service);
    let response=call(&backend,"GET",
        "/api/mobile/job-activity?id=101&repo=toy%2Frepo",None);
    assert_eq!(response.status,409);
    assert_eq!(data(response)["error"],"Ambiguous Job ID");
    assert_eq!(call(&backend,"POST","/api/mobile/job-cancel",
        Some(json!({"id":"101","repository":"toy/repo"}))).status,409);
    assert_eq!(call(&backend,"POST","/api/mobile/job-pause",Some(json!({"id":"101","repository":"toy/repo"}))).status,409);
    let log=calls.lock().unwrap();
    assert!(!log.iter().any(|row|matches!(row["method"].as_str(),
        Some("events"|"job_action"|"control"))),
        "ambiguous ID cannot access another repository's events or cancellation");
}

#[test]
fn dashboard_qa_loads_saves_and_reloads_the_shared_skill_file(){
    let path=std::env::temp_dir().join(format!("relay-dashboard-qa-{}-{}.md",
        std::process::id(),std::time::SystemTime::now().duration_since(
            std::time::UNIX_EPOCH).unwrap().as_nanos()));
    std::fs::write(&path,"# Isolated guidance\n\nOriginal.\n").unwrap();
    let backend=NativeDashboardApi::new(DashboardApiOptions{
        graph_directory:PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../workflow"),
        router_rules_path:std::env::temp_dir().join("unused-qa-test-rules"),
        troubleshooter_qa_path:path.clone(),
        webhook_secret:None,webhook_repositories:HashSet::new(),webhook_job_id:None,
    },FixtureServices::default());
    let get=|method:&str,body:&[u8],headers:&HashMap<String,String>|backend.api(
        DashboardRequest{method,target:"/api/troubleshooter-qa",body,headers});
    let empty=HashMap::new();
    let loaded=get("GET",&[],&empty);
    assert_eq!(loaded.status,200);
    let loaded:Value=serde_json::from_slice(&loaded.body).unwrap();
    assert_eq!(loaded["text"],"# Isolated guidance\n\nOriginal.\n");
    let revised="# Isolated guidance\n\nSaved from Dashboard.\n";
    let mut headers=HashMap::new();
    headers.insert("content-type".into(),"application/json".into());
    let saved=get("PUT",json!({"text":revised,"hash":loaded["hash"]})
        .to_string().as_bytes(),&headers);
    assert_eq!(saved.status,200);
    let reloaded=get("GET",&[],&empty);
    let reloaded:Value=serde_json::from_slice(&reloaded.body).unwrap();
    assert_eq!(reloaded["text"],revised);
    assert_eq!(std::fs::read_to_string(&path).unwrap(),revised);
    assert_eq!(get("POST",&[],&empty).status,405);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn dashboard_default_qa_path_is_the_file_pinned_troubleshooter_reads(){
    let skill=agents_relay_rust2::runtime_resources::package_root().unwrap()
        .join("skills/agents-relay");
    assert_eq!(agents_relay_rust2::relayd::troubleshooter_qa_path().unwrap(),
        skill.join("troubleshooter-qa.md"));
    let agent=std::fs::read_to_string(skill.join("agents/troubleshooter.agent.md")).unwrap();
    assert!(agent.contains("Read `troubleshooter-qa.md` beside the Prompt-pinned Relay Skill"));
    assert!(agent.contains("guidance only, below current evidence and authoritative contracts"));
    assert!(agent.contains("absolute startup-contract `worker-lifecycle.md` path"));
    let contract=std::fs::canonicalize(skill.join("contracts/worker-lifecycle.md")).unwrap();
    let qa=contract.parent().unwrap().parent().unwrap().join("troubleshooter-qa.md");
    assert_eq!(qa,agents_relay_rust2::relayd::troubleshooter_qa_path().unwrap());
}
fn hmac_sha256(secret: &str, body: &[u8]) -> String {
    let mut key = [0u8; 64];
    let secret = secret.as_bytes();
    if secret.len() > 64 {
        key[..32].copy_from_slice(&Sha256::digest(secret));
    } else {
        key[..secret.len()].copy_from_slice(secret);
    }
    let mut inner = [0x36u8; 64];
    let mut outer = [0x5cu8; 64];
    for i in 0..64 {
        inner[i] ^= key[i];
        outer[i] ^= key[i];
    }
    let mut hash = Sha256::new();
    hash.update(inner);
    hash.update(body);
    let digest = hash.finalize();
    let mut hash = Sha256::new();
    hash.update(outer);
    hash.update(digest);
    format!(
        "sha256={}",
        hash.finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}
fn tcp(addr: &str, request: &str) -> (u16, Vec<u8>) {
    let mut stream = TcpStream::connect(addr).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    stream.write_all(request.as_bytes()).unwrap();
    let mut result = Vec::new();
    stream.read_to_end(&mut result).unwrap();
    let at = result
        .windows(4)
        .position(|bytes| bytes == b"\r\n\r\n")
        .unwrap()
        + 4;
    let headers = std::str::from_utf8(&result[..at]).unwrap();
    let status = headers
        .split_ascii_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    (status, result[at..].to_vec())
}
#[test]
fn actual_pwa_http_transport_preserves_bytes_and_authenticates_webhooks() {
    let (backend, calls, _, fail_webhook) = fixture();
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let addr = listener.local_addr().unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let server = {
        let cloned = backend.clone();
        let stop = stop.clone();
        thread::spawn(move || serve_dashboard(listener, cloned, stop).unwrap())
    };
    let url = addr.to_string();
    // Real native HTTP/TCP transport, not just a direct DashboardApi call.
    // Mobile pagination and scoped identity must stay redacted end to end.
    let (mobile_status,mobile_body)=tcp(&url,
        "GET /api/mobile/jobs?offset=0&limit=20 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    assert_eq!(mobile_status,200);
    let mobile:Value=serde_json::from_slice(&mobile_body).unwrap();
    assert_eq!(mobile["total"],3);
    assert_eq!(mobile["jobs"][0]["id"],"101");
    assert!(!mobile.to_string().contains("objective"));
    let (denied,_) = tcp(&url,
        "GET /api/mobile/job-tasks?id=101&repo=other%2Frepo HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    assert_eq!(denied,409);
    let (status, body) = tcp(&url, "GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
    assert_eq!(status, 200);
    // Node's PWA server now renders immutable versioned asset URLs.
    // Both native and Node must reuse the same single dashboard/ template.
    assert_eq!(
        body,
        agents_relay_rust2::dashboard::static_response("GET", "/")
            .unwrap().body,
        "native HTTP must serve exactly the canonical versioned PWA response"
    );
    let html=String::from_utf8(body).unwrap();
    for asset in ["dashboard.css","dashboard.js","vendor/markdown-it.min.js"]{
        assert!(html.contains(&format!("/{asset}?v={}",agents_relay_rust2::dashboard::dashboard_asset_version())));
    }
    let (status, body) = tcp(
        &url,
        "GET /dashboard.js HTTP/1.1\r\nHost: localhost\r\n\r\n",
    );
    assert_eq!(status, 200);
    assert_eq!(body, include_bytes!("../../dashboard/dashboard.js"));
    let (status, body) = tcp(
        &url,
        "GET /api/jobs?status=ACTIVE HTTP/1.1\r\nHost: localhost\r\n\r\n",
    );
    assert_eq!(status, 200);
    assert_eq!(serde_json::from_slice::<Value>(&body).unwrap()["total"], 1);
    let payload = json!({"action":"synchronize","repository":{"full_name":"toy/repo"},
        "pull_request":{"number":17,
            "head":{"ref":"refs/heads/feature","sha":"abcdef123456"}}})
    .to_string();
    let sign = hmac_sha256("local-fixture-secret", payload.as_bytes());
    let deliver = |signature: &str, delivery: &str| {
        let req=format!("POST /webhooks/github HTTP/1.1\r\nHost: localhost\r\n            X-GitHub-Event: pull_request\r\nX-GitHub-Delivery: {delivery}\r\n            X-Hub-Signature-256: {signature}\r\nContent-Length: {}\r\n\r\n{payload}",
            payload.len());
        tcp(&url, &req)
    };
    assert_eq!(deliver("sha256=invalid", "one").0, 401);
    fail_webhook.store(true, Ordering::Release);
    let (status, body) = deliver(&sign, "one");
    assert_eq!(status, 503, "{}", String::from_utf8_lossy(&body));
    let (status, body) = deliver(&sign, "one");
    assert_eq!(status, 202, "{}", String::from_utf8_lossy(&body));
    assert_eq!(std::str::from_utf8(&body).unwrap(), "Accepted");
    let (status, body) = deliver(&sign, "one");
    assert_eq!(status, 202);
    assert_eq!(std::str::from_utf8(&body).unwrap(), "Duplicate");
    let records = calls.lock().unwrap();
    assert_eq!(
        records
            .iter()
            .filter(|e| e["method"] == "github_webhook")
            .count(),
        2
    );
    drop(records);
    // Duplicate security-critical headers must fail closed.
    let request=format!("POST /webhooks/github HTTP/1.1\r\nHost: localhost\r\n        X-GitHub-Event: pull_request\r\nX-GitHub-Delivery: duplicate\r\n        X-Hub-Signature-256: {sign}\r\nX-Hub-Signature-256: {sign}\r\n        Content-Length: {}\r\n\r\n{payload}",payload.len());
    assert_eq!(tcp(&url, &request).0, 400);
    stop.store(true, Ordering::Release);
    server.join().unwrap();
}

// Explicit opt-in historical report UI acceptance. The Job snapshot is read
// through the installed Relay CLI; the native HTTP API uses only its snapshot.
// The real Neo report CLI remains read-only with respect to Relay Jobs.
#[test]
#[ignore = "requires explicit real historical Job and local Chrome"]
fn historical_execution_report_browser() {
    let id=std::env::var("RELAY_REPORT_TEST_JOB").expect("explicit Job ID");
    let repo=std::env::var("RELAY_REPORT_TEST_REPO").expect("explicit repository");
    let task=std::env::var("RELAY_REPORT_TEST_TASK").expect("explicit Task ID");
    let cli=std::env::var_os("NEO_RELAY_EXECUTABLE").unwrap_or_else(||"agents-relay".into());
    let output=std::process::Command::new(cli).args(["job","show","--repo",&repo,"--id",&id]).output().unwrap();
    assert!(output.status.success());
    let job:Value=serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(job["id"],id);
    assert_eq!(job["repository"],repo);
    assert!(job["tasks"].as_array().unwrap().iter().any(|t|t["id"]==task));
    let mut services=FixtureServices::default();
    services.report_fixture=Some(job);
    let options=DashboardApiOptions {
        graph_directory:PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../workflow"),
        router_rules_path:std::env::temp_dir().join("unused-report-browser-rules"),
        troubleshooter_qa_path:PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../skills/agents-relay/troubleshooter-qa.md"),
        webhook_secret:None,webhook_repositories:HashSet::new(),webhook_job_id:None,
    };
    let backend=Arc::new(NativeDashboardApi::new(options,services));
    let listener=TcpListener::bind(("127.0.0.1",0)).unwrap();
    let base=format!("http://{}",listener.local_addr().unwrap());
    let stop=Arc::new(AtomicBool::new(false));
    let server={let stop=stop.clone();thread::spawn(move||serve_dashboard(listener,backend,stop).unwrap())};
    let result=std::process::Command::new("node")
        .arg(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dashboard/tests/e2e/report-viewer.mjs"))
        .env("RELAY_REPORT_TEST_BASE",&base)
        .status();
    stop.store(true,Ordering::Release);
    server.join().unwrap();
    assert!(result.unwrap().success(),"real historical JEL report browser acceptance failed");
}
