//! Native Codex Planner: a subprocess cannot fabricate a Plan Apply receipt.
//! No Codex account, external provider, Node relayd, or production SQLite is used.
use agents_relay_rust2::{
    native_script_planner::run_native_codex_planner, planner::create_plan_round,
    relay_store::SQLiteRelayStore,
};
use serde_json::json;
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
fn fixture() -> (PathBuf, PathBuf, PathBuf) {
    let root = std::env::temp_dir().join(format!(
        "r2-model-plan-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let project = root.join("project");
    fs::create_dir_all(project.join("agents")).unwrap();
    fs::create_dir_all(root.join("stores")).unwrap();
    fs::write(
        project.join("agents/planner.agent.md"),
        "# Planner\nUse matching Plan context and apply CLI only; never invent receipts.\n",
    )
    .unwrap();
    let db = root.join("relay.sqlite");
    let stamp = "2026-11-21T00:00:00Z";
    let mut job = json!({"id":"903","repository":"project","projectRoot":project,
        "title":"Native Model Planner fixture","objective":"Verify a saved output",
        "state":"ACTIVE","prNumber":0,"reviewEnabled":false,"autoMerge":true,
        "createdAt":stamp,"updatedAt":stamp,"plans":[],
        "tasks":[{"id":"904","jobId":"903","kind":"work","adapter":"script",
          "agentName":"fixture","state":"SUCCEEDED","title":"Already verified",
          "output":{"kind":"file","path":project.join("proof.json")},
          "createdAt":stamp,"updatedAt":stamp}]});
    let graph = Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow");
    let plan = create_plan_round(&graph, &job, None, false, Some(4000), Some(stamp)).unwrap();
    job["plans"] = json!([plan]);
    let store = SQLiteRelayStore::open(&db, Some("903")).unwrap();
    store.save_job(&job).unwrap();
    (root, project, db)
}
#[test]
#[cfg(unix)]
fn unverified_codex_receipt_never_marks_plan_succeeded() {
    use std::os::unix::fs::PermissionsExt;
    let (root, _project, db) = fixture();
    let fake = root.join("fake-codex");
    let executed = root.join("provider-executed");
    fs::write(&fake,format!("#!/bin/sh\nprintf 'executed' > {}\nprintf '{{\"type\":\"thread.started\",\"thread_id\":\"38f84f9e-410d-4e36-96e0-a420594a102d\"}}\\n'\nprintf '{{\"type\":\"item.completed\",\"item\":{{\"type\":\"agent_message\",\"text\":\"PLAN_APPLIED:plan-1:unverified\"}}}}\\n'\nexit 0\n",executed.display())).unwrap();
    fs::set_permissions(&fake, fs::Permissions::from_mode(0o700)).unwrap();
    let graph = Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow");
    let _ = run_native_codex_planner(
        &db,
        &root.join("stores"),
        &graph,
        "903",
        "plan-1",
        &fake,
        4000,
    );
    assert!(
        executed.exists(),
        "Fake provider must actually launch, not fail prompt setup"
    );
    let store = SQLiteRelayStore::open_without_claim_reset(&db, Some("903")).unwrap();
    let current = store.load_job("903").unwrap().unwrap();
    assert_ne!(current["plans"][0]["status"], "SUCCEEDED", "{current}");
    assert_eq!(
        current["plans"][0]["threadId"], "38f84f9e-410d-4e36-96e0-a420594a102d",
        "failed Planner generation still records verified original Codex Thread"
    );
    assert_eq!(current["tasks"].as_array().unwrap().len(), 1);
    assert_eq!(current["state"], "ACTIVE");
    drop(store);
    fs::remove_dir_all(root).unwrap();
}
#[test]
#[cfg(unix)]
fn native_planner_honors_router_selected_model_profile_and_reasoning() {
    use agents_relay_rust2::native_script_planner::run_native_codex_planner_with_route;
    use std::os::unix::fs::PermissionsExt;
    let (root, _project, db) = fixture();
    let fake = root.join("fake-codex");
    let captured = root.join("captured-args.txt");
    let script = format!(
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > {}\nexit 7\n",
        captured.display()
    );
    fs::write(&fake, script).unwrap();
    fs::set_permissions(&fake, fs::Permissions::from_mode(0o700)).unwrap();
    let route = json!({"model":{"provider":"openai","model":"gpt-6-luna",
        "reasoning":"high","profile":"quality"},
        "selection":{"adapter":"codex","workerId":"codex"}});
    let graph = Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow");
    let _ = run_native_codex_planner_with_route(
        &db,
        &root.join("stores"),
        &graph,
        "903",
        "plan-1",
        &fake,
        4000,
        Some(route),
    );
    let args = fs::read_to_string(&captured).expect("Routed Codex must launch");
    assert!(args.contains("-p\nquality\n"), "{args}");
    assert!(args.contains("-m\ngpt-6-luna\n"), "{args}");
    assert!(args.contains("model_reasoning_effort=\"high\""), "{args}");
    assert!(args.contains("model_provider=\"openai\""), "{args}");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn native_planner_requires_explicit_executable() {
    let (root, _project, db) = fixture();
    let graph = Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow");
    let failure = run_native_codex_planner(
        &db,
        &root.join("stores"),
        &graph,
        "903",
        "plan-1",
        Path::new("codex"),
        1000,
    )
    .unwrap_err();
    assert!(failure.contains("explicit absolute"));
    let store = SQLiteRelayStore::open_without_claim_reset(&db, Some("903")).unwrap();
    assert_eq!(
        store.load_job("903").unwrap().unwrap()["plans"][0]["status"],
        "PLANNING"
    );
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn planner_prompt_explicitly_loads_project_agents_context_and_fails_when_missing() {
    let (root, project, _db) = fixture();
    // A project Planner must explicitly extend the bundled Planner to
    // inherit its startup Contract and declared project Context.
    fs::write(project.join("agents/planner.agent.md"),
        "---\nname: planner\nextends: planner\nmode: extend\n---\n# Project Planner\nFollow the project graph.\n").unwrap();
    let context_path = project.join("AGENTS.md");
    fs::write(
        &context_path,
        "PLANNER_PROJECT_CONTEXT_SENTINEL: use project verification",
    )
    .unwrap();
    let pkg = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let input = json!({
        "job":{"id":"903","repository":"project"},
        "planExecution":{"planId":"plan-1","executionId":"execution-1"},
        "executionContext":{"project":{"path":project,"gitRoot":project},"agents":[]},
        "nativeRustCli":"/tmp/agents-relay-rust"
    });
    let built = agents_relay_rust2::planner_adapters::build_planner_execution_prompt(
        &input, pkg, None, "codex", None,
    )
    .unwrap();
    assert!(built.system.contains("Managed Planner Execution Contract"));
    assert!(built.user.contains("Plan: plan-1"));
    assert!(built.system.contains("plan context --id '903' --plan-id 'plan-1' --execution-id 'execution-1'"));
    assert!(built.system.contains("<execution-bootstrap>\n"));
    assert!(built.user.contains("Follow the trusted System <execution-bootstrap> block"));
    assert!(!built.user.contains("Load Plan Context:"));
    assert!(!built.user.contains("task.started"));
    assert!(!built.user.contains("EVENT SOURCE (exact)"));
    assert!(!built.user.contains("reply.completed"));
    assert!(built.user.contains("PLANNER_PROJECT_CONTEXT_SENTINEL"));
    assert!(!built.system.contains("PLANNER_PROJECT_CONTEXT_SENTINEL"));
    assert!(built.references.iter().any(|item| item["kind"] == "context"
        && item["path"]
            .as_str()
            .is_some_and(|s| s.ends_with("/AGENTS.md"))));
    let mut without_execution_context = input.clone();
    without_execution_context
        .as_object_mut()
        .unwrap()
        .remove("executionContext");
    let missing_binding = agents_relay_rust2::planner_adapters::build_planner_execution_prompt(
        &without_execution_context,
        pkg,
        None,
        "codex",
        None,
    )
    .unwrap_err();
    assert!(
        missing_binding.contains("no resolved execution context"),
        "{missing_binding}"
    );
    fs::remove_file(context_path).unwrap();
    let error = agents_relay_rust2::planner_adapters::build_planner_execution_prompt(
        &input, pkg, None, "codex", None,
    )
    .unwrap_err();
    assert!(
        error.contains("Missing required project Context"),
        "{error}"
    );
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn native_planner_context_names_exact_rust_cli_for_apply() {
    let context = json!({"job":{"id":"903","repository":"project","prNumber":0},
        "objective":"Verify the current output", "tasks":[],
        "planExecution":{"planId":"plan-2","executionId":"execution-2"},
        "nativeRustCli":"/tmp/agents-relay-rust"});
    let rendered = agents_relay_rust2::planner::planner_input(&context);
    let value: serde_json::Value = serde_json::from_str(&rendered).unwrap();
    let apply = value["apply_cli"].as_str().unwrap();
    assert!(
        apply.starts_with("\"/tmp/agents-relay-rust\" plan apply"),
        "{apply}"
    );
    assert!(!apply.contains("dist/cli.js"), "{apply}");
    assert!(apply.contains("--plan-id plan-2 --execution-id execution-2"));
}

#[test]
fn planner_new_round_resumes_previous_codex_thread_but_not_plan_verdict() {
    let (root, _project, db) = fixture();
    let graph = Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow");
    let store = SQLiteRelayStore::open_without_claim_reset(&db, Some("903")).unwrap();
    let mut job = store.load_job("903").unwrap().unwrap();
    job["plans"][0]["status"] = json!("FAILED");
    job["plans"][0]["threadId"] = json!("38f84f9e-410d-4e36-96e0-a420594a102d");
    let second = create_plan_round(&graph, &job, None, false, None, None).unwrap();
    assert_eq!(second["id"], "plan-2");
    assert_eq!(second["threadId"], "38f84f9e-410d-4e36-96e0-a420594a102d");
    assert_eq!(second["status"], "PLANNING");
    assert!(second["executionId"].is_null());
    let args = agents_relay_rust2::planner::build_planner_codex_resume_args(
        &root.join("stores"),
        "Continue planning",
        second["threadId"].as_str(),
    );
    assert_eq!(
        &args[0..4],
        &[
            "exec",
            "--json",
            "resume",
            "--dangerously-bypass-approvals-and-sandbox"
        ]
    );
    assert!(args.contains(&"38f84f9e-410d-4e36-96e0-a420594a102d".to_string()));
    assert!(!args.contains(&"--last".to_string()));
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
#[cfg(unix)]
fn routed_planner_resumes_only_compatible_bound_thread() {
    use agents_relay_rust2::native_script_planner::run_native_codex_planner_with_route;
    use std::os::unix::fs::PermissionsExt;
    const OLD: &str = "38f84f9e-410d-4e36-96e0-a420594a102d";
    const NEW: &str = "38f84f9e-410d-4e36-96e0-a420594a102e";
    for same in [true, false] {
        let (root, _project, db) = fixture();
        let store = SQLiteRelayStore::open_without_claim_reset(&db, Some("903")).unwrap();
        let mut job = store.load_job("903").unwrap().unwrap();
        let old = json!({"provider":"zai","model":"glm-5.3-flash","profile":"zai"});
        job["plans"][0]["threadId"] = json!(OLD);
        job["plans"][0]["threadRoute"] = old.clone();
        store.save_job(&job).unwrap();
        drop(store);
        let selected = if same {
            old
        } else {
            json!({"provider":"openai","model":"gpt-6-luna"})
        };
        let fake = root.join("fake-codex");
        let captured = root.join("captured-args.txt");
        let observed = if same { OLD } else { NEW };
        fs::write(&fake,format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\nprintf '%s\\n' '{{\"type\":\"thread.started\",\"thread_id\":\"{observed}\"}}'\nexit 7\n",captured.display())).unwrap();
        fs::set_permissions(&fake, fs::Permissions::from_mode(0o700)).unwrap();
        let route = json!({"model":selected,"selection":{"adapter":"codex","workerId":"codex"}});
        let graph = Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow");
        let _ = run_native_codex_planner_with_route(
            &db,
            &root.join("stores"),
            &graph,
            "903",
            "plan-1",
            &fake,
            4000,
            Some(route),
        );
        let args = fs::read_to_string(&captured).unwrap();
        assert_eq!(args.lines().any(|l| l == "resume"), same, "{args}");
        if !same {
            assert!(args.contains("previousThreadId") && args.contains(OLD));
        }
        let store = SQLiteRelayStore::open_without_claim_reset(&db, Some("903")).unwrap();
        let after = store.load_job("903").unwrap().unwrap();
        assert_eq!(after["plans"][0]["threadId"], observed);
        if !same {
            assert_eq!(after["plans"][0]["threadHistory"][0]["threadId"], OLD);
            assert_eq!(after["plans"][0]["threadRoute"]["provider"], "openai");
        }
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }
}
