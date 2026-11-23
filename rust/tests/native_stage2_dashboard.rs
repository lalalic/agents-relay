// Node provenance: src/dashboard.ts. Stage2 server-side validation migrated
// to the canonical shared PWA transport and injected native API adapter.
// No legacy alternate HTML server, production Store or network backend.
use agents_relay_rust2::{
    dashboard::{dashboard_config_script, dashboard_version, is_backend_route, static_response, DashboardBackend, DashboardRequest, DashboardResponse},
    dashboard_api::{DashboardApiOptions, DashboardApiServices, NativeDashboardApi},
};
use serde_json::{json, Value};
use std::{collections::{HashMap,HashSet},path::PathBuf,sync::{Arc,Mutex,mpsc::{self,Receiver}}};

#[derive(Default)]
struct FakeBackend {
    records:Arc<Mutex<Vec<Value>>>,
}
impl FakeBackend {
    fn record(&self,name:&str,value:Value)->Result<Value,String>{
        self.records.lock().map_err(|_|"poison")?.push(json!({"name":name,"value":value.clone()}));
        Ok(value)
    }
}
impl DashboardApiServices for FakeBackend {
    fn discovered_jobs(&mut self,_force:bool)->Result<Vec<Value>,String>{
        Ok(vec![json!({"id":"101","repository":"toy","title":"Alpha",
            "state":"ACTIVE","priority":"P2","createdAt":"2026-11-17T12:00:00.000Z",
            "updatedAt":"2026-11-17T12:00:00.000Z","tasks":[],"plans":[]})])
    }
    fn exact_job(&mut self,id:&str,_repo:Option<&str>)
        ->Result<Option<Value>,String>{
        Ok((id=="101").then(||json!({"id":id,"state":"ACTIVE","title":"Alpha"})))
    }
    fn control(&mut self,body:&Value)->Result<Value,String>{self.record("control",body.clone())}
    fn job_action(&mut self,job:&str,action:&str)->Result<Value,String>{
        self.record("job_action",json!({"job":job,"action":action}))
    }
    fn task_command(&mut self,body:&Value)->Result<Value,String>{
        self.record("task_command",body.clone())
    }
    fn task_action(&mut self,job:&str,task:&str,action:&str)->Result<Value,String>{
        self.record("task_action",json!({"job":job,"task":task,"action":action}))
    }
    fn job_set_state(&mut self,job:&str,state:&str,target:&Value)->Result<Value,String>{
        self.record("job_state",json!({"job":job,"state":state,"target":target}))
    }
    fn task_set_state(&mut self,job:&str,task:&str,state:&str,target:&Value)->Result<Value,String>{
        self.record("task_state",json!({"job":job,"task":task,"state":state,"target":target}))
    }
    fn events(&mut self,job:&str,task:Option<&str>,limit:i64)->Result<Vec<Value>,String>{
        Ok(vec![json!({"job_id":job,"task":task,"limit":limit})])
    }
    fn github_webhook(&mut self,event:&Value)->Result<(),String>{
        self.record("webhook",event.clone())?;Ok(())
    }
    fn router_test(&mut self,job:&str,task:&str)->Result<Value,String>{
        self.record("router_test",json!({"job":job,"task":task}))
    }
    fn decision_audit(&mut self)->Result<Vec<Value>,String>{
        Ok((0..40).map(|i|json!({"order":i})).collect())
    }
    fn runtime_status(&mut self)->Value{json!({"healthy":true})}
    fn account_usage(&mut self)->Result<Value,String>{Ok(json!({"providers":[]}))}
    fn github_usage(&mut self)->Result<Option<Value>,String>{Ok(None)}
    fn subscribe_events(&mut self)->Receiver<String>{mpsc::channel().1}
}
fn fixture()->(NativeDashboardApi<FakeBackend>,Arc<Mutex<Vec<Value>>>){
    let backend=FakeBackend::default();let records=backend.records.clone();
    let opts=DashboardApiOptions {
        graph_directory:PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../workflow"),
        router_rules_path:std::env::temp_dir().join(format!("stage2-dashboard-rules-{}",std::process::id())),
        webhook_secret:None,webhook_repositories:HashSet::new(),
        webhook_job_id:None,
    };
    (NativeDashboardApi::new(opts,backend),records)
}
fn handle(server:&NativeDashboardApi<FakeBackend>,method:&str,url:&str,body:Option<Value>)->DashboardResponse {
    let bytes=body.map(|v|v.to_string().into_bytes()).unwrap_or_default();
    server.api(DashboardRequest{method,target:url,body:&bytes,headers:&HashMap::new()})
}
fn data(reply:DashboardResponse)->Value{
    serde_json::from_slice(&reply.body).unwrap()
}
#[test]
fn server_uses_exact_original_pwa_assets_with_no_second_frontend() {
    let response=static_response("GET","/").unwrap();
    assert_eq!(response.status,200);
    assert_eq!(response.content_type,"text/html; charset=utf-8");
    let html=String::from_utf8(response.body).unwrap();
    for asset in ["dashboard.css","dashboard.js","vendor/markdown-it.min.js"]{
        assert!(html.contains(&format!("/{asset}?v={}",dashboard_version())));
    }
    assert!(static_response("POST","/").is_none());
    assert!(static_response("GET","/../../secret").is_none());
    assert!(static_response("GET","/dashboard.js").is_some());
    assert!(static_response("GET","/service-worker.js").is_some());
}
#[test]
fn control_requires_supported_mutations_and_returns_exact_ack() {
    let (server,records)=fixture();
    assert_eq!(handle(&server,"GET","/api/control",None).status,404);
    assert_eq!(handle(&server,"POST","/api/control",
        Some(json!({"command":"job.reconcile","jobId":"101"}))).status,200);
    assert_eq!(handle(&server,"POST","/api/task-command",
        Some(json!({"jobId":"101","action":"unknown"}))).status,409);
    let result=data(handle(&server,"POST","/api/task-action?id=101&task=9&action=retry",None));
    assert_eq!(result,json!({"job":"101","task":"9","action":"retry"}));
    assert_eq!(handle(&server,"POST","/api/task-action?id=101&task=9&action=merge",None).status,404);
    assert_eq!(handle(&server,"POST","/api/task-state?id=101&task=9&state=INJECTED",None).status,404);
    assert_eq!(data(handle(&server,"POST","/api/job-action?id=101&action=start",None)),
        json!({"job":"101","action":"start"}));
    assert_eq!(records.lock().unwrap().len(),3);
}
#[test]
fn readonly_endpoints_are_fresh_and_webhook_fails_closed(){
    let (server,records)=fixture();
    let version=static_response("GET","/api/version").unwrap();
    assert_eq!(version.status,200);
    assert_eq!(version.cache_control,"no-store");
    assert_eq!(data(version),json!({"version":dashboard_version()}));
    assert_eq!(data(handle(&server,"GET","/api/job?id=101",None)),
        json!({"id":"101","state":"ACTIVE","title":"Alpha"}));
    assert_eq!(data(handle(&server,"GET","/api/events?job=101&task=2&limit=7",None)),
        json!([{"job_id":"101","task":"2","limit":7}]));
    assert_eq!(handle(&server,"GET","/api/events?job=bad%20id",None).status,400);
    assert_eq!(handle(&server,"POST","/webhooks/github",Some(json!({}))).status,401);
    assert_eq!(data(handle(&server,"GET","/api/status",None)),json!({"healthy":true}));
    let audits=data(handle(&server,"GET","/api/decision-audit",None));
    assert_eq!(audits.as_array().unwrap().len(),30);
    assert_eq!(audits[0]["order"],json!(39));
    assert_eq!(data(handle(&server,"POST","/api/router-test",
        Some(json!({"jobId":"101","taskId":"2"})))),
        json!({"job":"101","task":"2"}));
    assert_eq!(records.lock().unwrap().len(),1);
}
#[test]
fn sse_is_never_cached_and_never_reinterpreted_as_a_task_receipt(){
    assert!(static_response("GET","/events").is_none());
    assert!(!is_backend_route("GET","/events"));
    assert!(is_backend_route("GET","/api/events?job=101"));
    assert_eq!(static_response("GET","/dashboard-config.js").unwrap().cache_control,"no-store");
    assert!(dashboard_config_script().contains("buildJelDiagram"));
    // The TCP SSE framing, heartbeats and live event forwarding are tested
    // in native_dashboard_pwa.rs with an actual ephemeral event receiver.
}
