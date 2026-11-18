// Physical loopback + SQLite service fixture for direct Node CLI comparison.
// No live daemon, NATS, provider, global store or remote Git side effects.
use agents_relay_rust2::{
    cli::{runtime,RuntimePaths,create_service,start_service},
    owned_process::OwnedProcessManager,
    relay_store::SQLiteRelayStore,
    relayd::{DaemonConfig,DaemonServices},
};
use serde_json::{json,Value};
use std::{
    fs,io::{Read,Write},net::TcpStream,path::PathBuf,
    sync::{Arc,mpsc::{self,Receiver},atomic::{AtomicUsize,Ordering}},
    time::Duration,
};
struct Host{store:SQLiteRelayStore,effects:Arc<AtomicUsize>,loads:Arc<AtomicUsize>}
impl DaemonServices for Host{
 fn control(&mut self,_:&Value)->Result<Value,String>{Err("Fixture read-only".into())}
 fn load(&mut self,id:&str)->Result<Value,String>{
     self.loads.fetch_add(1,Ordering::SeqCst);
     self.store.load_job(id)?.ok_or_else(||format!("Job {id} not found"))
 }
 fn load_execution_process(&mut self,job_id:&str,task_id:&str,
     execution_id:&str)->Result<Option<Value>,String>{
     self.store.load_execution_process(job_id,task_id,execution_id)
 }
 fn save_exact(&mut self,id:&str,old:&Value,new:&Value)->Result<Value,String>{
     self.store.mutate_job(id,|existing|{
         if &existing!=old{return Err("SQLite generation CAS conflict".into())}
         Ok(new.clone())
     })
 }
 fn job_action(&mut self,_:&str,_:&str)->Result<Value,String>{Err("Fixture read-only".into())}
 fn task_command(&mut self,_:&Value)->Result<Value,String>{Err("Fixture read-only".into())}
 fn task_action(&mut self,_:&str,_:&str,_:&str)->Result<Value,String>{Err("Fixture read-only".into())}
 fn job_set_state(&mut self,_:&str,_:&str,_:&Value)->Result<Value,String>{Err("Fixture read-only".into())}
 fn task_set_state(&mut self,_:&str,_:&str,_:&str,_:&Value)->Result<Value,String>{Err("Fixture read-only".into())}
 fn event_history(&mut self,_:&str,_:Option<&str>,_:i64)->Result<Vec<Value>,String>{Ok(vec![])}
 fn publish_event(&mut self,_:&Value)->Result<(),String>{Ok(())}
 fn subscribe_events(&mut self)->Receiver<String>{mpsc::channel().1}
 fn router_test(&mut self,_:&str,_:&str)->Result<Value,String>{Err("Fixture read-only".into())}
 fn decision_audit(&mut self)->Result<Vec<Value>,String>{Ok(vec![])}
 fn account_usage(&mut self)->Result<Value,String>{Ok(json!({}))}
 fn github_usage(&mut self)->Result<Option<Value>,String>{Ok(None)}
 fn status(&mut self)->Value{json!({"fixture":"sqlite-service"})}
 fn registered_agents(&mut self)->Result<Vec<Value>,String>{Ok(vec![])}
 fn effect(&mut self,_:&Value)->Result<(),String>{
     self.effects.fetch_add(1,Ordering::SeqCst);Ok(())
 }
}
fn response(port:u16)->Result<(u16,String,usize),String>{
 let mut socket=TcpStream::connect(("127.0.0.1",port)).map_err(|e|e.to_string())?;
 socket.set_read_timeout(Some(Duration::from_secs(2))).map_err(|e|e.to_string())?;
 socket.write_all(b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
     .map_err(|e|e.to_string())?;
 let mut data=Vec::new();socket.read_to_end(&mut data).map_err(|e|e.to_string())?;
 let raw=String::from_utf8_lossy(&data);
 let (header,body)=raw.split_once("\r\n\r\n").ok_or("Missing HTTP response headers")?;
 let status=header.split_whitespace().nth(1).unwrap_or("0").parse::<u16>().unwrap_or(0);
 let content_type=header.lines().find_map(|line|line.to_lowercase().strip_prefix("content-type:")
     .map(str::to_owned)).unwrap_or_default().trim().to_string();
 Ok((status,content_type,body.len()))
}
pub fn invoke(req:&Value)->Result<String,String>{
 let root=PathBuf::from(req["root"].as_str().unwrap_or("."));
 let args=req["args"].as_array().into_iter().flatten().filter_map(Value::as_str)
     .map(str::to_owned).collect::<Vec<_>>();
 let job=req["job"].clone();
 let fixture_root=std::env::temp_dir().join("rust2-native-service-fixtures");
 fs::create_dir_all(&fixture_root).map_err(|e|e.to_string())?;
 let db=fixture_root.join(format!("service-fixture-{}.sqlite",std::process::id()));
 let id=job["id"].as_str().ok_or("Job ID required")?;
 let store=SQLiteRelayStore::open(&db,Some(id))?;
 store.save_job(&job)?;
 let effects=Arc::new(AtomicUsize::new(0));
 let loads=Arc::new(AtomicUsize::new(0));
 let host=Host{store,effects:Arc::clone(&effects),loads:Arc::clone(&loads)};
 let mut config=DaemonConfig::from_argv(&[],&json!({
     "workspaceRoot":fixture_root,"storeDirectory":fixture_root,
     "graphDirectory":root.join("workflow"),
     "routerRulesPath":root.join(".rust2-rules"),
     "dashboardAsset":root.join("dist/dashboard.html"),
 }))?;
 config.port=0;config.interval_ms=120000;
 let mut paths=RuntimePaths::for_fixture(&root);
 paths.store=config.store_directory.clone();
 let native=runtime(&args,paths)?;
 let owned=Arc::new(OwnedProcessManager::default());
 let mut service=if req["kind"]=="start"{
     start_service(&args,config,host,native.reconciler,None,owned)?
 }else{create_service(&args,config,host,native.reconciler,None,owned)?};
 let (code,content_type,length)=response(service.port)?;
 let binding=service.job["id"].clone();
 let cleared_before=service.watchdog_cleared;
 let port=service.port;
 service.stop()?;
 let cleared_after=service.watchdog_cleared;
 service.stop()?;
 let closed=TcpStream::connect(("127.0.0.1",port)).is_err();
 let total=loads.load(Ordering::SeqCst);
 let outcome=json!({"code":code,"contentType":content_type,
     "htmlLength":length,"id":binding,"clearedBefore":cleared_before,
     "clearedAfter":cleared_after,"closed":closed,
     "effects":effects.load(Ordering::SeqCst),"loads":total});
 drop(service);
 let _=fs::remove_file(&db);
 Ok(outcome.to_string())
}
