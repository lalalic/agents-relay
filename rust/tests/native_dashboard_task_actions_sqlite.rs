//! Native Dashboard retry/cancel/state routes must persist Graph-owned Task
//! transitions in the shared SQLite file, not return a no-op acknowledgement.
//! Includes isolated Git paths, negative mutations, and process recreation.
use agents_relay_rust2::{
    relayd::{DaemonConfig,DaemonServices},relayd_sqlite_write::IsolatedSQLiteWriteHost,
    relay_store::SQLiteRelayStore,relay_store_discovery::relay_unified_store_path,
};
use serde_json::{json,Value};
use std::{fs,path::PathBuf,process::Command,time::{SystemTime,UNIX_EPOCH}};
fn graph()->PathBuf{PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../workflow")}
struct Fixture{root:PathBuf,config:DaemonConfig}
impl Fixture{
 fn new()->Self{
  let root=std::env::temp_dir().join(format!("rust2-dash-task-real-{}-{}",
   std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
  let stores=root.join("stores");let project=root.join("mockrepo");
  fs::create_dir_all(&stores).unwrap();fs::create_dir_all(&project).unwrap();
  assert!(Command::new("git").args(["init","-q","--initial-branch=main"])
   .arg(&project).status().unwrap().success());
  let mut config=DaemonConfig::from_argv(&[],&json!({})).unwrap();
  config.graph_directory=graph();config.store_directory=stores.clone();
  config.workspace_root=root.clone();config.repositories=vec!["mockrepo".into()];
  let store=SQLiteRelayStore::open(&relay_unified_store_path(&stores),Some("15")).unwrap();
  store.save_job(&json!({"id":"15","title":"Dashboard task job",
   "repository":"mockrepo","prNumber":0,"projectRoot":project,
   "state":"ACTIVE","plans":[],"createdAt":"2026-11-19T00:00:00.000Z",
   "updatedAt":"2026-11-19T00:00:00.000Z",
   "tasks":[{"id":"7","jobId":"15","title":"Retry target",
    "kind":"work","adapter":"script","state":"FAILED",
    "attempt":2,"maxAttempts":2,"dependencies":[],
    "routing":{"provider":"old"},"workerSelection":{"worker":"old"},
    "createdAt":"2026-11-19T00:00:00.000Z",
    "updatedAt":"2026-11-19T00:00:00.000Z"}]})).unwrap();
  store.close().unwrap();Self{root,config}
 }
 fn job(&self)->Value{
  let store=SQLiteRelayStore::open_without_claim_reset(
   &relay_unified_store_path(&self.config.store_directory),Some("15")).unwrap();
  store.load_job("15").unwrap().unwrap()
 }
}
impl Drop for Fixture{fn drop(&mut self){let _=fs::remove_dir_all(&self.root);}}
#[test]
fn dashboard_retry_and_cancel_are_graph_sqlite_commits_and_survive_restart(){
 let f=Fixture::new();let mut host=IsolatedSQLiteWriteHost::new(f.config.clone());
 let retry=DaemonServices::task_action(&mut host,"15","7","retry").unwrap();
 assert_eq!(retry["tasks"][0]["state"],"QUEUED");
 assert_eq!(retry["tasks"][0]["maxAttempts"],3);
 assert!(retry["tasks"][0].get("routing").is_none());
 assert!(retry["tasks"][0].get("workerSelection").is_none());
 assert_eq!(retry,f.job());
 drop(host);
 let mut restarted=IsolatedSQLiteWriteHost::new(f.config.clone());
 let cancelled=DaemonServices::task_set_state(&mut restarted,"15","7","CANCELLED",
  &json!({"repository":"mockrepo","prNumber":0})).unwrap();
 assert_eq!(cancelled["tasks"][0]["state"],"CANCELLED");
 assert_eq!(cancelled,f.job());
 let repeated=DaemonServices::task_set_state(&mut restarted,"15","7","CANCELLED",
  &json!({"repository":"mockrepo"})).unwrap();
 assert_eq!(repeated,cancelled);
}
#[test]
fn dashboard_failed_actions_never_overwrite_stored_worker_state(){
 let f=Fixture::new();let mut host=IsolatedSQLiteWriteHost::new(f.config.clone());
 let prior=f.job();
 assert!(DaemonServices::task_action(&mut host,"15","missing","retry").is_err());
 assert!(DaemonServices::task_action(&mut host,"15","7","unsupported").is_err());
 assert!(DaemonServices::task_set_state(&mut host,"15","7","RUNNING",
  &json!({"repository":"mockrepo"})).is_err());
 assert!(DaemonServices::task_set_state(&mut host,"15","7","CANCELLED",
  &json!({"repository":"another"})).is_err());
 assert_eq!(f.job(),prior);
}
#[test]
fn dashboard_task_command_uses_same_graph_action_and_rejects_malformed_create(){
 let f=Fixture::new();let mut host=IsolatedSQLiteWriteHost::new(f.config.clone());
 let updated=DaemonServices::task_command(&mut host,
  &json!({"jobId":"15","taskId":"7","action":"retry"})).unwrap();
 assert_eq!(updated["tasks"][0]["state"],"QUEUED");
 assert_eq!(updated,f.job());
 assert!(DaemonServices::task_command(&mut host,
  &json!({"jobId":"15","action":"create","task":{"title":"new"}})).is_err());
 assert_eq!(updated,f.job());
}

#[test]
fn dashboard_task_create_allocates_one_numeric_id_is_idempotent_and_rejects_conflicting_definition(){
 let f=Fixture::new();let mut host=IsolatedSQLiteWriteHost::new(f.config.clone());
 let before=f.job();
 let task=json!({"id":"","jobId":"15","title":"New task",
   "kind":"work","agentName":"developer","state":"DRAFT","attempt":0,
   "maxAttempts":3,"adapter":"script","input":"create once",
   "output":{"kind":"file","path":"out.txt"},"dependencies":[],
   "createdAt":"2026-11-19T00:00:00.000Z",
   "updatedAt":"2026-11-19T00:00:00.000Z"});
 let request=json!({"jobId":"15","action":"create","task":task,
   "idempotencyKey":"same-task-definition"});
 let first=DaemonServices::task_command(&mut host,&request).unwrap();
 let id=first["createdTaskId"].as_str().unwrap().to_owned();
 assert!(id.parse::<u64>().is_ok());
 assert_eq!(first["tasks"].as_array().unwrap().len(),2);
 assert_eq!(first["tasks"][1]["id"],id);
 assert_ne!(f.job(),before);
 drop(host);
 let mut restarted=IsolatedSQLiteWriteHost::new(f.config.clone());
 let second=DaemonServices::task_command(&mut restarted,&request).unwrap();
 assert_eq!(second,first);
 assert_eq!(second["createdTaskId"],id);
 let mut conflicting=request.clone();
 conflicting["task"]["input"]=json!("different definition");
 assert!(DaemonServices::task_command(&mut restarted,&conflicting).unwrap_err()
   .contains("different definition"));
 let mut manual=request.clone();manual["task"]["id"]=json!("123456");
 assert!(DaemonServices::task_command(&mut restarted,&manual).is_err());
 assert_eq!(f.job()["tasks"].as_array().unwrap().len(),2);
}
#[test]
fn dashboard_task_update_uses_original_task_version_and_never_overwrites_stale_state(){
 let f=Fixture::new();let mut host=IsolatedSQLiteWriteHost::new(f.config.clone());
 let original=f.job();let mut updated_task=original["tasks"][0].clone();
 updated_task["input"]=json!("Edited task via Dashboard");
 let request=json!({"jobId":"15","taskId":"7","action":"update",
  "task":updated_task,"expectedUpdatedAt":"2026-11-19T00:00:00.000Z"});
 let committed=DaemonServices::task_command(&mut host,&request).unwrap();
 assert_eq!(committed["tasks"][0]["input"],"Edited task via Dashboard");
 assert_eq!(committed,f.job());
 assert!(DaemonServices::task_command(&mut host,&request).unwrap_err()
  .contains("Task changed since update preflight"));
 let mut self_dependency=request.clone();
 self_dependency["expectedUpdatedAt"]=committed["tasks"][0]["updatedAt"].clone();
 self_dependency["task"]["dependencies"]=json!(["7"]);
 assert!(DaemonServices::task_command(&mut host,&self_dependency).is_err());
 assert_eq!(f.job(),committed);
}

#[test]
fn dashboard_job_cancel_is_graph_sqlite_durable_and_invalid_actions_fail_closed(){
 let f=Fixture::new();let mut host=IsolatedSQLiteWriteHost::new(f.config.clone());
 let reconciled=DaemonServices::job_action(&mut host,"15","reconcile").unwrap();
 assert_eq!(reconciled,f.job(),"explicit reconcile must return committed SQLite snapshot");
 let before=f.job();
 assert!(DaemonServices::job_action(&mut host,"15","invalid").is_err());
 assert!(DaemonServices::job_action(&mut host,"missing","cancel").is_err());
 assert_eq!(f.job(),before);
 let cancelled=DaemonServices::job_action(&mut host,"15","cancel").unwrap();
 assert_eq!(cancelled["state"],"CANCELLED");
 assert_eq!(cancelled,f.job());
 drop(host);
 let mut restarted=IsolatedSQLiteWriteHost::new(f.config.clone());
 assert!(DaemonServices::job_action(&mut restarted,"15","cancel").unwrap_err()
  .contains("not cancellable"));
 assert_eq!(cancelled,f.job());
 assert!(DaemonServices::job_action(&mut restarted,"15","start").is_err());
 assert_eq!(f.job(),cancelled);
}

#[test]
fn dashboard_job_start_uses_canonical_activation_and_persists_restart(){
 let f=Fixture::new();
 {
  let db=SQLiteRelayStore::open_without_claim_reset(
   &relay_unified_store_path(&f.config.store_directory),Some("15")).unwrap();
  db.mutate_job("15",|mut job|{
   job["state"]=json!("DRAFT");Ok(job)
  }).unwrap();
 }
 let mut host=IsolatedSQLiteWriteHost::new(f.config.clone());
 let started=DaemonServices::job_action(&mut host,"15","start").unwrap();
 assert_eq!(started["state"],"ACTIVE");
 assert_eq!(started,f.job());
 drop(host);
 let mut restarted=IsolatedSQLiteWriteHost::new(f.config.clone());
 assert_eq!(DaemonServices::load(&mut restarted,"15").unwrap(),started);
}

#[test]
fn dashboard_reconcile_executes_canonical_graph_with_real_git_head_and_durable_restart(){
 let f=Fixture::new();
 let project=f.root.join("mockrepo");
 let commit=Command::new("git").args(["-C"]).arg(&project).args([
  "-c","user.name=Rust Test","-c","user.email=rust-test@example.invalid",
  "commit","--allow-empty","-m","head for reconciler"]).output().unwrap();
 assert!(commit.status.success(),"{}",String::from_utf8_lossy(&commit.stderr));
 let head=Command::new("git").arg("-C").arg(&project).args([
  "rev-parse","HEAD"]).output().unwrap();
 assert!(head.status.success());
 let head=String::from_utf8_lossy(&head.stdout).trim().to_owned();
 {
  let store=SQLiteRelayStore::open_without_claim_reset(
   &relay_unified_store_path(&f.config.store_directory),Some("15")).unwrap();
  store.mutate_job("15",|mut job|{
   job["state"]=json!("DRAFT");
   job["tasks"]=json!([]);
   job["headSha"]=json!("stale-cached-sha");
   job["reviewEnabled"]=json!(false);
   Ok(job)
  }).unwrap();
 }
 let mut host=IsolatedSQLiteWriteHost::new(f.config.clone());
 let first=DaemonServices::job_action(&mut host,"15","reconcile").unwrap();
 assert_eq!(first["headSha"],head);
 assert_eq!(first["state"],"DRAFT");
 assert_eq!(first,f.job());
 drop(host);
 let mut restarted=IsolatedSQLiteWriteHost::new(f.config.clone());
 let second=DaemonServices::job_action(&mut restarted,"15","reconcile").unwrap();
 assert_eq!(second,first,"repeated Graph pass should preserve terminal facts");
}
