use agents_relay_rust2::reconciler_context::WorkerContextRoots;
use agents_relay_rust2::{
    native_codex_thread::{build_codex_turn_args,persist_task_thread,parse_thread_started,quota_failure_without_effects,resumable_provider_failure},
    model_routing::{codex_profile_candidates,deterministic_model,eligible_models},
    native_codex_execution::execute_claimed_codex,
    relay_store::SQLiteRelayStore,
    worker_failure_recovery::{classify_worker_launch_failure,apply_launch_failure_mutation},
    workflow::{lifecycle::decide_task_lifecycle,runtime::{apply_task_graph_target,apply_task_mutation}},
    task_actions::apply_task_retry_action,
    troubleshooter::{pending_troubleshooter_retries,pending_troubleshooter_reopens},
    troubleshooter_fallback::{fallback_failed_troubleshooters,exhausted_troubleshooter_escalations},
};
use serde_json::{json,Value};
use std::{fs,path::{Path,PathBuf},time::{SystemTime,UNIX_EPOCH}};
const THREAD:&str="38f84f9e-410d-4e36-96e0-a420594a102d";
fn fixture()->PathBuf{
    let dir=std::env::temp_dir().join(format!("codex-thread-router-{}-{}",
        std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
    fs::create_dir_all(&dir).unwrap();dir
}
fn base_job(root:&Path)->Value{
    json!({"id":"901","repository":"unit","projectRoot":root,
    "title":"Codex Thread test","state":"ACTIVE","prNumber":0,
    "createdAt":"2026-11-23T00:00:00Z","updatedAt":"2026-11-23T00:00:00Z",
    "plans":[],"tasks":[{"id":"902","jobId":"901","kind":"work",
    "adapter":"codex","agentName":"fixture","state":"QUEUED",
    "attempt":1,"maxAttempts":4,"executionId":"execution-1",
    "leaseOwner":"owner","leaseExpiresAt":"2099-01-01T00:00:00Z",
    "executionHistory":[{"id":"execution-1","attempt":1}],
    "routing":{"provider":"zai","model":"glm-5.3-flash","profile":"zai"},
    "input":"test this source only","output":{"kind":"file","path":root.join("out.json")},
    "createdAt":"2026-11-23T00:00:00Z","updatedAt":"2026-11-23T00:00:00Z"}]})
}
#[test]
fn one_model_per_profile_and_catalog_not_fallback(){
    let home=fixture();
    fs::write(home.join("config.toml"),"model = \"gpt-6-luna\"\n").unwrap();
    fs::write(home.join("zai.config.toml"),"model_provider = \"zai\"\nmodel = \"glm-5.3-flash\"\n").unwrap();
    fs::write(home.join("neo.config.toml"),"model_provider = \"neo-local\"\nmodel = \"neo\"\n").unwrap();
    fs::write(home.join("models_cache.json"),r#"{"models":[{"slug":"random-catalog","visibility":"list","supported_in_api":true}]}"#).unwrap();
    let profiles=codex_profile_candidates(&home,None,0);
    assert_eq!(profiles.len(),3,"{profiles:?}");
    assert_eq!(profiles.iter().filter(|p|p.get("profile").is_none()).count(),1);
    assert!(profiles.iter().all(|p|!p["id"].as_str().unwrap().starts_with("catalog:")));
    assert_eq!(profiles.iter().find(|p|p["profile"]=="zai").unwrap()["model"],"glm-5.3-flash");
    let z=profiles.iter().find(|p|p["profile"]=="zai").unwrap();
    let eligible=eligible_models(&profiles,None,&json!({}),&[json!({"provider":z["provider"],"model":z["model"],"profile":"zai"})]);
    assert_eq!(eligible.len(),2);
    let chosen=deterministic_model(&eligible,None,&json!({"preferredProfiles":["neo"]}));
    assert_eq!(chosen["profile"],"neo");
    fs::remove_dir_all(home).unwrap();
}
#[test]
fn resume_switches_provider_profile_model_without_losing_thread(){
    let new=build_codex_turn_args(&json!({"provider":"zai","model":"glm-5.3-flash","profile":"zai"}),
        "/tmp","first turn",None).unwrap();
    assert!(new.contains(&"zai".to_owned()));
    assert!(!new.contains(&"resume".to_owned()));
    let resume=build_codex_turn_args(&json!({"provider":"openai","model":"gpt-6-luna","reasoning":"high"}),
        "/tmp","continue in context",Some(THREAD)).unwrap();
    assert!(resume.contains(&"resume".to_owned()));
    assert!(resume.contains(&THREAD.to_owned()));
    assert!(resume.contains(&"gpt-6-luna".to_owned()));
    assert!(resume.contains(&"model_provider=\"openai\"".to_owned()));
    assert!(!resume.contains(&"zai".to_owned()));
    assert!(!resume.contains(&"-C".to_owned()));
    assert_eq!(resume.iter().filter(|v|v.as_str()=="--dangerously-bypass-approvals-and-sandbox").count(),1);
    assert_eq!(parse_thread_started(&format!(r#"{{"type":"thread.started","thread_id":"{THREAD}"}}"#)).as_deref(),Some(THREAD));
    assert!(build_codex_turn_args(&json!({"provider":"openai","model":"gpt-6-luna"}),
        "/tmp","unsafe",Some("--last")).is_err());
}
#[test]
fn thread_id_is_durable_and_fenced_to_current_execution(){
    let root=fixture();let db=root.join("relay.sqlite");
    let store=SQLiteRelayStore::open(&db,Some("901")).unwrap();
    store.save_job(&base_job(&root)).unwrap();drop(store);
    persist_task_thread(&db,"901","902","execution-1",THREAD).unwrap();
    persist_task_thread(&db,"901","902","execution-1",THREAD).unwrap();
    assert!(persist_task_thread(&db,"901","902","old",THREAD).is_err());
    assert!(persist_task_thread(&db,"901","902","execution-1","38f84f9e-410d-4e36-96e0-a420594a102e").is_err());
    let store=SQLiteRelayStore::open_without_claim_reset(&db,Some("901")).unwrap();
    assert_eq!(store.load_job("901").unwrap().unwrap()["tasks"][0]["threadId"],THREAD);
    drop(store);fs::remove_dir_all(root).unwrap();
}
#[test]
fn a_real_owned_fake_codex_process_persists_thread_for_next_generation(){
    use std::os::unix::fs::PermissionsExt;
    let root=fixture();fs::create_dir_all(root.join("agents")).unwrap();
    fs::write(root.join("agents/fixture.agent.md"),"---\nname: fixture\ncapabilities: [model, local_repo]\n---\n# Test Agent\n").unwrap();
    let db=root.join("relay.sqlite");
    let store=SQLiteRelayStore::open(&db,Some("901")).unwrap();
    let job=base_job(&root);store.save_job(&job).unwrap();drop(store);
    let file=root.join("fake-codex");let args=root.join("invocation-argv.txt");
    fs::write(&file,format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\nprintf '%s\\n' '{{\"type\":\"thread.started\",\"thread_id\":\"{THREAD}\"}}'\nexit 1\n",args.display())).unwrap();
    fs::set_permissions(&file,fs::Permissions::from_mode(0o700)).unwrap();
    let failed=execute_claimed_codex(&db,&job,&job["tasks"][0],&file,&root,&WorkerContextRoots::isolated(&root)).unwrap_err();
    assert!(!failed.contains("without verified Task terminal event"));
    let store=SQLiteRelayStore::open_without_claim_reset(&db,Some("901")).unwrap();
    let saved=store.load_job("901").unwrap().unwrap();
    assert_eq!(saved["tasks"][0]["threadId"],THREAD);
    let mut resume=saved.clone();
    resume["tasks"][0]["executionId"]=json!("execution-2");
    resume["tasks"][0]["routing"]=json!({"provider":"openai","model":"gpt-6-luna"});
    store.save_job(&resume).unwrap();drop(store);
    let _=execute_claimed_codex(&db,&resume,&resume["tasks"][0],&file,&root,&WorkerContextRoots::isolated(&root)).unwrap_err();
    let command=fs::read_to_string(args).unwrap();
    assert!(command.lines().any(|l|l=="resume"),"{command}");
    assert!(command.lines().any(|l|l==THREAD),"{command}");
    assert!(command.lines().any(|l|l=="gpt-6-luna"),"{command}");
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn quota_switch_is_graph_owned_and_refuses_tool_side_effects(){
    let root=Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow");
    let quota=format!("{{\"type\":\"turn.failed\",\"error\":{{\"message\":\"429 quota exceeded\"}}}}\n");
    assert!(quota_failure_without_effects(&quota,"").is_some());
    let with_tool=format!("{{\"type\":\"item.started\",\"item\":{{\"type\":\"command_execution\"}}}}\n{quota}");
    assert!(quota_failure_without_effects(&with_tool,"").is_none());
    let original=json!({"id":"9","state":"RUNNING","kind":"work","adapter":"codex",
        "agentName":"implementation","attempt":1,"maxAttempts":3,
        "executionId":"generation-1","threadId":THREAD,
        "routing":{"provider":"zai","model":"glm-5.3-flash","profile":"zai"}});
    let failure=classify_worker_launch_failure(Some(&original),
        &json!("codex_quota_no_side_effects: 429 quota exceeded"),
        "process",Some("generation-1"),Some("generation-1"),true,true,false);
    assert!(!failure.unknown_outcome);
    assert_eq!(failure.event,"worker.platform_failure");
    assert_eq!(failure.facts["platformFallbackSafe"],true);
    let graph=decide_task_lifecycle(&root,&original,&failure.event,&failure.facts).unwrap();
    assert_eq!(graph["accepted"],true,"{graph}");
    assert_eq!(graph["target"],"QUEUED","{graph}");
    let mut next=original.clone();
    apply_task_graph_target(&mut next,"QUEUED","2026-11-23T10:00:00Z",false).unwrap();
    for action in graph["actions"].as_array().unwrap(){
        let name=action.as_str().or_else(||action.get("id").and_then(Value::as_str)).expect("action ID");
        if name.starts_with("mutation."){
            apply_task_mutation(&mut next,name,"2026-11-23T10:00:00Z").unwrap();
        }
    }
    apply_launch_failure_mutation(&mut next,Some(&original),&failure,&graph);
    assert_eq!(next["threadId"],THREAD);
    assert!(next["executionId"].is_null());
    assert!(next["routing"].is_null(),"{next}");
    assert_eq!(next["routingExclusions"][0]["profile"],"zai");
    let no_more=classify_worker_launch_failure(Some(&original),
        &json!("codex_quota_no_side_effects: quota"),"process",Some("generation-1"),
        Some("generation-1"),true,false,false);
    assert_eq!(no_more.facts["platformFallbackSafe"],false);
    let failed=decide_task_lifecycle(&root,&original,&no_more.event,&no_more.facts).unwrap();
    assert_eq!(failed["target"],"FAILED");
}
#[test]
fn troubleshooter_never_retries_and_escalates_after_one_failure(){
    let job=json!({"id":"8","repository":"fixture","state":"ACTIVE","tasks":[
        {"id":"1","agentName":"implementation","state":"FAILED"},
        {"id":"2","agentName":"troubleshooter","parentTaskId":"1","state":"FAILED",
            "attempt":1,"maxAttempts":3,"error":"cannot resolve"}
    ],"plans":[]});
    assert!(pending_troubleshooter_retries(&job).is_empty());
    assert!(pending_troubleshooter_reopens(&job).is_empty());
    let mut mutable=job.clone();
    assert!(fallback_failed_troubleshooters(Path::new("/tmp"),&mut mutable).unwrap().is_empty());
    assert_eq!(mutable,job);
    assert_eq!(exhausted_troubleshooter_escalations(&job).len(),1);
    let mut task=job["tasks"][1].clone();
    assert!(apply_task_retry_action(Path::new("/tmp"),&mut task,true,"now")
        .unwrap_err().contains("one-shot"));
}

#[test]
fn quota_after_completed_tools_resumes_only_a_verified_terminal_thread(){
    let head=format!("{{\"type\":\"thread.started\",\"thread_id\":\"{THREAD}\"}}\n{{\"type\":\"turn.started\"}}\n");
    let started=r#"{"type":"item.started","item":{"id":"item_1","type":"command_execution","status":"in_progress"}}"#;
    let completed=r#"{"type":"item.completed","item":{"id":"item_1","type":"command_execution","status":"completed","exit_code":0}}"#;
    let quota=r#"{"type":"turn.failed","error":{"message":"rate limit exceeded: Weekly/Monthly Limit Exhausted."}}"#;
    let transcript=format!("{head}{started}\n{completed}\n{quota}\n");
    assert_eq!(resumable_provider_failure(&transcript,THREAD).unwrap().0,"quota_exhausted");
    assert!(quota_failure_without_effects(&transcript,"").is_none());
    assert!(resumable_provider_failure(&format!("{head}{started}\n{quota}"),THREAD).is_none());
    assert!(resumable_provider_failure(&format!("{head}{completed}\n{{bad json}}\n{quota}"),THREAD).is_none());
    assert!(resumable_provider_failure(&format!("{head}{completed}\n{{\"type\":\"error\",\"message\":\"rate limit exceeded\"}}"),THREAD).is_none());
    assert!(resumable_provider_failure(&transcript,"38f84f9e-410d-4e36-96e0-a420594a102e").is_none());
    let incompatible=json!({"type":"turn.failed","error":{"message":r#"{"type":"error","error":{"message":"Invalid 'input[3].content': array too long.","type":"invalid_request_error","param":"input[3].content","code":"array_above_max_length"},"status":400}"#}});
    assert_eq!(resumable_provider_failure(&format!("{head}{incompatible}"),THREAD).unwrap().0,"resume_context_incompatible");
    assert!(resumable_provider_failure(&format!("{head}{completed}\n{incompatible}"),THREAD).is_none());
}

#[test]
fn actual_owned_worker_quota_fallback_preserves_artifact_thread_and_budget(){
    use std::os::unix::fs::PermissionsExt;
    let root=fixture();fs::create_dir_all(root.join("agents")).unwrap();
    fs::write(root.join("agents/fixture.agent.md"),"---\nname: fixture\ncapabilities: [model, local_repo]\n---\n# Test Agent\n").unwrap();
    let db=root.join("relay.sqlite");let job=base_job(&root);
    let store=SQLiteRelayStore::open(&db,Some("901")).unwrap();
    store.save_job(&job).unwrap();drop(store);
    let file=root.join("fake-codex");
    let artifact=root.join("partial.txt");
    fs::write(&file,format!(r#"#!/bin/sh
printf '%s\n' '{{"type":"thread.started","thread_id":"{THREAD}"}}' '{{"type":"turn.started"}}' '{{"type":"item.started","item":{{"id":"item_1","type":"command_execution","status":"in_progress"}}}}'
printf partial > '{}'
awk 'BEGIN {{printf "{{\"type\":\"item.updated\",\"item\":{{\"id\":\"item_1\",\"type\":\"command_execution\",\"aggregated_output\":\""; for(i=0;i<3100000;i++)printf "x"; print "\"}}}}"}}'
awk 'BEGIN {{for(i=0;i<3000;i++){{printf "{{\"type\":\"item.updated\",\"item\":{{\"id\":\"item_1\",\"type\":\"command_execution\",\"aggregated_output\":\""; for(j=0;j<1024;j++)printf "y"; print "\"}}}}"}}}}'
awk 'BEGIN {{for(i=0;i<150000;i++)printf "e"}}' >&2
printf '%s\n' '{{"type":"item.completed","item":{{"id":"item_1","type":"command_execution","status":"completed","exit_code":0}}}}' '{{"type":"turn.failed","error":{{"message":"rate limit exceeded: Weekly/Monthly Limit Exhausted."}}}}'
exit 1
"#,artifact.display())).unwrap();
    fs::set_permissions(&file,fs::Permissions::from_mode(0o700)).unwrap();
    let error=execute_claimed_codex(&db,&job,&job["tasks"][0],&file,&root,&WorkerContextRoots::isolated(&root)).unwrap_err();
    assert!(error.starts_with("codex_provider_continuation_quota_exhausted:"),"{error}");
    assert_eq!(fs::read_to_string(&artifact).unwrap(),"partial");
    let store=SQLiteRelayStore::open_without_claim_reset(&db,Some("901")).unwrap();
    let job=store.load_job("901").unwrap().unwrap();drop(store);
    let original=&job["tasks"][0];
    assert_eq!(original["threadId"],THREAD);
    let failure=classify_worker_launch_failure(Some(original),&json!(error),"process",Some("execution-1"),Some("execution-1"),true,true,false);
    assert_eq!(failure.event,"worker.platform_failure");
    assert!(!failure.unknown_outcome);
    assert_eq!(failure.facts["platformFallbackSafe"],true);
    let graph_dir=Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow");
    let decision=decide_task_lifecycle(&graph_dir,original,&failure.event,&failure.facts).unwrap();
    assert_eq!(decision["target"],"QUEUED");
    let mut next=original.clone();
    apply_task_graph_target(&mut next,"QUEUED","2026-11-24T21:00:00Z",false).unwrap();
    for action in decision["actions"].as_array().unwrap(){
        if let Some(name)=action.as_str().filter(|s|s.starts_with("mutation.")){
            apply_task_mutation(&mut next,name,"2026-11-24T21:00:00Z").unwrap();
        }
    }
    apply_launch_failure_mutation(&mut next,Some(original),&failure,&decision);
    assert_eq!(next["threadId"],THREAD);
    assert_eq!(next["routingExclusions"][0]["profile"],"zai");
    assert_eq!(next["platformFailure"]["classification"],"quota_exhausted");
    assert!(next["routing"].is_null());
    let mut exhausted=original.clone();exhausted["attempt"]=exhausted["maxAttempts"].clone();
    let blocked=classify_worker_launch_failure(Some(&exhausted),&json!(failure.message),"process",Some("execution-1"),Some("execution-1"),true,true,false);
    assert_eq!(blocked.facts["platformFallbackSafe"],false);
    let no_thread=classify_worker_launch_failure(Some(&json!({"adapter":"codex","agentName":"fixture"})),&json!(failure.message),"process",Some("execution-1"),Some("execution-1"),true,true,false);
    assert_eq!(no_thread.facts["platformFallbackSafe"],false);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn incremental_facts_keep_failure_guards_after_long_output(){
    use agents_relay_rust2::native_codex_thread::CodexTurnFacts;
    let head=json!({"type":"thread.started","thread_id":THREAD}).to_string();
    let started=r#"{"type":"item.started","item":{"id":"item_1","type":"command_execution","status":"in_progress"}}"#;
    let completed=r#"{"type":"item.completed","item":{"id":"item_1","type":"command_execution","status":"completed"}}"#;
    let quota=r#"{"type":"turn.failed","error":{"message":"429 quota exceeded"}}"#;
    let long=json!({"type":"item.completed","item":{"type":"agent_message","text":"x".repeat(3*1024*1024)}}).to_string();
    for (suffix,eligible) in [(vec![completed,quota],true),(vec![quota],false),
        (vec![completed,"{bad json}",quota],false),(vec![completed,quota,r#"{"type":"turn.completed"}"#],false)]{
        let mut facts=CodexTurnFacts::new();
        assert_eq!(facts.observe(&head).as_deref(),Some(THREAD));
        facts.observe(started);
        facts.observe(&long);
        for line in suffix{facts.observe(line);}
        assert_eq!(facts.resumable_provider_failure(THREAD).is_some(),eligible);
        assert!(facts.quota_failure_without_effects().is_none());
    }
    let mut facts=CodexTurnFacts::new();
    facts.observe(&head);
    facts.observe(&long);
    facts.observe(quota);
    assert!(facts.quota_failure_without_effects().is_some());
    assert!(facts.resumable_provider_failure(THREAD).is_some());
    assert!(facts.resumable_provider_failure("38f84f9e-410d-4e36-96e0-a420594a102e").is_none());
}
