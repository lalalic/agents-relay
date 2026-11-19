// Native browser-worker-routing pool binding: the real BrowserWorkerPoolManager
// drives admission through outage/verified-recovery transitions and fails
// closed when the pool snapshot is unavailable. Original provenance:
// src/browser-worker-routing.ts pre-submission admission evidence.
use agents_relay_rust2::browser_worker_pool::{BrowserPoolOptions,BrowserWorkerPoolManager};
use agents_relay_rust2::browser_worker_routing::{
    has_safe_alternative_worker,has_safe_alternative_worker_with_pool,
};
use serde_json::json;
use std::path::PathBuf;

fn temp_pool(name:&str)->BrowserWorkerPoolManager{
    let mut path=std::env::temp_dir();
    path.push(format!("r2-native-bwr-{}-{}.sqlite",name,std::process::id()));
    let path=PathBuf::from(path);
    let _=std::fs::remove_file(&path);
    BrowserWorkerPoolManager::with_clock(
        BrowserPoolOptions{path:Some(path),..Default::default()},||1_000_000,
    ).expect("isolated pool manager")
}
fn adapters()->Vec<serde_json::Value>{
    vec![
        json!({"name":"codex","id":"codex-1","capabilities":["codex","write"]}),
        json!({"name":"chatgpt","id":"chatgpt-1","capabilities":["browser","write"]}),
    ]
}
#[test]
fn orchestrator_and_thread_delivery_are_never_rerouted(){
    let adapters=adapters();
    let agents=vec![];
    for task in [
        json!({"adapter":"orchestrator"}),
        json!({"adapter":"chatgpt","chatgptThreadDelivery":true}),
        json!({"adapter":"chatgpt","chatgptThreadDelivery":"pending"}),
        json!({"adapter":"script","workerRequirements":{"runtime":"script"}}),
    ] {
        assert!(!has_safe_alternative_worker(Some(&task),&adapters,&agents,None,0,&|_|true),
            "task must fail closed: {task}");
    }
    assert!(!has_safe_alternative_worker(None,&adapters,&agents,None,0,&|_|true));
}
#[test]
fn chatgpt_outage_blocks_browser_alternative_until_verified_recovery(){
    let pool=temp_pool("outage");
    let chatgpt_only=vec![json!({"name":"chatgpt","id":"chatgpt-1",
        "capabilities":["browser","write"]})];
    let agents=vec![json!({"id":"ag-chatgpt","capabilities":["browser"],
        "runtime":{"adapter":"chatgpt"}})];
    let task=json!({"adapter":"script","workerRequirements":{"capabilities":["browser"]}});
    let healthy=|p:&str|has_safe_alternative_worker_with_pool(
        Some(&task),&chatgpt_only,&agents,None,0,&pool);
    assert!(healthy("chatgpt"),"fresh pool starts HEALTHY");
    pool.report_pre_submission_outage("chatgpt",600_000).expect("outage");
    assert!(!healthy("chatgpt"),"pre-submission outage must fail closed");
    pool.report_healthy("chatgpt").expect("recovery");
    assert!(healthy("chatgpt"),"verified recovery re-admits the browser worker");
    let codex_only=vec![json!({"name":"codex","id":"codex-1","capabilities":["codex"]})];
    assert!(!has_safe_alternative_worker_with_pool(Some(&task),
        &codex_only,&agents,None,0,&pool),
        "capability-gap alternatives are rejected regardless of pool health");
}
#[test]
fn requirement_mismatches_and_offline_agents_fail_closed(){
    let pool=temp_pool("requirements");
    let adapters=adapters();
    let agents=vec![json!({"id":"ag-chatgpt","capabilities":["write"],
        "runtime":{"adapter":"chatgpt"}})];
    let task=json!({"adapter":"script","workerRequirements":{"capabilities":["browser"]}});
    assert!(!has_safe_alternative_worker_with_pool(Some(&task),
        &adapters,&agents,None,0,&pool),
        "chatgpt agent lacks the required browser capability");
    let offline=vec![json!({"id":"ag-offline","capabilities":["browser"],
        "runtime":{"adapter":"chatgpt"},"availability":"offline"})];
    assert!(!has_safe_alternative_worker_with_pool(Some(&task),
        &adapters,&offline,None,0,&pool),"offline agents are never safe alternatives");
    let same_adapter=json!({"adapter":"chatgpt"});
    let chatgpt_only=vec![json!({"name":"chatgpt","id":"chatgpt-1",
        "capabilities":["browser","write"]})];
    assert!(!has_safe_alternative_worker_with_pool(Some(&same_adapter),
        &chatgpt_only,&agents,None,0,&pool),
        "candidates on the failed adapter are not alternatives");
}
#[test]
fn missing_task_adapter_and_undefined_runtime_stay_rejected(){
    // Node: task.workerRequirements?.runtime === task.adapter with both
    // undefined must keep the original early rejection.
    let adapters=adapters();
    let agents=vec![json!({"id":"ag-chatgpt","capabilities":["browser"],
        "runtime":{"adapter":"chatgpt"}})];
    let task=json!({"workerRequirements":{"capabilities":["browser"]}});
    assert!(!has_safe_alternative_worker(Some(&task),&adapters,&agents,None,0,&|_|true));
    let explicit=json!({"adapter":"script","workerRequirements":{
        "capabilities":["browser"]}});
    assert!(has_safe_alternative_worker(Some(&explicit),&adapters,&agents,None,0,&|_|true));
}
