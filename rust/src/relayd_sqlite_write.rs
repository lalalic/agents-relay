//! Concrete SQLite + Graph mutations for explicitly isolated native daemon
//! acceptance. Uses the same workspace_control()/SQLiteRelayStore paths as
//! production; provider launch, external events and unported actions fail
//! closed until their real adapters are installed. Never use live credentials.
use crate::{
    dashboard_actions::{dashboard_job_set_state,dashboard_task_action,dashboard_task_set_state},
    relayd_dashboard_actions::workspace_task_create_snapshot,
    git_delivery::source_commit_sha,
    local_merge_delivery::{native_merge_effect,reconcile_local_git_completion},
    local_git_merge::{local_source_head,reviewed_checkout_merge_request,git as checked_local_git},
    local_merge_projection::reconcile_completed_local_delivery,
    agent_script_discovery::discover_script_agent,
    native_script_execution::run_claimed_script_task,
    native_worker_event_ingress::apply_verified_worker_event,
    native_host_review_ingress::apply_durable_host_review_event,
    route_outcome_recording::record_terminal_route_outcome_jsonl,
    daemon_worker_failure::{
        classify_native_launch_phase, DaemonFailureState, DaemonLiveWorkers,
        DaemonWorkerFailurePorts},
    native_script_planner::run_isolated_script_planner,
    manual_plan::prepare_manual_plan,
    planner::create_plan_round,
    native_script_worker::configured_script_interpreter,
    reconciler::Reconciler,
    interactive_request::fail_interactive_review,
    relay_store::SQLiteRelayStore,
    relay_store_discovery::relay_unified_store_path,
    relayd::{inventory_from_local,DaemonConfig,DaemonServices},
    relayd_control::{workspace_control,WorkspaceControlBackend},
    workspace::{ensure_local_job_source_branch,
        prepare_local_job_execution_worktree,task_requires_managed_worktree},
};
use serde_json::{json,Value};
use std::{cell::{Ref,RefCell,RefMut},collections::{HashMap,HashSet},future::{ready,Future},path::{Path,PathBuf},pin::pin,sync::mpsc::{self,Receiver,Sender},task::{Context,Poll,Waker}};
fn field<'a>(v:&'a Value,key:&str)->&'a str{v.get(key).and_then(Value::as_str).unwrap_or("")}
fn denied(name:&str)->String{format!("Rust isolated-write daemon {name} not bound; refusing unsafe side effect")}

/// A WebHelm "submitted" HTTP receipt is NOT a worker start acknowledgement.
/// Only the canonical Graph+SQLite result of an execution-correlated
/// task.started may flip the volatile Worker live observation. Terminal
/// cleanup is likewise fenced to the execution history that actually closed.
fn update_live_worker_from_committed_event(
    live:&mut DaemonLiveWorkers,committed:&Value,
    task_id:&str,execution_id:&str,event_type:&str,
){
    let task=committed.get("tasks").and_then(Value::as_array)
        .into_iter().flatten().find(|task|field(task,"id")==task_id);
    let Some(task)=task else{return;};
    if event_type=="task.started"
        &&field(task,"state")=="RUNNING"
        &&field(task,"executionId")==execution_id{
        live.mark_started(task_id,execution_id);
    }else if matches!(event_type,"task.completed"|"task.failed")
        &&matches!(field(task,"state"),"SUCCEEDED"|"FAILED"|"CANCELLED")
        &&task.get("executionHistory").and_then(Value::as_array)
            .into_iter().flatten().any(|generation|field(generation,"id")==execution_id)
        &&live.get(task_id).is_some_and(|state|state.execution_id==execution_id){
        live.remove(task_id);
    }
}

/// Outbox may carry either a locally produced Script event or a verified,
/// already-committed Model/Events Bus ingress receipt. Both must be tied to
/// the precise leased execution and immutable event_id before publication.
/// Replaying via NATS retains the original event_id for consumer de-duplication.
fn verified_worker_outbox_event(key:&str,kind:&str,event:&Value)->bool{
    let job=field(event,"job_id");
    let task=field(event,"task_id");
    let event_type=field(event,"type");
    let event_id=field(event,"event_id");
    if event.get("version")!=Some(&json!(1))||crate::events::subject_token(job).is_err()
        ||task.is_empty()||event_id.is_empty()||kind!=event_type{
        return false;
    }
    // The native Planner commits these events to the SAME durable SQLite
    // outbox as Script/Model Workers, but uses an independent Graph/Plan
    // identity, not a Task execution generation. A well-formed Planner
    // record must not poison FIFO publication of all subsequent Workers.
    // Require the exact internal Planner key, immutable event_id, Plan Task
    // namespace, canonical status and trusted optional source. Never admit
    // arbitrary event types or rewrite an unverified row as published.
    if matches!(event_type,"planner.started"|"planner.retry"|"planner.completed"|"planner.failed"){
        let expected_status=match event_type{
            "planner.started"=>"running",
            "planner.retry"=>"queued",
            "planner.completed"=>"succeeded",
            _=>"failed",
        };
        let source_ok=event.get("source").is_none_or(|source|
            source.is_object()
            &&field(source,"agent")=="planner"
            &&field(source,"component")=="agents-relay"
            &&source.get("id").is_none_or(Value::is_null));
        return task.starts_with("plan-")&&task.len()>5
            &&field(event,"status")==expected_status
            &&event.get("parent_task_id").is_none_or(Value::is_null)
            &&source_ok
            &&key==format!("isolated-planner/{job}/{event_type}/{event_id}");
    }
    // Local merge outcomes have their own durable Graph-generated identity,
    // not a Worker execution key. Validate the exact key, source and status.
    if matches!(event_type,"job.merge.succeeded"|"job.merge.failed"){
        let succeeded=event_type=="job.merge.succeeded";
        let source=field(&event["source"],"id");
        let prefix=format!("job/{job}/task/merge/execution/attempt-");
        let attempt=source.strip_prefix(&prefix).and_then(|n|n.parse::<u64>().ok());
        let digest=event_id.strip_prefix("workflow-local-merge-");
        let valid_digest=digest.is_some_and(|s|s.len()==64
            &&s.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)));
        return task=="merge"&&key==event_id&&valid_digest
            &&field(&event["source"],"agent")=="relay"&&attempt.is_some()
            &&event.get("parent_task_id").is_none_or(Value::is_null)
            &&field(event,"status")==if succeeded{"succeeded"}else{"failed"};
    }
    let (prefix,allowed)=if matches!(event_type,"task.started"|"task.completed"|"task.failed"){
        (format!("script-event/{job}/{task}/"),true)
    }else{(String::new(),false)};
    if allowed{
        if let Some(execution)=key.strip_prefix(&prefix)
            .and_then(|rest|rest.strip_suffix(&format!("/{event_type}"))){
            return !execution.is_empty()
                &&event.pointer("/source/id").and_then(Value::as_str)
                    ==Some(crate::execution_event_identity::execution_event_source(
                        job,task,execution).as_str());
        }
    }
    if !matches!(event_type,"task.started"|"task.progress"|"task.completed"|"task.failed"){
        return false;
    }
    let prefix=format!("model-event/{job}/{task}/");
    let Some(rest)=key.strip_prefix(&prefix)else{return false;};
    let Some(execution)=rest.strip_suffix(&format!("/{event_id}"))else{return false;};
    !execution.is_empty()
        &&event.pointer("/source/id").and_then(Value::as_str)
            ==Some(crate::execution_event_identity::execution_event_source(
                job,task,execution).as_str())
}

/// Select at most one publication batch of valid pending events. Invalid
/// records stay pending for diagnosis/replay; they cannot head-of-line block
/// later verified events, even when there are more than a full batch of them.
fn pending_verified_workflow_events(db:&rusqlite::Connection,limit:usize,report_rejected:bool)
    ->Result<Vec<(String,Value)>,String>{
    let mut query=db.prepare(
        "SELECT event_key,event_id,payload_json FROM workflow_event_outbox
         WHERE state='pending' ORDER BY created_at,event_key"
    ).map_err(|e|e.to_string())?;
    let rows=query.query_map([],|r|Ok((r.get::<_,String>(0)?,
        r.get::<_,String>(1)?,r.get::<_,String>(2)?)))
        .map_err(|e|e.to_string())?;
    let mut verified=Vec::new();
    let mut rejected=0usize;
    let mut first_rejected=None;
    for row in rows{
        let (key,kind,raw)=row.map_err(|e|e.to_string())?;
        let event=serde_json::from_str::<Value>(&raw).ok()
            .filter(|event|verified_worker_outbox_event(&key,&kind,event));
        if let Some(event)=event{
            verified.push((key,event));
            if verified.len()>=limit{break;}
        }else{
            rejected+=1;
            if first_rejected.is_none(){first_rejected=Some(key);}
        }
    }
    if let Some(key)=first_rejected.filter(|_|report_rejected){
        eprintln!("warning: skipped {rejected} invalid durable Workflow events (retained pending; first: {key})");
    }
    Ok(verified)
}

pub struct IsolatedSQLiteWriteHost {
    config:DaemonConfig,
    // Explicitly selected production-owned canonical store. Isolated callers
    // still reject any project outside their disposable Git fixture.
    live_store:bool,
    usage_cache:Option<(std::time::Instant,Value)>,
    subscriptions:Vec<Sender<String>>,
    wake_count:u64,
    wake_pending:bool,
    reconcile_attempts:u64,
    connections:RefCell<HashMap<String,SQLiteRelayStore>>,
    // Node provenance: src/reconciler-runtime.ts failLaunch binding state.
    // Shared with worker threads so launch failures reach the same
    // Graph/SQLite path as Node, not a bare stderr print.
    failure_state:std::sync::Arc<DaemonFailureState>,
    live_workers:std::sync::Arc<std::sync::Mutex<DaemonLiveWorkers>>,
    // Only explicitly injected loopback fixture URLs are permitted by this
    // isolated host; it NEVER reads a user's real notification endpoint.
    escalation_notifier:Option<crate::escalation_notifier::EscalationNotifierConfig>,
    // Explicit read-only Events Bus history provider. Isolated daemons
    // never open the operator's configured bus without opt-in.
    event_history_api:Option<url::Url>,
    // Explicit caller-owned event stream trust boundary, independent of
    // read-only UI history. Cursor is only a cache; durable SQLite event
    // keys fence replay on process recreation.
    model_event_ingress_enabled:bool,
    // Explicit non-browser Codex execution path. No PATH lookup/Node relay.
    model_codex_executable:Option<PathBuf>,
    model_event_cursor:HashMap<String,i64>,
    // NATS callback thread delivers only immutable JSON into a bounded
    // in-process queue. Graph/SQLite is always mutated on daemon thread.
    model_nats_subscription:Option<crate::events::NatsSubscription>,
    // Graph-created lifecycle events MUST reach the same Events Bus that the
    // Dashboard reads; subscribing for Model completions alone is not enough.
    model_nats_publisher:Option<crate::events::NatsEventBus>,
    model_nats_receiver:Option<Receiver<Value>>,
    model_nats_sender:Option<mpsc::SyncSender<Value>>,
    model_nats_url:Option<String>,
    model_nats_token:Option<String>,
    model_nats_wake:std::sync::Arc<std::sync::atomic::AtomicBool>,
    model_nats_last_retry:Option<std::time::Instant>,
    model_nats_pending:HashMap<String,Vec<Value>>,
    workflow_outbox_last_poll:Option<std::time::Instant>,
    // Observational SSE de-duplication: an unchanged Graph/SQLite snapshot
    // must not trigger an extra render on every daemon wake.
    last_sse_snapshot:HashMap<String,String>,
}
impl IsolatedSQLiteWriteHost {
    pub fn new(config:DaemonConfig)->Self{
        Self{config,live_store:false,usage_cache:None,subscriptions:Vec::new(),wake_count:0,wake_pending:false,reconcile_attempts:0,connections:RefCell::new(HashMap::new()),
            failure_state:std::sync::Arc::new(DaemonFailureState::new()),
            live_workers:std::sync::Arc::new(std::sync::Mutex::new(DaemonLiveWorkers::default())),
            escalation_notifier:None,event_history_api:None,
            model_event_ingress_enabled:false,
            model_codex_executable:None,
            model_event_cursor:HashMap::new(),
            model_nats_subscription:None,model_nats_publisher:None,
            model_nats_receiver:None,
            model_nats_sender:None,model_nats_url:None,
            model_nats_token:None,
            model_nats_wake:std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            model_nats_last_retry:None,model_nats_pending:HashMap::new(),
            workflow_outbox_last_poll:None,
            last_sse_snapshot:HashMap::new()}
    }
    /// Construct a Graph/SQLite writer for the canonical store only after
    /// the executable has obtained exclusive ownership, checked the exact
    /// store binding and successfully acquired its production lock.
    pub fn new_live(config:DaemonConfig)->Self{
        let mut host=Self::new(config);
        host.live_store=true;
        host
    }
    /// Bind the REAL Events Bus read-only HTTP history API only when the
    /// caller explicitly supplies a loopback endpoint. This isolated daemon
    /// never discovers/touches the user's live Events Bus configuration.
    /// Ingress is still Graph/SQLite-authorized separately, never derived
    /// from a historical event observation.
    pub fn set_loopback_event_history_api(&mut self,raw:&str)->Result<(),String>{
        let parsed=url::Url::parse(raw).map_err(|e|format!("Invalid Events Bus history API: {e}"))?;
        if parsed.scheme()!="http"
            ||!matches!(parsed.host_str(),Some("127.0.0.1"|"localhost"|"::1"))
            ||parsed.port().is_none()
            ||parsed.path()!="/"
            ||parsed.query().is_some()||parsed.fragment().is_some()
            ||!parsed.username().is_empty()||parsed.password().is_some(){
            return Err("Native isolated Events Bus history must be an explicit loopback HTTP root URL with port".into());
        }
        self.event_history_api=Some(parsed);
        Ok(())
    }
    /// Subscribe only to an explicitly caller-owned loopback NATS service.
    /// This never selects the default operator NATS endpoint or treats a
    /// decoded NATS frame as a Graph/SQLite transition. NATS callback only
    /// enqueues immutable JSON; exact leased execution is checked later.
    pub fn set_loopback_model_nats(&mut self,raw:&str)->Result<(),String>{
        self.set_loopback_model_nats_with_token(raw,None)
    }
    /// An explicitly provided token is only for test-owned loopback NATS.
    /// The native daemon must never automatically read operator credentials.
    pub fn set_loopback_model_nats_with_token(
        &mut self,raw:&str,token:Option<&str>,
    )->Result<(),String>{
        let parsed=url::Url::parse(raw)
            .map_err(|error|format!("Invalid isolated NATS model URL: {error}"))?;
        if parsed.scheme()!="nats"
            ||!matches!(parsed.host_str(),Some("127.0.0.1"|"localhost"|"::1"))
            ||parsed.port().is_none()||parsed.path()!="/"
            ||parsed.query().is_some()||parsed.fragment().is_some()
            ||!parsed.username().is_empty()||parsed.password().is_some(){
            return Err("Isolated model NATS requires explicit nats://127.0.0.1:PORT/ without credentials".into());
        }
        let bus=crate::events::NatsEventBus::with_loopback_token(
            Some(raw),None,token)?;
        // The NATS reader must not allocate unbounded memory when a
        // Graph/SQLite writer is blocked; JetStream/HTTP history remains
        // responsible for replay if the fixed-capacity intake is full.
        let (sender,receiver)=mpsc::sync_channel(1024);
        let callback_sender=sender.clone();
        let wake=std::sync::Arc::clone(&self.model_nats_wake);
        let subscription=bus.subscribe_all(std::sync::Arc::new(move |event|{
            callback_sender.try_send(event.clone()).map_err(|e|e.to_string())?;
            wake.store(true,std::sync::atomic::Ordering::Release);
            Ok(())
        }))?;
        self.model_nats_subscription=Some(subscription);
        self.model_nats_publisher=Some(bus);
        self.model_nats_receiver=Some(receiver);
        self.model_nats_sender=Some(sender);
        self.model_nats_url=Some(raw.into());
        self.model_nats_token=token.map(str::to_owned);
        self.model_nats_last_retry=None;
        Ok(())
    }
    fn reconnect_isolated_model_nats_if_needed(&mut self)->Result<(),String>{
        let Some(url)=self.model_nats_url.as_ref() else{return Ok(());};
        if self.model_nats_subscription.as_ref().is_some_and(
            crate::events::NatsSubscription::is_alive){return Ok(());}
        // One daemon scan may visit hundreds of Jobs. Throttle reconnection
        // per host, not per Job, and never spin on a disconnected broker.
        if self.model_nats_last_retry.is_some_and(|at|
            at.elapsed()<std::time::Duration::from_secs(1)){
            return Ok(());
        }
        self.model_nats_last_retry=Some(std::time::Instant::now());
        let sender=self.model_nats_sender.as_ref()
            .ok_or("NATS subscription is missing its intake sender")?.clone();
        let wake=std::sync::Arc::clone(&self.model_nats_wake);
        let bus=crate::events::NatsEventBus::with_loopback_token(
            Some(url),None,self.model_nats_token.as_deref())?;
        let next=bus.subscribe_all(std::sync::Arc::new(move|event|{
            sender.try_send(event.clone()).map_err(|error|error.to_string())?;
            wake.store(true,std::sync::atomic::Ordering::Release);
            Ok(())
        }))?;
        // Replace only after successful SUB write. Keep the same receiver
        // and all already-buffered events even if broker reconnects.
        self.model_nats_subscription=Some(next);
        Ok(())
    }
    /// Explicit fixture transport only. No environment-derived or public
    /// GitHub/HTTPS notification endpoint can run inside isolated mode.
    pub fn set_test_loopback_escalation_notifier(
        &mut self,config:crate::escalation_notifier::EscalationNotifierConfig,
    )->Result<(),String>{
        if config.url.scheme()!="http"
            ||!matches!(config.url.host_str(),Some("localhost"|"127.0.0.1"|"::1")){
            return Err("Isolated escalation notifier requires an explicit loopback fixture".into());
        }
        self.escalation_notifier=Some(config);
        Ok(())
    }
    /// The native Codex provider is non-browser and executes only inside the
    /// canonical Rust-owned live store. Credentials belong to Codex itself;
    /// Relay never imports or places them in a Task/CLI argument.
    pub fn set_live_codex_executable(
        &mut self,raw:&str,
    )->Result<(),String>{
        if !self.live_store || !self.model_event_ingress_enabled{
            return Err("Live Codex requires native owner and trusted EventBus".into());
        }
        let declared=Path::new(raw);
        if !declared.is_absolute(){
            return Err("Live Codex executable must be absolute".into());
        }
        let path=std::fs::canonicalize(declared)
            .map_err(|_|"Live Codex executable unavailable")?;
        if !path.is_file(){
            return Err("Live Codex executable is not a regular file".into());
        }
        #[cfg(unix)]{
            use std::os::unix::fs::PermissionsExt;
            if path.metadata().map_err(|e|e.to_string())?
                .permissions().mode()&0o111==0{
                return Err("Live Codex executable is not executable".into());
            }
        }
        self.model_codex_executable=Some(path);
        Ok(())
    }
    /// Explicit opt-in, isolated loopback HTTP history and/or local NATS
    /// push, entirely separate from the Dashboard read-only observation.
    /// No public unauthenticated model Worker endpoint exists.
    pub fn enable_isolated_model_event_ingress(&mut self)->Result<(),String>{
        if self.event_history_api.is_none()&&self.model_nats_receiver.is_none(){
            return Err("Trusted local model EventBus ingress requires an explicit loopback history or NATS endpoint".into());
        }
        self.model_event_ingress_enabled=true;
        Ok(())
    }
    fn apply_issued_model_worker_event(&mut self,id:&str,event:&Value)
        ->Result<bool,String>{
        if field(event,"job_id")!=id{return Ok(false);}
        let kind=field(event,"type");
        if kind=="task.interactive_decision"{
            let job=self.scoped(id)?.load_job(id)?
                .ok_or("Interactive Review EventBus Job disappeared")?;
            self.isolated_project(&job)?;
            if let Some((resumed,accepted))=apply_durable_host_review_event(
                &self.path(),&self.config.graph_directory,id,event)?{
                if !accepted.is_null(){self.emit(accepted);}
                self.emit_job_snapshot(&resumed);
                self.wake(id,"native-host-review.decision")?;
                return Ok(true);
            }
            return Ok(false);
        }
        if !matches!(kind,"task.started"|"task.progress"|"task.completed"|"task.failed"){
            return Ok(false);
        }
        let task_id=field(event,"task_id");
        let current=self.scoped(id)?.load_job(id)?
            .ok_or("Model Events Bus Job disappeared")?;
        let Some(task)=current["tasks"].as_array().into_iter().flatten()
            .find(|task|field(task,"id")==task_id)else{return Ok(false);};
        let execution=field(task,"executionId").to_string();
        let trusted=field(task,"adapter")=="codex"
            &&!execution.is_empty()
            &&event.pointer("/source/id").and_then(Value::as_str)
                ==Some(crate::execution_event_identity::execution_event_source(
                    id,task_id,&execution).as_str());
        if !trusted{return Ok(false);}
        // Direct DAG Model terminal events are explicitly unsupported after
        // the shared task.complete cutover. They were already published to
        // EventBus, so consume/skip them rather than retrying forever and
        // poisoning the pending FIFO/history cursor for valid later events.
        if kind=="task.completed"&&task.get("dagNode").is_some_and(|v|!v.is_null()){
            eprintln!("warning: ignored direct DAG Model completion for Job {id} Task {task_id}; use agents-relay task complete");
            return Ok(false);
        }
        // At-least-once NATS delivery can include an additional start event
        // with a different event_id for the SAME leased generation. Once the
        // Graph has committed RUNNING, start is permanently stale for that
        // execution. Do not requeue this invalid duplicate indefinitely and
        // strand the later genuine task.completed behind it. Out-of-order
        // terminal events on QUEUED generations still retain their retry.
        if kind=="task.started"&&field(task,"state")=="RUNNING"{
            return Ok(false);
        }
        let event_id=field(event,"event_id");
        let key=format!("model-event/{id}/{task_id}/{execution}/{event_id}");
        // New SQLite scopes create their outbox at the first genuine CAS.
        let existing=self.scoped(id)?;
        let table_exists:i64=existing.db.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='workflow_event_outbox'",
            [],|row|row.get(0)).map_err(|error|error.to_string())?;
        let already:i64=if table_exists==0{0}else{
            existing.db.query_row(
                "SELECT COUNT(*) FROM workflow_event_outbox WHERE event_key=?",
                [&key],|row|row.get(0)).map_err(|error|error.to_string())?
        };
        drop(existing);
        if already!=0{return Ok(false);}
        self.accept_model_worker_event(id,task_id,&execution,event)?;
        Ok(true)
    }
    pub fn poll_isolated_model_worker_events(&mut self,id:&str)->Result<usize,String>{
        if !self.model_event_ingress_enabled{return Ok(0);}
        // Recover a dead NATS subscription independently of Pool admission.
        // HTTP history, if configured, remains a separate durable fallback.
        if let Err(error)=self.reconnect_isolated_model_nats_if_needed(){
            eprintln!("warning: Isolated model NATS resubscribe: {error}");
        }
        // Drain a bounded number of NATS callback rows before inspecting
        // this Job. Multi-Job events are cached for their OWN daemon turn,
        // never applied with the wrong Job-scoped SQLite connection.
        let mut received=Vec::new();
        if let Some(receiver)=self.model_nats_receiver.as_ref(){
            for _ in 0..256{
                match receiver.try_recv(){
                    Ok(event)=>received.push(event),
                    Err(_)=>break,
                }
            }
        }
        for event in received{
            let event_job=field(&event,"job_id");
            if event_job.is_empty(){continue;}
            let total:usize=self.model_nats_pending.values().map(Vec::len).sum();
            if total>=1024{continue;}
            self.model_nats_pending.entry(event_job.to_string())
                .or_default().push(event);
        }
        let job=self.scoped(id)?.load_job(id)?
            .ok_or("Model EventBus ingress Job is absent")?;
        self.isolated_project(&job)?;
        let has_model_lease=job["tasks"].as_array().into_iter().flatten().any(|task|
            field(task,"adapter")=="codex"
            &&!field(task,"executionId").is_empty()

            &&matches!(field(task,"state"),"QUEUED"|"RUNNING"));
        let has_review_wait=job["tasks"].as_array().into_iter().flatten().any(|task|
            field(task,"state")=="AWAITING_DECISION"
            &&field(&task["interactiveInvocation"],"status")=="awaiting_decision");
        // A human Review has already dropped the Worker lease. Do not gate
        // its authenticated decision on the unrelated Model-lease heuristic.
        if !has_model_lease&&!has_review_wait{
            self.model_nats_pending.remove(id);
            return Ok(0);
        }
        let mut applied=0;
        let pending=self.model_nats_pending.remove(id).unwrap_or_default();
        for (index,event) in pending.iter().enumerate(){
            match self.apply_issued_model_worker_event(id,event){
                Ok(true)=>applied+=1,
                Ok(false)=>{},
                Err(error)=>{
                    // Original event remains pending on failed SQLite CAS
                    // so a later daemon wake can retry; no fake ack.
                    self.model_nats_pending.entry(id.into()).or_default()
                        .extend_from_slice(&pending[index..]);
                    return Err(error);
                }
            }
        }
        let Some(api)=self.event_history_api.as_ref().cloned() else{
            return Ok(applied);
        };
        let env=json!({
            "EVENTS_BUS_API_URL":api.as_str(),
            "EVENTS_BUS_CONFIG":self.config.store_directory.join(
                ".eventsbus-model-ingress-no-global-config.json").to_string_lossy(),
        });
        let mut after=*self.model_event_cursor.get(id).unwrap_or(&0);
        for _page in 0..4{
            let page=crate::events_bus_runtime::events_bus_history_page(
                id,None,&json!(60),&json!({
                    "order":"asc","after":after,"timeoutMs":1200,
                }),&env)?;
            let rows=page["rows"].as_array()
                .ok_or("Model EventBus history response has no rows")?;
            if rows.is_empty(){break;}
            for row in rows{
                let cursor=row["cursor"].as_i64()
                    .ok_or("Model EventBus history cursor invalid")?;
                if self.apply_issued_model_worker_event(id,&row["event"])?{
                    applied+=1;
                }
                // Failure to commit a legitimate Graph event returns
                // before cursor advance, preserving durable retry.
                after=cursor;
                self.model_event_cursor.insert(id.into(),after);
            }
            if rows.len()<60{break;}
        }
        Ok(applied)
    }
    fn decision_options(&self)->Value{
        let recent=if self.live_store{
            crate::decision_audit::JsonlDecisionAuditStore::new(
                crate::decision_audit::audit_path(&self.config.store_directory)).read_recent_routes(10)
        }else{Vec::new()};
        json!({"decisionMode":if self.live_store{crate::decision::decision_mode()}else{"off"},
            "useDecisionEngine":self.live_store,"recordDecisionAudit":true,"recentRouteResults":recent})
    }
    fn append_routing_audit(&self, record: Option<&Value>) {
        if let Some(record)=record {
            let store=crate::decision_audit::JsonlDecisionAuditStore::new(
                crate::decision_audit::audit_path(&self.config.store_directory));
            if let Err(error)=store.append(record) {
                eprintln!("Decision audit append failed: {error}");
            }
        }
    }
    fn path(&self)->PathBuf{relay_unified_store_path(&self.config.store_directory)}
    /// Isolated writes must be confined to the same disposable caller-owned
    /// workspace as SQLite. A copied Job snapshot pointing at a live source
    /// checkout cannot authorize either a Script Worker or a Git merge/push.
    fn isolated_project(&self,job:&Value)->Result<PathBuf,String>{
        let root=std::fs::canonicalize(field(job,"projectRoot"))
            .map_err(|e|format!("Invalid isolated Job projectRoot: {e}"))?;
        let base=if self.live_store {
            std::fs::canonicalize(&self.config.workspace_root)
                .map_err(|e|format!("Live Workspace Root inaccessible: {e}"))?
        } else {
            std::fs::canonicalize(self.config.store_directory.parent()
                .ok_or("Isolated store has no parent")?)
                .map_err(|e|e.to_string())?
        };
        if root==base || !root.starts_with(&base)
            || root.file_name().and_then(|v|v.to_str())!=Some(field(job,"repository"))
            ||!root.join(".git").exists(){
            return Err(if self.live_store {
                "Live Rust daemon refuses Job outside its canonical local Git workspace"
            }else{
                "Isolated Rust daemon refuses Job project outside its own independent Git fixture"
            }.into());
        }
        Ok(root)
    }
    fn ensure_scoped(&self,id:&str,allow_create:bool)->Result<(),String>{
        if id.is_empty(){return Err("Immutable Job ID required".into());}
        if self.connections.borrow().contains_key(id){return Ok(());}
        if !allow_create&&!self.path().is_file(){
            return Err(format!("SQLite Job {id} not found"));
        }
        let store=SQLiteRelayStore::open_without_claim_reset(&self.path(),Some(id))?;
        self.connections.borrow_mut().insert(id.to_string(),store);
        Ok(())
    }
    fn scoped(&self,id:&str)->Result<Ref<'_,SQLiteRelayStore>,String>{
        self.ensure_scoped(id,false)?;
        Ok(Ref::map(self.connections.borrow(),|stores|stores.get(id).expect("cached scoped DB")))
    }
    fn scoped_create(&self,id:&str)->Result<RefMut<'_,SQLiteRelayStore>,String>{
        self.ensure_scoped(id,true)?;
        Ok(RefMut::map(self.connections.borrow_mut(),|stores|
            stores.get_mut(id).expect("cached scoped DB")))
    }
    fn all(&self)->Result<Vec<Value>,String>{inventory_from_local(&self.config,false)}
    fn persist_exact(&mut self,id:&str,prior:&Value,next:&Value)->Result<Value,String>{
        if field(prior,"id")!=id||field(next,"id")!=id{
            return Err("Cross-Job SQLite CAS forbidden".into());
        }
        let expected=prior.clone();let candidate=next.clone();
        let committed=self.scoped(id)?.mutate_job(id,|current|{
            if current!=expected{
                return Err("Concurrent Job mutation; recompute from SQLite snapshot".into());
            }
            Ok(candidate)
        })?;
        // Node subscribeLocalCommits publishes ONLY committed snapshots;
        // the UI must never see speculative Reconciler or Worker states.
        self.emit_job_snapshot(&committed);
        Ok(committed)
    }
    fn isolated_origin(&self,project:&Path)->Result<(),String>{
        let names=checked_local_git(project,&["remote"])?;
        if !names.lines().any(|name|name=="origin"){return Ok(());}
        let url=checked_local_git(project,&["remote","get-url","--push","origin"])?;
        let raw=Path::new(&url);
        if !raw.is_absolute(){
            return Err("Isolated native daemon refuses network or relative Git origin delivery".into());
        }
        let origin=std::fs::canonicalize(raw)
            .map_err(|e|format!("Invalid isolated Git origin: {e}"))?;
        let parent=std::fs::canonicalize(
            self.config.store_directory.parent().ok_or("Isolated store parent missing")?)
            .map_err(|e|e.to_string())?;
        if !origin.starts_with(parent){
            return Err("Isolated native daemon refuses delivery outside its own Git fixture".into());
        }
        Ok(())
    }
    /// Internal EventBus adapter port. Caller authentication remains the
    /// responsibility of the future provider transport: source correlation
    /// alone is NOT authentication. Never expose this as an open HTTP/CLI
    /// command or treat a submission receipt as Worker completion.
    pub fn accept_model_worker_event(&mut self,job_id:&str,task_id:&str,
        execution_id:&str,event:&Value)->Result<Value,String>{
        let job=self.scoped(job_id)?.load_job(job_id)?
            .ok_or_else(||format!("SQLite Job {job_id} not found"))?;
        self.isolated_project(&job)?;
        let result=apply_verified_worker_event(&self.path(),&self.config.graph_directory,
            job_id,task_id,execution_id,event)?;
        // Node ReconcilerRuntime.markWorkerStarted executes only AFTER the
        // authoritative Graph/SQLite task.started receipt. The browser
        // delivery receipt itself is never evidence of Worker execution.
        update_live_worker_from_committed_event(
            &mut *self.live_workers.lock()
                .map_err(|_|"Daemon live worker lock poisoned")?,
            &result,task_id,execution_id,field(event,"type"));
        // This audit is strictly post-Graph/SQLite commit. A rejected or
        // duplicate execution cannot append an outcome, and an audit I/O
        // failure is observational (never rolls back durable Task state).
        if matches!(field(event,"type"),"task.completed"|"task.failed"){
            if let Some(task)=result["tasks"].as_array().into_iter().flatten()
                .find(|task|field(task,"id")==task_id){
                let audit_path=crate::decision_audit::audit_path(&self.config.store_directory);
                record_terminal_route_outcome_jsonl(
                    &audit_path,task,event,Some(execution_id));
            }
        }
        // Notifications and scheduling are post-commit effects. A submitted
        // browser receipt or a speculative provider callback must never
        // notify Dashboard that an uncommitted Task succeeded.
        self.emit(event.clone());
        self.emit_job_snapshot(&result);
        if matches!(field(event,"type"),"task.completed"|"task.failed"){
            self.wake(job_id,"native-model-worker.terminal")?;
        }
        Ok(result)
    }
    pub fn reconcile_remote_delivery(&self,id:&str,expected_sha:&str)->Result<(),String>{
        let job=self.scoped(id)?.load_job(id)?
            .ok_or_else(||format!("SQLite Job {id} not found"))?;
        if job.pointer("/localMerge/mergedCommitSha").and_then(Value::as_str)
            !=Some(expected_sha) || expected_sha.is_empty(){
            return Err("Remote delivery expected SHA no longer matches SQLite completion".into());
        }
        let project=self.isolated_project(&job)?;
        // The fixture-only origin fence must never reject a canonical live repository.
        if !self.live_store { self.isolated_origin(&project)?; }
        let graph=self.config.graph_directory.clone();
        reconcile_completed_local_delivery(&graph,id,&project,
            |job_id|self.scoped(job_id)?.load_job(job_id)?
                .ok_or_else(||format!("SQLite Job {job_id} not found")),
            |job_id,mutate|{
                let mut changed=false;
                let saved=self.scoped(job_id)?.mutate_job(job_id,|mut job|{
                    changed=mutate(&mut job)?;
                    Ok(job)
                })?;
                Ok((saved,changed))
            })
    }
    fn apply_dashboard_task_action(&mut self,id:&str,task_id:&str,action:&str)
        ->Result<Value,String>{
        let current=self.scoped(id)?.load_job(id)?
            .ok_or_else(||format!("SQLite Job {id} not found"))?;
        self.isolated_project(&current)?;
        let command=dashboard_task_action(&current,task_id,action)?;
        let result=crate::task_actions::dispatch_task_action(
            &self.config.graph_directory,&*self.scoped(id)?,&command)?;
        self.wake(id,"dashboard.task.action")?;
        Ok(result["job"].clone())
    }
    fn emit_sse(&mut self,frame:String){
        self.subscriptions.retain(|sender|sender.send(frame.clone()).is_ok());
    }
    fn emit(&mut self,event:Value){
        // Original Node Dashboard bus.subscribe wraps each event in a
        // named SSE "relay" frame. A bare JSON string in the socket is
        // ignored by EventSource and cannot update live Dashboard bubbles.
        let payload=json!({"event":event});
        self.emit_sse(format!("event: relay\ndata: {payload}\n\n"));
    }
    fn emit_job_snapshot(&mut self,job:&Value){
        let id=field(job,"id");
        if id.is_empty(){return;}
        let payload=json!({"job":job}).to_string();
        if self.last_sse_snapshot.get(id).is_some_and(|prior|prior==&payload){
            return;
        }
        self.last_sse_snapshot.insert(id.to_owned(),payload.clone());
        self.emit_sse(format!("data: {payload}\n\n"));
    }
    /// Current Job Graph invokes this effect; the shared local Git module
    /// owns immutable source/target ref checks and completion guard. Each
    /// SQLite snapshot/merge receipt uses an exact CAS, never overwriting
    /// concurrent Task/Review progress.
    pub fn reconcile_git_delivery(&self,id:&str)->Result<bool,String>{
        let mut job=self.scoped(id)?.load_job(id)?
            .ok_or_else(||format!("SQLite Job {id} not found"))?;
        if field(&job,"state")!="ACTIVE"{return Ok(false);}
        let project=self.isolated_project(&job)?;
        // Jobs created without --local-merge-source could previously show
        // MERGE_PENDING forever: no Graph-owned merge effect was eligible.
        // Persist an exact approved Git branch receipt with a SQLite CAS
        // BEFORE running the existing Job Lifecycle merge Graph. Never
        // bypass Graph completion or fabricate historical Planner SUCCESS.
        if let Some(request)=reviewed_checkout_merge_request(&project,&job)?{
            let before=job.clone();
            job=self.scoped(id)?.mutate_job(id,|current|{
                if current!=before{return Err("Concurrent reviewed Git merge staging CAS conflict".into());}
                let mut staged=current;
                staged["localMerge"]=request.clone();
                staged["updatedAt"]=json!(crate::local_merge_lock::iso8601_now());
                Ok(staged)
            })?;
        }
        // Materialize the Project Runner's declared Coordinator receipt only
        // from committed Graph/SQLite SUCCEEDED child Tasks. This projection
        // never advances Job/Task/Review state or overwrites run files.
        let output_root=if self.live_store{
            project.clone()
        }else{
            std::fs::canonicalize(self.config.store_directory.parent()
                .ok_or("Isolated Coordinator output root missing")?)
                .map_err(|e|e.to_string())?
        };
        if let Err(error)=crate::dag_coordinator_receipt::materialize_committed_dag_receipts(
            &job,&project,&output_root){
            // A pre-existing malformed/relative Coordinator output is NOT
            // permission to write it. Also not permission to stop the entire
            // workspace's independent Job reconciliation: the Reviewer will
            // still detect its missing artifact; no Task state is inferred.
            eprintln!("warning: Coordinator receipt Job {id} not materialized: {error}");
        }
        let ref_name=job.pointer("/localMerge/sourceRef")
            .and_then(Value::as_str).filter(|s|!s.is_empty());
        let head=ref_name.map(|ref_name|local_source_head(&project,ref_name))
            .transpose()?;
        let timestamp=chrono::Utc::now().timestamp_millis();
        let graph=self.config.graph_directory.clone();
        let prior=RefCell::new(job.clone());
        let save=|candidate:Value,event:Option<Value>|{
            let outcome=(||->Result<Value,String>{
                let expected=prior.borrow().clone();
                let db=self.scoped(id)?;
                let committed=if let Some(event)=event{
                    let key=event.get("event_id").and_then(Value::as_str)
                        .ok_or("Merge result has no durable event identity")?;
                    db.commit_workflow_mutation_and_events(id,|current|{
                        if current!=expected{return Err("Concurrent Job merge receipt CAS conflict".into());}
                        Ok(candidate)
                    },&[json!({"key":key,"event":event})])?
                }else{
                    db.mutate_job(id,|current|{
                        if current!=expected{return Err("Concurrent Job completion CAS conflict".into());}
                        Ok(candidate)
                    })?
                };
                prior.replace(committed.clone());
                Ok(committed)
            })();
            ready(outcome)
        };
        let future=reconcile_local_git_completion(&graph,&mut job,head.as_deref(),
            true,Some(&project),timestamp,save,native_merge_effect);
        // This action's save adapter is entirely synchronous SQLite I/O.
        // A pending Future would be a wiring bug, never a reason to mark
        // a Job complete without committed source/target evidence.
        let mut future=pin!(future);
        let mut ctx=Context::from_waker(Waker::noop());
        match future.as_mut().poll(&mut ctx){
            Poll::Ready(result)=>result,
            Poll::Pending=>Err("Native local Git completion effect unexpectedly suspended".into())
        }
    }
}
impl IsolatedSQLiteWriteHost {
    /// Automatic Reconciler Planner effect, reusing the exact native
    /// PlannerLaunchPorts/finishPlanner Script runner as manual job.plan.
    /// The Plan is already Graph-authorized and durably CAS-committed before
    /// this volatile effect. Never create a second Plan or launch Codex.
    /// One provider inventory for both Plan Apply forward-convergence and
    /// Planner route selection. Never advertise a transport that the daemon
    /// has not explicitly initialized and verified.
    /// Source Tasks must have an owned local source branch/worktree before
    /// their execution is leased. Otherwise task.started cannot bind the Git
    /// baseline and the Worker can edit/commit main while SQLite stays QUEUED.
    /// Persist sourceRef with exact SQLite CAS, then prepare the checkout.
    fn prepare_model_execution_checkout(
        &mut self,job_id:&str,job:&Value,task_id:&str,
    )->Result<(Value,PathBuf),String>{
        let task=job.get("tasks").and_then(Value::as_array)
            .into_iter().flatten().find(|task|field(task,"id")==task_id)
            .ok_or("Source checkout Task missing")?;
        let requires_git=task["gitDeliveryRequired"]==true;
        let managed=task_requires_managed_worktree(job,Some(task));
        let project=self.isolated_project(job)?;
        let mut current=job.clone();
        if requires_git&&field(&current["localMerge"],"sourceRef").is_empty(){
            // isolated_project() already confines tests to their independent
            // caller-owned Git fixture; live mode confines to its Workspace.
            let source=ensure_local_job_source_branch(&project,&current)?;
            let mut configured=current.clone();
            configured["localMerge"]=json!({"sourceRef":source,
                "targetRef":"refs/heads/main","status":"pending"});
            configured["updatedAt"]=json!(crate::local_merge_lock::iso8601_now());
            current=self.persist_exact(job_id,&current,&configured)?;
        }
        if managed{
            let checkout=prepare_local_job_execution_worktree(
                &project,&current,&self.config.workspace_root)?;
            // Optional host-local tooling; never affect the Task Graph or
            // resync an existing checkout index on each Worker invocation.
            if self.live_store && field(task,"adapter")=="codex" && checkout!=project {
                if let Some(executable)=crate::codegraph_index::installed_codegraph(){
                    if let Err(error)=crate::codegraph_index::prepare_worktree_index(
                        &executable,&project,&checkout){
                        eprintln!("warning: CodeGraph index preparation Job {job_id}: {error}");
                    }
                }
            }
            return Ok((current,checkout));
        }
        Ok((current,project))
    }
    fn available_model_workers(&self)->Vec<Value>{
        let mut workers=Vec::new();
        if self.model_codex_executable.is_some(){
            workers.push(json!({"workerId":"codex","id":"codex","name":"codex",
                "adapter":"codex","runtime":"codex",
                "capabilities":["model","codex","local_repo","iterative_tools"]}));
        }
        workers
    }
    fn launch_graph_planner_effect(&mut self,action:&Value)->Result<(),String>{
        let id=field(action,"jobId");
        let plan_id=field(action,"planId");
        if id.is_empty()||plan_id.is_empty(){
            return Err("Graph Planner launch requires exact Job/Plan ID".into());
        }
        let job=self.scoped(id)?.load_job(id)?
            .ok_or("Graph Planner Job was not committed to SQLite")?;
        let project=self.isolated_project(&job)?;
        let plan=job.get("plans").and_then(Value::as_array)
            .into_iter().flatten().find(|plan|field(plan,"id")==plan_id)
            .ok_or("Graph Planner Plan was not committed to SQLite")?;
        if field(plan,"status")!="PLANNING"{
            // A stale planner effect may arrive after the first generation
            // committed; never start a duplicate execution.
            return Ok(());
        }
        // An existing OS process owns its exact Planner generation. The
        // current process identity, not a deadline, prevents duplicate launch.
        if !field(plan,"executionId").is_empty(){
            let execution=field(plan,"executionId");
            let record=self.scoped(id)?.load_execution_process(id,plan_id,execution)?;
            // The claimed Plan may still be starting: missing identity is
            // not evidence that the new process exited.
            let Some(record)=record else{return Ok(());};
            let state=crate::process_identity::probe_process_record(&record);
            if state=="alive"||state=="unknown"{return Ok(());}
            let recovered=crate::planner_runtime::fail_plan_execution(
                &self.config.graph_directory,&job,plan_id,execution,
                "Planner process exited without a verified Plan result",
                &crate::local_merge_lock::iso8601_now())?;
            if recovered!=job{
                self.persist_exact(id,&job,&recovered)?;
            }
            return Ok(());
        }
        let declared=project.join("agents/.shortcut/planner.agent.mjs");
        // Absence may select the authorized Model provider; an existing but
        // broken/escaping Script contract must fail closed, not fall back.
        let script=if std::fs::symlink_metadata(&declared).is_ok(){
            let resolved=std::fs::canonicalize(&declared)
                .map_err(|e|format!("Invalid automatic Planner Shortcut: {e}"))?;
            if !resolved.starts_with(&project)||!resolved.is_file(){
                return Err("Automatic Planner Shortcut escapes canonical Job Git root".into());
            }
            Some(resolved)
        }else{None};
        // Model-only Jobs do not require a Planner Shortcut. Their Graph
        // selected repair Plan must run through the explicitly configured
        // native Codex provider, never a Node fallback.
        let codex=if self.live_store{
            self.model_codex_executable.clone()
        }else{None};
        if script.is_none()&&codex.is_none(){
            return Err("Automatic Planner needs a trusted Script or configured native Codex provider".into());
        }
        let interpreter=if script.is_some(){
            Some(PathBuf::from(configured_script_interpreter()?))
        }else{None};
        let timeout=plan.get("timeoutMs").and_then(Value::as_u64)
            .unwrap_or(60_000).clamp(100,86_400_000);
        // A soft high-reasoning preference ranks *eligible* profiles; the
        // DecisionRouter selects the actual model/profile from configured
        // provider routes. No model or profile is invented by the Planner.
        let planner_route=if codex.is_some()&&script.is_none(){
            let usage=self.account_usage().ok();
            let mut options=self.decision_options();
            options["taskFacts"]=json!({"task":{"kind":"planner","agentName":"planner","jobId":id,"id":plan_id},"routingPreferences":job.get("routingPreferences")});
            // Planner's own default is not a user Job preference. Preserve its
            // fallback ranking without elevating it over global user rules.
            options["modelPreference"]=json!({"reasoning":"high"});
            options["fallbackRoutingPreferences"]=json!({"reasoning":"high"});
            options["usage"]=json!(usage);
            let workers=self.available_model_workers().into_iter()
                .filter(|worker|field(worker,"adapter")=="codex")
                .collect::<Vec<_>>();
            let routed=crate::execution_routing::route_execution(
                &workers,&json!({"capabilities":["model"]}),
                &options,
                &self.config.profile_home,&self.config.policy_path,
                &self.config.router_rules_path,
                chrono::Utc::now().timestamp_millis(),None,None,options["recentRouteResults"].as_array().map(Vec::as_slice).unwrap_or(&[]),None)?;
            Some(routed)
        }else{None};
        let graph=self.config.graph_directory.clone();
        let store_directory=self.config.store_directory.clone();
        let db=self.path();
        let job_id=id.to_string();
        let plan_id=plan_id.to_string();
        std::thread::Builder::new().name(format!("rust-automatic-planner-{plan_id}"))
            .spawn(move||{
                let result=if let (Some(script),Some(interpreter))=(script,interpreter){
                    run_isolated_script_planner(&db,&store_directory,&graph,
                        &job_id,&plan_id,&script,&interpreter,timeout)
                }else if let Some(executable)=codex{
                    crate::native_script_planner::run_native_codex_planner_with_route(
                        &db,&store_directory,&graph,&job_id,&plan_id,&executable,
                        timeout,planner_route)
                }else{Err("Automatic Planner provider lost before launch".into())};
                if let Err(error)=result{
                    eprintln!("Native automatic Planner {job_id}/{plan_id}: {error}");
                }
            }).map_err(|e|format!("Cannot spawn isolated automatic Planner: {e}"))?;
        Ok(())
    }
}
impl WorkspaceControlBackend for IsolatedSQLiteWriteHost {
    fn graph_directory(&self)->&Path{&self.config.graph_directory}
    fn store_directory(&self)->&Path{&self.config.store_directory}
    fn repositories(&self)->Vec<String>{self.config.repositories.clone()}
    fn repository_path(&self,repository:&str)->Option<String>{
        if let Some(root)=self.all().ok()?.into_iter()
            .find(|j|field(j,"repository")==repository)
            .and_then(|j|j.get("projectRoot").and_then(Value::as_str).map(str::to_owned)){
            return Some(root);
        }
        // Node's startup discovery recursively walks independently nested
        // local Git roots beneath Workspace (for example neo/project).
        // Use the ported canonical discovery function so Project Runner Jobs
        // under nested roots have the same immutable repository identity,
        // collision refusal and symlink boundary as Node.
        if !self.live_store || repository.is_empty()
            || repository=="." || repository==".." {
            return None;
        }
        let base=std::fs::canonicalize(&self.config.workspace_root).ok()?;
        // Search all valid workspace Git roots, but apply collision fencing
        // to THIS repository identity only. An unrelated Xcode SourcePackages
        // duplicate must not prevent a legitimate new Project Runner Job.
        let mut match_root:Option<PathBuf>=None;
        for found in crate::workspace::discover_git_repositories(&base){
            if found.file_name().and_then(|v|v.to_str())!=Some(repository){
                continue;
            }
            let candidate=std::fs::canonicalize(found).ok()?;
            if candidate==base || !candidate.starts_with(&base)
                ||candidate.file_name().and_then(|v|v.to_str())!=Some(repository)
                ||!candidate.join(".git").exists(){
                return None;
            }
            if let Some(prior)=&match_root{
                if prior!=&candidate{return None;}
            }else{
                match_root=Some(candidate);
            }
        }
        match_root.map(|root|root.to_string_lossy().to_string())
    }
    fn known_jobs(&mut self)->Result<Vec<Value>,String>{self.all()}
    fn load_job(&mut self,id:&str)->Result<Value,String>{
        self.scoped(id)?.load_job(id)?.ok_or_else(||format!("SQLite Job {id} not found"))
    }
    fn save_job(&mut self,job:&Value)->Result<Value,String>{
        let id=field(job,"id");
        self.scoped(id)?.save_job(job)?;
        self.emit_job_snapshot(job);
        Ok(job.clone())
    }
    fn create_job_if_absent(&mut self,job:&Value)->Result<Value,String>{
        // Creation is the first point where an untrusted Control request can
        // establish its source root. Refuse outside-fixture roots BEFORE
        // opening or mutating SQLite, rather than relying on later actions.
        self.isolated_project(job)?;
        let id=field(job,"id");
        let saved=self.scoped_create(id)?.create_job_if_absent(job)?;
        self.emit_job_snapshot(&saved);
        Ok(saved)
    }
    fn mutate_job(&mut self,id:&str,reduce:&dyn Fn(&mut Value)->Result<(),String>)
        ->Result<Value,String>{
        let saved=self.scoped(id)?.mutate_job(id,|mut job|{
            reduce(&mut job)?;Ok(job)
        })?;
        self.emit_job_snapshot(&saved);
        Ok(saved)
    }
    fn mutate_job_with_terminal_event(&mut self,id:&str,event:&Value,
        execution_id:&str,reduce:&dyn Fn(&mut Value)->Result<(),String>)
        ->Result<Value,String>{
        let task=field(event,"task_id");
        let event_id=field(event,"event_id");
        let key=format!("model-event/{id}/{task}/{execution_id}/{event_id}");
        if field(event,"type")!="task.completed" || field(event,"job_id")!=id
            || !verified_worker_outbox_event(&key,"task.completed",event){
            return Err("Invalid terminal event publication identity".into());
        }
        let intent=json!({"key":key,"event":event});
        let saved=self.scoped(id)?.commit_workflow_mutation_and_events(id,|mut job|{
            reduce(&mut job)?;Ok(job)
        },&[intent])?;
        self.emit_job_snapshot(&saved);
        Ok(saved)
    }
    fn append_task(&mut self,id:&str,task:&Value)->Result<Value,String>{
        if field(task,"jobId")!=id||field(task,"id").is_empty(){
            return Err("Task create requires immutable Job/Task identity".into());
        }
        let saved=self.scoped(id)?.mutate_job(id,|mut job|{
            let list=job.get_mut("tasks").and_then(Value::as_array_mut)
                .ok_or("Job Task list unavailable")?;
            if list.iter().any(|row|field(row,"id")==field(task,"id")){
                return Err("Task ID already allocated".into());
            }
            list.push(task.clone());Ok(job)
        })?;
        self.emit_job_snapshot(&saved);
        Ok(saved)
    }
    fn save_agent(&mut self,id:&str,agent:&Value)->Result<(),String>{
        self.scoped(id)?.upsert_agent(agent)
    }
    fn list_agents(&mut self,id:&str)->Result<Vec<Value>,String>{
        Ok(self.scoped(id)?.load_agents()?.unwrap_or_default())
    }
    fn wake(&mut self,id:&str,reason:&str)->Result<(),String>{
        self.wake_count+=1;
        // Node pool.reconcileLocalJob schedules canonical work immediately.
        // Preserve this local wake until the single daemon Reconciler consumes
        // it; emitting SSE alone cannot wake the five-minute scan.
        self.wake_pending=true;
        self.emit(json!({"type":"relay.wake","jobId":id,"reason":reason}));
        // Snapshot readback is observational. A wake that has not yet
        // committed cannot invent a fresh Job/Task state.
        if let Ok(Some(job))=self.scoped(id).and_then(|db|db.load_job(id)){
            self.emit_job_snapshot(&job);
        }
        Ok(())
    }
    fn refresh_inventory(&mut self)->Result<(),String>{
        // Dashboard reads the authoritative SQLite inventory per request.
        Ok(())
    }
    fn publish(&mut self,event:&Value)->Result<(),String>{
        // Reconciler broadcasts only AFTER its canonical SQLite CAS. The
        // original Node daemon publishes the same eventFor envelope to NATS
        // in addition to the in-process SSE. A Rust host that only sends SSE
        // leaves new Jobs invisible to /api/mobile/job-activity even while
        // historical Node events are visible.
        //
        // Do not forward an untrusted webhook/wake shape as an execution
        // event. The broker's own NATS subject is validated by publish().
        // A successful PUB followed by PONG proves broker acceptance but
        // cannot create or alter Task state; that belongs to SQLite/Graph.
        if self.live_store
            &&event["version"]==1
            &&event.get("event_id").and_then(Value::as_str)
                .is_some_and(|value|!value.is_empty())
            &&event.get("timestamp").and_then(Value::as_str)
                .is_some_and(|value|!value.is_empty())
            &&matches!(field(event,"type").split('.').next(),
                Some("job"|"task"|"review"|"planner")){
            let publisher=self.model_nats_publisher.as_ref()
                .ok_or("Live Graph lifecycle Events Bus publisher is not bound")?;
            publisher.publish(event)?;
            publisher.ping().map_err(|error|format!(
                "Live Graph event publication broker acknowledgement unavailable: {error}"))?;
        }
        // Keep Dashboard SSE as a distinct observational channel.
        self.emit(event.clone());
        Ok(())
    }
    fn manual_plan(&mut self,id:&str,guidance:Option<&str>,force:bool)
        ->Result<Value,String>{
        let current=self.scoped(id)?.load_job(id)?
            .ok_or_else(||format!("SQLite Job {id} not found"))?;
        self.isolated_project(&current)?;
        let timeout=60_000u64;
        let graph=self.config.graph_directory.clone();
        let mut scheduled_round=None;
        let committed=self.scoped(id)?.mutate_job(id,|job|{
            let (next,round)=prepare_manual_plan(&graph,&job,guidance,timeout,
                force,|job,guidance,timeout|create_plan_round(&graph,job,guidance,
                    true,Some(timeout),None))?;
            scheduled_round=Some(round);
            Ok(next)
        })?;
        let round=scheduled_round.ok_or("Durable Planner did not create a round")?;
        let plan_id=field(&round,"id").to_owned();
        // Use the same provider-aware launch effect as Graph reconciliation.
        self.launch_graph_planner_effect(&json!({"jobId":id,"planId":plan_id}))?;
        Ok(json!({"job":committed,"round":round}))
    }
    fn task_update(&mut self,id:&str,task_id:&str,task:&Value,
        expected_updated_at:&str)->Result<Value,String>{
        let original=self.scoped(id)?.load_job(id)?
            .ok_or_else(||format!("SQLite Job {id} not found"))?;
        self.isolated_project(&original)?;
        let scoped=self.scoped(id)?;
        let updated=crate::task_update::apply_managed_task_update(
            &self.config.graph_directory,&scoped,id,task_id,
            task,expected_updated_at)?;
        drop(scoped);
        self.wake(id,"control.task.update")?;
        Ok(updated)
    }
    fn review_targeted(&mut self,id:&str,request:&Value)->Result<Value,String>{
        // Only the exact reviewer execution and immutable reviewed HEAD can
        // submit a correction. Atomic SQLite mutation allocates one numeric
        // child ID, appends the feedback and enqueues the Revision Graph task.
        let mut input=request.clone();
        if input.get("originalTaskId").is_some()
            &&input["originalTaskId"]!=input["taskId"]{
            return Err("Reviewer original Task identity conflicts with requested Task".into());
        }
        input["originalTaskId"]=input["taskId"].clone();
        let directory=self.config.store_directory.clone();
        let graph=self.config.graph_directory.clone();
        self.scoped(id)?.submit_review_revision(&directory,&graph,id,&input)
    }
    fn blocker_ensure(&mut self,request:&Value)->Result<Value,String>{
        // This port accepts only caller-owned independent Git fixtures. The
        // native Graph produces both snapshots, then a single SQLite CAS
        // commits the blocker relation and dependent receipt atomically.
        crate::blocker_recovery::validate_input(request)?;
        let dependent_id=field(request,"dependentJobId");
        let dependent=self.scoped(dependent_id)?.load_job(dependent_id)?
            .ok_or("Dependent Job not found")?;
        self.isolated_project(&dependent)?;
        if field(&dependent,"repository")!=field(request,"dependentRepository"){
            return Err("Blocker dependent repository identity mismatch".into());
        }
        // Validate the target repository's path before allocating any ID.
        let target=json!({"repository":request.get("targetRepository"),
            "projectRoot":request.get("targetProjectRoot")});
        self.isolated_project(&target)?;
        // Inventory discovery projects legacy fields; reload each candidate
        // from its authoritative scoped SQLite snapshot for exact CAS.
        let snapshots=crate::relay_store_discovery::discover_local_relay_store_snapshots(
            &self.config.store_directory)?;
        let mut known=Vec::new();
        for snapshot in snapshots{
            for summary in snapshot.jobs{
                let id=field(&summary,"id");
                let current=self.scoped(id)?.load_job(id)?
                    .ok_or_else(||format!("Discovered blocker Job {id} disappeared"))?;
                known.push(current);
            }
        }
        let plan={
            let future=crate::blocker_recovery::ensure_blocker_recovery(
                &self.config.graph_directory,&self.config.store_directory,
                request,&dependent,&known,request.get("now").and_then(Value::as_str));
            let mut future=pin!(future);
            let mut context=Context::from_waker(Waker::noop());
            match future.as_mut().poll(&mut context){
                Poll::Ready(result)=>result?,
                Poll::Pending=>return Err("Native blocker recovery unexpectedly suspended".into()),
            }
        };
        let blocker_id=field(&plan.blocker,"id").to_owned();
        let prior=known.iter().find(|job|field(job,"id")==blocker_id);
        self.scoped(dependent_id)?.commit_blocker_recovery_pair(
            &dependent,&plan.dependent,prior,&plan.blocker)?;
        self.wake(dependent_id,"blocker.recovery.registered")?;
        self.wake(&blocker_id,"blocker.recovery.registered")?;
        Ok(plan.receipt)
    }
    fn blocker_resolve(&mut self,_:&str,_:&str)->Result<Value,String>{Err(denied("blocker_resolve"))}
    fn validate_dag_result(&mut self,job:&Value,task:&Value)->Result<Value,String>{
        // Identical shared validator is used by native Script and CLI Model
        // completion. The canonical project is checked against the daemon's
        // isolated/live workspace before reading any caller-owned output.
        self.isolated_project(job)?;
        let interpreter=crate::native_script_worker::configured_script_interpreter()?;
        crate::dag_precompletion::validate_dag_precompletion(
            job,task,Path::new(&interpreter))
    }
    fn local_head(&mut self,job:&Value)->Result<String,String>{source_commit_sha(job)}
    fn fail_interactive(&mut self,id:&str,task:&str,execution:&str,reason:&str)
        ->Result<Value,String>{
        fail_interactive_review(&self.config.graph_directory,&*self.scoped(id)?,id,task,execution,reason)
    }
}
impl DaemonServices for IsolatedSQLiteWriteHost {
    fn control(&mut self,body:&Value)->Result<Value,String>{
        if field(body,"command")=="job.reconcile"{
            let id=field(body,"jobId");
            if id.is_empty(){return Err("job.reconcile requires immutable Job ID".into());}
            // Stable Node's control.job.reconcile awaits the actual Pool
            // pass. Do not acknowledge only a Dashboard wake receipt.
            return self.job_action(id,"reconcile");
        }
        if field(body,"command")=="plan.apply"{
            let job_id=field(body,"jobId");
            let plan_id=field(body,"planId");
            let execution_id=field(body,"executionId");
            let proposal=body.get("proposal").filter(|value|value.is_object())
                .ok_or("Planner apply requires validated JSON proposal")?;
            if job_id.is_empty()||plan_id.is_empty()||execution_id.is_empty(){
                return Err("Planner apply requires immutable Job/Plan/execution identity".into());
            }
            let current=self.scoped(job_id)?.load_job(job_id)?
                .ok_or("Planner apply Job not found")?;
            self.isolated_project(&current)?;
            let available=self.available_model_workers();
            let committed=crate::native_script_planner::apply_isolated_planner_proposal(
                &self.path(),&self.config.store_directory,
                &self.config.graph_directory,job_id,plan_id,execution_id,proposal,
                &available)?;
            let persisted={self.scoped(job_id)?.load_job(job_id)?};
            if let Some(job)=persisted{
                self.emit_job_snapshot(&job);
            }
            self.wake(job_id,"native-plan.apply")?;
            return Ok(committed);
        }
        workspace_control(self,body)
    }
    fn deliver_pending_escalations(&mut self,id:&str)->Result<(),String>{
        // Node Reconciler calls this before normal Task reconciliation.
        // Isolated tests have NO external notifier credentials: record a
        // durable missing-channel observation, not an invented delivery.
        let current=self.scoped(id)?.load_job(id)?
            .ok_or("Escalation notification Job missing from SQLite")?;
        self.isolated_project(&current)?;
        let notify:Option<Box<dyn Fn(&Value)->Result<Value,String>>>=
            self.escalation_notifier.as_ref().map(|config|{
                let config=config.clone();
                Box::new(move |request:&Value|{
                    crate::escalation_notifier::send_escalation_notification(&config,request)
                }) as Box<dyn Fn(&Value)->Result<Value,String>>
            });
        crate::escalation_notifier::deliver_pending_escalations(
            &current,id,std::time::SystemTime::now(),notify,
            |task_id,escalation_id,mutation|{
                self.scoped(id)?.mutate_job(id,|mut job|{
                    let mut candidate=job.get("tasks").and_then(Value::as_array)
                        .into_iter().flatten().find(|task|field(task,"id")==task_id)
                        .cloned().ok_or("Notification Task absent from SQLite")?;
                    // A verified receipt must go through the canonical
                    // conflict checker even if another worker already marked
                    // it delivered: matching duplicates are idempotent and
                    // contradictory receipts are rejected, never hidden.
                    if let crate::escalation_notifier::NotificationMutation::Delivered{ref receipt}=mutation{
                        return Ok(crate::task_recovery::record_escalation_notification_delivery(
                            &job,task_id,escalation_id,receipt)?["job"].clone());
                    }
                    let escalation=&candidate["escalation"];
                    if field(escalation,"id")!=escalation_id
                        ||field(escalation,"status")!="pending"
                        ||field(&escalation["notification"],"status")=="delivered"{
                        // Failed/no-channel attempts cannot overwrite a
                        // replacement or already delivered escalation.
                        return Ok(job);
                    }
                    match mutation{
                        crate::escalation_notifier::NotificationMutation::Delivered{..}=>{
                            unreachable!("validated delivery handled above")
                        },
                        crate::escalation_notifier::NotificationMutation::MissingChannel=>{
                            let notification=&mut candidate["escalation"]["notification"];
                            if !notification.is_object(){*notification=json!({});}
                            notification["status"]=json!("pending");
                            notification["lastError"]=json!(
                                "Notification delivery channel is not configured");
                        },
                        crate::escalation_notifier::NotificationMutation::Failed{
                            ref message,attempts,ref last_attempt_at,ref next_attempt_at,
                        }=>{
                            let notification=&mut candidate["escalation"]["notification"];
                            if !notification.is_object(){*notification=json!({});}
                            notification["status"]=json!("pending");
                            notification["attempts"]=json!(attempts);
                            notification["lastError"]=json!(message);
                            notification["lastAttemptAt"]=json!(last_attempt_at);
                            notification["nextAttemptAt"]=json!(next_attempt_at);
                        },
                    }
                    let entry=job.get_mut("tasks").and_then(Value::as_array_mut)
                        .and_then(|tasks|tasks.iter_mut().find(|t|field(t,"id")==task_id))
                        .ok_or("Notification Task disappeared before SQLite write")?;
                    *entry=candidate;
                    Ok(job)
                })?;
                Ok(())
            },true)?;
        Ok(())
    }
    fn load(&mut self,id:&str)->Result<Value,String>{WorkspaceControlBackend::load_job(self,id)}
    fn load_execution_process(&mut self,id:&str,task:&str,execution:&str)
        ->Result<Option<Value>,String>{
        self.scoped(id)?.load_execution_process(id,task,execution)
    }
    fn save_exact(&mut self,id:&str,prior:&Value,next:&Value)->Result<Value,String>{
        self.persist_exact(id,prior,next)
    }
    fn job_action(&mut self,id:&str,action:&str)->Result<Value,String>{
        let current=self.scoped(id)?.load_job(id)?
            .ok_or_else(||format!("SQLite Job {id} not found"))?;
        // Production writes must stay in their canonical local Git tree.
        // Isolated fixtures may have historical DRAFT Jobs with nonexistent
        // paths; Node's reconcile on these is a harmless no-op/wake.
        if self.live_store{self.isolated_project(&current)?;}
        match action {
            "start"=>{
                let next=crate::job_actions::apply_job_activate_action(
                    &self.config.graph_directory,&current)?;
                let saved=self.persist_exact(id,&current,&next)?;
                self.wake(id,"dashboard.job.start")?;
                Ok(saved)
            }
            "cancel"=>{
                let graph=self.config.graph_directory.clone();
                let saved=self.scoped(id)?.mutate_job(id,|fresh|{
                    crate::job_actions::apply_job_cancel_action(&graph,&fresh,None)
                })?;
                self.wake(id,"dashboard.job.cancel")?;
                Ok(saved)
            }
            "reconcile"=>{
                // Terminal Jobs never re-enter the Graph or change their
                // immutable accepted Git head. A DRAFT Job, however, must
                // still pass through the same Graph snapshot reconciler so
                // a verified local Git HEAD replaces a stale cached headSha
                // without launching a Worker or changing the Job lifecycle.
                // The Graph itself decides that DRAFT cannot dispatch work.
                if !matches!(field(&current,"state"),"ACTIVE"|"DRAFT"){
                    self.wake(id,"dashboard.job.reconcile")?;
                    return Ok(current);
                }
                // The same Graph/SQLite Reconciler as periodic Pool admission.
                let config=self.config.clone();
                let owner=format!("isolated-rust-daemon-{}",std::process::id());
                let runtime_config=config.clone();
                let live_store=self.live_store;
                crate::relayd::reconcile_one_daemon_job(
                    &config,self,id,config.concurrency,move |_snapshot|{
                        let config=&runtime_config;
                        Ok(Reconciler::new(
                            config.graph_directory.clone(),
                            config.store_directory.clone(),
                            config.profile_home.clone(),
                            config.policy_path.clone(),
                            config.router_rules_path.clone(),
                            json!({"owner":owner,
                                "maxConcurrent":config.concurrency,"decisionMode":if live_store{crate::decision::decision_mode()}else{"off"},
                                "useDecisionEngine":live_store,"recordDecisionAudit":live_store,
                                })))
                    })
            },
            _=>Err(format!("Unsupported Job action {action}")),
        }
    }
    fn task_command(&mut self,body:&Value)->Result<Value,String>{
        let id=field(body,"jobId");
        let task_id=field(body,"taskId");
        match field(body,"action"){
            "retry"|"cancel"=>self.apply_dashboard_task_action(
                id,task_id,field(body,"action")),
            "update"=>{
                let current=self.scoped(id)?.load_job(id)?
                    .ok_or_else(||format!("SQLite Job {id} not found"))?;
                self.isolated_project(&current)?;
                let task=body.get("task").filter(|value|value.is_object())
                    .ok_or("Dashboard Task update requires Task object")?;
                let expected=field(body,"expectedUpdatedAt");
                if task_id.is_empty()||expected.is_empty(){
                    return Err("Dashboard Task update requires identity and version".into());
                }
                let updated=crate::task_update::apply_managed_task_update(
                    &self.config.graph_directory,&*self.scoped(id)?,
                    id,task_id,task,expected)?;
                self.wake(id,"dashboard.task.update")?;
                Ok(updated)
            }
            "create"=>{
                let current=self.scoped(id)?.load_job(id)?
                    .ok_or_else(||format!("SQLite Job {id} not found"))?;
                self.isolated_project(&current)?;
                let task=body.get("task").filter(|value|value.is_object())
                    .ok_or("Dashboard Task create requires Task object")?;
                // No caller-supplied Task ID, no worktree/provider side effects.
                // Allocation is global and idempotent, while Job CAS enforces
                // a single atomic Task append and optional Job activation.
                let overviews=self.all()?.into_iter()
                    .map(|job|json!({"job":job})).collect::<Vec<_>>();
                let (candidate,task_id,existing)=workspace_task_create_snapshot(
                    &self.config.graph_directory,&self.config.store_directory,
                    &overviews,&current,task,
                    body.get("idempotencyKey").and_then(Value::as_str))?;
                let mut updated=if existing{current.clone()}else{
                    self.persist_exact(id,&current,&candidate)?
                };
                if !existing{self.wake(id,"dashboard.task.create")?;}
                updated["createdTaskId"]=json!(task_id);
                Ok(updated)
            }
            _=>Err(denied("unsupported task command")),
        }
    }
    fn task_action(&mut self,id:&str,task_id:&str,action:&str)
        ->Result<Value,String>{
        self.apply_dashboard_task_action(id,task_id,action)
    }
    fn job_set_state(&mut self,id:&str,state:&str,_target:&Value)->Result<Value,String>{
        let original=WorkspaceControlBackend::load_job(self,id)?;
        self.isolated_project(&original)?;
        let (next,_)=dashboard_job_set_state(
            &self.config.graph_directory,&original,state)?;
        if next==original{return Ok(original);}
        let committed=self.persist_exact(id,&original,&next)?;
        if state=="CANCELLED"{self.wake(id,"dashboard.job.cancel")?;}
        Ok(committed)
    }
    fn task_set_state(&mut self,id:&str,task_id:&str,state:&str,target:&Value)
        ->Result<Value,String>{
        let current=self.scoped(id)?.load_job(id)?
            .ok_or_else(||format!("SQLite Job {id} not found"))?;
        self.isolated_project(&current)?;
        if target.get("repository").and_then(Value::as_str)
            .is_some_and(|repo|repo!=field(&current,"repository"))
{
            return Err("Dashboard Task target does not match immutable Job binding".into());
        }
        let command=dashboard_task_set_state(&current,task_id,state)?;
        if command.is_none(){return Ok(current);}
        let result=crate::task_actions::dispatch_task_action(
            &self.config.graph_directory,&*self.scoped(id)?,
            &command.expect("validated Task cancellation"))?;
        self.wake(id,"dashboard.task.setState")?;
        Ok(result["job"].clone())
    }
    fn event_history(&mut self,id:&str,task:Option<&str>,limit:i64)
        ->Result<Vec<Value>,String>{
        // The scoped durable Job must be known before any external query.
        // A supplied Task is also checked against this exact Job.
        let job=self.scoped(id)?.load_job(id)?
            .ok_or_else(||format!("SQLite Job {id} not found"))?;
        if task.is_some_and(|task_id|!job["tasks"].as_array().into_iter().flatten()
            .any(|row|field(row,"id")==task_id)){
            return Err("Events Bus history requested an unrelated Task".into());
        }
        let api=self.event_history_api.as_ref()
            .ok_or("Dashboard event history is not configured")?;
        // Reuse the production Node-compatible /events reader, including
        // cursor ordering, exact Job/Task checks and bounded response rows.
        // Missing/unavailable external history is *observational only* and
        // never affects Graph/SQLite Task progress or CLI reconciliation.
        let env=json!({
            "EVENTS_BUS_API_URL":api.as_str(),
            "EVENTS_BUS_CONFIG":self.config.store_directory.join(
                ".eventsbus-history-no-global-config.json").to_string_lossy(),
        });
        // EventBus history frequently exceeds 1.2s under live render load.
        // A timeout is an unavailable read, not proof that zero events exist.
        // Keep the dashboard feed intact on HTTP failure; the SSE channel
        // remains independent and continues delivering real-time events.
        let fetched=crate::events_bus_runtime::events_bus_history_page(
            id,task,&json!(limit.max(1)),&json!({"timeoutMs":5000}),&env)
            .map_err(|error|format!("Dashboard event history unavailable: {error}"))?;
        fetched["events"].as_array().cloned()
            .ok_or("Dashboard event history returned invalid events".into())
    }
    fn publish_event(&mut self,event:&Value)->Result<(),String>{
        WorkspaceControlBackend::publish(self,event)
    }
    fn subscribe_events(&mut self)->Receiver<String>{
        let (sender,receiver)=mpsc::channel();
        self.subscriptions.push(sender);receiver
    }
    fn observe_committed_job_snapshot(&mut self,id:&str)->Result<(),String>{
        if self.subscriptions.is_empty(){return Ok(());}
        // Re-read, do not trust the potentially stale inventory copy
        // assembled before the background Worker finished. A Graph/SQLite
        // commit in another process is visible without a synthetic wake.
        let snapshot=self.scoped(id)?.load_job(id)?
            .ok_or_else(||format!("Dashboard observation missing Job {id}"))?;
        self.emit_job_snapshot(&snapshot);
        Ok(())
    }
    fn router_test(&mut self,id:&str,task_id:&str)->Result<Value,String>{
        let job=WorkspaceControlBackend::load_job(self,id)?;
        let mut task=job["tasks"].as_array().into_iter().flatten()
            .find(|t|field(t,"id")==task_id).cloned().ok_or("Router test Task not found")?;
        if field(&task,"adapter")!="codex"{
            return Err("Router test requires a Model Task".into());
        }
        task.as_object_mut().ok_or("Invalid Task")?.remove("routing");
        task.as_object_mut().ok_or("Invalid Task")?.remove("workerSelection");
        let adapters=self.available_model_workers();
        let usage=self.account_usage().ok();
        let options=self.decision_options();
        let result=crate::reconciler_review::route_task_for_execution(
            &self.config.graph_directory,&self.config.profile_home,
            &self.config.policy_path,&self.config.router_rules_path,
            &job,&task,&adapters,&[],usage.as_ref(),&options)?;
        let audit=result.decision_audit.ok_or("Router test did not select a route")?;
        let selected=&audit["selected"];
        let evidence=&audit["decision_evidence"];
        let stage=audit.pointer("/decision_input/stages/0").unwrap_or(&Value::Null);
        Ok(json!({"selected":{"worker":selected.pointer("/worker/id").or_else(||selected.pointer("/worker/adapter")),
            "model":selected.pointer("/model/model"),"route":selected["id"]},
            "fallback":evidence["fallback"],"engine":evidence["engine"],"error":evidence["error"],
            "probabilities":evidence["probabilities"],"effectiveChoices":audit["eligible_candidates"],
            "mergedChoices":stage.pointer("/contract/choices"),"gates":audit["gate_results"],
            "routingInstruction":stage.pointer("/contract/question"),"decisionInput":stage,
            "proposedFields":{"worker":selected.pointer("/worker/adapter"),"provider":selected.pointer("/model/provider"),
                "model":selected.pointer("/model/model"),"reasoning":selected.pointer("/model/reasoning")}}))
    }
    fn decision_audit(&mut self)->Result<Vec<Value>,String>{crate::decision_audit::dashboard_records(&self.config.store_directory)}
    fn account_usage(&mut self)->Result<Value,String>{
        if !self.live_store{return Err(denied("provider account usage"));}
        if let Some((at,snapshot))=&self.usage_cache{
            if at.elapsed()<std::time::Duration::from_secs(60){return Ok(snapshot.clone());}
        }
        let snapshot=crate::usage::codex_and_zai_usage_registry(None,None).snapshot()?;
        self.usage_cache=Some((std::time::Instant::now(),snapshot.clone()));
        Ok(snapshot)
    }
    fn routing_adapters(&self)->Vec<Value>{self.available_model_workers()}
    fn github_usage(&mut self)->Result<Option<Value>,String>{Ok(None)}
    fn status(&mut self)->Value{
        let mode=if self.live_store {"live-write"}else{"isolated-write"};
        match self.all(){
            Ok(jobs)=>json!({"runtime":"native-rust","mode":mode,
                "productionReady":false,"jobCount":jobs.len(),"wakeCount":self.wake_count,
                "reconcileAttempts":self.reconcile_attempts,
                "reason":"Canonical Rust service ownership active; full external Model/EventBus E2E not yet certified"}),
            Err(error)=>json!({"runtime":"native-rust","mode":mode,
                "productionReady":false,"error":error}),
        }
    }
    fn reconcile_local_completion(&mut self,id:&str)->Result<bool,String>{
        self.reconcile_git_delivery(id)
    }
    fn poll_model_events(&mut self,id:&str)->Result<usize,String>{
        self.poll_isolated_model_worker_events(id)
    }
    fn flush_workflow_events(&mut self)->Result<usize,String>{
        let Some(publisher)=self.model_nats_publisher.as_ref() else {
            return Ok(0);
        };
        if !self.live_store{return Ok(0);}
        use rusqlite::{Connection,params};
        // One bounded batch each tick; never open every historical Job.
        // An event is already durably committed with its Task generation.
        // A failure leaves that exact event pending for safe replay.
        let db=Connection::open(self.path()).map_err(|e|e.to_string())?;
        let rows=pending_verified_workflow_events(&db,64,true)?;
        let mut count=0;
        let mut emitted=Vec::new();
        for (key,event) in rows{
            publisher.publish(&event)?;
            // NATS accepts the earlier PUB before responding to this PING.
            // An uncertain disconnect does not acknowledge the SQLite row;
            // any later replay retains the SAME event_id for consumer de-dupe.
            publisher.ping()?;
            let changed=db.execute(
                "UPDATE workflow_event_outbox
                 SET state='published',published_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
                 WHERE event_key=? AND state='pending'",params![key]
            ).map_err(|e|e.to_string())?;
            if changed==1{
                count+=1;
                emitted.push(event);
            }
        }
        for event in emitted{self.emit(event);}
        Ok(count)
    }
    fn has_pending_model_events(&mut self)->bool{
        // NATS disconnect does not create a new MSG callback. Check the
        // subscription's actual reader liveness on the watchdog sleep path,
        // not just on the next 5-minute Job polling round. The existing
        // per-host 1-second throttle prevents a broker outage reconnect spin.
        // This is only transport maintenance; Graph/SQLite effects still
        // require a verified event in the single daemon reconciliation loop.
        if self.model_nats_url.is_some()
            && self.model_nats_subscription.as_ref().is_some_and(
                |subscription|!subscription.is_alive()){
            if let Err(error)=self.reconnect_isolated_model_nats_if_needed(){
                eprintln!("warning: Isolated model NATS reconnect: {error}");
            }
        }
        let native_wake=std::mem::take(&mut self.wake_pending);
        let provider_wake=self.model_nats_wake.swap(
            false,std::sync::atomic::Ordering::AcqRel);
        if native_wake||provider_wake{return true;}
        // Out-of-process Worker commits have no in-process daemon wake.
        // Probe for a publishable outbox row at a bounded interval rather than
        // waiting for the five-minute Pool scan (or reparsing all Jobs).
        if self.live_store&&self.model_nats_publisher.is_some()
            &&self.workflow_outbox_last_poll.is_none_or(|instant|
                instant.elapsed()>=std::time::Duration::from_millis(250)){
            self.workflow_outbox_last_poll=Some(std::time::Instant::now());
            if let Ok(db)=rusqlite::Connection::open_with_flags(self.path(),
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY){
                if pending_verified_workflow_events(&db,1,false)
                    .is_ok_and(|rows|!rows.is_empty()){return true;}
            }
        }
        false
    }
    fn prepare_dependency_revisions(&mut self,id:&str)->Result<(),String>{
        let source=self.scoped(id)?.load_job(id)?
            .ok_or("Dependency Revision Job not found")?;
        self.isolated_project(&source)?;
        crate::dependency_revision_execution::reconcile_dependency_revisions(
            &self.config.graph_directory,&self.config.store_directory,
            &*self.scoped(id)?,id)?;
        // Original Node Reconciler retries previously committed Planner
        // cross-Job intents BEFORE scheduling fresh work. A registration
        // error leaves that precise intent pending for the next wake.
        let db=self.path();
        let graph=self.config.graph_directory.clone();
        let stores=self.config.store_directory.clone();
        let mut registrar=|job_id:&str,request:&Value|{
            crate::native_script_planner::register_isolated_planner_unblock(
                &db,&stores,&graph,job_id,request)
        };
        crate::planner_runtime::retry_pending_planner_unblocks(
            &*self.scoped(id)?,id,Some(&mut registrar),true)?;
        Ok(())
    }
    fn registered_agents(&mut self)->Result<Vec<Value>,String>{
        self.reconcile_attempts+=1;
        let mut seen=HashSet::new();let mut agents=Vec::new();
        for job in self.all()?{
            for agent in WorkspaceControlBackend::list_agents(self,field(&job,"id"))?{
                let key=field(&agent,"id").to_owned();
                if seen.insert(key){agents.push(agent)}
            }
        }
        Ok(agents)
    }
    fn effect(&mut self,action:&Value)->Result<(),String>{
        if matches!(field(action,"action"),"planner.launch"|"planner.recoverPending"){
            // Both actions are selected by canonical planner-orchestration
            // Graph. A restart recovery retries the existing Plan without
            // allocating a second round or reusing a stale generation.
            return self.launch_graph_planner_effect(action);
        }
        if field(action,"action")=="effect.remoteDelivery"{
            return self.reconcile_remote_delivery(
                field(action,"jobId"),field(action,"expectedMergedCommitSha"));
        }
        if field(action,"action")!="effect.launchTask"{
            return Err(denied("Planner or unsupported Worker effect"));
        }
        let id=field(action,"jobId");
        let task_id=field(action,"taskId");
        let mut original=WorkspaceControlBackend::load_job(self,id)?;
        let current=original.get("tasks").and_then(Value::as_array).into_iter().flatten()
            .find(|task|field(task,"id")==task_id)
            .ok_or("Unregistered Worker Task")?;
        // Before committing to the placeholder Codex adapter, give an
        // *unpinned* Task the Job's soft preference across configured real
        // worker transports. Browser Tasks whose route was cleared must also
        // be re-routed before launch. A user-selected runtime or exact Task
        // route still wins, and an absent transport never becomes a choice.
        let can_route=field(current,"adapter")=="codex"
            &&current.get("routing").is_none_or(Value::is_null)
            &&current.get("workerSelection").is_none_or(Value::is_null);
        if can_route && self.model_codex_executable.is_some(){
            let usage=self.account_usage().ok();
            let options=self.decision_options();
            let mut available=Vec::new();
            if self.model_codex_executable.is_some(){
                available.push(json!({"id":"codex","name":"codex",
                    "capabilities":["model","codex"]}));
            }
            let routed=crate::reconciler_review::route_task_for_execution(
                &self.config.graph_directory,&self.config.profile_home,
                &self.config.policy_path,&self.config.router_rules_path,
                &original,current,&available,&[],usage.as_ref(),&options)?;
            if routed.job!=original {
                let previous=original.clone();
                original=self.persist_exact(id,&previous,&routed.job)?;
                self.append_routing_audit(routed.decision_audit.as_ref());
                for event in &routed.events {
                    WorkspaceControlBackend::publish(self,event)?;
                }
            }
        }
        let task=original.get("tasks").and_then(Value::as_array).into_iter().flatten()
            .find(|task|field(task,"id")==task_id)
            .ok_or("Unregistered Worker Task")?;
        // Each adapter must have a real, explicitly isolated source and
        // transport before a Task generation can be reserved. No Node Relay
        // fallback, no implicit production WebHelm, no receipt-based success.
        let adapter=field(task,"adapter").to_owned();
        if adapter!="script"&&adapter!="codex"{
            return Err(denied("unsupported model Worker adapter"));
        }
        let (prepared,execution_root)=self.prepare_model_execution_checkout(
            id,&original,task_id)?;
        original=prepared;
        let task=original.get("tasks").and_then(Value::as_array)
            .into_iter().flatten().find(|task|field(task,"id")==task_id)
            .ok_or("Prepared Worker Task disappeared")?;
        // The daemon owns context roots, not the transport or its pool.
        let worker_roots=if self.live_store{
            crate::reconciler_context::WorkerContextRoots::live(&self.config.workspace_root)?
        }else{
            let fixture=self.config.store_directory.parent()
                .ok_or("Isolated worker host requires explicit fixture root")?;
            crate::reconciler_context::WorkerContextRoots::isolated(fixture)
        };
        if adapter=="codex"{
            let executable=self.model_codex_executable.clone()
                .ok_or("Non-browser Codex adapter not explicitly configured")?;
            let candidates=json!([
                {"id":"codex","name":"codex","capabilities":["model","codex"]}
            ]);
            let mut ready=original.clone();
            if task.get("routing").is_none_or(Value::is_null){
                let usage=self.account_usage().ok();
                let options=self.decision_options();
                let route=crate::reconciler_review::route_task_for_execution(
                    &self.config.graph_directory,&self.config.profile_home,
                    &self.config.policy_path,&self.config.router_rules_path,
                    &original,task,candidates.as_array().expect("static candidates"),
                    &[],usage.as_ref(),&options)?;
                if route.job==original{
                    return Err("Model Router did not select a real Codex route".into());
                }
                if route.job["tasks"].as_array().into_iter().flatten()
                    .find(|t|field(t,"id")==task_id)
                    .is_none_or(|t|field(t,"adapter")!="codex"
                        ||t.get("routing").is_none_or(Value::is_null)){
                    return Err("Native non-browser route selected an unsupported adapter".into());
                }
                ready=self.persist_exact(id,&original,&route.job)?;
                self.append_routing_audit(route.decision_audit.as_ref());
                // Route events only after the exact durable Graph CAS.
                for event in &route.events{
                    WorkspaceControlBackend::publish(self,event)?;
                }
            }
            let mut reconciler=Reconciler::new(
                self.config.graph_directory.clone(),self.config.store_directory.clone(),
                self.config.profile_home.clone(),self.config.policy_path.clone(),
                self.config.router_rules_path.clone(),
                json!({"owner":format!("live-rust-codex-{}",std::process::id()),
                    "maxConcurrent":self.config.concurrency}),
            );
            let claimed=reconciler.claim_task_execution(&ready,task_id)?.ok_or("Codex Task no longer eligible for launch")?;
            self.persist_exact(id,&ready,&claimed)?;
            let task=claimed["tasks"].as_array().into_iter().flatten()
                .find(|t|field(t,"id")==task_id).cloned()
                .ok_or("Claimed Codex Task disappeared")?;
            let db=self.path();
            let graph=self.config.graph_directory.clone();
            let job_id=id.to_string();let task_id=task_id.to_string();
            let execution_id=field(&task,"executionId").to_string();
            let audit_path=Some(crate::decision_audit::audit_path(&self.config.store_directory));
            let profile_home=Some(self.config.profile_home.clone());
            let codex_policy=self.config.policy_path.clone();
            let codex_rules=self.config.router_rules_path.clone();
            let live_workers=std::sync::Arc::clone(&self.live_workers);
            let failure_state=std::sync::Arc::clone(&self.failure_state);
            live_workers.lock().expect("daemon Worker lock poisoned")
                .register(&task_id,&execution_id);
            std::thread::Builder::new().name(format!("rust-codex-task-{task_id}"))
                .spawn(move||{
                    // Keep the exact generation owned through stdout drain,
                    // terminal inspection and graph-authorized failure settlement.
                    let _execution=match crate::execution_process_tracker::ExecutionGuard::enter(
                        &job_id,&task_id,&execution_id){
                        Ok(guard)=>guard,
                        Err(error)=>{eprintln!("Native Codex Worker {job_id}/{task_id}: {error}");return;}
                    };
                    let result=crate::native_codex_execution::execute_claimed_codex(
                        &db,&claimed,&task,&executable,&execution_root,&worker_roots);
                    if let Err(error)=result{
                        eprintln!("Native Codex Worker {job_id}/{task_id}: {error}");
                        let phase=classify_native_launch_phase(&error);
                        let mut ports=DaemonWorkerFailurePorts::new(
                            db.clone(),graph.clone(),Some(job_id.clone()),
                            audit_path.clone(),profile_home.clone(),
                            std::sync::Arc::clone(&live_workers),
                            std::sync::Arc::clone(&failure_state))
                            .with_routing_policy(codex_policy.clone(),codex_rules.clone());
                        if let Err(recovery)=crate::worker_failure_recovery::
                            handle_worker_launch_failure(&mut ports,&job_id,&task_id,
                                Some(&execution_id),&json!(error),phase){
                            eprintln!("Native Codex Worker recovery {job_id}/{task_id}: {recovery}");
                        }
                    }else{
                        live_workers.lock().expect("Codex live Worker lock poisoned")
                            .remove(&task_id);
                    }
                }).map_err(|e|format!("Cannot launch Rust Codex Worker: {e}"))?;
            return Ok(());
        }
        let script=discover_script_agent(field(task,"agentName"),
            field(&original,"projectRoot"),
            self.config.workspace_root.to_str(),None)?
            .ok_or("Source Worker has no declared trusted Shortcut")?;
        if !Path::new(&script).is_file(){return Err("Script Agent module is absent".into());}
        let isolated_parent=if self.live_store {
            self.isolated_project(&original)?
        }else{
            std::fs::canonicalize(self.config.store_directory.parent()
                .ok_or("Isolated store parent missing")?)
                .map_err(|e|e.to_string())?
        };
        let output=task.pointer("/output/path").and_then(Value::as_str)
            .ok_or("Native Script Worker requires a declared file output")?;
        let output_parent=Path::new(output).parent()
            .ok_or("Native Script Worker output path has no parent")?;
        let output_existing=output_parent.ancestors()
            .find(|path|path.exists())
            .and_then(|path|std::fs::canonicalize(path).ok())
            .ok_or("Native Script Worker output parent cannot be canonicalized")?;
        if task.pointer("/output/kind")!=Some(&json!("file"))
            || !Path::new(output).is_absolute()
            || !output_existing.starts_with(&isolated_parent){
            return Err("Native Script Worker output must remain inside the isolated job root".into());
        }
        let runtime=configured_script_interpreter()?;
        let mut reconciler=Reconciler::new(
            self.config.graph_directory.clone(),self.config.store_directory.clone(),
            self.config.profile_home.clone(),self.config.policy_path.clone(),
            self.config.router_rules_path.clone(),
            json!({"owner":format!("isolated-rust-daemon-{}",std::process::id()),
                "maxConcurrent":self.config.concurrency}),
        );
        let claimed=reconciler.claim_task_execution(&original,task_id)?.ok_or("Script Task no longer eligible for launch")?;
        // One immutable generation claim, committed via same transactional CAS.
        self.persist_exact(id,&original,&claimed)?;
        let task=claimed.get("tasks").and_then(Value::as_array).into_iter().flatten()
            .find(|task|field(task,"id")==task_id).cloned()
            .ok_or("Script Task vanished during lease claim")?;
        let path=self.path();
        let graph=self.config.graph_directory.clone();
        let runtime=PathBuf::from(runtime);
        let timeout=task.get("timeoutMs").and_then(Value::as_u64)
            .unwrap_or(900_000).clamp(100,86_400_000);
        let job_id=id.to_string();let task_id=task_id.to_string();
        std::thread::Builder::new().name(format!("rust-script-task-{task_id}"))
            .spawn(move||{
                if let Err(error)=run_claimed_script_task(
                    &path,&graph,&claimed,&task,&runtime,timeout){
                    eprintln!("Rust Script Worker {job_id}/{task_id}: {error}");
                }
            }).map_err(|e|format!("Cannot launch owned Script Worker executor: {e}"))?;
        Ok(())
    }
}

#[cfg(test)]
mod verified_worker_outbox_tests {
    use super::*;
    #[test]
    fn model_and_script_outbox_are_correlated_and_bounded() {
        let job="689";let task="2124";let lease="fca5e941-6e62-4067-bc18-932294cc4217";
        let id="2adb3c03-237d-4f45-8050-24ca7f5434bc";
        let source=crate::execution_event_identity::execution_event_source(job,task,lease);
        let event=json!({"version":1,"job_id":job,"task_id":task,
            "type":"task.started","event_id":id,"source":{"id":source}});
        assert!(verified_worker_outbox_event(&format!("model-event/{job}/{task}/{lease}/{id}"),
            "task.started",&event));
        assert!(verified_worker_outbox_event(&format!("script-event/{job}/{task}/{lease}/task.started"),
            "task.started",&event));
        let mut progress=event.clone();progress["type"]=json!("task.progress");
        assert!(verified_worker_outbox_event(&format!("model-event/{job}/{task}/{lease}/{id}"),
            "task.progress",&progress));
        assert!(!verified_worker_outbox_event(&format!("script-event/{job}/{task}/{lease}/task.progress"),
            "task.progress",&progress));
        assert!(!verified_worker_outbox_event(&format!("model-event/{job}/{task}/{lease}/wrong"),
            "task.started",&event));
        assert!(!verified_worker_outbox_event(&format!("model-event/{job}/{task}/wrong/{id}"),
            "task.started",&event));
        assert!(!verified_worker_outbox_event(&format!("model-event/{job}/wrong/{lease}/{id}"),
            "task.started",&event));
        let mut fake=event.clone();fake["source"]["id"]=json!("job/other/task/other/execution/wrong");
        assert!(!verified_worker_outbox_event(&format!("model-event/{job}/{task}/{lease}/{id}"),
            "task.started",&fake));
        assert!(!verified_worker_outbox_event(&format!("model-event/{job}/{task}/{lease}/{id}"),
            "task.failed",&event));
    }

    #[test]
    fn invalid_rows_cannot_starve_later_valid_merge_and_script_events(){
        let db=rusqlite::Connection::open_in_memory().unwrap();
        let publication=crate::workflow::durable_publication::DurableWorkflowPublication::new(&db).unwrap();
        for index in 0..80 {
            publication.enqueue(&format!("invalid-{index:03}"),"unknown",&json!({"type":"unknown"})).unwrap();
        }
        let id=format!("workflow-local-merge-{}","a".repeat(64));
        for (ty,status) in [("job.merge.succeeded","succeeded"),("job.merge.failed","failed")]{
            let event=json!({"version":1,"event_id":id,"job_id":"729",
                "task_id":"merge","type":ty,"status":status,
                "source":{"id":"job/729/task/merge/execution/attempt-1","agent":"relay"}});
            assert!(verified_worker_outbox_event(&id,ty,&event));
            assert!(!verified_worker_outbox_event("wrong",ty,&event));
            let mut bad=event.clone();bad["source"]["id"]=json!("job/other/task/merge/execution/attempt-1");
            assert!(!verified_worker_outbox_event(&id,ty,&bad));
            if ty=="job.merge.succeeded"{publication.enqueue(&id,ty,&event).unwrap();}
        }
        let key="script-event/729/2291/exec/task.started";
        let event=json!({"version":1,"event_id":"script-id","job_id":"729","task_id":"2291",
            "type":"task.started","source":{"id":"job/729/task/2291/execution/exec"}});
        publication.enqueue(key,"task.started",&event).unwrap();
        db.execute("UPDATE workflow_event_outbox SET created_at='2000-01-01' WHERE event_key LIKE 'invalid-%'",[]).unwrap();
        let rows=pending_verified_workflow_events(&db,64,true).unwrap();
        assert_eq!(rows.len(),2);
        assert!(rows.iter().any(|(k,_)|k==&id));
        assert!(rows.iter().any(|(k,_)|k==key));
        let pending:i64=db.query_row("SELECT count(*) FROM workflow_event_outbox WHERE state='pending'",[],|r|r.get(0)).unwrap();
        assert_eq!(pending,82,"selection does not destroy or falsely acknowledge rejected records");
    }
    #[test]
    fn graph_owned_planner_event_is_published_without_unblocking_forged_events(){
        let started=crate::events::event_for("716","plan-1",None,
            "planner.started","running","Real Graph Planner started",
            Some("orchestrator"),None,None);
        let id=field(&started,"event_id");
        let key=format!("isolated-planner/716/planner.started/{id}");
        assert!(verified_worker_outbox_event(&key,
            "planner.started",&started),
            "durably committed Planner event must not stall unrelated Script/Model outbox");
        assert!(!verified_worker_outbox_event(&format!(
            "isolated-planner/717/planner.started/{id}"),"planner.started",&started));
        assert!(!verified_worker_outbox_event(&format!(
            "isolated-planner/716/planner.started/other-id"),"planner.started",&started));
        let mut wrong_plan=started.clone();
        wrong_plan["task_id"]=json!("2236");
        assert!(!verified_worker_outbox_event(&key,"planner.started",&wrong_plan));
        let mut wrong_status=started.clone();
        wrong_status["status"]=json!("succeeded");
        assert!(!verified_worker_outbox_event(&key,"planner.started",&wrong_status));
        let mut fake_source=started.clone();
        fake_source["source"]=json!({"agent":"planner","component":"malicious"});
        assert!(!verified_worker_outbox_event(&key,"planner.started",&fake_source));
        let mut foreign_kind=started.clone();
        foreign_kind["type"]=json!("job.completed");
        assert!(!verified_worker_outbox_event(&key,"job.completed",&foreign_kind));
        for (ty,status) in [("planner.retry","queued"),("planner.completed","succeeded"),("planner.failed","failed")]{
            let mut terminal=started.clone();
            terminal["type"]=json!(ty);
            terminal["status"]=json!(status);
            terminal["source"]=json!({"agent":"planner","component":"agents-relay"});
            assert!(verified_worker_outbox_event(&format!(
                "isolated-planner/716/{ty}/{id}"),ty,&terminal));
        }
    }
}

#[cfg(test)]
mod committed_worker_observation_tests{
    use super::*;
    #[test]
    fn submission_does_not_start_a_worker_but_exact_graph_event_does(){
        let mut live=DaemonLiveWorkers::default();
        live.register("2","exec-new");
        let queued=json!({"tasks":[{"id":"2","state":"QUEUED",
            "executionId":"exec-new"}]});
        update_live_worker_from_committed_event(
            &mut live,&queued,"2","exec-new","task.process.launched");
        assert!(!live.get("2").unwrap().worker_started,
            "WebHelm submitted is not the worker task.started event");
        update_live_worker_from_committed_event(
            &mut live,&queued,"2","exec-new","task.started");
        assert!(!live.get("2").unwrap().worker_started,
            "a Graph-denied/stale task.started cannot mark a worker started");
        let running=json!({"tasks":[{"id":"2","state":"RUNNING",
            "executionId":"exec-new"}]});
        update_live_worker_from_committed_event(
            &mut live,&running,"2","exec-old","task.started");
        assert!(!live.get("2").unwrap().worker_started,
            "wrong execution source cannot mark a worker started");
        update_live_worker_from_committed_event(
            &mut live,&running,"2","exec-new","task.started");
        assert!(live.get("2").unwrap().worker_started,
            "only exact current Graph/SQLite RUNNING generation starts");
        let terminal=json!({"tasks":[{"id":"2","state":"SUCCEEDED",
            "executionId":null,"executionHistory":[{"id":"exec-new"}]}]});
        update_live_worker_from_committed_event(
            &mut live,&terminal,"2","exec-old","task.completed");
        assert!(live.get("2").is_some(),"stale terminal cannot clear live Worker");
        update_live_worker_from_committed_event(
            &mut live,&terminal,"2","exec-new","task.completed");
        assert!(live.get("2").is_none(),
            "committed terminal clears only its matching volatile live Worker");
    }
}

#[cfg(test)]
mod source_checkout_regression_tests {
    use super::*;
    use crate::{
        events::event_for,execution_event_identity::execution_event_source,
        native_worker_event_ingress::apply_verified_worker_event,
    };
    use std::{fs,process::Command};
    #[test]
    fn source_worker_gets_git_branch_before_graph_started_and_never_checks_out_main(){
        let base=std::env::temp_dir().join(format!(
            "relay-source-preflight-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(
                std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let project=base.join("project");let stores=base.join("stores");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&stores).unwrap();
        let git=|args:&[&str]|{
            let output=Command::new("git").arg("-C").arg(&project)
                .args(args).output().unwrap();
            assert!(output.status.success(),"git {:?}: {}",
                args,String::from_utf8_lossy(&output.stderr));
            String::from_utf8_lossy(&output.stdout).trim().to_owned()
        };
        git(&["init","-q","-b","main"]);
        git(&["config","user.name","Relay Test"]);
        git(&["config","user.email","relay@example.invalid"]);
        fs::write(project.join("readme.md"),"baseline").unwrap();
        git(&["add","."]);git(&["commit","-qm","baseline"]);
        let main=git(&["rev-parse","HEAD"]);
        let config=DaemonConfig{
            workspace_root:base.clone(),store_directory:stores.clone(),
            graph_directory:Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow"),
            profile_home:base.join("profiles"),policy_path:base.join("policy.json"),
            router_rules_path:base.join("rules.md"),
            dashboard_asset:base.join("index.html"),repositories:vec!["project".into()],
            port:0,concurrency:1,interval_ms:100,event_transport:json!({}),
        };
        let db=base.join("relay.sqlite");
        let stamp="2026-11-23T00:00:00.000Z";
        let job=json!({"id":"724","repository":"project","projectRoot":project,
            "title":"Test managed source checkout","state":"ACTIVE",
            "autoMerge":true,"reviewEnabled":true,"createdAt":stamp,
            "updatedAt":stamp,"plans":[],
            "tasks":[{"id":"2264","jobId":"724","kind":"work",
                "agentName":"implementation","adapter":"codex",
                "state":"QUEUED","attempt":1,"maxAttempts":2,
                "executionId":"exec-724-1","gitDeliveryRequired":true,
                "output":{"kind":"task_pr"},"dependencies":[],
                "createdAt":stamp,"updatedAt":stamp}]});
        let store=SQLiteRelayStore::open(&db,Some("724")).unwrap();
        store.save_job(&job).unwrap();
        assert!(crate::git_delivery::started_source_baseline(&job,"2264")
            .unwrap_err().contains("source branch"));
        let mut host=IsolatedSQLiteWriteHost::new(config.clone());
        let (ready,worktree)=host.prepare_model_execution_checkout(
            "724",&job,"2264").unwrap();
        let source=ready.pointer("/localMerge/sourceRef").and_then(Value::as_str)
            .unwrap();
        assert!(source.starts_with("refs/heads/relay/job-724-"));
        assert!(worktree.starts_with(base.join(".worktrees/agents-relay")));
        assert_ne!(worktree,project);
        assert_eq!(git(&["rev-parse","HEAD"]),main);
        assert_eq!(git(&["symbolic-ref","HEAD"]),"refs/heads/main");
        assert_eq!(crate::git_delivery::started_source_baseline(
            &ready,"2264").unwrap(),Some(main.clone()));
        // The exact external task.started event must now be accepted through
        // the original Graph + SQLite ingress, not an invented worker receipt.
        let event=event_for("724","2264",None,"task.started","running",
            "started",Some("worker"),None,Some(json!({
                "id":execution_event_source("724","2264","exec-724-1")
            })));
        let running=apply_verified_worker_event(&db,&config.graph_directory,
            "724","2264","exec-724-1",&event).unwrap();
        assert_eq!(running["tasks"][0]["state"],"RUNNING");
        assert_eq!(running["tasks"][0]["gitDeliveryBaseline"]["sha"],
            json!(main));
        drop(host);drop(store);
        fs::remove_dir_all(base).unwrap();
    }
}
