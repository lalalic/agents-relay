// Node src/cli-support.ts true readonly-vs-authoritative store routing and
// bounded EventBus ownership; uses only disposable files and fake transport.
use agents_relay_rust2::{
  cli_support::{store_for,CliBoundStore,event_bus,with_event_bus,ServiceEventBusPort},
  events::Wake,
  relay_store::SQLiteRelayStore,
};
use serde_json::{json,Value};
use std::{path::PathBuf,fs,sync::{Arc,atomic::{AtomicBool,Ordering}},
 time::{SystemTime,UNIX_EPOCH}};
fn fixture_root()->PathBuf{
 std::env::temp_dir().join(format!("rust2-cli-support-{}-{}",
 std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()))
}
fn job(id:&str)->Value{
 json!({"id":id,"repository":"local-api","prNumber":0,"state":"ACTIVE",
   "projectRoot":"/tmp/local-api","plans":[],"tasks":[],"title":"test",
   "updatedAt":"2026-11-17T19:00:00.000Z","createdAt":"2026-11-17T19:00:00.000Z"})
}
#[test]
fn file_bindings_own_in_memory_store_and_keep_disk_unchanged(){
 let root=fixture_root();fs::create_dir_all(&root).unwrap();
 let file=root.join("job.json");fs::write(&file,job("901").to_string()).unwrap();
 let args=vec!["--file".into(),file.to_string_lossy().to_string()];
 let binding=store_for(&args,&root,false,false).unwrap();
 assert!(matches!(binding.store,CliBoundStore::InMemory(_)));
 assert_eq!(binding.job["id"],"901");
 assert_eq!(binding.store.load("901").unwrap()["title"],"test");
 assert!(binding.local_file.is_some());
 assert_eq!(serde_json::from_str::<Value>(&fs::read_to_string(&file).unwrap()).unwrap(),job("901"));
 let mut fenced=args.clone();fenced.extend(["--id".into(),"wrong".into()]);
 assert_eq!(store_for(&fenced,&root,false,true).err().unwrap(),"Local --file Job ID binding mismatch");
 fenced[3]="901".into();fenced.extend(["--repo".into(),"other".into()]);
 assert_eq!(store_for(&fenced,&root,false,true).err().unwrap(),"Local --file repository binding mismatch");
 fs::remove_dir_all(root).unwrap();
}
#[test]
fn read_only_lookup_does_not_create_writer_and_mutable_respects_scoped_job(){
 let root=fixture_root();fs::create_dir_all(&root).unwrap();
 let directory=root.join("stores");fs::create_dir_all(&directory).unwrap();
 let path=root.join("relay.sqlite");let original=job("902");
 let relay=SQLiteRelayStore::open(&path,Some("902")).unwrap();
 relay.save_job(&original).unwrap();relay.close().unwrap();
 let readonly=store_for(&["--id".into(),"902".into()],&directory,true,false).unwrap();
 assert!(matches!(readonly.store,CliBoundStore::InMemory(_)));
 assert_eq!(readonly.job["id"],"902");
 let mutable=store_for(&["--id".into(),"902".into(),"--repo".into(),"local-api".into()],
    &directory,false,false).unwrap();
 assert!(mutable.store.is_writable_sqlite());
 assert_eq!(mutable.store.load("902").unwrap(),original);
 drop(mutable);
 assert_eq!(store_for(&["--id".into(),"902".into(),"--repo".into(),"wrong".into()],
    &directory,false,false).err().unwrap(),"Immutable local Job not found for repository: 902");
 fs::remove_dir_all(root).unwrap();
}
struct TestBus {closed:Arc<AtomicBool>}
impl ServiceEventBusPort for TestBus {
 fn publish(&self,_event:&Value)->Result<(),String>{Ok(())}
 fn subscribe(&self,_id:&str,_wake:Wake)->Result<Box<dyn FnOnce()+Send>,String>{
  Ok(Box::new(||{}))
 }
 fn subscribe_all(&self,_wake:Wake)->Result<Box<dyn FnOnce()+Send>,String>{
  Ok(Box::new(||{}))
 }
 fn close(&self)->Result<(),String>{self.closed.store(true,Ordering::SeqCst);Ok(())}
}
#[test]
fn with_event_bus_closes_on_success_and_work_error(){
 for fail in [false,true]{
  let closed=Arc::new(AtomicBool::new(false));
  let bus=TestBus{closed:Arc::clone(&closed)};
  let result=with_event_bus::<TestBus,_,_,_>(
   &[], |_|Ok(Some(bus)),|b|{
    assert!(b.is_some());if fail{Err("work rejected".into())}
    else{Ok("done")}
   });
  assert_eq!(result.is_err(),fail);
  assert!(closed.load(Ordering::SeqCst));
 }
}
#[test]
fn explicit_none_transport_skips_external_nats_and_explicit_nats_does_not_ping(){
 let none=event_bus(&["--file".into(),"fixture.json".into()],&json!({}),
   Some(&|_|panic!("local fixtures do not probe NATS"))).unwrap();
 assert!(none.is_none());
 let disabled=event_bus(&["--events".into(),"none".into()],&json!({}),
   Some(&|_|panic!("explicit none never probes"))).unwrap();
 assert!(disabled.is_none());
 let explicit=event_bus(&["--events".into(),"nats".into()],&json!({}),
   Some(&|_|panic!("explicit NATS transport is selected, not probed"))).unwrap();
 assert!(explicit.is_some());
 explicit.unwrap().close().unwrap();
}
