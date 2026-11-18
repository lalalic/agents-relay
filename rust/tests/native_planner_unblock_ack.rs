// Planner unblock registration retains external failure evidence in SQLite.
// The test never contacts a provider or a second durable Job store.
use agents_relay_rust2::{
    planner_runtime::{drain_planner_unblocks,retry_pending_planner_unblocks},
    relay_store::SQLiteRelayStore,
};
use serde_json::{json,Value};
use std::path::Path;
fn intent(id:&str)->Value{
    json!({"repository":"fixture/repo","prNumber":7,
        "jobId":"dependent","taskId":id,"resolutionMode":"merge"})
}
fn store(plans:Value)->SQLiteRelayStore{
    let store=SQLiteRelayStore::open(Path::new(":memory:"),None).unwrap();
    store.save_job(&json!({"id":"job-1","title":"fixture",
        "repository":"fixture/repo","state":"ACTIVE","prNumber":0,
        "createdAt":"2026-11-17T09:00:00.000Z",
        "updatedAt":"2026-11-17T09:00:00.000Z",
        "tasks":[],"plans":plans})).unwrap();
    store
}
#[test]
fn failed_registrations_survive_atomic_ack_and_concurrent_new_intents(){
    let store=store(json!([{"id":"p","status":"SUCCEEDED",
        "pendingUnblocks":[intent("a"),intent("b")]}]));
    let mut added=false;
    let mut register=|id:&str,item:&Value|{
        if !added{
            added=true;
            store.mutate_job(id,|mut current|{
                current["plans"][0]["pendingUnblocks"].as_array_mut()
                    .unwrap().push(intent("late"));
                Ok(current)
            })?;
        }
        if item["taskId"]=="b"{Err("dependent temporarily unavailable".into())}
        else{Ok(())}
    };
    let remaining=drain_planner_unblocks(&store,"job-1","p",
        Some(&mut register),true).unwrap();
    assert_eq!(remaining,vec![
        "fixture/repo#7:dependent:b", "fixture/repo#7:dependent:late"]);
    let current=store.load_job("job-1").unwrap().unwrap();
    assert_eq!(current["plans"][0]["pendingUnblocks"],
        json!([intent("b"),intent("late")]));
}
#[test]
fn no_registration_capability_fails_closed_without_mutation(){
    let store=store(json!([{"id":"p","status":"SUCCEEDED",
        "pendingUnblocks":[intent("a")]}]));
    let before=store.load_job("job-1").unwrap().unwrap();
    assert_eq!(drain_planner_unblocks(&store,"job-1","p",None,true).unwrap_err(),
        "Blocker registration unavailable");
    assert_eq!(store.load_job("job-1").unwrap().unwrap(),before);
}
#[test]
fn retry_touches_only_succeeded_plans_and_keeps_failed_plan_intents(){
    let store=store(json!([
        {"id":"one","status":"SUCCEEDED","pendingUnblocks":[intent("a")]},
        {"id":"two","status":"FAILED","pendingUnblocks":[intent("b")]},
        {"id":"three","status":"SUCCEEDED","pendingUnblocks":[intent("c")]},
    ]));
    let mut seen=Vec::<String>::new();
    let mut register=|_:&str,item:&Value|{
        seen.push(item["taskId"].as_str().unwrap().into());Ok(())
    };
    retry_pending_planner_unblocks(&store,"job-1",Some(&mut register),true).unwrap();
    assert_eq!(seen,vec!["a","c"]);
    let current=store.load_job("job-1").unwrap().unwrap();
    assert!(current["plans"][0].get("pendingUnblocks").is_none());
    assert_eq!(current["plans"][1]["pendingUnblocks"],json!([intent("b")]));
    assert!(current["plans"][2].get("pendingUnblocks").is_none());
}
