// Native DurableTaskTransitionRuntime public methods over the SAME canonical
// SQLite authority as daemon Task actions, including cross-process restart,
// monotonic versions, invalid Graph transitions and rollback.
use agents_relay_rust2::{
    workflow::durable_transition::DurableTaskTransitionRuntime,
    local_authority_store::LocalAuthorityDurableStore,
    relay_store::SQLiteRelayStore,
};
use serde_json::{json,Value};
use std::{fs,path::PathBuf,sync::Arc,time::{SystemTime,UNIX_EPOCH}};
fn drive<T>(future:impl std::future::Future<Output=T>)->T{
    use std::{future::Future,pin::pin,task::{Context,Poll,Waker}};
    let mut future=pin!(future);let mut context=Context::from_waker(Waker::noop());
    loop{if let Poll::Ready(value)=Future::poll(future.as_mut(),&mut context){return value;}}
}
struct Fixture{path:PathBuf,root:PathBuf,store:Arc<LocalAuthorityDurableStore>,runtime:DurableTaskTransitionRuntime}
impl Fixture{
 fn new()->Self{
  let root=std::env::temp_dir().join(format!("rust2-durable-transition-{}-{}",
   std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
  fs::create_dir_all(&root).unwrap();
  let path=root.join("relay.sqlite");
  let store=LocalAuthorityDurableStore::new(
   SQLiteRelayStore::open_without_claim_reset(&path,Some("17")).unwrap(),true);
  store.save_job(&json!({"id":"17","repository":"fixture","prNumber":0,
   "projectRoot":root.join("repo"),"state":"ACTIVE","plans":[],
   "tasks":[{"id":"2","jobId":"17","title":"Worker","kind":"work",
    "adapter":"script","state":"DRAFT","attempt":0,"maxAttempts":2,
    "dependencies":[],"createdAt":"2098-11-19T00:00:00.000Z",
    "updatedAt":"2098-11-19T00:00:00.000Z"}]})).unwrap();
  Self{path,root,store:Arc::new(store),runtime:DurableTaskTransitionRuntime::new(
   PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../workflow"))}
 }
 fn loaded(&self)->Value{self.store.load("17").unwrap()}
 fn apply(&self,event:&str,save_ok:bool)->Result<Option<Value>,String>{
  let read=Arc::clone(&self.store);let write=Arc::clone(&self.store);
  drive(self.runtime.apply("17","2",event,move|id|std::future::ready(read.load(id)),
   move|_,task|std::future::ready(if save_ok{
      write.save_task(task)
   }else{Err("isolated SQLite simulated write rejection".into())}),
   |_,_|true,|_,_|json!({}),|_,task,decision|{
    if decision["accepted"]==true{task["input"]=json!("native durable input");}
    Ok(())
   }))
 }
}
impl Drop for Fixture{fn drop(&mut self){let _=fs::remove_dir_all(&self.root);}}
#[test]
fn graph_accepted_and_rejected_task_events_persist_only_after_real_sqlite_save(){
 let f=Fixture::new();
 let prior=f.loaded();
 assert!(f.apply("unsupported_event",true).unwrap_err().contains("unknown event"));
 assert_eq!(f.loaded(),prior);
 assert!(f.apply("release",false).unwrap_err().contains("SQLite simulated"));
 assert_eq!(f.loaded(),prior,"failed write must never invent transition");
 let accepted=f.apply("release",true).unwrap().unwrap();
 assert_eq!(accepted["task"]["state"],"QUEUED");
 assert_eq!(f.loaded()["tasks"][0]["state"],"QUEUED");
 assert!(f.loaded()["tasks"][0]["updatedAt"].as_str().unwrap()>
  prior["tasks"][0]["updatedAt"].as_str().unwrap());
 assert_eq!(f.loaded()["tasks"][0]["input"],"native durable input");
 let reopened=LocalAuthorityDurableStore::new(
  SQLiteRelayStore::open_without_claim_reset(&f.path,Some("17")).unwrap(),true);
 assert_eq!(reopened.load("17").unwrap(),f.loaded());
}
#[test]
fn non_lifecycle_fact_is_serialized_with_graph_and_durable_task_version(){
 let f=Fixture::new();
 f.apply("release",true).unwrap();
 let before=f.loaded();
 let read=Arc::clone(&f.store);
 let save=Arc::clone(&f.store);
 let change=drive(f.runtime.update_fact(
  "17","2",move|id|std::future::ready(read.load(id)),
  move|_,task|std::future::ready(save.save_task(task)),
  |task|task["state"]=="QUEUED",
  |task|{task["result"]=json!({"kind":"observation","value":1});}
 )).unwrap().unwrap();
 assert_eq!(change["result"]["value"],1);
 assert_eq!(f.loaded()["tasks"][0]["result"]["value"],1);
 assert!(f.loaded()["tasks"][0]["updatedAt"].as_str().unwrap()>
  before["tasks"][0]["updatedAt"].as_str().unwrap());
}
