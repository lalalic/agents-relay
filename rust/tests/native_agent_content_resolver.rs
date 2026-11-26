// Native Rust regressions for Node src/agent-content-resolver.ts: layered inheritance, section rewrites, source link paths and confinement.
use agents_relay_rust2::agent_content_resolver::{agent_source_layers, resolve_agent_markdown};
use serde_json::json;
use std::{
    fs,
    os::unix::fs::symlink,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
fn temp() -> PathBuf {
    static UNIQUE: AtomicU64 = AtomicU64::new(0);
    let tick = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "r2-agent-{}-{tick}-{}",
        std::process::id(),
        UNIQUE.fetch_add(1, Ordering::Relaxed)
    ))
}
fn put(base: &Path, filename: &str, content: &str) -> PathBuf {
    let file = base.join(filename);
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(&file, content).unwrap();
    file
}
#[test]
fn source_layers_deduplicate_duplicate_roots_and_keep_parent_order() {
    let roots = agent_source_layers(
        "/tmp/work/project/sub",
        &json!({"globalRoot":"/tmp/global","workspaceRoot":"/tmp/work"}),
    );
    let result = roots.as_array().unwrap();
    assert_eq!(
        result
            .iter()
            .map(|layer| layer["source"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["global", "parent", "parent", "project"]
    );
    assert_eq!(result[1]["root"], "/tmp/work");
    assert_eq!(result[2]["root"], "/tmp/work/project");
    assert_eq!(result[3]["root"], "/tmp/work/project/sub");
}
#[test]
fn nested_heading_replace_and_extend_preserve_untouched_siblings() {
    let root = temp();
    let builtin = root.join("builtin");
    let project = root.join("project");
    put(&builtin,"planner.agent.md","---\nname: planner\nrole: builtin\n---\n# Planner\n## A\nOriginal A\n### G\nOriginal G\n## B\nOriginal B\n## C\nOriginal C");
    put(&project,"agents/planner.agent.md","---\nname: planner\nextends: planner\nrole: project\nsections:\n  replace: [Planner/A/G]\n  extend: [Planner/B]\n---\n# Planner\n## A\n### G\nChanged G\n## B\nAdded B");
    let output = resolve_agent_markdown(
        "planner",
        builtin.to_str().unwrap(),
        project.to_str().unwrap(),
        None,
    )
    .unwrap();
    let content = output["content"].as_str().unwrap();
    assert!(content.contains("Original A\n### G\nChanged G"));
    assert!(!content.contains("Original G"));
    assert!(content.contains("Original B\nAdded B\n## C\nOriginal C"));
    assert_eq!(output["metadata"]["role"], "project");
    assert_eq!(output["sources"].as_array().unwrap().len(), 2);
    assert_eq!(output["hash"].as_str().unwrap().len(), 64);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn relative_links_are_anchored_to_their_real_source_without_inlining_content() {
    let root = temp();
    let builtin = root.join("builtin");
    let project = root.join("project");
    let base = put(
        &builtin,
        "planner.agent.md",
        "---\nname: planner\n---\n# Base\nRead [docs](./reference.md)",
    );
    put(&project,"agents/planner.agent.md","---\nname: planner\nextends: planner\n---\n# Project\n[child](../docs/a.md#part)\n```md\n[example](../docs/leave.md)\n```");
    let result = resolve_agent_markdown(
        "planner",
        builtin.to_str().unwrap(),
        project.to_str().unwrap(),
        None,
    )
    .unwrap();
    let body = result["content"].as_str().unwrap();
    assert!(body.contains(&format!(
        "[docs]({}/reference.md)",
        base.parent().unwrap().canonicalize().unwrap().display()
    )));
    assert!(body.contains("/docs/a.md#part)"));
    assert!(body.contains("[example](../docs/leave.md)"));
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn symlink_escape_and_invalid_parent_fail_closed() {
    let root = temp();
    let builtin = root.join("builtin");
    let project = root.join("project");
    let base = put(
        &builtin,
        "planner.agent.md",
        "---\nname: planner\n---\n# Base",
    );
    fs::create_dir_all(project.join("agents")).unwrap();
    let file = project.join("agents/planner.agent.md");
    symlink(base, &file).unwrap();
    let error = resolve_agent_markdown(
        "planner",
        builtin.to_str().unwrap(),
        project.to_str().unwrap(),
        None,
    )
    .unwrap_err();
    assert_eq!(error, "Agent file escapes context root");
    fs::remove_file(&file).unwrap();
    put(
        &project,
        "agents/planner.agent.md",
        "---\nname: planner\nextends: other\n---\n# Invalid",
    );
    assert!(resolve_agent_markdown(
        "planner",
        builtin.to_str().unwrap(),
        project.to_str().unwrap(),
        None
    )
    .unwrap_err()
    .contains("Missing base agent other"));
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn shared_base_from_differently_named_agent_and_unknown_agent() {
    let root = temp();
    let builtin = root.join("builtin");
    let project = root.join("project");
    let shared = root.join("shared");
    fs::create_dir_all(&builtin).unwrap();
    put(
        &shared,
        "agents/common.agent.md",
        "---\nname: common\n---\n# Shared\nCommon rules",
    );
    put(
        &project,
        "agents/special.agent.md",
        "---\nname: special\nextends: common\n---\n# Local\nSpecific rules",
    );
    let result = resolve_agent_markdown(
        "special",
        builtin.to_str().unwrap(),
        project.to_str().unwrap(),
        Some(&agent_source_layers(
            project.to_str().unwrap(),
            &json!({"workspaceRoot":shared.to_str().unwrap()}),
        )),
    )
    .unwrap();
    assert!(result["content"]
        .as_str()
        .unwrap()
        .contains("Common rules\n\n# Local"));
    assert!(result["content"]
        .as_str()
        .unwrap()
        .contains("Specific rules"));
    assert_eq!(result["sources"].as_array().unwrap().len(), 2);
    assert_eq!(
        resolve_agent_markdown(
            "does-not-exist",
            builtin.to_str().unwrap(),
            project.to_str().unwrap(),
            None
        )
        .unwrap_err(),
        "Unknown agent does-not-exist"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn agent_context_metadata_is_inherited_replaced_and_cleared_without_duplication() {
    use agents_relay_rust2::agent_context::selected_references;
    let root = temp();
    let builtin = root.join("builtin");
    let project = root.join("project");
    let bundle = root.join("bundle");
    put(&builtin,"base.agent.md","---\nname: base\ncontexts: [base-rules/AGENTS.md]\ncontracts: [relay:contracts/review.md]\nrequired_skills: [markcut]\n---\n# Base\nShared editorial behavior");
    put(&project, "base-rules/AGENTS.md", "base input");
    put(&project, "editor-rules/AGENTS.md", "editor input");
    put(&bundle, "contracts/review.md", "review contract");
    let skill = put(&root, "skills/markcut/SKILL.md", "how to edit");
    put(&project,"agents/editor.agent.md","---\nname: editor\nextends: base\ncontexts: [editor-rules/AGENTS.md]\n---\n# Editor\nSpecific instructions");
    let context = json!({"project":{"path":project,"gitRoot":project},"skills":[{"name":"markcut","path":skill}]});
    let resolve = || {
        resolve_agent_markdown(
            "editor",
            builtin.to_str().unwrap(),
            project.to_str().unwrap(),
            None,
        )
        .unwrap()
    };
    let merged = resolve();
    assert_eq!(merged["sources"].as_array().unwrap().len(), 2);
    assert_eq!(merged["metadata"]["contexts"], "[editor-rules/AGENTS.md]");
    assert_eq!(
        merged["metadata"]["contracts"],
        "[relay:contracts/review.md]"
    );
    assert_eq!(merged["metadata"]["required_skills"], "[markcut]");
    let selected = selected_references(&merged["metadata"], &context, &bundle, "codex").unwrap();
    assert_eq!(selected.as_array().unwrap().len(), 2);
    assert_eq!(
        selected[0]["path"],
        project
            .join("editor-rules/AGENTS.md")
            .canonicalize()
            .unwrap()
            .to_str()
            .unwrap()
    );
    assert_eq!(selected[1]["kind"], "contract");
    assert_eq!(
        agents_relay_rust2::agent_context::required_skill_names(&merged["metadata"]).unwrap(),
        vec!["markcut"]
    );
    assert!(
        !selected.to_string().contains("base-rules"),
        "Overridden parent Context cannot leak"
    );

    put(&project,"agents/editor.agent.md","---\nname: editor\nextends: base\ncontexts: []\ncontracts: []\nrequired_skills: []\n---\n# Editor\nClear inherited dependencies");
    let cleared = resolve();
    assert_eq!(cleared["metadata"]["contexts"], "[]");
    assert_eq!(cleared["metadata"]["contracts"], "[]");
    assert_eq!(cleared["metadata"]["required_skills"], "[]");
    assert_eq!(
        selected_references(&cleared["metadata"], &context, &bundle, "codex").unwrap(),
        json!([])
    );
    assert!(cleared["content"]
        .as_str()
        .unwrap()
        .contains("Shared editorial behavior"));
    put(
        &project,
        "agents/editor.agent.md",
        "---\nname: editor\nextends: base\ncontexts:\n---\n# Editor\nEmpty declared Context",
    );
    let empty = resolve();
    assert_eq!(empty["metadata"]["contexts"], "");
    let selected = selected_references(&empty["metadata"], &context, &bundle, "codex").unwrap();
    assert_eq!(
        selected
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r["kind"] == "context")
            .count(),
        0
    );
    assert_eq!(
        selected.as_array().unwrap().len(),
        1,
        "Parent on-demand Contract still inherited; Skill remains a name"
    );

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn bundled_implementation_and_planner_only_load_declared_project_agents_md() {
    use agents_relay_rust2::{
        agent_context::selected_references, agent_prompt_builder::build_relay_work_prompt,
    };
    let bundle = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let builtin = bundle.join("skills/agents-relay/agents");
    let project = temp().join("project");
    put(
        &project,
        "AGENTS.md",
        "PROJECT_CONTEXT_SENTINEL: obey repository build checks",
    );
    let context = json!({"project":{"gitRoot":project}});
    for role in ["implementation", "planner"] {
        let resolved = resolve_agent_markdown(
            role,
            builtin.to_str().unwrap(),
            project.to_str().unwrap(),
            None,
        )
        .unwrap();
        assert_eq!(resolved["metadata"]["contexts"], "[AGENTS.md]");
        let references =
            selected_references(&resolved["metadata"], &context, bundle, "codex").unwrap();
        assert_eq!(references.as_array().unwrap().len(), 1);
        assert_eq!(references[0]["kind"], "context");
        assert_eq!(
            references[0]["path"],
            project
                .join("AGENTS.md")
                .canonicalize()
                .unwrap()
                .to_str()
                .unwrap()
        );
        let prompt = build_relay_work_prompt(
            &json!({
                "agentName":role,"agentContent":resolved["content"],
                "jobId":"1","taskId":"2","executionId":"3",
                "projectPath":project,"references":references
            }),
            None,
        )
        .unwrap();
        assert!(prompt.user.contains("PROJECT_CONTEXT_SENTINEL"));
        assert!(
            !prompt.system.contains("PROJECT_CONTEXT_SENTINEL"),
            "project instructions are lower priority than role and Contracts"
        );
    }
    for role in ["reviewer", "troubleshooter", "review-chair"] {
        let resolved = resolve_agent_markdown(
            role,
            builtin.to_str().unwrap(),
            project.to_str().unwrap(),
            None,
        )
        .unwrap();
        assert!(
            resolved["metadata"].get("contexts").is_none(),
            "{role} must not inherit project AGENTS.md from Worker"
        );
        let refs = selected_references(&resolved["metadata"], &context, bundle, "codex").unwrap();
        assert_eq!(refs, json!([]));
    }
    fs::remove_file(project.join("AGENTS.md")).unwrap();
    for role in ["implementation", "planner"] {
        let resolved = resolve_agent_markdown(
            role,
            builtin.to_str().unwrap(),
            project.to_str().unwrap(),
            None,
        )
        .unwrap();
        let error =
            selected_references(&resolved["metadata"], &context, bundle, "codex").unwrap_err();
        assert!(
            error.contains("Missing required project Context"),
            "{error}"
        );
    }
    fs::remove_dir_all(project.parent().unwrap()).unwrap();
}

#[test]
fn absolute_external_base_inherits_only_declared_references() {
    use agents_relay_rust2::agent_context::selected_references;
    let root = temp();
    let builtin = root.join("builtin");
    let project = root.join("project");
    let external=put(&root,"external/editor-base.md","---\nname: editor-base\ncontexts: [director/AGENTS.md]\nrequired_skills: []\n---\n# Shared\nExternal approved role");
    put(&project, "director/AGENTS.md", "directory instructions");
    put(
        &project,
        "agents/editor.agent.md",
        &format!(
            "---\nname: editor\nextends: {}\n---\n# Editor\nLocal guidance",
            external.display()
        ),
    );
    fs::create_dir_all(&builtin).unwrap();
    let merged = resolve_agent_markdown(
        "editor",
        builtin.to_str().unwrap(),
        project.to_str().unwrap(),
        None,
    )
    .unwrap();
    assert_eq!(merged["metadata"]["contexts"], "[director/AGENTS.md]");
    let ctx = json!({"project":{"path":project,"gitRoot":project},"skills":[]});
    let refs = selected_references(&merged["metadata"], &ctx, &root, "codex").unwrap();
    assert_eq!(refs.as_array().unwrap().len(), 1);
    assert_eq!(
        refs[0]["path"],
        project
            .join("director/AGENTS.md")
            .canonicalize()
            .unwrap()
            .to_str()
            .unwrap()
    );
    assert_eq!(merged["sources"].as_array().unwrap().len(), 2);
    fs::remove_dir_all(root).unwrap();
}
