use agents_relay_rust2::{
    cli::{job_create_request, job_update_request, task_update_request},
    cli_option_contract::validate_cli_options,
    execution_routing::{route_execution_with_choice, execution_choice_label, ExecutionRouteDiscovery},
    job_routing_preferences,
    reconciler_review::route_task_for_execution,
    task_update::apply_managed_task_update_snapshot,
};
use serde_json::{json, Value};
use std::{collections::HashMap, path::Path};

fn args(flags: &[&str]) -> Vec<String> {
    flags.iter().map(|s| (*s).to_owned()).collect()
}

fn queued_task() -> Value {
    json!({"id":"22","jobId":"21","updatedAt":"before","state":"QUEUED",
        "adapter":"codex","attempt":0,"maxAttempts":3,
        "routing":{"provider":"openai","model":"old-model","reasoning":"medium",
            "decidedBy":"cli","decidedAt":"before"},
        "workerSelection":{"workerId":"codex-default"},
        "workerRequirements":{"capabilities":[]}})
}

#[test]
fn preferences_create_update_merge_clear_and_validate() {
    let create=args(&["--repo","demo","--objective","Build artifact",
        "--preflight=true","--prefer-adapter","codex",
        "--prefer-provider","openai","--prefer-model","gpt-6",
        "--prefer-reasoning","high"]);
    validate_cli_options(&create).unwrap();
    let request=job_create_request(&create,None).unwrap();
    let prefs=&request["options"]["routingPreferences"];
    assert_eq!(prefs,&json!({"adapter":"codex","provider":"openai",
        "model":"gpt-6","reasoning":"high"}));
    let equals=job_create_request(&args(&["--repo","demo","--objective","Build artifact",
        "--preflight=true","--prefer-model=gpt-6"]),None).unwrap();
    assert_eq!(equals["options"]["routingPreferences"]["model"],"gpt-6");
    let existing=json!({"id":"21","routingPreferences":prefs});
    let update=job_update_request(&args(&["--id","21","--prefer-model","gpt-6-sol"]),
        &existing,None).unwrap();
    assert_eq!(update["patch"]["routingPreferences"]["adapter"],"codex");
    assert_eq!(update["patch"]["routingPreferences"]["model"],"gpt-6-sol");
    let clear=job_update_request(&args(&["--id","21","--clear-routing-preferences"]),
        &existing,None).unwrap();
    assert!(clear["patch"]["routingPreferences"].is_null());
    assert!(job_create_request(&args(&["--repo","demo","--objective","X",
        "--preflight=true","--prefer-adapter","ChatGPT"]),None)
        .unwrap_err().contains("--prefer-adapter"));
    assert!(job_update_request(&args(&["--id","21","--prefer-model",""]),
        &existing,None).is_err());
    assert!(job_update_request(&args(&["--id","21", "--clear-routing-preferences",
        "--prefer-model","gpt-6"]),&existing,None).is_err());
    assert!(job_create_request(&args(&["--repo","demo","--objective","X",
        "--preflight=true","--clear-routing-preferences"]),None).is_err());
    assert!(job_routing_preferences::validate(&json!({"adapter":"codex",
        "model":"gpt-6"})).is_ok());
    assert!(job_routing_preferences::validate(&json!({"unrecognized":1})).is_err());
    assert!(job_routing_preferences::validate(&json!({"adapter":"chatgpt"})).is_err());
    assert!(job_routing_preferences::validate(&json!({"adapter":"z"})).is_err());
    assert!(job_routing_preferences::validate(&json!({"adapter":"chatgpt"})).is_err());
    assert!(job_routing_preferences::validate(&json!({"adapter":"z"})).is_err());
    assert!(job_routing_preferences::reject_task_flags(&args(&[
        "--prefer-model=gpt-6"])).is_err());
}

#[test]
fn task_update_replaces_routing_and_clears_stale_worker_selection() {
    let mut old=queued_task();
    old["adapter"]=json!("chatgpt");
    assert!(task_update_request(&args(&["--prefer-model","gpt-6"]),
        &json!({"id":"21"}),&old,None).unwrap_err().contains("Job-only"));

    let job=json!({"id":"21","tasks":[old.clone()]});
    let request=task_update_request(&args(&["--id","21","--task-id","22",
        "--adapter","codex","--provider","neo-local","--model","neo",
        "--profile","neo","--reasoning","high"]),&job,&old,None).unwrap();
    let proposed=&request["task"];
    assert_eq!(proposed["adapter"],"codex");
    assert_eq!(proposed["routing"]["provider"],"neo-local");
    assert_eq!(proposed["routing"]["model"],"neo");
    assert_eq!(proposed["routing"]["profile"],"neo");
    assert_eq!(proposed["routing"]["reasoning"],"high");
    assert_eq!(proposed["routing"]["decidedBy"],"cli");
    assert_eq!(proposed["workerRequirements"]["runtime"],"codex");
    let updated=apply_managed_task_update_snapshot(&job,"21","22",proposed,"before",
        |_task,_action|true).unwrap();
    assert_eq!(updated["tasks"][0]["routing"]["model"],"neo");
    assert!(updated["tasks"][0].get("workerSelection").is_none());

    let change_only=task_update_request(&args(&["--adapter","codex"]),&job,&old,None)
        .unwrap();
    assert!(change_only["task"].get("routing").is_none());
    assert_eq!(change_only["task"]["workerRequirements"]["runtime"],"codex");
    let new_model=task_update_request(&args(&["--model","new-model"]),
        &job,&old,None).unwrap();
    assert_eq!(new_model["task"]["routing"]["model"],"new-model");
    assert!(new_model["task"]["routing"].get("reasoning").is_none());
    let cleared=task_update_request(&args(&["--clear-routing"]),&job,&old,None).unwrap();
    assert!(cleared["task"].get("routing").is_none());
    assert!(cleared["task"].get("workerSelection").is_none());
    assert!(task_update_request(&args(&["--clear-routing","--model","x"]),
        &job,&old,None).is_err());
    let missing=json!({"id":"22","jobId":"21","state":"QUEUED",
        "adapter":"codex"});
    assert!(task_update_request(&args(&["--provider","zai"]),
        &job,&missing,None).is_err());
    let mut terminal=old.clone();
    terminal["state"]=json!("SUCCEEDED");
    assert!(task_update_request(&args(&["--model","new"]),
        &job,&terminal,None).is_err());
}

fn route(adapter:&str, provider:&str, model:&str) -> Value {
    json!({"worker":{"workerId":adapter,"adapter":adapter,
        "capabilities":["model"]},
        "model":{"id":format!("default:{adapter}"),"provider":provider,
        "model":model,"reasoning":"high"}})
}

#[test]
fn soft_preference_ranks_only_eligible_routes_and_missing_choice_falls_back() {
    let codex=route("codex","openai","codex-default");
    let mut neo=route("codex","neo-local","neo");
    neo["model"]["profile"]=json!("neo");
    let discovery=ExecutionRouteDiscovery{
        routes:vec![codex.clone(),neo.clone()],evaluations:vec![],
        worker_gate_evaluations:vec![],policy:json!({}),choices:vec![],
        routing_instruction:String::new(),configured_defaults:HashMap::new()};
    let options=json!({"taskFacts":{"routingPreferences":{
        "profile":"neo"}},
        "decisionMode":"off"});
    let chosen=route_execution_with_choice(&discovery,&json!({}),&[],&options,
        None,None,&[],None).unwrap();
    assert_eq!(chosen["routing"]["profile"],"neo");
    assert_eq!(chosen["routing"]["decidedBy"],"execution-router:job-preference");
    // An explicit decision still wins over the advisory Job preference.
    let explicit=execution_choice_label(&codex,false);
    let commanded=route_execution_with_choice(&discovery,&json!({}),&[],&options,
        Some(&explicit),None,&[],None).unwrap();
    assert_eq!(commanded["candidate"]["adapter"],"codex");
    let unavailable=ExecutionRouteDiscovery{routes:vec![codex],..discovery.clone()};
    let fallback=route_execution_with_choice(&unavailable,&json!({}),&[],&options,
        None,None,&[],None).unwrap();
    assert_eq!(fallback["candidate"]["adapter"],"codex");
    // A partial provider-only hint cannot arbitrarily change the fallback
    // when both routes are equally preferred.
    let tie_opts=json!({"taskFacts":{"routingPreferences":{"provider":"openai"}}});
    let tied=route_execution_with_choice(&discovery,&json!({}),&[],&tie_opts,
        None,None,&[],None).unwrap();
    assert_eq!(tied["candidate"]["adapter"],"codex");
    // A hint never introduces a route outside the eligible list.
    assert_ne!(fallback["routing"]["model"],"neo");
}

#[test]
fn job_preference_routes_unpinned_worker_and_respects_exact_runtime() {
    let mut task=json!({"id":"22","jobId":"21","state":"QUEUED",
        "agentName":"implementation","adapter":"codex","input":"Produce file",
        "output":{"kind":"file","path":"artifact.txt"},
        "workerRequirements":{"capabilities":[]}});
    let mut job=json!({"id":"21","repository":"test-project",
        "routingPreferences":{"profile":"neo"},"tasks":[task.clone()]});
    let adapters=json!([
        {"id":"codex","name":"codex","capabilities":["model","codex"]}
    ]);
    let root=std::env::temp_dir().join(format!("relay-profile-routing-{}-{}",std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("config.toml"),"model = \"gpt-6-luna\"\n").unwrap();
    std::fs::write(root.join("neo.config.toml"),"model_provider = \"neo-local\"\nmodel = \"neo\"\n").unwrap();
    let missing=root.join("missing");
    let routes=|job:&Value,task:&Value|route_task_for_execution(
        Path::new("workflow"),&root,&missing,&missing,
        job,task,adapters.as_array().unwrap(),&[],None,&json!({"decisionMode":"off","recordDecisionAudit":true}));
    let preferred=routes(&job,&task).unwrap();
    assert_eq!(preferred.job["tasks"][0]["adapter"],"codex");
    assert_eq!(preferred.job["tasks"][0]["routing"]["profile"],"neo");
    assert_eq!(preferred.job["tasks"][0]["routing"]["decidedBy"],"execution-router:job-preference");
    assert_eq!(preferred.events.len(),2);
    let audit=preferred.decision_audit.as_ref().unwrap();
    assert_eq!(audit["record_type"],"decision");
    assert_eq!(audit["correlation"]["job_id"],"21");
    assert_eq!(audit["correlation"]["task_id"],"22");
    assert_eq!(audit["selected"]["worker"]["adapter"],"codex");
    assert_eq!(audit["decision_id"],preferred.job["tasks"][0]["routing"]["decisionId"]);
    task["workerRequirements"]["runtime"]=json!("codex");
    job["tasks"]=json!([task.clone()]);
    assert_eq!(routes(&job,&task).unwrap().job["tasks"][0]["routing"]["profile"],"neo");
    task["agentName"]=json!("job-acceptance-reviewer");
    job["tasks"]=json!([task.clone()]);
    assert_eq!(routes(&job,&task).unwrap().job["tasks"][0]["adapter"],"codex");
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn production_decision_contract_accepts_only_eligible_choices_and_records_fallback(){
    use agents_relay_rust2::execution_routing::route_execution_decide_with;
    let codex=route("codex","openai","codex-default");
    let zai=route("codex","zai","glm-5.3-flash");
    let discovery=ExecutionRouteDiscovery{
        routes:vec![codex.clone(),zai.clone()],evaluations:vec![],
        worker_gate_evaluations:vec![],policy:json!({}),choices:vec![],
        routing_instruction:"Prefer zai".into(),configured_defaults:HashMap::new()};
    let opts=json!({"decisionMode":"active","recordDecisionAudit":true,
        "taskFacts":{"task":{"id":"22","jobId":"21"}}});
    let chosen=route_execution_decide_with(&discovery,&json!({}),&[],&opts,&[],|req,contract|{
        assert!(req["facts"].is_object());
        assert_eq!(contract["choices"].as_array().unwrap().len(),2);
        assert!(contract["question"].as_str().unwrap().contains("Prefer zai"));
        Ok(json!({"type":"choice","choice":execution_choice_label(&zai,false)}))
    }).unwrap();
    assert_eq!(chosen["routing"]["provider"],"zai");
    assert_eq!(chosen["routing"]["decidedBy"],"execution-router:jev");
    assert_eq!(chosen["audit"]["decision_id"],chosen["routing"]["decisionId"]);
    assert_eq!(chosen["audit"]["decision_input"]["stages"][0]["contract"]["choices"].as_array().unwrap().len(),2);
    let failed=route_execution_decide_with(&discovery,&json!({}),&[],&opts,&[],|_,_|{
        Ok(json!({"type":"choice","choice":"invented"}))
    }).unwrap();
    assert_eq!(failed["routing"]["decisionEvidence"]["fallback"],true);
    assert!(failed["routing"]["decisionEvidence"]["error"].is_string());
    let single=ExecutionRouteDiscovery{routes:vec![codex],..discovery.clone()};
    let bypass=route_execution_decide_with(&single,&json!({}),&[],&opts,&[],|_,_|panic!("single route must not call engine")).unwrap();
    assert_eq!(bypass["routing"]["decidedBy"],"execution-router:single-choice");
    let off=json!({"decisionMode":"off","recordDecisionAudit":true});
    let disabled=route_execution_decide_with(&discovery,&json!({}),&[],&off,&[],|_,_|panic!("off must not call engine")).unwrap();
    assert_eq!(disabled["routing"]["decisionEvidence"]["fallback"],true);
}
