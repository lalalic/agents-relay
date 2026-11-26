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
    assert!(!layers.system.contains("minimal required preflight"));
    assert!(layers.system.contains("DAG Task Completion Contract"));
    assert!(layers.system.contains(
        "agents-relay task complete --repo vlog --id 721 --task-id 2259 --execution-id exec-1"
    ));
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
    assert!(layers.system.contains(
        "agents-relay task complete --repo vlog --id 9 --task-id 8 --execution-id run-7"
    ));
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
