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
/// Node browserWorkerPool: process-scoped singleton with the same SQLite
/// lease authority. Callers must set AGENTS_RELAY_STORE_DIR for tests before
/// first use; no session or Task completion is inferred from this pool.
pub fn browser_worker_pool()
    ->Result<&'static std::sync::Mutex<BrowserWorkerPoolManager>,String>{
    static INSTANCE:std::sync::OnceLock<
        Result<std::sync::Mutex<BrowserWorkerPoolManager>,String>
    >=std::sync::OnceLock::new();
    INSTANCE.get_or_init(||
        BrowserWorkerPoolManager::open(
            crate::browser_worker_pool::BrowserPoolOptions::default())
            .map(std::sync::Mutex::new).map_err(|e|e.to_string())
    ).as_ref().map_err(Clone::clone)
}
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
/// The managed Chrome extension may need a moment for a *newly created*
/// idle tab to finish navigating to its own chrome-extension:// page.
/// Retrying the idempotent workspace-create RPC here is safe because no
/// Session exists and no browser prompt has been submitted. NEVER apply
/// this retry to platform-run/new-thread/new-turn or a timed-out Send.
fn retry_owned_idle_workspace<F>(
    workspace:&str,mut create:F,
)->Result<Value,String>
where F:FnMut()->Result<Value,String>{
    let mut attempt=0;
    loop{
        match create(){
            Ok(result)=>return Ok(result),
            Err(error)=>{
                // WebHelm may wrap extension RPC errors with the literal
                // JavaScript "Error: " prefix. Normalize only that wrapper;
                // do not broaden admission to generic browser or Send timeouts.
                let detail=error.strip_prefix("Error: ").unwrap_or(&error);
                let transient=detail.starts_with("Timed out waiting for workspace ")
                    &&detail.contains(" idle tab ")
                    &&detail.contains(&format!("workspace {workspace} idle tab "));
                if !transient || attempt>=2{return Err(error);}
                attempt+=1;
                std::thread::sleep(Duration::from_millis(150*attempt));
            }
        }
    }
}
pub fn ensure_relay_workspace(
    socket:&Path,webhelm:&Path,workspace:&str,
)->Result<(),String>{
    let args=vec!["ensure".into()];
    cli_command(webhelm,&args,None,None)?;
    retry_owned_idle_workspace(workspace,||
        daemon(socket,&json!({"op":"workspace-create","name":workspace,
            "pool_size":RELAY_WORKSPACE_CAPACITY}),150_000,None))?;
    Ok(())
}

#[cfg(test)]
mod workspace_create_retry_tests{
    use super::*;
    #[test]
    fn only_pre_submission_idle_readiness_is_retryable(){
        let mut attempts=0;
        let created=retry_owned_idle_workspace("Rust2CanaryFake",||{
            attempts+=1;
            if attempts==1 {
                Err("Error: Timed out waiting for workspace Rust2CanaryFake idle tab 25".into())
            }else{Ok(json!({"initialized":true,"idle":1}))}
        }).unwrap();
        assert_eq!(attempts,2);
        assert_eq!(created["idle"],1);
    }
    #[test]
    fn foreign_workspace_or_post_send_failure_never_retries(){
        for error in [
            "Timed out waiting for workspace Relay idle tab 25",
            "ChatGPT did not assign a durable thread id after Send click",
            "WebHelm daemon platform-run timed out",
        ]{
            let mut attempts=0;
            let actual=retry_owned_idle_workspace("Rust2CanaryFake",||{
                attempts+=1;Err(error.into())
            }).unwrap_err();
            assert_eq!(actual,error);
            assert_eq!(attempts,1);
        }
    }
    #[test]
    fn persistent_idle_failure_stops_after_three_before_any_send(){
        let mut attempts=0;
        let result=retry_owned_idle_workspace("Rust2CanaryFake",||{
            attempts+=1;
            Err("Timed out waiting for workspace Rust2CanaryFake idle tab 25".into())
        });
        assert!(result.is_err());
        assert_eq!(attempts,3);
    }
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
                // Match original Node PooledRun.release: an uncertain
                // WebHelm stop is NOT a new Task failure after a verified
                // terminal event. Preserve the occupied Slot as
                // QUARANTINED and finish release; an actual Pool DB error
                // still propagates as an infrastructure failure.
                pool.quarantine(lease).map_err(|e|e.to_string())?;
                eprintln!("warning: WebHelm Session release quarantined: {error}");
                Ok(())
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
        on_activity:Activity,recover:Recover,
    )->Result<(),String>
    where Activity:FnMut(&str)->Result<(),String>,
          Recover:FnMut(&str)->Result<Value,String>,
    {
        self.probe_with_recovery(socket,pool,timeout_ms,recovery_min_ms,
            on_activity,recover,|_,_|Ok(()))
    }
    /// The original Node PooledRun.onRecovery is telemetry only. Report it
    /// only AFTER independently verified same-thread recovery submission;
    /// any callback failure after possible send makes the session uncertain.
    pub fn probe_with_recovery<Activity,Recover,Notified>(
        &mut self,socket:&Path,pool:&BrowserWorkerPoolManager,
        timeout_ms:u64,recovery_min_ms:u64,
        mut on_activity:Activity,mut recover:Recover,mut on_recovery:Notified,
    )->Result<(),String>
    where Activity:FnMut(&str)->Result<(),String>,
          Recover:FnMut(&str)->Result<Value,String>,
          Notified:FnMut(&str,&str)->Result<(),String>,
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
                    "submitted"|"completed")&&!field(&value,"verified_by").is_empty()=>{
                    if on_recovery(thread,field(&value,"verified_by")).is_err(){
                        // Unlike an unsent builder failure, the callback
                        // runs after the WebHelm new-turn might have reached
                        // the provider. Never retry this ambiguous send.
                        self.recovery_outcome_uncertain=true;
                        self.uncertain=true;
                        if let Some(lease)=self.lease.as_ref(){
                            pool.quarantine(lease).map_err(|e|e.to_string())?;
                        }
                    }
                },
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
/// Mirror Node browser-worker-runtime.ts catch/stop: a pre-Send failure
/// MUST free the acquired Browser Pool lease; post-Send uncertainty MUST
/// quarantine it, and neither path may re-submit the browser prompt.
fn browser_submission_failure(
    state:&mut PooledWebHelmState,pool:&BrowserWorkerPoolManager,
    socket:&Path,provider:&str,submitted:bool,error:String,
)->String{
    if submitted{state.uncertain=true;}
    let diagnostic=if submitted{error}
        else{format!("{provider} pre-submission failure: {error}")};
    match state.release(pool,socket){
        Ok(())=>diagnostic,
        Err(cleanup)=>format!("{diagnostic}; pool cleanup failed: {cleanup}"),
    }
}
pub fn pooled_web_helm_run<Build>(
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
    if let Err(error)=ensure_relay_workspace(socket,webhelm,workspace){
        return Err(browser_submission_failure(
            &mut state,pool,socket,provider,false,error));
    }
    let session=match daemon(socket,&json!({"op":"start","workspace":workspace}),
        60_000,Some(cancelled)){
        Ok(session)=>session,
        Err(error)=>return Err(browser_submission_failure(
            &mut state,pool,socket,provider,false,error)),
    };
    let session_id=field(&session,"session_id").to_string();
    if session_id.is_empty(){
        let _=state.release(pool,socket);
        return Err("No WebHelm session ID".into());
    }
    state.session_id=Some(session_id.clone());
    if let Err(error)=pool.bind_session(&mut lease,&session_id){
        return Err(browser_submission_failure(
            &mut state,pool,socket,provider,false,error.to_string()));
    }
    state.lease=Some(lease.clone());
    if field(&session,"workspace")!=workspace
        ||session.get("workspace_supported")!=Some(&Value::Bool(true)){
        let _=state.release(pool,socket);
        return Err("WebHelm returned a Session outside the configured Relay browser workspace".into());
    }
    if cancelled.load(Ordering::Acquire){
        let _=state.release(pool,socket);
        return Err("Browser worker cancelled before submission".into());
    }
    let config=match build(){
        Ok(config)=>config,
        Err(error)=>return Err(browser_submission_failure(
            &mut state,pool,socket,provider,false,error)),
    };
    let action=field(&config,"action");
    let payload=config.get("config").cloned().unwrap_or(json!({}));
    state.submission_attempted=true;
    let submitted=config_run(socket,workspace,provider,
        action,&session_id,&payload,Some(cancelled));
    let receipt=match submitted{
        Ok(answer) if matches!(field(&answer,"status"),"submitted"|"completed")
            &&!field(&answer,"verified_by").is_empty()=>answer,
        Ok(_)=>return Err(browser_submission_failure(
            &mut state,pool,socket,provider,true,
            "Submission outcome unknown: no verified receipt".into())),
        Err(error)=>return Err(browser_submission_failure(
            &mut state,pool,socket,provider,true,error)),
    };
    state.verified_submitted=true;
    let thread_url=field(&receipt,"thread_url").to_string();
    let thread_url=if !thread_url.is_empty(){thread_url}
        else if !field(&receipt,"thread_id").is_empty(){
            format!("https://{}/c/{}",
                if provider=="z"{"chat.z.ai"}else{"chatgpt.com"},
                field(&receipt,"thread_id"))
        }else{String::new()};
    if let Err(error)=pool.bind_thread(&mut lease,&thread_url){
        return Err(browser_submission_failure(
            &mut state,pool,socket,provider,true,error.to_string()));
    }
    state.lease=Some(lease.clone());
    let thread_id=if !field(&receipt,"thread_id").is_empty(){
        field(&receipt,"thread_id").to_string()
    }else{thread_url.split('/').next_back().unwrap_or("").into()};
    if let Err(error)=pool.report_healthy(provider){
        return Err(browser_submission_failure(
            &mut state,pool,socket,provider,true,error.to_string()));
    }
    state.lease=Some(lease);
    state.thread_id=Some(thread_id.clone());
    state.thread_url=Some(thread_url.clone());
    state.observed_at=Some(Instant::now());
    Ok((state,PooledWebHelmReceipt{
        verified_by:field(&receipt,"verified_by").into(),
        provider:provider.into(),session_id,thread_id,thread_url,receipt
    }))
}

#[cfg(test)]
mod browser_submission_failure_tests {
    use super::*;
    use crate::browser_worker_pool::BrowserPoolOptions;

    fn fixture() -> (BrowserWorkerPoolManager, PathBuf) {
        let path=std::env::temp_dir().join(format!("r2-browser-failure-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                .unwrap().as_nanos()));
        let pool=BrowserWorkerPoolManager::open(BrowserPoolOptions {
            path:Some(path.clone()),capacity:1,
            ..Default::default()
        }).unwrap();
        (pool,path)
    }

    #[test]
    fn pre_send_workspace_failure_releases_its_pool_slot() {
        let (mut pool,path)=fixture();
        let lease=pool.acquire("chatgpt","pre-send-lease",None).unwrap();
        assert_eq!(pool.snapshot("chatgpt").unwrap().leased,1);
        let mut state=PooledWebHelmState::default();
        state.lease=Some(lease);
        let error=browser_submission_failure(&mut state,&pool,
            Path::new("/tmp/nonexistent-webhelm-test-socket"),
            "chatgpt",false,"idle tab readiness failed".into());
        assert!(error.contains("pre-submission failure"));
        let snapshot=pool.snapshot("chatgpt").unwrap();
        assert_eq!(snapshot.leased,0);
        assert_eq!(snapshot.quarantined,0);
        assert_eq!(snapshot.idle,1);
        drop(pool);
        let _=std::fs::remove_file(path);
    }

    #[test]
    fn post_send_uncertainty_quarantines_without_releasing() {
        let (mut pool,path)=fixture();
        let lease=pool.acquire("chatgpt","submitted-lease",None).unwrap();
        let mut state=PooledWebHelmState::default();
        state.lease=Some(lease);
        state.submission_attempted=true;
        let error=browser_submission_failure(&mut state,&pool,
            Path::new("/tmp/nonexistent-webhelm-test-socket"),
            "chatgpt",true,"durable thread id unavailable".into());
        assert_eq!(error,"durable thread id unavailable");
        assert!(state.uncertain);
        let snapshot=pool.snapshot("chatgpt").unwrap();
        assert_eq!(snapshot.leased,0);
        assert_eq!(snapshot.quarantined,1);
        assert_eq!(snapshot.idle,0);
        drop(pool);
        let _=std::fs::remove_file(path);
    }
}
