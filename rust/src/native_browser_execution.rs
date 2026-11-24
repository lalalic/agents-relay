//! Rust-owned ChatGPT/WebHelm launch boundary. WebHelm handles the
//! browser session; native Graph/SQLite own the Task. A submitted receipt
//! cannot advance Task state or satisfy a human Review decision.
use crate::{
    adapters::{ChatGptAdapter,WorkerExecution},
    browser_worker_pool::{BrowserPoolOptions,BrowserWorkerPoolManager},
    browser_worker_runtime::relay_workspace_name,
    reconciler_context::{worker_managed_prompt,WorkerContextRoots},
    relay_store::SQLiteRelayStore,
};
use serde_json::Value;
use std::{
    fs,path::{Path,PathBuf},
    sync::atomic::{AtomicBool,Ordering},
    thread,time::Duration,
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
    /// Explicit external WebHelm binding only for a disposable canary Job
    /// store. Merely detecting a running provider never opts in to launch.
    pub fn from_explicit_canary(
        store_directory:&Path,socket_raw:&str,executable_raw:&str,
        workspace_raw:&str,
    )->Result<Self,String>{
        if !workspace_raw.starts_with("Rust2Canary")
            ||workspace_raw.len()>60{
            return Err("Live WebHelm canary must use a distinct Rust2Canary workspace".into());
        }
        let workspace=relay_workspace_name(Some(workspace_raw))?;
        let absolute=|path:&str,label:&str|->Result<PathBuf,String>{
            let source=Path::new(path);
            if !source.is_absolute(){return Err(format!("{label} must be an absolute path"));}
            fs::canonicalize(source).map_err(|_|format!("{label} is not accessible"))
        };
        let socket=absolute(socket_raw,"Canary WebHelm socket")?;
        let executable=absolute(executable_raw,"Canary WebHelm executable")?;
        if !socket.metadata().is_ok_and(|m|
            std::os::unix::fs::FileTypeExt::is_socket(&m.file_type())){
            return Err("Canary WebHelm socket is not a Unix socket".into());
        }
        if !executable.is_file(){
            return Err("Canary WebHelm executable is not a regular file".into());
        }
        #[cfg(unix)]{
            use std::os::unix::fs::PermissionsExt;
            if executable.metadata().map_err(|e|e.to_string())?
                .permissions().mode()&0o111==0{
                return Err("Canary WebHelm executable is not executable".into());
            }
        }
        Ok(Self{socket,executable,workspace,
            pool_db:store_directory.join("browser-worker-pool.sqlite")})
    }
    /// Explicit authenticated local WebHelm transport for the sole native
    /// production owner. Never silently choose a browser profile or Session.
    /// The caller must also attach a verified Events Bus ingress before
    /// launching a Model Worker; browser delivery alone cannot finish Tasks.
    pub fn from_explicit_live(
        store_directory:&Path,socket_raw:&str,executable_raw:&str,
        workspace_raw:&str,
    )->Result<Self,String>{
        let workspace=relay_workspace_name(Some(workspace_raw))?;
        if workspace_raw.trim().is_empty(){
            return Err("Live WebHelm requires an explicit safe workspace".into());
        }
        let validate=|raw:&str,label:&str|->Result<PathBuf,String>{
            let path=Path::new(raw);
            if !path.is_absolute(){return Err(format!("{label} must be absolute"));}
            fs::canonicalize(path).map_err(|_|format!("{label} unavailable"))
        };
        let socket=validate(socket_raw,"Live WebHelm socket")?;
        let executable=validate(executable_raw,"Live WebHelm executable")?;
        if !socket.metadata().is_ok_and(|metadata|
            std::os::unix::fs::FileTypeExt::is_socket(&metadata.file_type())){
            return Err("Live WebHelm socket must be a Unix socket".into());
        }
        if !executable.is_file(){
            return Err("Live WebHelm executable must be a regular file".into());
        }
        #[cfg(unix)]{
            use std::os::unix::fs::PermissionsExt;
            if executable.metadata().map_err(|e|e.to_string())?
                .permissions().mode()&0o111==0{
                return Err("Live WebHelm executable must be executable".into());
            }
        }
        Ok(Self{socket,executable,workspace,
            pool_db:store_directory.join("browser-worker-pool.sqlite")})
    }
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
    barrier:&str,cancelled:&AtomicBool,
)->Result<(),String>{
    loop{
        if cancelled.load(Ordering::Acquire){
            return Err("Native WebHelm Worker was cancelled".into());
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
        let history=task.get("executionHistory").and_then(Value::as_array)
            .into_iter().flatten().find(|history|field(history,"id")==execution_id);
        let old_generation=history.is_some();
        // A Worker can finish before the first poll. A Graph-authorized
        // SUCCEEDED generation necessarily passed the Task started state;
        // a FAILED/CANCELLED generation might instead reflect pre-submit
        // rejection or cancellation with NO task.started. Do not let the
        // claim-time startedAt field alone satisfy a start acknowledgement.
        if barrier=="worker-start"&&old_generation&&state=="SUCCEEDED"
            &&history.is_some_and(|entry|!field(entry,"startedAt").is_empty()){
            return Ok(());
        }
        if barrier=="terminal" &&old_generation
            &&matches!(state,"SUCCEEDED"|"FAILED"|"CANCELLED"){
            return Ok(());
        }
        if barrier=="worker-start"&&old_generation
            &&matches!(state,"FAILED"|"CANCELLED"){
            return Err("WebHelm Worker stopped without a verified task.started".into());
        }
        if generation!=execution_id && !old_generation{
            return Err("Native WebHelm event barrier saw a stale execution generation".into());
        }
        thread::sleep(Duration::from_millis(25));
    }
}
/// Same prompt contract as the Codex Worker; only runtime metadata differs.
pub fn native_browser_managed_prompt(
    db:&Path,job:&Value,task:&Value,execution_root:&Path,roots:&WorkerContextRoots,
)->Result<String,String>{
    let adapters=vec![serde_json::json!({
        "name":"chatgpt", "id":"chatgpt/browser-worker",
        "capabilities":["model","chatgpt","webhelm"]
    })];
    worker_managed_prompt(db,job,task,execution_root,roots,&adapters)
}
/// The Task must already have been claimed and committed by the daemon.
/// The return value is only delivery metadata. It never mutates Job/Task.
pub fn submit_claimed_chatgpt_worker(
    db_path:&Path,job_id:&str,task:&Value,
    config:&IsolatedWebHelmConfig,execution_root:&Path,roots:&WorkerContextRoots,cancelled:&AtomicBool,
)->Result<WorkerExecution,String>{
    let task_id=field(task,"id");let execution_id=field(task,"executionId");
    if field(task,"adapter")!="chatgpt"||task_id.is_empty()
        ||execution_id.is_empty()||field(task,"executionId").is_empty()
        ||field(task,"state")!="QUEUED"{
        return Err("Native WebHelm launch requires a committed ChatGPT execution lease".into());
    }
    let store=SQLiteRelayStore::open_without_claim_reset(db_path,Some(job_id))?;
    let current=store.load_job(job_id)?.ok_or("Browser Worker Job missing")?;
    let fresh=current.get("tasks").and_then(Value::as_array)
        .into_iter().flatten().find(|v|field(v,"id")==task_id)
        .ok_or("Browser Worker Task missing")?;
    if field(fresh,"executionId")!=execution_id
        ||field(fresh,"state")!="QUEUED"{
        return Err("Native WebHelm launch was superseded by another Task generation".into());
    }
    // The same contract-based managed input used by Node Workers must be
    // resolved before the browser provider sees a prompt. The original Task
    // remains immutable in SQLite; the assembled prompt is transport-only.
    let prompt=native_browser_managed_prompt(db_path,&current,fresh,execution_root,roots)?;
    let mut submitted_task=fresh.clone();
    submitted_task["input"]=serde_json::json!(prompt);
    let mut pool=BrowserWorkerPoolManager::open(BrowserPoolOptions{
        path:Some(config.pool_db.clone()),..Default::default()
    }).map_err(|e|e.to_string())?;
    let launched=ChatGptAdapter::default().launch(&submitted_task,
        &config.socket,&config.executable,&config.workspace,
        &mut pool,cancelled,|barrier|await_generation_barrier(
            db_path,job_id,task_id,execution_id,barrier,cancelled));
    pool.close().map_err(|e|e.to_string())?;
    launched
}

#[cfg(test)]
mod start_ack_barrier_tests{
    use super::*;
    #[test]
    fn cancelled_worker_barrier_exits_without_a_deadline(){
        let cancelled=AtomicBool::new(true);
        let error=await_generation_barrier(
            Path::new("/dev/null"),"job-7","task-9","exec-2",
            "worker-start",&cancelled).unwrap_err();
        assert!(error.contains("cancelled"),"{error}");
    }
    #[test]
    fn exact_terminal_worker_completion_satisfies_both_barriers(){
        let root=std::env::temp_dir().join(format!(
            "rust2-terminal-{}-{}",std::process::id(),chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)));
        fs::create_dir_all(&root).unwrap();
        let db=root.join("relay.sqlite");
        let store=SQLiteRelayStore::open(&db,Some("7")).unwrap();
        let job=serde_json::json!({"id":"7","repository":"fixture","prNumber":0,
            "state":"ACTIVE","title":"early-terminal","tasks":[{"id":"2","jobId":"7",
                "kind":"work","state":"SUCCEEDED","executionId":null,
                "executionHistory":[{"id":"e1","startedAt":"2026-11-20T01:00:00.000Z",
                    "endedAt":"2026-11-20T01:00:01.000Z"}]}]});
        store.save_job(&job).unwrap();
        store.close().unwrap();
        let cancelled=AtomicBool::new(false);
        assert!(await_generation_barrier(&db,"7","2","e1","worker-start",&cancelled).is_ok());
        assert!(await_generation_barrier(&db,"7","2","e1","terminal",&cancelled).is_ok());
        fs::remove_dir_all(root).unwrap();
    }
}
