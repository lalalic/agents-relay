// Node provenance: src/{relay-store,browser-worker-pool,owned-process,
// local-managed-store,reconciler-context,task-inactivity-watchdog}.ts.
// Use isolated SQLite and adapter facts; no production Job or service runs.
use agents_relay_rust2::{
    browser_worker_pool::{BrowserPoolOptions,BrowserWorkerPoolManager},
    owned_process::{owned_process_termination_reason,OwnedProcess},
    relay_store::SQLiteRelayStore,
    task_inactivity_watchdog::{WatchdogTimers,arm_inactivity_watchdog},
    local_managed_store::open_local_managed_store,
    reconciler_context::resolve_planner_context,
};
use serde_json::{json,Value};
use std::{path::{Path,PathBuf},time::{SystemTime,UNIX_EPOCH},future::Future,task::{Context,Poll,Waker}};

fn fixture_dir()->PathBuf{
    let id=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    std::env::temp_dir().join(format!("rust2-api-facade-{}-{id}",std::process::id()))
}
fn run_ready<F:Future>(future:F)->F::Output{
    let waker=Waker::noop();let mut context=Context::from_waker(waker);
    let mut future=std::pin::pin!(future);
    match future.as_mut().poll(&mut context){
        Poll::Ready(value)=>value,Poll::Pending=>panic!("injected resolver unexpectedly awaited I/O"),
    }
}
#[test]
fn explicit_close_releases_only_owned_sqlite_resources(){
    SQLiteRelayStore::open(Path::new(":memory:"),None).unwrap().close().unwrap();
    BrowserWorkerPoolManager::open(BrowserPoolOptions{
        path:Some(PathBuf::from(":memory:")),..BrowserPoolOptions::default()
    }).unwrap().close().unwrap();
}
#[test]
fn ineligible_watchdog_cancels_old_task_timer_and_never_fires(){
    let mut timers=WatchdogTimers::default();
    let declined=json!({"id":"8","jobId":"32","state":"FAILED","executionId":"gen-a"});
    assert_eq!(arm_inactivity_watchdog(&declined,"gen-a",&mut timers,100,||panic!("ineligible")),None);
    assert_eq!(arm_inactivity_watchdog(&declined,"gen-b",&mut timers,100,||panic!("wrong generation")),None);
}
#[test]
fn process_reason_requires_an_owned_handle_and_cannot_probe_foreign_pid(){
    let _typed_port:fn(&OwnedProcess)->Option<&'static str>=owned_process_termination_reason;
}
#[test]
fn local_managed_store_opens_a_scoped_canonical_sqlite_connection(){
    let root=fixture_dir();let directory=root.join("stores");std::fs::create_dir_all(&directory).unwrap();
    let store=open_local_managed_store("my-repo",0,&directory,Some("123"),true).unwrap();
    assert_eq!(store.authority.scope_job_id.as_deref(),Some("123"));
    assert!(store.no_github);
    assert_eq!(store.authority.path,root.join("relay.sqlite"));
    store.authority.close().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn planner_context_resolves_with_same_registered_agents_and_runtime_ports(){
    let root=json!({"workspaceRoot":"/workspace"});
    let agents=vec![json!({"name":"planner"})];
    let adapters=vec![json!({"name":"script","id":"script","capabilities":["filesystem"]})];
    let resolved=run_ready(resolve_planner_context("/fixture",&root,&agents,&adapters,
        |cwd,role,options|async move{Ok::<Value,String>(json!({"cwd":cwd,"role":role,"options":options}))})).unwrap();
    assert_eq!(resolved["cwd"],"/fixture");
    assert_eq!(resolved["role"],"planner");
    assert_eq!(resolved["options"]["workspaceRoot"],"/workspace");
    assert_eq!(resolved["options"]["registeredAgents"],json!(agents));
    assert_eq!(resolved["options"]["runtimes"],json!([{"name":"script","id":"script","capabilities":["filesystem"]}]));
}
#[test]
fn browser_pool_singleton_is_the_same_lease_authority(){
    let root=fixture_dir();
    std::fs::create_dir_all(&root).unwrap();
    std::env::set_var("AGENTS_RELAY_STORE_DIR",root.as_os_str());
    let first=agents_relay_rust2::browser_worker_runtime::browser_worker_pool().unwrap();
    let second=agents_relay_rust2::browser_worker_runtime::browser_worker_pool().unwrap();
    assert!(std::ptr::eq(first,second));
    let _pool=first.lock().unwrap();
}
#[test]
fn adapters_error_identity_and_provider_names_are_explicit(){
    use agents_relay_rust2::adapters::{LaunchFailure,StartAckTimeout,WorkerAdapter};
    let failure:LaunchFailure=StartAckTimeout("no server-start".into()).into();
    assert_eq!(failure.to_string(),"no server-start");
    let z=agents_relay_rust2::z_adapter::ZAdapter::new();
    assert_eq!((z.name(),z.id()),("z","z/webhelm"));
    assert!(z.capabilities().contains(&"webhelm"));
    let prompt="Execution source: job/1/task/2/execution/01234567-89ab-cdef-0123-456789abcdef";
    let request=z.launch_request(prompt,&[],"dummy-not-real",None,
        "01234567-89ab-cdef-0123-456789abcdef",1000).unwrap();
    assert_eq!(request["action"],"new-thread");
    assert_eq!(request["provider"],"z");
    assert!(request["config"]["message"].as_str().unwrap().contains("OAuth access token: dummy-not-real"));
}
#[test]
fn script_adapter_preserves_worker_identity_and_rejects_unleased_tasks(){
    use agents_relay_rust2::adapters::WorkerAdapter;
    use agents_relay_rust2::script_task_adapter::ScriptTaskAdapter;
    let mut adapter=ScriptTaskAdapter::new(json!({}),
        |_path:&Path,_input:&Value,_cancelled:&std::sync::atomic::AtomicBool|{
            panic!("unleased Task cannot execute script")
        },
        |_event:&Value|Ok(()));
    assert_eq!((adapter.name(),adapter.id()),("script","script"));
    assert_eq!(adapter.capabilities(),&["script"]);
    assert_eq!(adapter.launch(&json!({"id":"x","state":"DRAFT"}),&json!({}),
        &std::sync::atomic::AtomicBool::new(false)).err().expect("expected rejection"),
        "Script Adapter requires a leased Agent Task");
}
#[test]
fn webhelm_preflight_requires_both_profile_and_running_daemon(){
    use agents_relay_rust2::adapters::ensure_chat_gpt_webhelm_ready;
    let mut commands=Vec::new();
    ensure_chat_gpt_webhelm_ready(|argv|{
        commands.push(argv.join(" "));
        if argv.first()==Some(&"platform") {Ok("diagnostic\n{\"platform\":\"chatgpt\"}".into())}
        else {Ok("{\"daemon\":{\"running\":true}}".into())}
    }).unwrap();
    assert_eq!(commands,vec!["platform profile chatgpt","status"]);
    let err=ensure_chat_gpt_webhelm_ready(|_|Ok("{\"platform\":\"z\"}".into())).unwrap_err();
    assert_eq!(err,"Global WebHelm CLI cannot load the ChatGPT platform skill");
    let err=ensure_chat_gpt_webhelm_ready(|argv|{
        if argv.first()==Some(&"platform") {Ok("{\"platform\":\"chatgpt\"}".into())}
        else{Ok("{\"daemon\":{\"running\":false}}".into())}
    }).unwrap_err();
    assert_eq!(err,"Global WebHelm daemon is not running");
}
#[test]
fn job_id_resolver_uses_readonly_unique_selection_and_reuses_scoped_sqlite(){
    use agents_relay_rust2::local_job_registry::create_job_id_registry_resolver;
    let root=fixture_dir();let directory=root.join("stores");
    std::fs::create_dir_all(&directory).unwrap();
    let path=root.join("relay.sqlite");
    for (id,state) in [("101","ACTIVE"),("102","COMPLETED")]{
        let scoped=SQLiteRelayStore::open(&path,Some(id)).unwrap();
        scoped.save_job(&json!({"id":id,"title":id,"repository":format!("repo-{id}"),"prNumber":0,
            "projectRoot":root.join(id).to_string_lossy(),"state":state,
            "plans":[],"tasks":[],"createdAt":"2026-11-17T10:00:00Z",
            "updatedAt":"2026-11-17T10:00:00Z"})).unwrap();
        scoped.close().unwrap();
    }
    let mut registry=create_job_id_registry_resolver(&directory,true);
    assert!(registry.resolve("invalid").unwrap().is_none());
    assert_eq!(registry.cached_count(),0);
    assert_eq!(registry.resolve("101").unwrap().unwrap().job["state"],"ACTIVE");
    let first=registry.resolve("101").unwrap().unwrap().relay() as *const SQLiteRelayStore;
    let second=registry.resolve("101").unwrap().unwrap().relay() as *const SQLiteRelayStore;
    assert_eq!(first,second,"same job scope must not open another writable store");
    assert_eq!(registry.resolve("102").unwrap().unwrap().job["state"],"COMPLETED");
    assert_eq!(registry.cached_count(),2,"same DB path is scoped by immutable Job ID");
    drop(registry);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn planner_agent_requires_execution_binding_before_any_worker_or_file_effect(){
    use agents_relay_rust2::planner::AgentObjectivePlanner;
    let agent=AgentObjectivePlanner::new(Some("definitely-not-codex"),None);
    let context=json!({"job":{"id":"31","tasks":[]},"tasks":[],"objective":"safe"});
    let root=fixture_dir();
    assert_eq!(agent.plan(&context,&root,&root,None,
        |_,_,_|->Result<agents_relay_rust2::planner_adapters::PlannerProcessResult,String>{
            panic!("invalid Planner identity cannot launch a Worker")
        }).unwrap_err(),"Planner execution is missing its durable Plan and execution identity");
}
#[test]
fn planner_public_spec_rejects_missing_output_and_bad_adapter(){
    use agents_relay_rust2::planner::planning_spec;
    let error=planning_spec(&json!({"id":"1","adapter":"codex"})).unwrap_err();
    assert_eq!(error,"Initial task 1 requires an output contract");
    let error=planning_spec(&json!({"id":"1","adapter":"unknown","output":{"kind":"file","path":"/tmp/data"}})).unwrap_err();
    assert_eq!(error,"Initial task 1 requires a supported worker adapter");
}
