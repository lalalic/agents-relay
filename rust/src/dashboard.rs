// Head-to-head Phase1 port: src/dashboard.ts (SERVER SIDE ONLY).
// The Dashboard HTML/CSS/browser JavaScript is an immutable prebuilt asset.
// This module never translates, edits, replaces or generates client-side UI.
// HTTP, SSE, webhook identity and actions remain server-owned capabilities.
use crate::{
    dashboard_data::{
        dashboard_workflow_graphs,effective_github_usage,
        event_history,list_dashboard_job_inventory,search_dashboard_jobs,
    },
    dashboard_workflow_inspection::inspect_workflow_symbol,
    github_webhook::{verify_github_webhook,parse_github_webhook},
    routing_policy::{load_execution_router_rules,save_execution_router_rules},
    runtime_summary::summarize_runtime,
};
use chrono::Utc;
use regex::Regex;
use serde_json::{json,Value};
use std::{
    collections::{HashMap,HashSet,VecDeque},fs,
    io::{BufRead,BufReader,Read,Write},
    net::{TcpListener,TcpStream},path::{Path,PathBuf},
    sync::{Arc,Mutex,atomic::{AtomicBool,Ordering}},
    time::Duration,
};
use url::Url;

pub const SSE_HEARTBEAT_MS:u64=15_000;
pub const MAX_HTTP_BODY:usize=1_048_576;
pub const MAX_ROUTER_RULES_BODY:usize=65_536;
fn field<'a>(value:&'a Value,key:&str)->&'a str{
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
pub struct HttpRequest{
    pub method:String,pub url:String,
    pub headers:HashMap<String,String>,pub body:Vec<u8>,
}
pub struct HttpResponse{
    pub status:u16,pub content_type:String,pub body:Vec<u8>,
    pub headers:HashMap<String,String>,
    pub keep_stream:bool,
}
impl HttpResponse{
    pub fn text(status:u16,text:impl Into<String>)->Self{
        Self{status,content_type:"text/plain; charset=utf-8".into(),
            body:text.into().into_bytes(),headers:HashMap::new(),
            keep_stream:false}
    }
    pub fn json(status:u16,value:&Value)->Self{
        Self{status,content_type:"application/json".into(),
            body:value.to_string().into_bytes(),headers:HashMap::new(),
            keep_stream:false}
    }
    pub fn no_cache(mut self)->Self{
        self.headers.insert("Cache-Control".into(),"no-store".into());self
    }
    pub fn stream()->Self{
        let mut response=Self::text(200,": connected\n\n");
        response.content_type="text/event-stream".into();
        response.headers.insert("Cache-Control".into(),"no-cache".into());
        response.headers.insert("Connection".into(),"keep-alive".into());
        response.keep_stream=true;response
    }
}
pub trait DashboardBackend:Send{
    fn discovered_jobs(&mut self,force:bool)->Result<Vec<Value>,String>;
    fn exact_job(&mut self,job_id:&str,repo:Option<&str>,pr:Option<u64>)
        ->Result<Option<Value>,String>;
    fn control(&mut self,body:&Value)->Result<Value,String>;
    fn job_action(&mut self,job_id:&str,action:&str)->Result<Value,String>;
    fn task_command(&mut self,body:&Value)->Result<Value,String>;
    fn task_action(&mut self,job_id:&str,task_id:&str,action:&str)
        ->Result<Value,String>;
    fn job_set_state(&mut self,job_id:&str,state:&str,target:&Value)
        ->Result<Value,String>;
    fn task_set_state(&mut self,job_id:&str,task_id:&str,state:&str,
        target:&Value)->Result<Value,String>;
    fn events(&mut self,job_id:&str,task_id:Option<&str>,limit:i64)
        ->Result<Vec<Value>,String>;
    fn github_webhook(&mut self,event:&Value)->Result<(),String>;
    fn router_test(&mut self,job_id:&str,task_id:&str)->Result<Value,String>;
    fn decision_audit(&mut self)->Result<Vec<Value>,String>;
    fn runtime_status(&mut self)->Value;
    fn account_usage(&mut self)->Result<Value,String>;
    fn github_usage(&mut self)->Result<Option<Value>,String>;
}
fn safe_id(value:&str)->bool{
    Regex::new(r"^[A-Za-z0-9_.-]+$").expect("static Job identity").is_match(value)
}
fn query(parsed:&Url,key:&str)->Option<String>{
    parsed.query_pairs().find(|(name,_)|name==key).map(|(_,v)|v.into_owned())
}
fn target(parsed:&Url)->Value{
    let pr=query(parsed,"pr").and_then(|v|v.parse::<u64>().ok())
        .filter(|n|*n>0);
    json!({"repository":query(parsed,"repo"),"prNumber":pr})
}
fn post_json(req:&HttpRequest)->Result<Value,String>{
    serde_json::from_slice::<Value>(&req.body)
        .map_err(|e|format!("Invalid request body: {e}"))
}
fn allow(req:&HttpRequest,method:&str)->bool{
    req.method==method
}
#[derive(Clone)]
pub struct DashboardOptions{
    pub client_asset_path:PathBuf,
    pub dashboard_version:String,
    pub graph_directory:PathBuf,
    pub router_rules_path:PathBuf,
    pub webhook_secret:Option<String>,
    pub webhook_repositories:HashSet<String>,
    pub webhook_job_id:Option<String>,
    pub webhook_pr_number:Option<u64>,
}
pub struct DashboardServer<B:DashboardBackend>{
    options:DashboardOptions,
    backend:Arc<Mutex<B>>,
    webhook_deduper:Arc<Mutex<VecDeque<String>>>,
    stream_clients:Arc<Mutex<Vec<TcpStream>>>,
    recent_jobs:Arc<Mutex<Option<Vec<Value>>>>,
}
impl<B:DashboardBackend> DashboardServer<B>{
    pub fn new(options:DashboardOptions,backend:B)->Self{
        Self{options,backend:Arc::new(Mutex::new(backend)),
            webhook_deduper:Arc::new(Mutex::new(VecDeque::new())),
            stream_clients:Arc::new(Mutex::new(Vec::new())),
            recent_jobs:Arc::new(Mutex::new(None))}
    }
    fn jobs(&self,backend:&mut B,force:bool)->Result<Vec<Value>,String>{
        match backend.discovered_jobs(force){
            Ok(jobs)=>{
                *self.recent_jobs.lock().map_err(|_|"Dashboard cache poisoned")?
                    =Some(jobs.clone());
                Ok(jobs)
            },
            Err(error)=>{
                if force{return Err(error);}
                self.recent_jobs.lock().map_err(|_|"Dashboard cache poisoned")?
                    .clone().ok_or(error)
            },
        }
    }
    fn webhook(&self,backend:&mut B,req:&HttpRequest)
        ->HttpResponse{
        let Some(secret)=self.options.webhook_secret.as_deref()else{
            return HttpResponse::text(401,"Invalid signature");
        };
        let signature=req.headers.get("x-hub-signature-256")
            .map(String::as_str);
        if !verify_github_webhook(secret,&req.body,signature){
            return HttpResponse::text(401,"Invalid signature");
        }
        let headers=json!(req.headers);
        let Some(event)=parse_github_webhook(&headers,&req.body)else{
            return HttpResponse::text(202,"Ignored");
        };
        let repo=field(&event,"repository");
        let delivery=field(&event,"deliveryId");
        if !self.options.webhook_repositories.contains(repo)
            ||self.options.webhook_job_id.as_ref().is_some_and(|id|
                event.get("jobId").and_then(Value::as_str)
                    .is_some_and(|actual|actual!=id))
            ||self.options.webhook_pr_number.is_some_and(|pr|
                event.get("pullRequest").and_then(Value::as_u64)
                    .is_some_and(|actual|actual!=pr)){
            return HttpResponse::text(202,"Ignored");
        }
        if self.webhook_deduper.lock().ok().is_some_and(|dedupe|
            dedupe.contains(&delivery.to_string())){
            return HttpResponse::text(202,"Duplicate");
        }
        if backend.github_webhook(&event).is_err(){
            // A 202 must not acknowledge a webhook whose durable SQLite
            // delivery failed; GitHub is allowed to retry on 503.
            return HttpResponse::text(503,
                "Webhook handling unavailable; redelivery required");
        }
        if let Ok(mut dedupe)=self.webhook_deduper.lock(){
            if !delivery.is_empty(){dedupe.push_back(delivery.into());}
            while dedupe.len()>1000{dedupe.pop_front();}
        }
        HttpResponse::text(202,"Accepted")
    }
    pub fn handle(&self,req:&HttpRequest)->HttpResponse{
        let endpoint=format!("http://127.0.0.1{}",req.url);
        let parsed=match Url::parse(&endpoint){
            Ok(value)=>value,
            Err(_)=>return HttpResponse::text(400,"Invalid URL")
        };
        let path=parsed.path();
        let mut backend=match self.backend.lock(){
            Ok(backend)=>backend,
            Err(_)=>return HttpResponse::text(503,"Dashboard backend unavailable")
        };
        let result=(||->Result<HttpResponse,String>{
            Ok(match path{
                "/"=>{
                    if !allow(req,"GET"){return Ok(HttpResponse::text(405,"Method not allowed"));}
                    // Serve EXACT unchanged client-side bytes. The original
                    // Dashboard asset is built by the TypeScript build path.
                    let asset=fs::read(&self.options.client_asset_path)
                        .map_err(|e|format!("Unchanged Dashboard asset unavailable: {e}"))?;
                    HttpResponse{status:200,content_type:
                        "text/html; charset=utf-8".into(),body:asset,
                        headers:HashMap::new(),keep_stream:false}
                },
                "/api/version"=>HttpResponse::json(200,
                    &json!({"version":self.options.dashboard_version})).no_cache(),
                "/api/graph-symbol"=>{
                    if !allow(req,"GET"){return Ok(HttpResponse::text(405,"Method not allowed"));}
                    let symbol=inspect_workflow_symbol(
                        &self.options.graph_directory,
                        query(&parsed,"graph").as_deref().unwrap_or(""),
                        query(&parsed,"kind").as_deref().unwrap_or(""),
                        query(&parsed,"name").as_deref().unwrap_or(""));
                    HttpResponse::json(if symbol.is_some(){200}else{404},
                        &symbol.unwrap_or(json!({"error":"No canonical graph symbol found"})))
                        .no_cache()
                },
                "/api/graphs"=>HttpResponse::json(200,
                    &json!(dashboard_workflow_graphs(&self.options.graph_directory)?))
                    .no_cache(),
                "/api/troubleshooter-qa"=>
                    HttpResponse::text(503,"Troubleshooter QA requires the service-backed handler"),
                "/webhooks/github"=>{
                    if !allow(req,"POST"){return Ok(HttpResponse::text(405,"Method not allowed"));}
                    self.webhook(&mut backend,req)
                },
                "/api/jobs"=>{
                    let force=query(&parsed,"refresh").as_deref()==Some("1");
                    let jobs=self.jobs(&mut backend,force)?;
                    let response=if query(&parsed,"inventory").as_deref()==Some("1"){
                        list_dashboard_job_inventory(&jobs,
                            query(&parsed,"repo").as_deref().unwrap_or(""))
                    }else{search_dashboard_jobs(&jobs,parsed.query().unwrap_or(""))};
                    HttpResponse::json(200,&response).no_cache()
                },
                "/api/job"=>{
                    let id=query(&parsed,"id");
                    let candidates=self.jobs(&mut backend,false)?;
                    let id=id.or_else(||candidates.first()
                        .and_then(|job|job.get("id")).and_then(Value::as_str)
                        .map(str::to_owned)).ok_or("Managed job not found")?;
                    let t=target(&parsed);
                    let found=backend.exact_job(&id,
                        t.get("repository").and_then(Value::as_str),
                        t.get("prNumber").and_then(Value::as_u64))?;
                    HttpResponse::json(200,&found.or_else(||
                        candidates.into_iter().find(|job|field(job,"id")==id))
                        .ok_or("Managed job not found")?)
                },
                "/api/events"=>{
                    let id=query(&parsed,"job").unwrap_or_default();
                    if !safe_id(&id){return Ok(HttpResponse::text(400,"Invalid job id"));}
                    let limit=query(&parsed,"limit")
                        .and_then(|v|v.parse::<i64>().ok()).unwrap_or(60);
                    HttpResponse::json(200,&json!(backend.events(&id,
                        query(&parsed,"task").as_deref(),limit)?))
                },
                "/api/status"=>HttpResponse::json(200,&backend.runtime_status()),
                "/api/usage"=>{
                    let registry=backend.account_usage()?;
                    let status=backend.runtime_status();
                    let github=backend.github_usage().ok().flatten();
                    let mut output=registry;
                    if let Some(obj)=output.as_object_mut(){
                        obj.insert("githubEffective".into(),json!(
                            effective_github_usage(github.as_ref(),
                                status.get("runtimeRateUsage"))));
                        obj.insert("githubStatus".into(),status);
                    }
                    HttpResponse::json(200,&output)
                },
                "/api/runtime-summary"=>HttpResponse::json(200,
                    &summarize_runtime(&self.jobs(&mut backend,false)?,
                        Utc::now().timestamp_millis())),
                "/api/decision-audit"=>{
                    if !allow(req,"GET"){return Ok(HttpResponse::text(405,"Method not allowed"));}
                    let mut records=backend.decision_audit()?;
                    records.reverse();records.truncate(30);
                    HttpResponse::json(200,&json!(records))
                },
                "/api/router-test"=>{
                    if !allow(req,"POST"){return Ok(HttpResponse::text(405,"Method not allowed"));}
                    let body=post_json(req)?;
                    let (job,task)=(field(&body,"jobId"),field(&body,"taskId"));
                    if job.is_empty()||task.is_empty(){
                        return Ok(HttpResponse::text(400,"Select a Job and Task first"));
                    }
                    HttpResponse::json(200,&backend.router_test(job,task)?)
                },
                "/api/execution-router-rules"=>{
                    if allow(req,"GET"){
                        HttpResponse::json(200,&load_execution_router_rules(
                            &self.options.router_rules_path.to_string_lossy()))
                    }else if allow(req,"PUT"){
                        if req.body.len()>MAX_ROUTER_RULES_BODY{
                            return Ok(HttpResponse::text(413,"Execution router rules exceed 64 KiB"));
                        }
                        let text=std::str::from_utf8(&req.body).map_err(|e|e.to_string())?;
                        HttpResponse::json(200,&save_execution_router_rules(text,
                            &self.options.router_rules_path.to_string_lossy())?)
                    }else{return Ok(HttpResponse::text(405,"Method not allowed"));}
                },
                "/api/control"=>{
                    if !allow(req,"POST"){return Ok(HttpResponse::text(404,"Control API unavailable"));}
                    HttpResponse::json(200,&backend.control(&post_json(req)?)?)
                },
                "/api/task-command"=>{
                    if !allow(req,"POST"){return Ok(HttpResponse::text(404,"Task command unavailable"));}
                    let body=post_json(req)?;
                    if !safe_id(field(&body,"jobId"))||
                        !matches!(field(&body,"action"),"create"|"update"|"retry"|"cancel"){
                        return Ok(HttpResponse::text(409,"Task command unavailable"));
                    }
                    HttpResponse::json(200,&backend.task_command(&body)?)
                },
                "/api/job-action"=>{
                    let id=query(&parsed,"id").unwrap_or_default();
                    let action=query(&parsed,"action").unwrap_or_default();
                    if !allow(req,"POST")||!safe_id(&id)
                        ||!matches!(action.as_str(),"start"|"reconcile"|"cancel"){
                        return Ok(HttpResponse::text(404,"Job action unavailable"));
                    }
                    HttpResponse::json(200,&backend.job_action(&id,&action)?)
                },
                "/api/task-action"=>{
                    let id=query(&parsed,"id").unwrap_or_default();
                    let task=query(&parsed,"task").unwrap_or_default();
                    let action=query(&parsed,"action").unwrap_or_default();
                    if !allow(req,"POST")||!safe_id(&id)||task.is_empty()
                        ||!matches!(action.as_str(),"retry"|"cancel"){
                        return Ok(HttpResponse::text(404,"Task action unavailable"));
                    }
                    HttpResponse::json(200,&backend.task_action(&id,&task,&action)?)
                },
                "/api/job-state"=>{
                    let id=query(&parsed,"id").unwrap_or_default();
                    let state=query(&parsed,"state").unwrap_or_default();
                    if !allow(req,"POST")||!safe_id(&id)
                        ||!matches!(state.as_str(),"DRAFT"|"ACTIVE"|"COMPLETED"|"CANCELLED"){
                        return Ok(HttpResponse::text(404,"Job state override unavailable"));
                    }
                    HttpResponse::json(200,&backend.job_set_state(&id,&state,&target(&parsed))?)
                },
                "/api/task-state"=>{
                    let id=query(&parsed,"id").unwrap_or_default();
                    let task=query(&parsed,"task").unwrap_or_default();
                    let state=query(&parsed,"state").unwrap_or_default();
                    if !allow(req,"POST")||!safe_id(&id)||task.is_empty()
                        ||!matches!(state.as_str(),"DRAFT"|"QUEUED"|"RUNNING"|
                            "AWAITING_DECISION"|"BLOCKED"|"SUCCEEDED"|"FAILED"|"CANCELLED"){
                        return Ok(HttpResponse::text(404,"Task state override unavailable"));
                    }
                    HttpResponse::json(200,&backend.task_set_state(
                        &id,&task,&state,&target(&parsed))?)
                },
                "/events"=>HttpResponse::stream(),
                _=>HttpResponse::text(404,"Not found"),
            })
        })();
        match result{
            Ok(value)=>value,
            Err(error)=>{
                let status=if path=="/api/job"{404}
                    else if path=="/api/usage"{503}
                    else if matches!(path,"/api/control"|"/api/task-command"|
                        "/api/job-action"|"/api/task-action"|"/api/job-state"|
                        "/api/task-state"){409}
                    else{502};
                HttpResponse::text(status,error)
            }
        }
    }
    pub fn broadcast_job(&self,job:&Value){
        self.send_sse(&format!("data: {}\n\n",
            json!({"job":job})));
    }
    pub fn broadcast_event(&self,event:&Value){
        self.send_sse(&format!("event: relay\ndata: {}\n\n",
            json!({"event":event})));
    }
    pub fn heartbeat(&self){self.send_sse(": heartbeat\n\n");}
    fn send_sse(&self,message:&str){
        if let Ok(mut clients)=self.stream_clients.lock(){
            clients.retain_mut(|stream|stream.write_all(message.as_bytes()).is_ok());
        }
    }
    fn respond(stream:&mut TcpStream,response:&HttpResponse)
        ->Result<(),String>{
        let reason=match response.status{
            200=>"OK",202=>"Accepted",400=>"Bad Request",401=>"Unauthorized",
            404=>"Not Found",405=>"Method Not Allowed",409=>"Conflict",
            413=>"Payload Too Large",500=>"Internal Server Error",
            502=>"Bad Gateway",503=>"Service Unavailable",_=>"Status"
        };
        let mut headers=format!("HTTP/1.1 {} {}\r\nContent-Type: {}\r\n",
            response.status,reason,response.content_type);
        if !response.keep_stream{
            headers.push_str(&format!("Content-Length: {}\r\n",
                response.body.len()));
            headers.push_str("Connection: close\r\n");
        }
        for (key,value) in &response.headers{
            headers.push_str(&format!("{key}: {value}\r\n"));
        }
        headers.push_str("\r\n");
        stream.write_all(headers.as_bytes()).map_err(|e|e.to_string())?;
        stream.write_all(&response.body).map_err(|e|e.to_string())
    }
    fn parse_request(stream:&TcpStream)->Result<HttpRequest,String>{
        let mut reader=BufReader::new(stream);
        let mut line=String::new();
        reader.read_line(&mut line).map_err(|e|e.to_string())?;
        if line.len()>8192{return Err("Request line too long".into());}
        let pieces=line.trim_end().split_ascii_whitespace()
            .map(str::to_owned).collect::<Vec<_>>();
        if pieces.len()!=3{return Err("Malformed HTTP request".into());}
        let mut headers=HashMap::new();
        loop{
            line.clear();
            reader.read_line(&mut line).map_err(|e|e.to_string())?;
            if line=="\r\n"||line=="\n"{break;}
            if line.len()>8192||headers.len()>100{
                return Err("Request headers too large".into());
            }
            let (name,value)=line.split_once(':')
                .ok_or("Malformed HTTP header")?;
            headers.insert(name.trim().to_ascii_lowercase(),
                value.trim().to_owned());
        }
        let length=headers.get("content-length")
            .map(|v|v.parse::<usize>().map_err(|e|e.to_string()))
            .transpose()?.unwrap_or(0);
        if length>MAX_HTTP_BODY{return Err("Request body too large".into());}
        let mut body=vec![0u8;length];
        reader.read_exact(&mut body).map_err(|e|e.to_string())?;
        Ok(HttpRequest{method:pieces[0].clone(),url:pieces[1].clone(),
            headers,body})
    }
    /// Caller-owned stop signal. No serve() call is made during Phase1.
    pub fn serve(&self,port:u16,stop:&AtomicBool)->Result<(),String>{
        let listener=TcpListener::bind(("127.0.0.1",port))
            .map_err(|e|e.to_string())?;
        listener.set_nonblocking(true).map_err(|e|e.to_string())?;
        while !stop.load(Ordering::Acquire){
            match listener.accept(){
                Ok((mut stream,_))=>{
                    let request=match Self::parse_request(&stream){
                        Ok(req)=>req,
                        Err(error)=>{
                            let _=Self::respond(&mut stream,
                                &HttpResponse::text(400,error));
                            continue;
                        }
                    };
                    let response=self.handle(&request);
                    Self::respond(&mut stream,&response)?;
                    if response.keep_stream{
                        stream.set_write_timeout(Some(Duration::from_secs(2)))
                            .map_err(|e|e.to_string())?;
                        self.stream_clients.lock().map_err(|_|"SSE clients poisoned")?
                            .push(stream);
                    }
                },
                Err(error) if error.kind()==std::io::ErrorKind::WouldBlock=>
                    std::thread::sleep(Duration::from_millis(100)),
                Err(error)=>return Err(error.to_string())
            }
        }
        Ok(())
    }
}
