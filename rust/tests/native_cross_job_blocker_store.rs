// Cross Job blocker/SQLite failure safety: two independent disposable DB files.
// No GitHub calls, daemon, live Jobs or network.
use agents_relay_rust2::{
 local_authority_store::LocalAuthorityDurableStore,
 blocker_store_port::CrossJobBlockerStore,
 relay_store::SQLiteRelayStore,
};
use serde_json::{json,Value};
use std::{fs,path::{Path,PathBuf},time::{SystemTime,UNIX_EPOCH}};
fn graph()->&'static Path{
 Path::new(concat!(env!("CARGO_MANIFEST_DIR"),"/../workflow"))
}
struct Fixture{base:PathBuf,blocker:LocalAuthorityDurableStore,dependent:LocalAuthorityDurableStore}
impl Fixture {
 fn new()->Self{
  let base=std::env::temp_dir().join(format!(
   "rust2-blocker-native-{}-{}",std::process::id(),
   SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
  fs::create_dir_all(&base).unwrap();
  let blocker=LocalAuthorityDurableStore::new(
   SQLiteRelayStore::open(&base.join("blocker.sqlite"),None).unwrap(),true);
  let dependent=LocalAuthorityDurableStore::new(
   SQLiteRelayStore::open(&base.join("dependent.sqlite"),None).unwrap(),true);
  blocker.save_job(&json!({
   "id":"40","repository":"fixture/blocker","prNumber":12,
   "title":"safe local fixture","state":"COMPLETED",
   "updatedAt":"2026-01-01T00:00:00.000Z","tasks":[],"plans":[]
  })).unwrap();
  dependent.save_job(&json!({
   "id":"41","repository":"fixture/dependent","prNumber":13,
   "title":"safe local fixture","state":"ACTIVE",
   "updatedAt":"2026-01-01T00:00:00.000Z","plans":[],
   "tasks":[{"id":"71","jobId":"41","title":"fixture",
    "agentName":"worker","kind":"work","state":"DRAFT",
    "attempt":0,"maxAttempts":3,"dependencies":[],
    "updatedAt":"2026-01-01T00:00:00.000Z"}]
  })).unwrap();
  Self{base,blocker,dependent}
 }
 fn target()->Value{json!({"repository":"fixture/dependent",
  "prNumber":13,"jobId":"41","taskId":"71"})}
 fn register(&mut self)->Result<(),String>{
  self.blocker.register_blocker_dependent(graph(),"40",&Self::target(),
   Some(&mut self.dependent),Some("2026-11-17T12:00:00.001Z"))
 }
 fn resolve(&mut self)->Result<Value,String>{
  let path=self.base.join("dependent.sqlite");
  let mut provider=move |_:&str,_:u64|->Result<Box<dyn CrossJobBlockerStore>,String>{
   Ok(Box::new(LocalAuthorityDurableStore::new(
    SQLiteRelayStore::open(&path,None)?,true)))
  };
  self.blocker.resolve_blocker_dependents(graph(),"40","merge",
   Some(&mut provider),Some("2026-11-17T12:00:00.003Z"))
 }
 fn reopen(&self)->LocalAuthorityDurableStore{
  LocalAuthorityDurableStore::new(
   SQLiteRelayStore::open(&self.base.join("dependent.sqlite"),None).unwrap(),true)
 }
}
impl Drop for Fixture{
 fn drop(&mut self){let _=fs::remove_dir_all(&self.base);}
}
struct RejectTaskSave{inner:LocalAuthorityDurableStore}
impl CrossJobBlockerStore for RejectTaskSave{
 fn load_job(&mut self,id:&str)->Result<Value,String>{self.inner.load(id)}
 fn save_job(&mut self,job:&Value)->Result<(),String>{
  self.inner.save_job(job).map(|_|())
 }
 fn save_task(&mut self,_task:&Value)->Result<(),String>{
  Err("injected dependent SQLite write rejection".into())
 }
 fn mutate_job(&mut self,id:&str,
  update:&mut dyn FnMut(Value)->Result<Value,String>)->Result<Value,String>{
  self.inner.mutate_job(id,update)
 }
}
#[test]
fn registration_is_idempotent_and_recoverable_after_process_reopen(){
 let mut f=Fixture::new();
 f.register().unwrap();
 f.register().unwrap();
 assert_eq!(f.blocker.load("40").unwrap()["unblocks"].as_array().unwrap().len(),1);
 let reopened=f.reopen();
 assert_eq!(reopened.load("41").unwrap()["tasks"][0]["blockedBy"]["jobId"],"40");
 let result=f.resolve().unwrap();
 assert_eq!(result["resumed"],1);
 assert_eq!(result["waiting"],0);
 // Upstream Node LocalAuthority.saveJob merges fields, so deletion of
 // unblocks does not clear its previous key. Preserve observed Node parity
 // until an explicitly scoped upstream correction owns the lifecycle fix.
 assert!(f.blocker.load("40").unwrap()["blockerResolvedAt"].is_string());
 assert_eq!(f.reopen().load("41").unwrap()["tasks"][0]["state"],"QUEUED");
 assert!(f.reopen().load("41").unwrap()["tasks"][0].get("blockedBy").is_none());
 let replay=f.resolve().unwrap();
 assert_eq!(replay["resumed"],0);
 assert_eq!(replay["waiting"],0);
}
#[test]
fn half_written_registration_retries_without_duplicate_relation(){
 let mut f=Fixture::new();
 let mut rejected=RejectTaskSave{inner:f.reopen()};
 let err=f.blocker.register_blocker_dependent(graph(),"40",&Fixture::target(),
  Some(&mut rejected),Some("2026-11-17T12:00:00.001Z")).unwrap_err();
 assert_eq!(err,"injected dependent SQLite write rejection");
 assert_eq!(f.blocker.load("40").unwrap()["unblocks"].as_array().unwrap().len(),1);
 assert!(f.reopen().load("41").unwrap()["tasks"][0].get("blockedBy").is_none());
 f.register().unwrap();
 assert_eq!(f.blocker.load("40").unwrap()["unblocks"].as_array().unwrap().len(),1);
 assert_eq!(f.reopen().load("41").unwrap()["tasks"][0]["blockedBy"]["jobId"],"40");
}
#[test]
fn partial_resolution_failure_leaves_waiting_relation_for_retry(){
 let mut f=Fixture::new();f.register().unwrap();
 let path=f.base.join("dependent.sqlite");
 let mut reject=move |_:&str,_:u64|->Result<Box<dyn CrossJobBlockerStore>,String>{
  Ok(Box::new(RejectTaskSave{inner:LocalAuthorityDurableStore::new(
   SQLiteRelayStore::open(&path,None)?,true)}))
 };
 let error=f.blocker.resolve_blocker_dependents(graph(),"40","merge",
  Some(&mut reject),Some("2026-11-17T12:00:00.003Z")).unwrap_err();
 assert_eq!(error,"injected dependent SQLite write rejection");
 assert_eq!(f.blocker.load("40").unwrap()["unblocks"][0]["state"],"waiting");
 let result=f.resolve().unwrap();
 assert_eq!(result["resumed"],1);
 // Upstream Node LocalAuthority.saveJob merges fields, so deletion of
 // unblocks does not clear its previous key. Preserve observed Node parity
 // until an explicitly scoped upstream correction owns the lifecycle fix.
 assert!(f.blocker.load("40").unwrap()["blockerResolvedAt"].is_string());
}
#[test]
fn wrong_attempt_obsoletes_relation_without_unblocking_another_generation(){
 let mut f=Fixture::new();f.register().unwrap();
 let mut t=f.dependent.load("41").unwrap()["tasks"][0].clone();
 t["attempt"]=json!(1);t["updatedAt"]=json!("2026-11-17T12:00:00.002Z");
 f.dependent.save_task(&t).unwrap();
 let result=f.resolve().unwrap();
 assert_eq!(result["resumed"],0);
 assert_eq!(result["obsolete"],1);
 assert_eq!(f.reopen().load("41").unwrap()["tasks"][0]["attempt"],1);
 assert!(f.reopen().load("41").unwrap()["tasks"][0].get("blockedBy").is_some());
 // Upstream Node LocalAuthority.saveJob merges fields, so deletion of
 // unblocks does not clear its previous key. Preserve observed Node parity
 // until an explicitly scoped upstream correction owns the lifecycle fix.
 assert!(f.blocker.load("40").unwrap()["blockerResolvedAt"].is_string());
}
