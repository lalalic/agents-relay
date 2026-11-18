// Real SQLite transaction and EventBus ingress of ReconcilerRuntimeBase.
// No provider process, managed Relay Job, or production state is accessed.
use agents_relay_rust2::{
    events::MemoryEventBus,
    reconciler_runtime_base::{ReconcilerRuntimeBase,RuntimeBaseStore},
    relay_store::SQLiteRelayStore,
    execution_event_identity::execution_event_source,
};
use serde_json::{json,Value};
use std::{path::{Path,PathBuf},sync::{Arc,Mutex,atomic::{AtomicUsize,Ordering}},
    time::{SystemTime,UNIX_EPOCH}};
struct SqliteHost {
    file:PathBuf,
    wakes:AtomicUsize,
    events:Mutex<Vec<Value>>,
}
impl SqliteHost {
    fn store(&self)->SQLiteRelayStore{
        SQLiteRelayStore::open(&self.file,Some("41")).unwrap()
    }
}
impl RuntimeBaseStore for SqliteHost {
    fn load_job(&self,id:&str)->Result<Value,String>{
        self.store().load_job(id)?.ok_or("Job absent".into())
    }
    fn mutate_job(&self,id:&str,mutate:&mut dyn FnMut(Value)->Result<Value,String>)
        ->Result<Value,String>{
        self.store().mutate_job(id,mutate)
    }
    fn reconcile(&self,id:&str)->Result<Value,String>{
        self.wakes.fetch_add(1,Ordering::SeqCst);
        self.load_job(id)
    }
    fn emit(&self,event:&Value)->Result<(),String>{
        self.events.lock().unwrap().push(event.clone());Ok(())
    }
}
fn fixture()->(PathBuf,Arc<SqliteHost>,Value){
    let suffix=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let directory=std::env::temp_dir().join(format!("rust2-runtime-base-{}-{suffix}",std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    let host=Arc::new(SqliteHost{file:directory.join("job.sqlite"),
        wakes:AtomicUsize::new(0),events:Mutex::new(vec![])});
    let stamp="2026-11-17T10:00:00.000Z";
    let task=json!({"id":"1","jobId":"41","title":"Worker", "kind":"work",
        "adapter":"codex","agentName":"worker","state":"QUEUED",
        "executionId":"execution-1","leaseOwner":"relay",
        "leaseExpiresAt":"2026-12-19T00:00:00Z","attempt":1,"maxAttempts":3,
        "createdAt":stamp,"updatedAt":stamp,"dependencies":[],"capabilities":[],
        "executionHistory":[{"id":"execution-1","attempt":1,"startedAt":stamp}]
    });
    let job=json!({"id":"41","repository":"fixture","prNumber":0,
        "state":"ACTIVE","createdAt":stamp,"updatedAt":stamp,
        "tasks":[task],"plans":[],"reviewEnabled":false,"headSha":null});
    host.store().save_job(&job).unwrap();
    (directory,host,job)
}
fn event(kind:&str,source:&str)->Value{
    json!({"version":1,"event_id":format!("evt-{kind}"),"job_id":"41",
        "task_id":"1","type":kind,"timestamp":"2026-11-17T12:00:00Z",
        "status":"running","message":"Worker event",
        "source":{"id":source,"component":"test"},
        "data":{}})
}
#[test]
fn authoritative_event_commit_and_invalid_generation_gate(){
    let (directory,host,baseline)=fixture();
    let graph=Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow");
    let runtime=ReconcilerRuntimeBase::new(graph,"relay",15000,
        Arc::clone(&host) as Arc<dyn RuntimeBaseStore>);
    runtime.handle_event(event("task.started","job/41/task/1/execution/forged")).unwrap();
    assert_eq!(host.load_job("41").unwrap(),baseline);
    assert_eq!(host.wakes.load(Ordering::SeqCst),0);
    let source=execution_event_source("41","1","execution-1");
    runtime.handle_event(event("task.started",&source)).unwrap();
    let durable=host.load_job("41").unwrap();
    assert_eq!(durable["tasks"][0]["state"],"RUNNING");
    runtime.handle_event(event("github.webhook","system")).unwrap();
    assert_eq!(host.load_job("41").unwrap(),durable);
    runtime.handle_event(event("job.wake","system")).unwrap();
    assert_eq!(host.wakes.load(Ordering::SeqCst),1);
    runtime.close().unwrap();drop(runtime);drop(host);
    std::fs::remove_dir_all(directory).unwrap();
}
#[test]
fn interactive_binding_atomic_and_bus_unsubscribe_scoped_to_one_job(){
    let (directory,host,_baseline)=fixture();
    host.store().mutate_job("41",|mut job|{
        job["tasks"][0]["state"]=json!("RUNNING");Ok(job)
    }).unwrap();
    let graph=Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow");
    let runtime=ReconcilerRuntimeBase::new(graph,"relay",15000,
        Arc::clone(&host) as Arc<dyn RuntimeBaseStore>);
    let task=host.load_job("41").unwrap()["tasks"][0].clone();
    let next=runtime.bind_interactive_invocation("41",&task,"execution-1").unwrap();
    assert_eq!(next["tasks"][0]["interactiveInvocation"]["status"],
        "awaiting_decision");
    assert_eq!(host.load_job("41").unwrap(),next);
    assert_eq!(runtime.bind_interactive_invocation("41",&task,"wrong-generation")
        .unwrap_err(),"Task 1 does not own execution wrong-generation");
    assert_eq!(host.load_job("41").unwrap(),next);
    let bus=MemoryEventBus::new();
    let unsubscribe=runtime.watch(Some(&bus),"41");
    bus.publish(&event("job.wake","system")).unwrap();
    runtime.idle();
    assert_eq!(host.wakes.load(Ordering::SeqCst),1);
    unsubscribe();
    bus.publish(&event("job.wake","system")).unwrap();
    runtime.idle();
    assert_eq!(host.wakes.load(Ordering::SeqCst),1);
    runtime.close().unwrap();drop(runtime);drop(host);
    std::fs::remove_dir_all(directory).unwrap();
}
