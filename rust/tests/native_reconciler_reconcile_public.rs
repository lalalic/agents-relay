// Native Reconciler.reconcile: real SQLite CAS before effects, terminal and
// paused Jobs preserve Graph/SQLite head refresh and reject stale generations.
use agents_relay_rust2::{reconciler::Reconciler,
    reconciler_durable::ReconcileHost,relay_store::SQLiteRelayStore};
use serde_json::{json,Value};
use std::{path::{Path,PathBuf},time::{SystemTime,UNIX_EPOCH}};
struct Host{store:SQLiteRelayStore,persisted:usize,launched:usize,
    emitted:usize,inject_race:bool}
impl ReconcileHost for Host{
 fn load(&mut self,id:&str)->Result<Value,String>{
     self.store.load_job(id)?.ok_or_else(||"Job missing".into())
 }
 fn persist(&mut self,id:&str,prior:&Value,next:&Value)->Result<Value,String>{
     self.persisted+=1;
     if self.inject_race{
         self.store.mutate_job(id,|mut value|{
             value["headSha"]=json!("concurrent-writer");Ok(value)
         })?;
     }
     self.store.mutate_job(id,|current|{
         if &current!=prior{return Err("SQLite generation CAS conflict".into());}
         Ok(next.clone())
     })
 }
 fn launch(&mut self,_action:&Value)->Result<(),String>{
     self.launched+=1;Ok(())
 }
 fn broadcast(&mut self,_event:&Value)->Result<(),String>{
     self.emitted+=1;Ok(())
 }
}
fn fixture(state:&str,paused:bool)->(PathBuf,Host){
 let suffix=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
 let root=std::env::temp_dir().join(format!("rust2-reconcile-{}-{suffix}",std::process::id()));
 std::fs::create_dir_all(&root).unwrap();
 let store=SQLiteRelayStore::open(&root.join("relay.sqlite"),Some("1")).unwrap();
 store.save_job(&json!({"id":"1","repository":"fixture","prNumber":0,
     "title":"Reconcile","objective":"No work","state":state,
     "createdAt":"2026-11-18T09:00:00.000Z","updatedAt":"2026-11-18T09:00:00.000Z",
     "tasks":[],"plans":[],"reviewEnabled":false,
     "pause":if paused{json!({"reason":"operator"})}else{Value::Null},
     "headSha":"old-head"})).unwrap();
 (root,Host{store,persisted:0,launched:0,emitted:0,inject_race:false})
}
fn rec(root:&Path)->Reconciler{
 Reconciler::new(Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow"),
     root,root,root,root,json!({"owner":"fixture","maxConcurrent":4}))
}
#[test]
fn paused_and_terminal_head_refresh_is_persisted_once_idempotently(){
 for (state,paused) in [("DRAFT",false),("COMPLETED",false),("ACTIVE",true)]{
     let (root,mut host)=fixture(state,paused);let mut reconciler=rec(&root);
     let first=reconciler.reconcile("1",Some("new-head"),&root,&json!({}),
         &[],&[],None,&mut host).unwrap();
     assert_eq!(first["headSha"],"new-head");
     assert_eq!(host.load("1").unwrap()["headSha"],"new-head");
     assert_eq!(host.persisted,1);
     let repeated=reconciler.reconcile("1",Some("new-head"),&root,
         &json!({}),&[],&[],None,&mut host).unwrap();
     assert_eq!(repeated["headSha"],"new-head");
     assert_eq!(host.persisted,1);
     assert_eq!(host.launched,0);assert_eq!(host.emitted,0);
     std::fs::remove_dir_all(root).unwrap();
 }
}
#[test]
fn concurrent_sqlite_mutation_rejects_stale_candidate_before_any_effect(){
 let (root,mut host)=fixture("DRAFT",false);host.inject_race=true;
 let mut reconciler=rec(&root);
 let error=reconciler.reconcile("1",Some("new-head"),&root,&json!({}),
     &[],&[],None,&mut host).unwrap_err();
 assert!(error.contains("CAS conflict"),"{error}");
 assert_eq!(host.load("1").unwrap()["headSha"],"concurrent-writer");
 assert_eq!(host.launched,0);assert_eq!(host.emitted,0);
 std::fs::remove_dir_all(root).unwrap();
}
