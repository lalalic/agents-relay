use agents_relay_rust2::{
    interactive_invocation::{HostInteractiveInvocationCoordinator,host_interactive_decision_event},
    interactive_invocation_ports::host_invocation_ports,
    relay_store::SQLiteRelayStore,
};
use serde_json::{json,Value};
use std::{path::Path,cell::RefCell};

fn fixture()->(SQLiteRelayStore,Value){
    let task=json!({"jobId":"job-interactive","id":"task-interactive",
        "parentTaskId":null,"dependencies":[],"capabilities":[],
        "adapter":"orchestrator","input":"work","state":"RUNNING",
        "attempt":1,"maxAttempts":3,"leaseOwner":"owner",
        "leaseExpiresAt":"2026-11-17T22:20:00.000Z","executionId":"exec-1",
        "threadId":null,"result":null,"error":null,"timeoutMs":60000,
        "createdAt":"2026-11-17T22:00:00.000Z",
        "updatedAt":"2026-11-17T22:00:00.000Z",
        "interactiveInvocation":{"invocationId":"exec-1","revision":"exec-1",
            "executionId":"exec-1","status":"awaiting_decision",
            "boundAt":"2026-11-17T22:00:00.000Z"}
    });
    let job=json!({"id":"job-interactive","title":"Interactive contract",
        "prNumber":0,"repository":"job","state":"ACTIVE",
        "continuation":null,"createdAt":"2026-11-17T22:00:00.000Z",
        "updatedAt":"2026-11-17T22:00:00.000Z","tasks":[task]});
    let store=SQLiteRelayStore::open(Path::new(":memory:"),None).unwrap();
    store.save_job(&job).unwrap();
    (store,job)
}
fn event()->Value{
    let context=json!({"jobId":"job-interactive","taskId":"task-interactive",
        "executionId":"exec-1"});
    let feedback=json!({"eventId":"decision-1","decision":"approved","feedback":"good",
        "comments":[]});
    host_interactive_decision_event(&context,&feedback,"2026-11-17T22:01:00.000Z").unwrap()
}
fn graph()->std::path::PathBuf{
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow")
}
#[test]
fn invalid_event_is_ignored_and_does_not_mutate_sqlite(){
    let (mut store,_job)=fixture();
    let mut ports=host_invocation_ports(&mut store);
    let before=ports.load_job("job-interactive").unwrap().unwrap();
    let mut coordinator=HostInteractiveInvocationCoordinator::default();
    let outcome=coordinator.apply_event(&mut ports,&graph(),&json!({"type":"other"}),
        |_,_|panic!("cannot accept invalid event"),
        |_|panic!("cannot emit invalid event")).unwrap();
    assert_eq!(outcome,json!({"outcome":"ignored","reason":"invalid_interactive_delivery"}));
    assert_eq!(ports.load_job("job-interactive").unwrap().unwrap(),before);
}
#[test]
fn accepted_decision_is_durable_duplicate_does_not_emit_twice(){
    let (mut store,_job)=fixture();
    let mut ports=host_invocation_ports(&mut store);
    let mut coordinator=HostInteractiveInvocationCoordinator::default();
    let accepted_count=RefCell::new(0usize);
    let emitted_count=RefCell::new(0usize);
    let first=coordinator.apply_event(&mut ports,&graph(),&event(),
        |_,_|{*accepted_count.borrow_mut()+=1;Ok(())},
        |_|{*emitted_count.borrow_mut()+=1;Ok(())}).unwrap();
    assert_eq!(first["outcome"],"accepted");
    assert_eq!(first["reason"],"latest_interactive_decision");
    assert_eq!(*accepted_count.borrow(),1);
    assert_eq!(*emitted_count.borrow(),1);
    let current=ports.load_job("job-interactive").unwrap().unwrap();
    assert_eq!(current["tasks"][0]["interactiveInvocation"]["status"],"approved");
    let twice=coordinator.apply_event(&mut ports,&graph(),&event(),
        |_,_|{*accepted_count.borrow_mut()+=1;Ok(())},
        |_|{*emitted_count.borrow_mut()+=1;Ok(())}).unwrap();
    assert_eq!(twice["outcome"],"duplicate");
    assert_eq!(*accepted_count.borrow(),1);
    assert_eq!(*emitted_count.borrow(),1);
}

#[test]
fn timed_out_prior_waiter_never_removes_rebound_same_execution_generation(){
 use std::time::Duration;
 let (_db,job)=fixture();
 let mut coordinator=HostInteractiveInvocationCoordinator::default();
 let now="2026-11-17T22:01:00.000Z";
 let (_,old)=coordinator.bind_with_waiter(
  "job-interactive","task-interactive","exec-1",now,&job).unwrap();
 // Node replaces the old resolve function when bind is called again for
 // the same Task generation. A late old Promise timeout must not erase it.
 let (_,replacement)=coordinator.bind_with_waiter(
  "job-interactive","task-interactive","exec-1",now,&job).unwrap();
 assert_eq!(old.wait_timeout(Duration::from_millis(2)).unwrap_err(),
  "Interactive decision timeout for task task-interactive, revision exec-1");
 let accepted=json!({
  "jobId":"job-interactive","taskId":"task-interactive",
  "executionId":"exec-1","invocationId":"exec-1","revision":"exec-1",
  "decision":"approved","feedback":"verified",
  "event":{"event_id":"trusted-decision","type":"task.interactive_decision"}
 });
 assert!(coordinator.accept(&accepted));
 assert_eq!(replacement.wait_timeout(Duration::from_millis(100)).unwrap(),
  accepted,"newer decision waiter must survive older timeout cleanup");
 assert!(!coordinator.accept(&accepted),
  "no second callback may receive an already delivered decision");
 coordinator.close();
}
