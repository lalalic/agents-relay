// Node provenance: src/browser-worker-runtime.ts. Relay-owned Browser
// Workspace and WebHelm session lifecycle. A verified WebHelm receipt is
// submission evidence, never an authoritative Task terminal event.
// No browser client-side Dashboard code is modified by this module.
use crate::{
    browser_worker_pool::{BrowserSlot,BrowserWorkerPoolManager},
    browser_worker_pool_graph::{monitor_pool_decision,progress_pool_decision},
    continuation::{run_delivery_owned_process,DeliveryProcessOptions},
    owned_process::OwnedProcessManager,
    terminal_event_recovery::{terminal_recovery_eligible,TerminalRecoveryFacts},
    webhelm_daemon_client::{request_with_cancel,DaemonRequest},
};
use serde_json::{json,Map,Value};
use std::{
    path::{Path,PathBuf},
    sync::atomic::{AtomicBool,Ordering},
    time::{Duration,Instant},
};
pub const RELAY_WORKSPACE_CAPACITY:u64=6;
pub const OUTPUT_LIMIT:usize=2_000_000;
pub const OBSERVE:&str=r#"const url=(await page_info()).url;
const state=await js('(()=>{const nodes=[...document.querySelectorAll("[data-message-author-role=assistant], [data-role=assistant], .assistant-message, .markdown")];const text=(nodes.at(-1)?.innerText||"").slice(-16000);const generating=!!document.querySelector("button[aria-label*=Stop],button[aria-label*=stop],[data-testid=stop-button]");const stream=window.__webhelmZStream?.entries?.at(-1);return {text, generating, streamLength: stream?.body?.length||0, streamState: stream?.state||null}})()');
console.log(JSON.stringify({url,state}));"#;
fn field<'a>(v:&'a Value,key:&str)->&'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
pub fn relay_workspace_name(configured:Option<&str>)->Result<String,String>{
    let raw=configured.map(str::trim).filter(|s|!s.is_empty())
        .unwrap_or("Relay");
    if !regex::Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
        .expect("safe workspace regex").is_match(raw){
        return Err("AGENTS_RELAY_WEBHELM_WORKSPACE must be a safe workspace name".into());
    }
    Ok(raw.into())
}
fn fields(request:&Value)->Map<String,Value>{
    request.as_object().cloned().unwrap_or_default()
}
fn daemon(
    socket:&Path,request:&Value,timeout_ms:u64,
    cancelled:Option<&AtomicBool>,
)->Result<Value,String>{
    let mut req=fields(request);
    let op=req.remove("op").and_then(|v|v.as_str().map(str::to_owned))
        .ok_or("WebHelm request missing operation")?;
    request_with_cancel(&socket.to_string_lossy(),
        &DaemonRequest{op,fields:req},Duration::from_millis(timeout_ms),cancelled)
}
pub fn cli_command(
    executable:&Path,args:&[String],input:Option<&str>,cancelled:Option<&AtomicBool>,
)->Result<String,String>{
    if input.is_some(){
        return Err("WebHelm CLI argv input requires owned stdin adapter".into());
    }
    let mut manager=OwnedProcessManager::default();
    let refs:Vec<&str>=args.iter().map(String::as_str).collect();
    let timeout=if args.first().is_some_and(|v|v=="session")
        &&args.get(1).is_some_and(|v|v=="exec"){25_000}
        else{150_000};
    let response=run_delivery_owned_process(&mut manager,
        &executable.to_string_lossy(),&refs,None,"browser-worker-pool:webhelm",
        DeliveryProcessOptions{timeout:Some(Duration::from_millis(timeout)),
            cancelled,supervisor_path:None,environment:None})?;
    let out=if response.stdout.len()>OUTPUT_LIMIT{
        &response.stdout[response.stdout.len()-OUTPUT_LIMIT..]
    }else{&response.stdout};
    if response.code!=0{
        return Err(if response.stderr.trim().is_empty(){
            if out.trim().is_empty(){format!("WebHelm exited {}",response.code)}
            else{out.trim().to_string()}
        }else{response.stderr.trim().to_string()});
    }
    Ok(out.trim().into())
}
pub fn parse_envelope(raw:&str)->Result<Value,String>{
    let lines=raw.trim().lines().rev().collect::<Vec<_>>();
    for (index,line) in lines.iter().enumerate(){
        let Ok(value)=serde_json::from_str::<Value>(line)else{continue;};
        if let Some(inner)=value.get("result").filter(|v|v.is_object()){
            if inner.get("ok")==Some(&Value::Bool(false)){
                return Err(inner.get("error").and_then(Value::as_str)
                    .or_else(||inner.get("message").and_then(Value::as_str))
                    .unwrap_or("WebHelm action failed").into());
            }
            if let Some(stdout)=inner.get("stdout").and_then(Value::as_str)
                .filter(|v|!v.trim().is_empty()){
                if let Ok(inner)=parse_envelope(stdout){return Ok(inner);}
            }
            return Ok(inner.get("value").filter(|v|v.is_object())
                .cloned().unwrap_or_else(||inner.clone()));
        }
        if let Some(stdout)=value.get("stdout").and_then(Value::as_str)
            .filter(|v|!v.trim().is_empty()){
            if let Ok(inner)=parse_envelope(stdout){return Ok(inner);}
        }
        return Ok(value.get("value").filter(|v|v.is_object())
            .cloned().unwrap_or(value));
    }
    Err("WebHelm returned no structured result".into())
}
pub fn ensure_relay_workspace(
    socket:&Path,webhelm:&Path,workspace:&str,
)->Result<(),String>{
    let args=vec!["ensure".into()];
    cli_command(webhelm,&args,None,None)?;
    daemon(socket,&json!({"op":"workspace-create","name":workspace,
        "pool_size":RELAY_WORKSPACE_CAPACITY}),150_000,None)?;
    Ok(())
}
pub fn config_run(
    socket:&Path,workspace:&str,provider:&str,
    action:&str,session_id:&str,config:&Value,
    cancelled:Option<&AtomicBool>,
)->Result<Value,String>{
    let result=daemon(socket,&json!({
        "op":"platform-run","platform":provider,"action":action,
        "session_id":session_id,"config":config,"auto_session":false,
        "workspace":workspace
    }),150_000,cancelled)?;
    parse_envelope(&result.to_string())
}
/// An idempotent stop response can be lost. Read back the exact Session ID
/// before freeing a Browser Pool lease. Two failed attempts quarantine it.
pub fn stop_webhelm_session_verified(
    socket:&Path,session_id:&str,
)->Result<(),String>{
    let mut error="WebHelm Session release was not verified".to_owned();
    for attempt in 0..2{
        match daemon(socket,&json!({"op":"stop","session_id":session_id}),45_000,None){
            Ok(result) if result.get("returned_to_idle")==Some(&Value::Bool(true))
                ||result.get("already_closed")==Some(&Value::Bool(true))
                =>return Ok(()),
            Ok(_)=>error="WebHelm stop returned no verified idle tab receipt".into(),
            Err(message)=>error=message,
        }
        if let Ok(list)=daemon(socket,&json!({"op":"list"}),15_000,None){
            if let Some(sessions)=list.get("sessions").and_then(Value::as_array){
                if !sessions.iter().any(|row|
                    row.get("session_id").and_then(Value::as_str)==Some(session_id)){
                    return Ok(());
                }
            }
        }
        if attempt==0{std::thread::sleep(Duration::from_millis(250));}
    }
    Err(error)
}
pub fn observer_fingerprint(observation:&Value)->String{
    format!("{}|{}",observation.pointer("/state/text")
        .and_then(Value::as_str).unwrap_or(""),
        observation.pointer("/state/streamLength")
            .and_then(Value::as_i64).unwrap_or(0))
}
#[derive(Clone,Debug)]
pub struct PooledWebHelmReceipt{
    pub receipt:Value,
    pub provider:String,
    pub session_id:String,
    pub thread_id:String,
    pub thread_url:String,
    pub verified_by:String,
}
#[derive(Default)]
pub struct PooledWebHelmState {
    pub lease:Option<BrowserSlot>,
    pub provider:Option<String>,
    pub session_id:Option<String>,
    pub thread_id:Option<String>,
    pub thread_url:Option<String>,
    pub last_fingerprint:String,
    pub observed_at:Option<Instant>,
    pub sampled:bool,
    pub recoveries:u64,
    pub submission_attempted:bool,
    pub verified_submitted:bool,
    pub uncertain:bool,
    pub recovery_outcome_uncertain:bool,
    pub released:bool,
    pub stopped:bool,
}
impl PooledWebHelmState {
    pub fn can_recover_terminal(&self)->bool{
        terminal_recovery_eligible(&TerminalRecoveryFacts{
            has_session:self.session_id.is_some(),
            has_thread:self.thread_id.is_some(),
            terminal_observed:false,recovery_attempts:self.recoveries as f64,
            outcome_uncertain:self.recovery_outcome_uncertain,
            cancelled:self.stopped||self.released||self.uncertain
        })
    }
    pub fn release(
        &mut self,pool:&BrowserWorkerPoolManager,socket:&Path,
    )->Result<(),String>{
        if self.stopped{return Ok(());}
        self.stopped=true;
        let Some(lease)=self.lease.as_ref()else{return Ok(());};
        if self.uncertain{
            return pool.quarantine(lease).map_err(|e|e.to_string());
        }
        let Some(session)=self.session_id.as_deref()else{
            return pool.release(lease).map_err(|e|e.to_string());
        };
        match stop_webhelm_session_verified(socket,session){
            Ok(())=>pool.release(lease).map_err(|e|e.to_string()),
            Err(error)=>{
                pool.quarantine(lease).map_err(|e|e.to_string())?;
                Err(error)
            }
        }
    }
    pub fn cancel(&mut self,pool:&BrowserWorkerPoolManager,
        socket:&Path)->Result<(),String>{
        self.released=true;
        if self.verified_submitted||self.submission_attempted{
            self.uncertain=true;
        }
        self.release(pool,socket)
    }
    pub fn heartbeat(&mut self,socket:&Path)->Result<(),String>{
        if self.stopped{return Ok(());}
        let Some(session)=self.session_id.as_deref()else{return Ok(());};
        let response=daemon(socket,&json!({"op":"heartbeat",
            "session_id":session}),15_000,None)?;
        if response.get("alive")!=Some(&Value::Bool(true)){
            return Err("WebHelm rejected Session heartbeat".into());
        }
        Ok(())
    }
    pub fn probe<Activity,Recover>(
        &mut self,socket:&Path,pool:&BrowserWorkerPoolManager,
        timeout_ms:u64,recovery_min_ms:u64,
        mut on_activity:Activity,mut recover:Recover,
    )->Result<(),String>
    where Activity:FnMut(&str)->Result<(),String>,
          Recover:FnMut(&str)->Result<Value,String>,
    {
        if self.stopped{return Ok(());}
        let Some(session)=self.session_id.as_deref()else{return Ok(());};
        let Some(ref thread_url)=self.thread_url else{return Ok(());};
        let current=daemon(socket,&json!({"op":"exec","session_id":session,
            "code":OBSERVE}),45_000,None)?;
        let observation=parse_envelope(&current.to_string())?;
        if let Some(url)=observation.get("url").and_then(Value::as_str){
            let normalize=|s:&str|s.split('?').next().unwrap_or("")
                .trim_end_matches('/').to_owned();
            if normalize(url)!=normalize(thread_url){return Ok(());}
        }
        let fingerprint=observer_fingerprint(&observation);
        if !self.sampled{
            self.sampled=true;
            self.last_fingerprint=fingerprint;
            return Ok(());
        }
        let now=Instant::now();
        let fresh=fingerprint!=self.last_fingerprint&&fingerprint!="|0";
        if progress_pool_decision(fresh)?=="extendTimeout"{
            self.last_fingerprint=fingerprint;
            self.observed_at=Some(now);
            if let Some(lease)=self.lease.as_ref(){
                pool.touch(lease).map_err(|e|e.to_string())?;
            }
            on_activity("Browser Worker produced new assistant output")?;
        }
        let since=self.observed_at.map(|t|now.duration_since(t).as_millis() as u64)
            .unwrap_or(0);
        let due=since>=recovery_min_ms.max((timeout_ms as f64*0.6).round() as u64)
            &&observation.pointer("/state/generating")!=Some(&Value::Bool(true))
            &&self.can_recover_terminal();
        if monitor_pool_decision(due)?=="recoverTurn"&&self.can_recover_terminal(){
            self.recoveries+=1;
            self.observed_at=Some(now);
            let thread=self.thread_id.as_deref().ok_or("Browser thread missing")?;
            let config=recover(thread)?;
            let answer=config_run(socket,&self.workspace_name(),
                self.provider.as_deref().unwrap_or("chatgpt"),
                "new-turn",session,&config,None);
            match answer{
                Ok(value) if matches!(field(&value,"status"),
                    "submitted"|"completed")&&!field(&value,"verified_by").is_empty()=>{},
                _=>{
                    self.recovery_outcome_uncertain=true;
                    self.uncertain=true;
                    if let Some(lease)=self.lease.as_ref(){
                        pool.quarantine(lease).map_err(|e|e.to_string())?;
                    }
                }
            }
        }
        Ok(())
    }
    fn workspace_name(&self)->String{
        std::env::var("AGENTS_RELAY_WEBHELM_WORKSPACE")
            .unwrap_or_else(|_|"Relay".into())
    }
}
/// Synchronous native port of pooledWebHelmRun. The caller owns monitoring
/// callbacks/intervals; a return receipt never completes a Task.
pub fn pooled_webhelm_run<Build>(
    socket:&Path,webhelm:&Path,workspace:&str,
    pool:&mut BrowserWorkerPoolManager,provider:&str,
    execution_id:&str,cancelled:&AtomicBool,
    mut build:Build,
)->Result<(PooledWebHelmState,PooledWebHelmReceipt),String>
where Build:FnMut()->Result<Value,String>,
{
    let mut state=PooledWebHelmState::default();
    let mut lease=pool.acquire(provider,execution_id,Some(cancelled))
        .map_err(|e|e.to_string())?;
    state.lease=Some(lease.clone());
    state.provider=Some(provider.into());
    if cancelled.load(Ordering::Acquire){
        let _=state.release(pool,socket);
        return Err("Browser worker cancelled before submission".into());
    }
    let profile_result=cli_command(webhelm,&vec![
        "platform".into(),"profile".into(),provider.into()],None,Some(cancelled));
    let profile=match profile_result.and_then(|raw|parse_envelope(&raw)){
        Ok(profile)=>profile,
        Err(error)=>{
            let _=pool.report_pre_submission_outage(provider,60_000);
            let _=state.release(pool,socket);
            return Err(format!("{provider} pre-submission failure: {error}"));
        }
    };
    if field(&profile,"platform")!=provider{
        let _=state.release(pool,socket);
        return Err(format!("WebHelm platform {provider} missing"));
    }
    ensure_relay_workspace(socket,webhelm,workspace)?;
    let session=daemon(socket,&json!({"op":"start","workspace":workspace}),
        60_000,Some(cancelled))?;
    let session_id=field(&session,"session_id").to_string();
    if session_id.is_empty(){
        let _=state.release(pool,socket);
        return Err("No WebHelm session ID".into());
    }
    state.session_id=Some(session_id.clone());
    pool.bind_session(&mut lease,&session_id).map_err(|e|e.to_string())?;
    if field(&session,"workspace")!=workspace
        ||session.get("workspace_supported")!=Some(&Value::Bool(true)){
        let _=state.release(pool,socket);
        return Err("WebHelm returned a Session outside the configured Relay browser workspace".into());
    }
    if cancelled.load(Ordering::Acquire){
        let _=state.release(pool,socket);
        return Err("Browser worker cancelled before submission".into());
    }
    let config=build()?;
    let action=field(&config,"action");
    let payload=config.get("config").cloned().unwrap_or(json!({}));
    state.submission_attempted=true;
    let submitted=config_run(socket,workspace,provider,
        action,&session_id,&payload,Some(cancelled));
    let receipt=match submitted{
        Ok(answer) if matches!(field(&answer,"status"),"submitted"|"completed")
            &&!field(&answer,"verified_by").is_empty()=>answer,
        Ok(_)=>{
            state.uncertain=true;
            let _=state.release(pool,socket);
            return Err("Submission outcome unknown: no verified receipt".into());
        },
        Err(error)=>{
            state.uncertain=true;
            let _=state.release(pool,socket);
            return Err(error);
        }
    };
    state.verified_submitted=true;
    let thread_url=field(&receipt,"thread_url").to_string();
    let thread_url=if !thread_url.is_empty(){thread_url}
        else if !field(&receipt,"thread_id").is_empty(){
            format!("https://{}/c/{}",
                if provider=="z"{"chat.z.ai"}else{"chatgpt.com"},
                field(&receipt,"thread_id"))
        }else{String::new()};
    pool.bind_thread(&mut lease,&thread_url).map_err(|e|e.to_string())?;
    let thread_id=if !field(&receipt,"thread_id").is_empty(){
        field(&receipt,"thread_id").to_string()
    }else{thread_url.split('/').next_back().unwrap_or("").into()};
    pool.report_healthy(provider).map_err(|e|e.to_string())?;
    state.lease=Some(lease);
    state.thread_id=Some(thread_id.clone());
    state.thread_url=Some(thread_url.clone());
    state.observed_at=Some(Instant::now());
    Ok((state,PooledWebHelmReceipt{
        verified_by:field(&receipt,"verified_by").into(),
        provider:provider.into(),session_id,thread_id,thread_url,receipt
    }))
}
