//! Public native Router eligibility and policy guards used by Reconciler review.
use agents_relay_rust2::execution_routing::{execution_task_shape,task_capability_facts,
    execution_choice_label,discover_execution_routes};
use serde_json::json;
use std::{fs,path::PathBuf};
#[test]
fn null_outer_story_size_falls_back_to_nested_task_without_fabricating_model(){
    let facts=json!({"storySize":null,"task":{"storySize":"L","title":"final review"}});
    assert_eq!(execution_task_shape(&facts)["storySize"],"L");
    assert_eq!(execution_task_shape(&facts)["preferredWorker"],"codex");
    assert_eq!(task_capability_facts(&facts),vec!["final_review"]);
}
#[test]
fn offline_worker_and_missing_model_remain_hard_exclusions(){
    let root=PathBuf::from("/tmp").join(format!("r2-execution-routing-{}",std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let result=discover_execution_routes(&[json!({"workerId":"offline","adapter":"codex",
        "runtime":"codex","availability":"offline","capabilities":["coding"]})],
        &json!({}),&json!({"registered":[]}),&root,&root.join("policy.json"),
        &root.join("rules.md"),1795000000000).unwrap();
    assert!(result.routes.is_empty());
    assert_eq!(result.worker_gate_evaluations[0]["eligible"],false);
    assert!(result.worker_gate_evaluations[0]["rejectionReasons"]
        .as_array().unwrap().iter().any(|v|v=="worker_offline"));
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn exact_route_label_preserves_worker_provider_model_reasoning_and_default(){
    let route=json!({"worker":{"workerId":"codex"},
        "model":{"provider":"openai","model":"gpt-6","reasoning":"high"}});
    assert_eq!(execution_choice_label(&route,true),
        "worker=codex provider=openai model=gpt-6 reasoning=high default=true");
}

#[test]
fn planner_prefers_strong_reasoning_via_canonical_router_without_pinning_model(){
    use agents_relay_rust2::execution_routing::route_execution;
    let root=std::env::temp_dir().join(format!("r2-planner-route-{}",
        std::process::id()));
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("config.toml"),
        "model = \"baseline\"\nmodel_reasoning_effort = \"low\"\n").unwrap();
    fs::write(root.join("quality.config.toml"),
        "model = \"stronger\"\nmodel_reasoning_effort = \"high\"\n").unwrap();
    let workers=[json!({"workerId":"codex","adapter":"codex",
        "runtime":"codex","capabilities":["model","codex"]})];
    let result=route_execution(&workers,&json!({"capabilities":["model"]}),
        &json!({"taskFacts":{"task":{"kind":"planner"},
            "routingPreferences":{"reasoning":"high"}},"decisionMode":"off"}),
        &root,&root.join("policy.json"),&root.join("rules.md"),
        1795000000000,None,None,&[],None).unwrap();
    assert_eq!(result["model"]["model"],"stronger");
    assert_eq!(result["model"]["profile"],"quality");
    assert_eq!(result["model"]["reasoning"],"high");
    assert_eq!(result["selection"]["adapter"],"codex");
    fs::remove_dir_all(root).unwrap();
}
