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

#[test]
fn daemon_reconciler_exhausted_troubleshooter_creates_one_durable_human_gate(){
 let f=Fixture::new();
 let db=SQLiteRelayStore::open_without_claim_reset(
  &relay_unified_store_path(&f.config.store_directory),Some("15")).unwrap();
 db.mutate_job("15",|mut job|{
  job["reviewEnabled"]=json!(false);
  job["autoMerge"]=json!(false);
  job["plans"]=json!([{
    "id":"plan-1","round":1,"status":"SUCCEEDED","objectiveStatus":"satisfied",
    "createdAt":"2026-11-19T00:00:00.000Z",
    "updatedAt":"2026-11-19T00:00:00.000Z"
  }]);
  job["tasks"][0]["agentName"]=json!("implementation");
  job["tasks"][0]["error"]=json!("Original provider failed");
  job["tasks"][0]["input"]=json!("Original task input");
  job["tasks"][0]["routing"]=Value::Null;
  job["tasks"][0]["workerSelection"]=Value::Null;
  job["tasks"].as_array_mut().unwrap().push(json!({
   "id":"8","jobId":"15","title":"Recovery diagnosis",
   "agentName":"troubleshooter","adapter":"codex","kind":"work",
   "parentTaskId":"7","recoveryForAttempt":2,
   "state":"FAILED","attempt":3,"maxAttempts":3,
   "dependencies":[],"input":"diagnostic [Relay execution fallback attempted]",
   "error":"provider permanently unavailable","executionId":null,
   "leaseOwner":null,"leaseExpiresAt":null,
   "createdAt":"2026-11-19T00:00:00.000Z",
   "updatedAt":"2026-11-19T00:00:00.000Z"
  }));
  Ok(job)
 }).unwrap();
 drop(db);
 let before=f.job();
 assert_eq!(before["tasks"][1]["state"],"FAILED");
 let mut host=IsolatedSQLiteWriteHost::new(f.config.clone());
 let first=DaemonServices::job_action(&mut host,"15","reconcile").unwrap();
 assert_eq!(first,f.job(),"human escalation must be an actual SQLite commit");
 assert_eq!(first["tasks"][1]["state"],"BLOCKED");
 assert_eq!(first["tasks"][1]["escalation"]["status"],"pending");
 assert!(first.get("recoveryFailures").is_none_or(Value::is_null),
  "human gate must not also log a false independent recovery.exhausted");
 assert_eq!(first["tasks"][0]["resolution"]["path"],"escalation_gate");
 assert_eq!(first["tasks"][0]["resolution"]["state"],"waiting");
 assert_eq!(first["tasks"][1]["escalation"]["notification"]["status"],"pending");
 assert!(first["tasks"][1]["escalation"]["fingerprint"].as_str()
   .is_some_and(|value|value.len()==64));
 drop(host);
 let mut restarted=IsolatedSQLiteWriteHost::new(f.config.clone());
 let again=DaemonServices::job_action(&mut restarted,"15","reconcile").unwrap();
 assert_eq!(again["tasks"][1]["escalation"]["id"],
  first["tasks"][1]["escalation"]["id"],
  "restart must not create a second human escalation identity");
 assert_eq!(again["tasks"][1]["escalation"]["fingerprint"],
  first["tasks"][1]["escalation"]["fingerprint"]);
 assert_eq!(again["tasks"][1]["escalation"]["notification"]["lastError"],
  "Notification delivery channel is not configured",
  "no notifier must persist pending/no-channel, not fake delivered");
 assert_eq!(again["tasks"][1]["escalation"]["notification"]["status"],"pending");
 assert_eq!(again["tasks"][0]["resolution"],first["tasks"][0]["resolution"]);
 assert_eq!(again,f.job());
 let third=DaemonServices::job_action(&mut restarted,"15","reconcile").unwrap();
 assert_eq!(third,again,"missing-channel ledger must not churn across passes");
 assert_eq!(third,f.job());
}

#[test]
fn daemon_reconciler_snapshot_binds_only_one_bounded_fallback_before_human_gate(){
 let f=Fixture::new();
 let job_store=SQLiteRelayStore::open_without_claim_reset(
  &relay_unified_store_path(&f.config.store_directory),Some("15")).unwrap();
 let job=job_store.mutate_job("15",|mut job|{
  job["reviewEnabled"]=json!(false);
  job["plans"]=json!([{"id":"plan-1","round":1,"status":"SUCCEEDED",
   "objectiveStatus":"satisfied",
   "createdAt":"2026-11-19T00:00:00.000Z",
   "updatedAt":"2026-11-19T00:00:00.000Z"}]);
  job["tasks"][0]["agentName"]=json!("implementation");
  job["tasks"][0]["error"]=json!("Original provider unavailable");
  job["tasks"][0]["input"]=json!("Original task input");
  job["tasks"][0]["routing"]=Value::Null;
  job["tasks"][0]["workerSelection"]=Value::Null;
  job["tasks"].as_array_mut().unwrap().push(json!({
   "id":"8","jobId":"15","title":"Recovery diagnosis",
   "agentName":"troubleshooter","adapter":"codex","kind":"work",
   "parentTaskId":"7","recoveryForAttempt":2,
   "state":"FAILED","attempt":3,"maxAttempts":3,
   "dependencies":[],"input":"Investigate provider failure",
   "error":"worker_process_failed: provider unavailable","executionId":null,
   "leaseOwner":null,"leaseExpiresAt":null,
   "createdAt":"2026-11-19T00:00:00.000Z",
   "updatedAt":"2026-11-19T00:00:00.000Z"
  }));
  Ok(job)
 }).unwrap();
 drop(job_store);
 let mut reconciler=agents_relay_rust2::reconciler::Reconciler::new(
  graph(),f.config.store_directory.clone(),f.config.profile_home.clone(),
  f.config.policy_path.clone(),f.config.router_rules_path.clone(),
  json!({"owner":"isolated-probe","maxConcurrent":0}));
 let adapters:Vec<Value>=vec![];
 let first=reconciler.reconcile_snapshot(&job,None,&f.root.join("mockrepo"),
  &json!({"workspaceRoot":f.root}),&adapters,&[],None).unwrap();
 assert_eq!(first.job["tasks"][1]["state"],"QUEUED");
 assert_eq!(first.job["tasks"][1]["maxAttempts"],4);
 assert!(first.job["tasks"][1]["input"].as_str()
  .unwrap().contains("[Relay execution fallback attempted]"));
 assert_eq!(first.job["tasks"][1]["routing"]["provider"],"");
 assert_eq!(first.job["tasks"][1]["routing"]["model"],"");
 assert!(first.events.iter().any(|event|
  event["type"]=="troubleshooter.retry_queued"
  &&event["task_id"]=="8"));
 assert!(agents_relay_rust2::troubleshooter_fallback::
  exhausted_troubleshooter_escalations(&first.job).is_empty(),
  "last-model retry cannot request premature human escalation");
 assert_eq!(f.job(),job,"snapshot must never mutate SQLite before CAS");
}

#[test]
fn isolated_reconciler_notification_requires_verified_loopback_receipt_and_sqlite_fence(){
 use std::io::{Read,Write};
 use std::net::TcpListener;
 use std::thread;
 use std::time::Duration;
 for (mode,verified) in [("valid",true),("missing-receipt",false)]{
  let f=Fixture::new();
  let database=SQLiteRelayStore::open_without_claim_reset(
   &relay_unified_store_path(&f.config.store_directory),Some("15")).unwrap();
  database.mutate_job("15",|mut job|{
   job["tasks"][0]["agentName"]=json!("implementation");
   job["tasks"][0]["error"]=json!("provider rejected");
   job["tasks"].as_array_mut().unwrap().push(json!({
    "id":"8","jobId":"15","agentName":"troubleshooter","kind":"work",
    "adapter":"codex","parentTaskId":"7","input":"diagnose",
    "state":"FAILED","attempt":3,"maxAttempts":3,
    "error":"provider failed","executionId":null,
    "leaseOwner":null,"leaseExpiresAt":null,
    "createdAt":"2026-11-19T00:00:00.000Z",
    "updatedAt":"2026-11-19T00:00:00.000Z"
   }));
   Ok(job)
  }).unwrap();
  drop(database);
  let mut host=IsolatedSQLiteWriteHost::new(f.config.clone());
  let gate=DaemonServices::control(&mut host,&json!({
   "command":"task.escalate","jobId":"15","taskId":"8",
   "requiredAction":"Provide verified restoration action",
   "resolutionCondition":"Owner decision with evidence",
   "context":"The external runtime could not start"
  })).unwrap();
  let original_id=gate["tasks"][1]["escalation"]["id"].as_str().unwrap().to_owned();
  assert_eq!(gate["tasks"][1]["escalation"]["status"],"pending");
  let listener=TcpListener::bind("127.0.0.1:0").unwrap();
  let port=listener.local_addr().unwrap().port();
  let server=thread::spawn(move||{
   let (mut conn,_)=listener.accept().unwrap();
   conn.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
   let mut content=Vec::new();
   let request=loop {
    let mut chunk=[0u8;2048];
    let size=conn.read(&mut chunk).unwrap();
    assert!(size>0,"missing notifier HTTP POST body");
    content.extend_from_slice(&chunk[..size]);
    if let Some(index)=content.windows(4).position(|entry|entry==b"\r\n\r\n"){
     let headers=String::from_utf8_lossy(&content[..index]);
     let declared=headers.lines().find_map(|line|{
      let (k,v)=line.split_once(':')?;
      (k.eq_ignore_ascii_case("Content-Length")).then(||v.trim().parse::<usize>().ok()).flatten()
     }).unwrap_or(0);
     if content.len()>=index+4+declared{
      break String::from_utf8(content).unwrap();
     }
    }
   };
   let payload=if verified{
    json!({"delivered":true,"channel":"test-loopback",
     "deliveryId":"receipt-native-15",
     "deliveredAt":"2026-11-20T12:00:00.000Z"})
   }else{
    json!({"delivered":true,"channel":"test-loopback",
     "deliveredAt":"2026-11-20T12:00:00.000Z"})
   };
   let body=payload.to_string();
   write!(conn,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
    body.len(),body).unwrap();
   conn.flush().unwrap();
   request
  });
  assert!(host.set_test_loopback_escalation_notifier(
   agents_relay_rust2::escalation_notifier::EscalationNotifierConfig{
    url:url::Url::parse("https://notify.example.invalid/").unwrap(),token:None
   }).is_err(),"isolation must reject external HTTPS before provider I/O");
  host.set_test_loopback_escalation_notifier(
   agents_relay_rust2::escalation_notifier::EscalationNotifierConfig{
    url:url::Url::parse(&format!("http://127.0.0.1:{port}/receipt")).unwrap(),
    token:Some("isolated-test-token".into())
   }).unwrap();
  DaemonServices::deliver_pending_escalations(&mut host,"15").unwrap();
  let recorded=server.join().unwrap();
  assert!(recorded.starts_with("POST /receipt HTTP/1.1"),"{mode}: {recorded}");
  assert!(recorded.contains(&format!("Idempotency-Key: escalation/{original_id}"))
   ||recorded.to_ascii_lowercase().contains(&format!("idempotency-key: escalation/{original_id}")),
   "{mode}: expected immutable HTTP Idempotency-Key");
  assert!(recorded.contains("Authorization: Bearer isolated-test-token")
   ||recorded.contains("authorization: Bearer isolated-test-token"));
  let stored=f.job();
  assert_eq!(stored["tasks"][1]["escalation"]["id"],original_id);
  if verified{
   assert_eq!(stored["tasks"][1]["escalation"]["notification"]["status"],"delivered");
   assert_eq!(stored["tasks"][1]["escalation"]["notification"]["deliveryId"],
    "receipt-native-15");
   // Reconciliation cannot replay a delivered notification or invent a
   // different escalation fingerprint after native daemon recreation.
   let mut restarted=IsolatedSQLiteWriteHost::new(f.config.clone());
   DaemonServices::deliver_pending_escalations(&mut restarted,"15").unwrap();
   assert_eq!(f.job(),stored);
  }else{
   assert_eq!(stored["tasks"][1]["escalation"]["notification"]["status"],"pending");
   assert_eq!(stored["tasks"][1]["escalation"]["notification"]["attempts"],1);
   assert_eq!(stored["tasks"][1]["escalation"]["notification"]["lastError"],
    "Notification endpoint did not provide a verified delivery ID");
   assert!(stored["tasks"][1]["escalation"]["notification"]["nextAttemptAt"].is_string());
  }
 }
}

#[test]
fn concurrent_isolated_daemon_human_escalations_preserve_one_sqlite_identity(){
 use std::sync::{Arc,Barrier};
 use std::thread;
 let f=Fixture::new();
 let db=SQLiteRelayStore::open_without_claim_reset(
  &relay_unified_store_path(&f.config.store_directory),Some("15")).unwrap();
 db.mutate_job("15",|mut job|{
  job["tasks"][0]["agentName"]=json!("implementation");
  job["tasks"][0]["error"]=json!("Provider unavailable");
  job["tasks"].as_array_mut().unwrap().push(json!({
   "id":"8","jobId":"15","agentName":"troubleshooter","kind":"work",
   "adapter":"codex","parentTaskId":"7","input":"diagnose",
   "state":"FAILED","attempt":3,"maxAttempts":3,
   "error":"worker delivery failed","executionId":null,
   "leaseOwner":null,"leaseExpiresAt":null,
   "createdAt":"2026-11-19T00:00:00.000Z",
   "updatedAt":"2026-11-19T00:00:00.000Z"
  }));
  Ok(job)
 }).unwrap();
 drop(db);
 let request=json!({"command":"task.escalate","jobId":"15","taskId":"8",
   "requiredAction":"Inspect failed provider and approve repair",
   "resolutionCondition":"Verified corrective action",
   "context":"No owned task execution can be started"});
 let gate=Arc::new(Barrier::new(2));
 let mut threads=Vec::new();
 for _ in 0..2{
  let config=f.config.clone();
  let barrier=Arc::clone(&gate);
  let payload=request.clone();
  threads.push(thread::spawn(move||{
   let mut host=IsolatedSQLiteWriteHost::new(config);
   barrier.wait();
   DaemonServices::control(&mut host,&payload)
  }));
 }
 let results=threads.into_iter().map(|task|task.join().unwrap())
  .collect::<Vec<_>>();
 assert!(results.iter().any(Result::is_ok),
  "at least one authorized atomic escalation must commit: {results:?}");
 let saved=f.job();
 let id=saved["tasks"][1]["escalation"]["id"].as_str()
  .expect("one committed human escalation").to_owned();
 assert_eq!(saved["tasks"][1]["state"],"BLOCKED");
 assert_eq!(saved["tasks"][0]["resolution"]["state"],"waiting");
 for result in results.iter().filter_map(|v|v.as_ref().ok()){
  assert_eq!(result["tasks"][1]["escalation"]["id"],id,
   "parallel callers must never create different human gate IDs");
 }
 let mut restarted=IsolatedSQLiteWriteHost::new(f.config.clone());
 let replay=DaemonServices::control(&mut restarted,&request).unwrap();
 assert_eq!(replay["tasks"][1]["escalation"]["id"],id);
 assert_eq!(replay,f.job());
 assert_eq!(replay["tasks"][1]["escalation"]["status"],"pending");
}
