// Native managed PromptLayers regression: Agent/User isolation and immutable on-demand references.
use agents_relay_rust2::agent_prompt_builder::{
    build_relay_work_prompt, prompt_file_reference, PromptLayers,
};
use serde_json::json;
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
fn temp() -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "rust2-prompt-{}-{epoch}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ))
}
#[test]
fn layers_require_nonempty_trusted_and_user_content() {
    assert!(PromptLayers::new("".into(), "Task".into(), vec![]).is_err());
    assert!(PromptLayers::new("Role".into(), "".into(), vec![]).is_err());
    assert!(PromptLayers::new(
        "Role".into(),
        "Task".into(),
        vec![json!({"kind":"contract","path":"relative.md"})]
    )
    .is_err());
    let layers = PromptLayers::new("Role".into(), "Task".into(), vec![]).unwrap();
    assert_eq!(layers.system, "Role");
    assert_eq!(layers.user, "Task");
}
#[test]
fn work_prompt_binds_original_task_and_immutable_refs() {
    let dir = temp();
    fs::create_dir_all(&dir).unwrap();
    let contract = dir.join("contract.md");
    fs::write(&contract, "Contract fixture").unwrap();
    let input = json!({"agentName":"designer","agentContent":"# Designer instructions",
        "references":[{"kind":"contract","path":contract}],
        "jobId":"42","taskId":"89","executionId":"abc-123",
        "projectPath":"/tmp/project","taskTitle":"Render Panda"});
    let result = build_relay_work_prompt(&input, None).unwrap();
    assert!(result.system.contains("Designer instructions"));
    assert!(!result.user.contains("Designer instructions"));
    assert!(result
        .user
        .contains("EVENT SOURCE (exact): job/42/task/89/execution/abc-123"));
    assert!(result.user.contains("contract.md"));
    assert_eq!(result.references.len(), 1);
    assert_eq!(result.references[0]["kind"], "contract");
    assert!(!result.user.contains("Contract fixture"));
    assert!(!result.system.contains("Contract fixture"));
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn invalid_binding_and_relative_reference_have_explicit_failures() {
    assert_eq!(
        build_relay_work_prompt(&json!({"jobId":"","taskId":"1","executionId":"2"}), None)
            .unwrap_err(),
        "Relay prompt requires a full execution binding"
    );
    assert_eq!(
        prompt_file_reference("relative/AGENTS.md", "context").unwrap_err(),
        "Prompt reference must be absolute: relative/AGENTS.md"
    );
}
#[test]
fn runtime_policy_is_supplied_by_native_caller_not_hardcoded_in_builder() {
    let base = json!({"agentName":"editor","agentContent":"# Editor",
        "references":[],"jobId":"721","taskId":"2259",
        "executionId":"exec-1","repository":"vlog",
        "projectPath":"/tmp/vlog"});
    let dag = build_relay_work_prompt(&base, None).unwrap();
    assert_eq!(dag.system, "# Editor");
    assert!(!dag.user.contains("DAG TERMINAL"));
    assert!(!dag.user.contains("task.completed"));
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let metadata = json!({
        "startup_contracts":"[relay:skills/agents-relay/contracts/worker-lifecycle.md]",
        "assignment_contracts":"[relay:skills/agents-relay/contracts/task-execution.md]",
        "dag_contracts":"[relay:skills/agents-relay/contracts/dag-task-completion.md]"
    });
    let policy = agents_relay_rust2::declared_contract_loader::load(
        &metadata,
        root,
        "worker",
        Some("dag"),
        false,
    )
    .unwrap();
    let mut declared = base.clone();
    declared["trustedRuntimePolicy"] = json!(policy.system);
    declared["startupContracts"] = json!(policy.provenance);
    let layers = build_relay_work_prompt(&declared, None).unwrap();
    assert!(layers.system.contains("Publish `task.started` immediately when execution begins."));
    assert!(layers.system.contains("consult the `events-bus` Skill only"));
    assert!(layers.system.contains("bound Bootstrap execution-fenced `task complete` CLI"));
    assert!(!layers.system.contains("minimal required preflight"));
    assert!(layers.system.contains("execution-bound Bootstrap publication commands"));
    assert!(layers.system.contains("DAG Task Completion Contract"));
    assert!(layers.system.contains("`task complete` CLI"));
    assert!(layers.system.contains("bound Bootstrap execution-fenced `task complete` CLI"));
    assert!(layers.user.contains("EVENT SOURCE (exact): job/721/task/2259/execution/exec-1"));
    assert!(!layers.system.contains("{{"));
    assert!(!layers
        .system
        .contains("Git Source Task Completion Contract"));
    assert!(!layers.user.contains("# Editor"));
}

#[test]
fn required_skill_names_use_harness_discovery_and_never_embed_skill_files() {
    let dir = temp();
    fs::create_dir_all(&dir).unwrap();
    let context = dir.join("AGENTS.md");
    let skill = dir.join("SKILL.md");
    fs::write(&context, "Project-specific Context v1").unwrap();
    fs::write(&skill, "NEVER_INLINE_THIS_SKILL_TEXT").unwrap();
    let input = json!({
        "agentName":"tester","agentContent":"# Trusted Tester",
        "jobId":"10","taskId":"20","executionId":"run-1","projectPath":dir,
        "requiredSkillNames":["markcut","ponytail","markcut"],
        "references":[{"kind":"context","path":context}]
    });
    let first = build_relay_work_prompt(&input, None).unwrap();
    assert!(first.user.contains("Project-specific Context v1"));
    assert!(first.system.contains("Required Skill names"));
    assert!(first.system.contains("markcut, ponytail"));
    assert!(!first.system.contains("NEVER_INLINE_THIS_SKILL_TEXT"));
    assert!(!first.user.contains("NEVER_INLINE_THIS_SKILL_TEXT"));
    assert_eq!(
        first
            .references
            .iter()
            .filter(|r| r["kind"] == "required-skill-name")
            .count(),
        2
    );
    assert!(first.references.iter().all(|r| r.get("sha256").is_none()));
    fs::write(&context, "Project-specific Context v2").unwrap();
    fs::remove_file(&skill).unwrap();
    let second = build_relay_work_prompt(&input, None).unwrap();
    assert!(second.user.contains("Project-specific Context v2"));
    assert!(second.system.contains("markcut, ponytail"));
    assert!(second
        .references
        .iter()
        .any(|r| r["name"] == "markcut" && r.get("path").is_none()));
    assert_ne!(first.user, second.user);
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn builder_rejects_preresolved_skill_path_even_if_file_exists() {
    let dir = temp();
    fs::create_dir_all(&dir).unwrap();
    let skill = dir.join("SKILL.md");
    fs::write(&skill, "do not read").unwrap();
    let input = json!({"agentContent":"# Agent","jobId":"1","taskId":"2",
        "executionId":"3","projectPath":dir,"references":[{"kind":"skill","path":skill}]});
    assert!(build_relay_work_prompt(&input, None)
        .unwrap_err()
        .contains("Unsupported Agent reference kind"));
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn required_completion_contract_is_trusted_not_user_task_text() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let policy = agents_relay_rust2::declared_contract_loader::load(
        &json!({}),
        dir,
        "worker",
        Some("dag"),
        false,
    )
    .unwrap();
    let input = json!({"agentContent":"# Role","jobId":"9","taskId":"8",
        "executionId":"run-7","repository":"vlog","projectPath":"/tmp/vlog",
        "trustedRuntimePolicy":policy.system,"startupContracts":policy.provenance});
    let layers = build_relay_work_prompt(&input, None).unwrap();
    assert!(layers.system.contains("DAG Task Completion Contract"));
    assert!(layers.system.contains("`task complete` CLI"));
    assert!(layers.system.contains("bound Bootstrap execution-fenced `task complete` CLI"));
    assert!(layers.user.contains("EVENT SOURCE (exact): job/9/task/8/execution/run-7"));
    assert!(!layers.user.contains("DAG Task Completion Contract"));
    assert!(!layers.user.contains("task complete"));
    assert!(layers.references.iter().all(|v| v.get("sha256").is_none()));
    assert!(layers
        .references
        .iter()
        .any(|v| v["kind"] == "startup-contract"));
}

#[test]
fn prompt_fingerprint_does_not_depend_on_provider_or_model() {
    let base = json!({
        "agentName":"editor","agentContent":"# Effective inherited Editor",
        "jobId":"150","taskId":"52","executionId":"exec-5",
        "projectPath":"/tmp/project","references":[],
        "taskTitle":"Edit storyboard"
    });
    let mut hashes = vec![];
    for provider in ["z.ai", "openai", "deepseek", "webchat"] {
        let mut input = base.clone();
        input["adapter"] = json!(provider);
        input["providerInstructions"] = json!([format!("Vendor-specific {provider}")]);
        let part = build_relay_work_prompt(&input, None).unwrap();
        assert!(!part.system.contains("Vendor-specific"));
        assert!(!part.user.contains("Vendor-specific"));
        assert!(part.user.contains("Job: 150"));
        hashes.push(part.fingerprint());
    }
    assert!(hashes.iter().all(|hash| hash == &hashes[0]));
    let mut changed = base;
    changed["executionId"] = json!("exec-6");
    assert_ne!(
        build_relay_work_prompt(&changed, None)
            .unwrap()
            .fingerprint(),
        hashes[0]
    );
}

#[test]
fn contract_tool_owners_are_declared_by_exact_skill_name() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent().unwrap().join("skills/agents-relay/contracts");
    // Only tool/service-bearing contracts are included. evaluation-safety.md
    // forbids every tool, and job-create-preflight.md is a CLI error template.
    let expected: &[(&str, &[&str])] = &[
        ("agent-contract.md", &["agents-relay"]),
        ("architect-design-handoff.md", &["agents-relay", "agency-agents", "speckit-specify", "speckit-clarify"]),
        ("blocker-job-recovery.md", &["agents-relay"]),
        ("dag-task-completion.md", &["agents-relay", "events-bus"]),
        ("event-contract.md", &["events-bus", "agents-relay"]),
        ("event-task-completion.md", &["events-bus", "agents-relay"]),
        ("execution-boundary.md", &["agents-relay"]),
        ("orchestrator-workflows.md", &["agents-relay", "speckit-specify", "speckit-clarify"]),
        ("plan-execution.md", &["agents-relay"]),
        ("source-task-completion.md", &["agents-relay", "events-bus"]),
        ("task-execution.md", &["agents-relay"]),
        ("task-job-contract.md", &["agents-relay", "speckit-specify", "speckit-clarify", "events-bus", "neo-project"]),
        ("task-recovery-flows.md", &["agents-relay", "events-bus"]),
        ("worker-lifecycle.md", &["events-bus"]),
        ("worker-self-review.md", &["agents-relay", "events-bus"]),
    ];
    for (file, skills) in expected {
        let text = fs::read_to_string(dir.join(file)).unwrap();
        for skill in *skills {
            assert!(text.contains(&format!("`{skill}` Skill")),
                "{file} must name owning skill `{skill}`");
        }
    }
    let startup = fs::read_to_string(dir.join("worker-lifecycle.md")).unwrap();
    assert!(!startup.to_ascii_lowercase().contains("preflight"));
    assert!(!startup.contains("```"));
    let completion = fs::read_to_string(dir.join("dag-task-completion.md")).unwrap();
    assert!(!completion.contains("```sh"));
}

#[test]
fn loaded_named_contracts_are_grouped_as_principles_and_referenced_by_user_name() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    for (operation, terminal, completion) in [
        ("worker", Some("event"), "event-task-completion"),
        ("worker", Some("dag"), "dag-task-completion"),
        ("worker", Some("source"), "source-task-completion"),
        ("plan", None, "plan-execution"),
    ] {
        let metadata = if operation == "plan" {
            json!({"startup_contracts":"[relay:skills/agents-relay/contracts/plan-execution.md]"})
        } else { json!({}) };
        let loaded = agents_relay_rust2::declared_contract_loader::load(
            &metadata, root, operation, terminal, false).unwrap();
        assert!(loaded.system.starts_with("<contracts>\nContracts are the principal rules you must follow."));
        assert!(loaded.system.ends_with("</contracts>"));
        let input = json!({"agentContent":"# Trusted Agent", "jobId":"746",
            "taskId":"2378", "executionId":"exec-1", "repository":"vlog",
            "taskInstructions":format!("Apply `{completion}` for the terminal outcome."),
            "trustedRuntimePolicy":loaded.system,"startupContracts":loaded.provenance});
        let prompt = build_relay_work_prompt(&input, None).unwrap();
        assert_eq!(prompt.system.matches("<contracts>").count(), 1);
        assert_eq!(prompt.system.matches("</contracts>").count(), 1);
        assert!(prompt.system.starts_with("# Trusted Agent\n\n<contracts>"));
        let names: Vec<String> = prompt.references.iter()
            .filter(|r| r["kind"] == "startup-contract")
            .map(|r| r["name"].as_str().unwrap().to_owned()).collect();
        assert!(names.iter().any(|n| n == "execution-boundary"));
        assert!(names.iter().any(|n| n == completion));
        assert_eq!(prompt.system.matches("</contract>").count(), names.len());
        for name in &names {
            assert_eq!(prompt.system.matches(&format!("<contract name=\"{name}\">")).count(),1);
            assert!(prompt.user.contains(&format!("`{name}`")));
        }
        assert!(prompt.user.contains(&format!("Apply `{completion}` for the terminal outcome.")));
        assert!(!prompt.user.contains("Contracts are the principal rules you must follow."));
        assert!(prompt.user.contains("<contracts> group"));
    }
}

#[test]
fn duplicate_on_demand_contract_names_fail_closed() {
    let dir = temp();fs::create_dir_all(dir.join("one")).unwrap();
    fs::create_dir_all(dir.join("two")).unwrap();
    let first=dir.join("one/same.md"); let second=dir.join("two/same.md");
    fs::write(&first,"One").unwrap();fs::write(&second,"Two").unwrap();
    let input=json!({"agentContent":"Role","jobId":"1","taskId":"2","executionId":"3",
        "references":[{"kind":"contract","path":first},{"kind":"contract","path":second}]});
    assert!(build_relay_work_prompt(&input,None).unwrap_err().contains("Ambiguous Contract name"));
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn mismatched_loaded_contract_name_is_rejected() {
    let dir = temp(); fs::create_dir_all(&dir).unwrap();
    let contract = dir.join("real-name.md"); fs::write(&contract, "A mandatory principle").unwrap();
    let input = json!({"agentContent":"# Role", "jobId":"1", "taskId":"2", "executionId":"3",
        "trustedRuntimePolicy":"<contracts><contract name=\"fake-name\">X</contract></contracts>",
        "startupContracts":[{"kind":"startup-contract","path":contract,
            "name":"fake-name","placement":"system","loaded":true}]});
    assert!(build_relay_work_prompt(&input,None).unwrap_err().contains("name does not match filename"));
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn bound_bootstrap_selects_completion_contract_and_never_emits_reply_events() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    for (mode, expected) in [("source", "--commit-sha COMMIT_SHA"), ("dag", "task complete"), ("event", "\"type\":\"task.completed\"")] {
        let policy = agents_relay_rust2::declared_contract_loader::load(&json!({}), root, "worker", Some(mode), false).unwrap();
        let prompt = build_relay_work_prompt(&json!({"agentName":"arbitrary-custom-role","agentContent":"# Role", "jobId":"9","taskId":"8","executionId":"run-7","repository":"repo name", "projectPath":"/tmp/project", "relayCli":"/tmp/relay's bin/agents-relay-rust", "eventApi":"http://127.0.0.1:4223", "startupContracts":policy.provenance,"trustedRuntimePolicy":policy.system}), None).unwrap();
        assert!(prompt.user.starts_with("# Execution Bootstrap"));
        assert!(prompt.user.contains("task context --id '9' --task-id '8' --execution-id 'run-7'"));
        assert!(prompt.user.contains("job/9/task/8/execution/run-7"));
        assert!(prompt.user.contains("task.started"));
        assert!(prompt.user.contains("task.failed"));
        assert!(prompt.user.contains(expected), "{}", prompt.user);
        assert_eq!(prompt.user.contains("--commit-sha"), mode == "source");
        assert_eq!(prompt.user.contains("task.completed"), mode == "event");
        assert!(!prompt.user.contains("reply.text"));
        assert!(!prompt.user.contains("reply.completed"));
        assert!(!prompt.system.contains("curl --fail-with-body"));
        let line = prompt.user.lines().find(|line|line.starts_with("Load Task Context:")).unwrap();
        assert!(line.contains("/tmp/relay'\"'\"'s bin/agents-relay-rust"));
    }
}

#[test]
fn execution_bootstrap_opt_out_keeps_binding_and_contracts() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let policy = agents_relay_rust2::declared_contract_loader::load(&json!({}), root, "worker", Some("source"), true).unwrap();
    let mut input = json!({"agentContent":"# Role","jobId":"9","taskId":"8","executionId":"run-7","repository":"test", "projectPath":"/tmp/project","relayCli":"/tmp/agents-relay-rust","eventApi":"http://127.0.0.1:4223","startupContracts":policy.provenance,"trustedRuntimePolicy":policy.system});
    let default = build_relay_work_prompt(&input,None).unwrap();
    input["executionBootstrap"] = json!(false);
    let off = build_relay_work_prompt(&input,None).unwrap();
    assert_eq!(default.system, off.system);
    assert_eq!(default.references, off.references);
    assert!(default.user.contains("Start immediately:"));
    assert!(off.user.starts_with("# Execution binding"));
    assert!(!off.user.contains("Start immediately:"));
    assert!(!off.user.contains("curl --fail-with-body"));
    assert!(off.user.contains("job/9/task/8/execution/run-7"));
    assert!(off.user.contains("owning Skills"));
    assert!(off.system.contains("Git Source Task Completion Contract"));
    use agents_relay_rust2::agent_context::execution_bootstrap_enabled as enabled;
    assert!(enabled(&json!({})).unwrap());
    assert!(enabled(&json!({"execution_bootstrap":"true"})).unwrap());
    assert!(!enabled(&json!({"execution_bootstrap":"false"})).unwrap());
    assert!(enabled(&json!({"execution_bootstrap":"yes"})).is_err());
}

#[test]
fn bootstrap_preference_inherits_and_can_be_overridden() {
    use agents_relay_rust2::{agent_content_resolver::resolve_agent_markdown,agent_context::execution_bootstrap_enabled};
    let dir = temp();
    let builtin = dir.join("builtin");
    let project = dir.join("project");
    fs::create_dir_all(&builtin).unwrap();
    fs::create_dir_all(project.join("agents")).unwrap();
    fs::write(builtin.join("base.agent.md"), "---\nname: base\nexecution_bootstrap: false\n---\nBase role\n").unwrap();
    fs::write(project.join("agents/child.agent.md"), "---\nname: child\nextends: base\n---\nChild role\n").unwrap();
    let resolve = || resolve_agent_markdown("child", &builtin.to_string_lossy(), &project.to_string_lossy(), None);
    assert!(!execution_bootstrap_enabled(&resolve().unwrap()["metadata"]).unwrap());
    fs::write(project.join("agents/child.agent.md"), "---\nname: child\nextends: base\nexecution_bootstrap: true\n---\nChild role\n").unwrap();
    assert!(execution_bootstrap_enabled(&resolve().unwrap()["metadata"]).unwrap());
    fs::write(project.join("agents/child.agent.md"), "---\nname: child\nextends: base\nexecution_bootstrap: maybe\n---\nChild role\n").unwrap();
    assert!(resolve().unwrap_err().contains("execution_bootstrap must be true or false"));
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn fallback_checkpoint_contract_reuses_existing_execution_id_without_extra_binding() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let worker=agents_relay_rust2::declared_contract_loader::load(&json!({}),root,"worker",Some("event"),false).unwrap();
    let mut input=json!({"agentContent":"# Role","jobId":"checkpoint-fixture","taskId":"task-1",
        "executionId":"checkpoint-test-exec","repository":"fixture","projectPath":"/tmp/project",
        "relayCli":"/tmp/agents-relay-rust","eventApi":"http://127.0.0.1:4223",
        "trustedRuntimePolicy":worker.system,"startupContracts":worker.provenance});
    let prompt=build_relay_work_prompt(&input,None).unwrap();
    assert!(prompt.system.contains("Execution Checkpoint Fallback Contract"));
    assert!(prompt.system.contains("/tmp/relay-checkpoint-<executionId>.md"));
    assert!(prompt.system.contains("Do not voluntarily reset context if both checkpoint methods failed"));
    assert!(prompt.user.contains("Execution: checkpoint-test-exec"));
    assert!(!prompt.user.contains("relay-checkpoint-"));
    input["executionBootstrap"]=json!(false);
    let disabled=build_relay_work_prompt(&input,None).unwrap();
    assert_eq!(disabled.system,prompt.system);
    assert!(disabled.user.contains("Execution: checkpoint-test-exec"));
    assert!(!disabled.user.contains("relay-checkpoint-"));
    let planner=agents_relay_rust2::declared_contract_loader::load(&json!({"startup_contracts":"[relay:skills/agents-relay/contracts/plan-execution.md]"}),root,"plan",None,false).unwrap();
    assert!(planner.system.contains("/tmp/relay-checkpoint-<executionId>.md"));
    assert!(planner.system.contains("Isolated evaluations and unbound executions do not use this fallback"));
}
