// Node provenance: src/dashboard.ts server routes. Exercise the new native
// Rust HTTP handler with a disposable backend and exact unchanged client asset.
// No browser HTML/CSS/JS source, live service, or production SQLite is touched.
use agents_relay_rust2::dashboard::{
    DashboardBackend,DashboardOptions,DashboardServer,HttpRequest,HttpResponse,
};
use serde_json::{json,Value};
use std::{
    collections::{HashMap,HashSet},
    fs,path::PathBuf,
    sync::{Arc,Mutex},time::{SystemTime,UNIX_EPOCH},
};
#[derive(Default)]
struct FakeBackend{
    records:Arc<Mutex<Vec<Value>>>,
}
impl FakeBackend{
    fn record(&self,name:&str,value:Value)->Result<Value,String>{
        self.records.lock().map_err(|_|"poison")?
            .push(json!({"name":name,"value":value.clone()}));
        Ok(value)
    }
}
impl DashboardBackend for FakeBackend{
    fn discovered_jobs(&mut self,_force:bool)->Result<Vec<Value>,String>{
        Ok(vec![json!({"id":"101","repository":"toy","title":"Alpha",
            "state":"ACTIVE","priority":"P2","createdAt":"2026-11-17T12:00:00.000Z",
            "updatedAt":"2026-11-17T12:00:00.000Z","tasks":[],"plans":[]})])
    }
    fn exact_job(&mut self,id:&str,_repo:Option<&str>,_pr:Option<u64>)
        ->Result<Option<Value>,String>{
        Ok((id=="101").then(||json!({"id":id,"state":"ACTIVE","title":"Alpha"})))
    }
    fn control(&mut self,body:&Value)->Result<Value,String>{
        self.record("control",body.clone())
    }
    fn job_action(&mut self,job:&str,action:&str)->Result<Value,String>{
        self.record("job_action",json!({"job":job,"action":action}))
    }
    fn task_command(&mut self,body:&Value)->Result<Value,String>{
        self.record("task_command",body.clone())
    }
    fn task_action(&mut self,job:&str,task:&str,action:&str)
        ->Result<Value,String>{
        self.record("task_action",json!({"job":job,"task":task,"action":action}))
    }
    fn job_set_state(&mut self,job:&str,state:&str,target:&Value)
        ->Result<Value,String>{
        self.record("job_state",json!({"job":job,"state":state,"target":target}))
    }
    fn task_set_state(&mut self,job:&str,task:&str,state:&str,target:&Value)
        ->Result<Value,String>{
        self.record("task_state",json!({
            "job":job,"task":task,"state":state,"target":target}))
    }
    fn events(&mut self,job:&str,task:Option<&str>,limit:i64)
        ->Result<Vec<Value>,String>{
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
}
fn request(method:&str,url:&str,body:Option<Value>)->HttpRequest{
    HttpRequest{method:method.into(),url:url.into(),
        headers:HashMap::new(),body:body.map(|body|body.to_string().into_bytes())
            .unwrap_or_default()}
}
fn data(response:HttpResponse)->Value{
    serde_json::from_slice(&response.body).unwrap()
}
fn fixture()->(DashboardServer<FakeBackend>,PathBuf,Arc<Mutex<Vec<Value>>>,Vec<u8>){
    let root=std::env::temp_dir().join(format!(
        "rust2-native-dashboard-{}-{}",
        std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH)
            .unwrap().as_nanos()));
    fs::create_dir_all(&root).unwrap();
    let asset=root.join("dashboard.html");
    let bytes=b"<!doctype html>\n<html><body>\xc3\xa9<script>window.__original = true;</script></body></html>\n".to_vec();
    fs::write(&asset,&bytes).unwrap();
    let backend=FakeBackend::default();
    let records=backend.records.clone();
    let server=DashboardServer::new(DashboardOptions{
        client_asset_path:asset,
        dashboard_version:"source-only-test".into(),
        graph_directory:PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../workflow"),
        router_rules_path:root.join("rules.md"),
        webhook_secret:None,
        webhook_repositories:HashSet::new(),
        webhook_job_id:None,
        webhook_pr_number:None,
    },backend);
    (server,root,records,bytes)
}
#[test]
fn server_uses_unchanged_html_and_rejects_non_get(){
    let (server,dir,records,bytes)=fixture();
    let page=server.handle(&request("GET","/",None));
    assert_eq!(page.status,200);
    assert_eq!(page.content_type,"text/html; charset=utf-8");
    assert_eq!(page.body,bytes);
    assert_eq!(server.handle(&request("POST","/",None)).status,405);
    assert!(records.lock().unwrap().is_empty());
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn control_requires_supported_mutations_and_returns_exact_ack(){
    let (server,dir,records,_)=fixture();
    assert_eq!(server.handle(&request("GET","/api/control",None)).status,404);
    assert_eq!(server.handle(&request("POST","/api/control",
        Some(json!({"command":"job.reconcile","jobId":"101"})))).status,200);
    assert_eq!(server.handle(&request("POST",
        "/api/task-command",Some(json!({"jobId":"101","action":"unknown"})))).status,409);
    let action=data(server.handle(&request("POST",
        "/api/task-action?id=101&task=9&action=retry",None)));
    assert_eq!(action,json!({"job":"101","task":"9","action":"retry"}));
    assert_eq!(server.handle(&request("POST",
        "/api/task-action?id=101&task=9&action=merge",None)).status,404);
    assert_eq!(server.handle(&request("POST",
        "/api/task-state?id=101&task=9&state=INJECTED",None)).status,404);
    assert_eq!(data(server.handle(&request("POST",
        "/api/job-action?id=101&action=start",None))),
        json!({"job":"101","action":"start"}));
    assert_eq!(records.lock().unwrap().len(),3);
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn readonly_endpoints_are_fresh_and_webhook_fails_closed(){
    let (server,dir,records,_)=fixture();
    let version=server.handle(&request("GET","/api/version",None));
    assert_eq!(version.status,200);
    assert_eq!(version.headers.get("Cache-Control").map(String::as_str),Some("no-store"));
    assert_eq!(data(version),json!({"version":"source-only-test"}));
    assert_eq!(data(server.handle(&request("GET","/api/job?id=101",None))),
        json!({"id":"101","state":"ACTIVE","title":"Alpha"}));
    assert_eq!(data(server.handle(&request("GET","/api/events?job=101&task=2&limit=7",None))),
        json!([{"job_id":"101","task":"2","limit":7}]));
    assert_eq!(server.handle(&request("GET","/api/events?job=bad%20id",None)).status,400);
    assert_eq!(server.handle(&request("POST","/webhooks/github",Some(json!({})))).status,401);
    assert_eq!(data(server.handle(&request("GET","/api/status",None))),
        json!({"healthy":true}));
    let history=data(server.handle(&request("GET","/api/decision-audit",None)));
    assert_eq!(history.as_array().unwrap().len(),30);
    assert_eq!(history[0]["order"],json!(39));
    assert_eq!(data(server.handle(&request("POST","/api/router-test",
        Some(json!({"jobId":"101","taskId":"2"}))))),
        json!({"job":"101","task":"2"}));
    assert_eq!(records.lock().unwrap().len(),1);
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn sse_is_not_a_terminal_worker_acknowledgement(){
    let (server,dir,_,_)=fixture();
    let response=server.handle(&request("GET","/events",None));
    assert_eq!(response.status,200);
    assert_eq!(response.content_type,"text/event-stream");
    assert_eq!(response.body,b": connected\n\n");
    assert!(response.keep_stream);
    assert_eq!(response.headers.get("Cache-Control").map(String::as_str),Some("no-cache"));
    fs::remove_dir_all(dir).unwrap();
}
