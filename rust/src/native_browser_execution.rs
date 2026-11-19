//! Rust-owned, isolated ChatGPT/WebHelm launch boundary. WebHelm handles the
//! browser session; native Graph/SQLite own the Task. A submitted receipt
//! cannot advance Task state or satisfy a human Review decision. Production
//! WebHelm transports and sender authentication are NOT bound here.
use crate::{
    adapters::{ChatGptAdapter,WorkerExecution},
    browser_worker_pool::{BrowserPoolOptions,BrowserWorkerPoolManager},
    browser_worker_runtime::relay_workspace_name,
    execution_context::resolve_execution_context,
    reconciler_context::resolve_task_context,
    managed_worker_input::managed_worker_input_resolved,
    relay_store::SQLiteRelayStore,
};
use serde_json::Value;
use std::{
    fs,path::{Path,PathBuf},
    sync::atomic::{AtomicBool,Ordering},
    thread,time::{Duration,Instant},
};
fn field<'a>(v:&'a Value,key:&str)->&'a str{
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
#[derive(Clone,Debug)]
pub struct IsolatedWebHelmConfig {
    pub socket:PathBuf,
    pub executable:PathBuf,
    pub workspace:String,
    pub pool_db:PathBuf,
}
fn isolated_path(name:&str,root:&Path)->Result<PathBuf,String>{
    let raw=std::env::var(name)
        .map_err(|_|format!("{name} requires an explicit isolated test-owned path"))?;
    let path=Path::new(&raw);
    if !path.is_absolute(){return Err(format!("{name} must be absolute"));}
    let canonical=fs::canonicalize(path).map_err(|e|format!("{name}: {e}"))?;
    let root=fs::canonicalize(root).map_err(|e|e.to_string())?;
    if canonical==root||!canonical.starts_with(root){
        return Err(format!("{name} cannot escape the isolated WebHelm test fixture"));
    }
    Ok(canonical)
}
impl IsolatedWebHelmConfig {
    pub fn from_test_store(store_directory:&Path)->Result<Self,String>{
        let root=store_directory.parent().ok_or("Isolated store has no parent")?;
        let socket=isolated_path("AGENTS_RELAY_WEBHELM_SOCKET",root)?;
        let executable=isolated_path("AGENTS_RELAY_WEBHELM_EXECUTABLE",root)?;
        let workspace=relay_workspace_name(std::env::var("AGENTS_RELAY_WEBHELM_WORKSPACE")
            .ok().as_deref())?;
        if !socket.metadata().is_ok_and(|m|
            std::os::unix::fs::FileTypeExt::is_socket(&m.file_type())){
            return Err("Isolated WebHelm socket must be a Unix socket".into());
        }
        if !executable.is_file(){
            return Err("Isolated WebHelm executable is missing".into());
        }
        #[cfg(unix)]{
            use std::os::unix::fs::PermissionsExt;
            let mode=executable.metadata().map_err(|e|e.to_string())?.permissions().mode();
            if mode&0o111==0{
                return Err("Isolated WebHelm executable has no execute permission".into());
            }
        }
        Ok(Self{socket,executable,workspace,
            pool_db:store_directory.join("browser-worker-pool.sqlite")})
    }
}
fn await_generation_barrier(
    db_path:&Path,job_id:&str,task_id:&str,execution_id:&str,
    barrier:&str,deadline:Instant,cancelled:&AtomicBool,
)->Result<(),String>{
    loop{
        if cancelled.load(Ordering::Acquire){
            return Err("Native WebHelm Worker was cancelled".into());
        }
        if Instant::now()>deadline{
            return Err(format!("Native WebHelm {barrier} Graph event barrier expired"));
        }
        let store=SQLiteRelayStore::open_without_claim_reset(db_path,Some(job_id))?;
        let job=store.load_job(job_id)?.ok_or("Browser Worker Job was removed")?;
        let task=job.get("tasks").and_then(Value::as_array)
            .into_iter().flatten().find(|task|field(task,"id")==task_id)
            .ok_or("Browser Worker Task was removed")?;
        let state=field(task,"state");
        let generation=field(task,"executionId");
        if barrier=="worker-start" && state=="RUNNING"&&generation==execution_id{
            return Ok(());
        }
        let old_generation=task.get("executionHistory").and_then(Value::as_array)
            .into_iter().flatten().any(|history|field(history,"id")==execution_id);
        if barrier=="terminal" &&old_generation
            &&matches!(state,"SUCCEEDED"|"FAILED"|"CANCELLED"){
            return Ok(());
        }
        if generation!=execution_id && !old_generation{
            return Err("Native WebHelm event barrier saw a stale execution generation".into());
        }
        thread::sleep(Duration::from_millis(25));
    }
}
/// The Task must already have been claimed and committed by the daemon.
/// The return value is only delivery metadata. It never mutates Job/Task.
pub fn submit_claimed_chatgpt_worker(
    db_path:&Path,job_id:&str,task:&Value,
    config:&IsolatedWebHelmConfig,cancelled:&AtomicBool,
)->Result<WorkerExecution,String>{
    let task_id=field(task,"id");let execution_id=field(task,"executionId");
    if field(task,"adapter")!="chatgpt"||task_id.is_empty()
        ||execution_id.is_empty()||field(task,"leaseOwner").is_empty()
        ||field(task,"state")!="QUEUED"{
        return Err("Native WebHelm launch requires a committed ChatGPT execution lease".into());
    }
    let store=SQLiteRelayStore::open_without_claim_reset(db_path,Some(job_id))?;
    let current=store.load_job(job_id)?.ok_or("Browser Worker Job missing")?;
    let fresh=current.get("tasks").and_then(Value::as_array)
        .into_iter().flatten().find(|v|field(v,"id")==task_id)
        .ok_or("Browser Worker Task missing")?;
    if field(fresh,"executionId")!=execution_id
        ||field(fresh,"leaseOwner")!=field(task,"leaseOwner")
        ||field(fresh,"state")!="QUEUED"{
        return Err("Native WebHelm launch was superseded by another Task generation".into());
    }
    // The same contract-based managed input used by Node Workers must be
    // resolved before the browser provider sees a prompt. The original Task
    // remains immutable in SQLite; the assembled prompt is transport-only.
    let project=current.get("projectRoot").and_then(Value::as_str)
        .ok_or("Native Worker Job missing immutable projectRoot")?;
    let fixture_root=config.pool_db.parent().and_then(Path::parent)
        .ok_or("Native WebHelm config missing isolated fixture root")?;
    let options=serde_json::json!({
        "workspaceRoot":fixture_root,
        "globalRoot":fixture_root
    });
    let agents=store.load_agents()?.unwrap_or_default();
    let adapters=vec![serde_json::json!({
        "name":"chatgpt/browser-worker", "id":"chatgpt/browser-worker",
        "capabilities":["model","chatgpt","webhelm"]
    })];
    let future=resolve_task_context(
        project,"worker",&options,&agents,&adapters,
        |project,role,options|std::future::ready(
            resolve_execution_context(&project,&role,&options)));
    let mut future=std::pin::pin!(future);
    let mut context=std::task::Context::from_waker(std::task::Waker::noop());
    let context=match std::future::Future::poll(future.as_mut(),&mut context){
        std::task::Poll::Ready(result)=>result?,
        std::task::Poll::Pending=>return Err(
            "Native Worker context resolution unexpectedly suspended".into()),
    };
    let package_root=Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent().ok_or("Rust package root missing")?;
    let prompt=managed_worker_input_resolved(
        &current,fresh,Some(&context),"production",package_root,None)?;
    let mut submitted_task=fresh.clone();
    submitted_task["input"]=serde_json::json!(prompt);
    let mut pool=BrowserWorkerPoolManager::open(BrowserPoolOptions{
        path:Some(config.pool_db.clone()),..Default::default()
    }).map_err(|e|e.to_string())?;
    let timeout=task.get("timeoutMs").and_then(Value::as_u64)
        .unwrap_or(900_000).clamp(500,86_400_000);
    let deadline=Instant::now()+Duration::from_millis(timeout);
    let launched=ChatGptAdapter::default().launch(&submitted_task,
        &config.socket,&config.executable,&config.workspace,
        &mut pool,cancelled,|barrier|await_generation_barrier(
            db_path,job_id,task_id,execution_id,barrier,deadline,cancelled));
    pool.close().map_err(|e|e.to_string())?;
    launched
}
