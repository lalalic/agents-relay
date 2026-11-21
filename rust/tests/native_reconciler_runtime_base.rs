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
    fn apply_host_invocation_event(
        &self,graph:&Path,event:&Value,
        coordinator:&mut agents_relay_rust2::interactive_invocation::
            HostInteractiveInvocationCoordinator,
    )->Result<agents_relay_rust2::reconciler_runtime::RuntimeEffect,String>{
        use agents_relay_rust2::{
            interactive_invocation_ports::host_invocation_ports,
            interactive_resume::recover_interactive_decisions,
            reconciler_runtime::RuntimeEffect,
        };
        let mut store=self.store();
        let mut accepted_events=Vec::new();
        let mut ports=host_invocation_ports(&mut store);
        let outcome=coordinator.apply_event(&mut ports,graph,event,
            |_,_|Ok(()),
            |accepted|{accepted_events.push(accepted.clone());Ok(())})?;
        drop(ports);
        for accepted in accepted_events{self.emit(&accepted)?;}
        let job_id=event["job_id"].as_str().unwrap_or("");
        let resumed=outcome["resumeWorker"]==true
            &&outcome["decision"].is_object()
            &&recover_interactive_decisions(graph,&store,job_id)?;
        let latest=store.load_job(job_id)?.ok_or("Host Job disappeared")?;
        let status=outcome["outcome"].as_str().unwrap_or("ignored");
        let reason=format!("task.interactive_decision.{status}");
        if status=="ignored"{
            return Ok(RuntimeEffect::ignored(&latest,reason));
        }
        Ok(RuntimeEffect::recognized(&latest,reason,
            resumed||status=="accepted"))
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

#[test]
fn interactive_host_decision_through_runtime_bus_is_durable_and_untrusted_replay_cannot_approve(){
 use agents_relay_rust2::interactive_invocation::host_interactive_decision_event;
 let (directory,host,_initial)=fixture();
 host.store().mutate_job("41",|mut job|{
  let task=&mut job["tasks"][0];
  task["state"]=json!("AWAITING_DECISION");
  task["interactiveInvocation"]=json!({
   "invocationId":"execution-1","revision":"execution-1",
   "executionId":"execution-1","status":"awaiting_decision",
   "boundAt":"2026-11-17T12:00:00.000Z"
  });
  Ok(job)
 }).unwrap();
 let graph=Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow");
 let runtime=ReconcilerRuntimeBase::new(graph,"relay",15000,
  Arc::clone(&host) as Arc<dyn RuntimeBaseStore>);
 let valid=host_interactive_decision_event(
  &json!({"jobId":"41","taskId":"1","executionId":"execution-1"}),
  &json!({"eventId":"decision-valid-1","decision":"approved",
   "feedback":"Verified by fixture owner","comments":[]}),
  "2026-11-17T13:00:00.000Z").unwrap();
 let mut forged=valid.clone();
 forged["source"]["id"]=json!("job/41/task/1/execution/forged");
 runtime.handle_event(forged).unwrap();
 assert_eq!(host.load_job("41").unwrap()["tasks"][0]["interactiveInvocation"]["status"],
  "awaiting_decision","forged host source must never persist an approval");
 runtime.handle_event(valid.clone()).unwrap();
 assert_eq!(host.events.lock().unwrap().iter().filter(|event|
  event["type"]=="task.interactive_decision.accepted").count(),1,
  "exactly one accepted-event emission must follow SQLite commit");
 let accepted=host.load_job("41").unwrap();
 assert_eq!(accepted["tasks"][0]["interactiveInvocation"]["status"],"approved",
  "actual Host decision must commit in SQLite before the runtime emits accepted");
 assert!(matches!(accepted["tasks"][0]["state"].as_str(),Some("QUEUED"|"DRAFT")),
  "Graph authorized host decision must actually resume Task: {accepted}");
 let before=accepted.clone();
 runtime.handle_event(valid.clone()).unwrap();
 assert_eq!(host.load_job("41").unwrap(),before,
  "duplicate event after durable approval cannot run a second transition");
 runtime.close().unwrap();drop(runtime);
 // A daemon can exit between decision persistence and a caller's retry.
 // A new runtime must not replay accepted events or change the Task again.
 let reopened=ReconcilerRuntimeBase::new(
  Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow"),
  "new-daemon-owner",15000,Arc::clone(&host) as Arc<dyn RuntimeBaseStore>);
 reopened.handle_event(valid).unwrap();
 assert_eq!(host.load_job("41").unwrap(),before,
  "an accepted decision must remain idempotent after daemon recreation");
 assert_eq!(host.events.lock().unwrap().iter().filter(|event|
  event["type"]=="task.interactive_decision.accepted").count(),1,
  "restarted daemon cannot republish an accepted decision");
 reopened.close().unwrap();drop(reopened);drop(host);
 std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn interactive_changes_requested_is_graph_resumed_with_feedback_and_replay_fence(){
 use agents_relay_rust2::interactive_invocation::host_interactive_decision_event;
 let (directory,host,_initial)=fixture();
 host.store().mutate_job("41",|mut job|{
  let task=&mut job["tasks"][0];
  task["state"]=json!("AWAITING_DECISION");
  task["interactiveInvocation"]=json!({
   "invocationId":"execution-1","revision":"execution-1",
   "executionId":"execution-1","status":"awaiting_decision",
   "boundAt":"2026-11-17T12:00:00.000Z"
  });
  Ok(job)
 }).unwrap();
 let graph=Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow");
 let runtime=ReconcilerRuntimeBase::new(graph,"relay",15000,
  Arc::clone(&host) as Arc<dyn RuntimeBaseStore>);
 let event=host_interactive_decision_event(
  &json!({"jobId":"41","taskId":"1","executionId":"execution-1"}),
  &json!({"eventId":"decision-changes-1","decision":"changes_requested",
   "feedback":"Fix missing integration evidence","comments":[{"text":"Need E2E proof"}]}),
  "2026-11-17T13:00:00.000Z").unwrap();
 runtime.handle_event(event.clone()).unwrap();
 let committed=host.load_job("41").unwrap();
 assert_eq!(committed["tasks"][0]["interactiveInvocation"]["status"],"changes_requested");
 assert_eq!(committed["tasks"][0]["state"],"QUEUED");
 assert!(committed.to_string().contains("Fix missing integration evidence"),
  "requested changes must be recorded durably on Job/Task");
 let before=committed.clone();
 runtime.handle_event(event).unwrap();
 assert_eq!(host.load_job("41").unwrap(),before);
 assert_eq!(host.events.lock().unwrap().iter().filter(|e|
  e["type"]=="task.interactive_decision.accepted").count(),1);
 runtime.close().unwrap();drop(runtime);drop(host);
 std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn interactive_host_bind_returns_one_shot_decision_only_after_sqlite_commit(){
 use agents_relay_rust2::interactive_invocation::host_interactive_decision_event;
 let (directory,host,_initial)=fixture();
 host.store().mutate_job("41",|mut job|{
  job["tasks"][0]["state"]=json!("RUNNING");
  Ok(job)
 }).unwrap();
 let graph=Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow");
 let runtime=ReconcilerRuntimeBase::new(graph,"relay",15000,
  Arc::clone(&host) as Arc<dyn RuntimeBaseStore>);
 let original=host.load_job("41").unwrap();
 let (bound,waiting)=runtime.bind_interactive_invocation_with_waiter(
  "41",&original["tasks"][0],"execution-1").unwrap();
 assert_eq!(bound,host.load_job("41").unwrap(),
  "Host cannot register a volatile waiter before SQLite bind");
 assert_eq!(bound["tasks"][0]["interactiveInvocation"]["status"],"awaiting_decision");
 let waiting_event=event("task.interactive_waiting",
  &execution_event_source("41","1","execution-1"));
 runtime.handle_event(waiting_event).unwrap();
 assert_eq!(host.load_job("41").unwrap()["tasks"][0]["state"],"AWAITING_DECISION");
 let decision=host_interactive_decision_event(
  &json!({"jobId":"41","taskId":"1","executionId":"execution-1"}),
  &json!({"eventId":"decision-waiter-1","decision":"approved",
    "feedback":"Owner explicitly approved","comments":[]}),
  "2026-11-17T13:00:00.000Z").unwrap();
 runtime.handle_event(decision.clone()).unwrap();
 let received=waiting.wait().unwrap();
 assert_eq!(received["jobId"],"41");
 assert_eq!(received["taskId"],"1");
 assert_eq!(received["executionId"],"execution-1");
 assert_eq!(received["decision"],"approved");
 assert_eq!(received["feedback"],"Owner explicitly approved");
 assert_eq!(received["event"],decision);
 assert_eq!(host.load_job("41").unwrap()["tasks"][0]["state"],"QUEUED");
 assert_eq!(host.events.lock().unwrap().iter().filter(|e|
  e["type"]=="task.interactive_decision.accepted").count(),1);
 runtime.close().unwrap();drop(runtime);drop(host);
 std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn interactive_host_wait_timeout_and_close_do_not_invent_human_approval(){
 use std::time::Duration;
 let (directory,host,_initial)=fixture();
 host.store().mutate_job("41",|mut job|{
  job["tasks"][0]["state"]=json!("RUNNING");
  Ok(job)
 }).unwrap();
 let runtime=ReconcilerRuntimeBase::new(
  Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow"),
  "relay",15000,Arc::clone(&host) as Arc<dyn RuntimeBaseStore>);
 let task=host.load_job("41").unwrap()["tasks"][0].clone();
 let (_,waiting)=runtime.bind_interactive_invocation_with_waiter(
  "41",&task,"execution-1").unwrap();
 assert_eq!(waiting.wait_timeout(Duration::from_millis(2)).unwrap_err(),
  "Interactive decision timeout for task 1, revision execution-1");
 assert_eq!(host.load_job("41").unwrap()["tasks"][0]["interactiveInvocation"]["status"],
  "awaiting_decision",
  "timeout cannot mark approval or invent Task progress");
 let (_,another)=runtime.bind_interactive_invocation_with_waiter(
  "41",&task,"execution-1").unwrap();
 runtime.close().unwrap();
 assert_eq!(another.wait_timeout(Duration::from_millis(2)).unwrap_err(),
  "Interactive decision timeout for task 1, revision execution-1",
  "closed Host still rejects at its Promise deadline, never claims approval");
 assert_eq!(host.events.lock().unwrap().iter().filter(|event|
  event["type"]=="task.interactive_decision.accepted").count(),0);
 drop(runtime);drop(host);
 std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn host_waiter_ignores_forged_source_and_stale_decision_until_trusted_receipt(){
 use agents_relay_rust2::interactive_invocation::host_interactive_decision_event;
 use std::time::Duration;
 let (directory,host,_initial)=fixture();
 host.store().mutate_job("41",|mut job|{
  job["tasks"][0]["state"]=json!("RUNNING");Ok(job)
 }).unwrap();
 let runtime=ReconcilerRuntimeBase::new(
  Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow"),
  "relay",15000,Arc::clone(&host) as Arc<dyn RuntimeBaseStore>);
 let task=host.load_job("41").unwrap()["tasks"][0].clone();
 let (_,waiting)=runtime.bind_interactive_invocation_with_waiter(
  "41",&task,"execution-1").unwrap();
 let wait_signal=event("task.interactive_waiting",
  &execution_event_source("41","1","execution-1"));
 runtime.handle_event(wait_signal).unwrap();
 let genuine=host_interactive_decision_event(
  &json!({"jobId":"41","taskId":"1","executionId":"execution-1"}),
  &json!({"eventId":"decision-trusted-later","decision":"approved",
   "feedback":"Verified complete","comments":[]}),
  "2026-11-17T13:00:00.000Z").unwrap();
 let mut forged=genuine.clone();
 forged["event_id"]=json!("decision-forged");
 forged["source"]["id"]=json!("job/41/task/1/execution/not-the-owner");
 runtime.handle_event(forged).unwrap();
 assert_eq!(host.load_job("41").unwrap()["tasks"][0]["interactiveInvocation"]["status"],
  "awaiting_decision","untrusted UI event must never mutate authoritative invocation");
 let mut stale=genuine.clone();
 stale["event_id"]=json!("decision-stale");
 stale["data"]["interactive"]["executionId"]=json!("stale-exec");
 runtime.handle_event(stale).unwrap();
 assert_eq!(host.events.lock().unwrap().iter()
  .filter(|row|row["type"]=="task.interactive_decision.accepted").count(),0);
 runtime.handle_event(genuine.clone()).unwrap();
 let result=waiting.wait_timeout(Duration::from_millis(100)).unwrap();
 assert_eq!(result["event"],genuine);
 assert_eq!(result["decision"],"approved");
 assert_eq!(host.events.lock().unwrap().iter()
  .filter(|row|row["type"]=="task.interactive_decision.accepted").count(),1);
 runtime.close().unwrap();drop(runtime);drop(host);
 std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn host_waiter_delivers_changes_requested_comments_after_durable_retry(){
 use agents_relay_rust2::interactive_invocation::host_interactive_decision_event;
 let (directory,host,_initial)=fixture();
 host.store().mutate_job("41",|mut job|{
  job["tasks"][0]["state"]=json!("RUNNING");Ok(job)
 }).unwrap();
 let runtime=ReconcilerRuntimeBase::new(
  Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow"),
  "relay",15000,Arc::clone(&host) as Arc<dyn RuntimeBaseStore>);
 let task=host.load_job("41").unwrap()["tasks"][0].clone();
 let (_,waiting)=runtime.bind_interactive_invocation_with_waiter(
  "41",&task,"execution-1").unwrap();
 runtime.handle_event(event("task.interactive_waiting",
  &execution_event_source("41","1","execution-1"))).unwrap();
 let data=host_interactive_decision_event(
  &json!({"jobId":"41","taskId":"1","executionId":"execution-1"}),
  &json!({"eventId":"decision-accepted-changes","decision":"changes_requested",
    "feedback":"Please show new tests","comments":[{"text":"Cover stale replay"}]}),
  "2026-11-17T13:00:00.000Z").unwrap();
 runtime.handle_event(data.clone()).unwrap();
 let received=waiting.wait().unwrap();
 assert_eq!(received["decision"],"changes_requested");
 assert_eq!(received["feedback"],"Please show new tests");
 assert_eq!(received["comments"][0]["text"],"Cover stale replay");
 assert_eq!(received["event"],data);
 let persisted=host.load_job("41").unwrap();
 assert_eq!(persisted["tasks"][0]["state"],"QUEUED");
 assert_eq!(persisted["tasks"][0]["interactiveInvocation"]["status"],"changes_requested");
 assert!(persisted.to_string().contains("Please show new tests"));
 runtime.close().unwrap();drop(runtime);drop(host);
 std::fs::remove_dir_all(directory).unwrap();
}
