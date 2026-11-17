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
        &json!({"globalRoot":"/tmp/global","workspaceRoot":"/tmp/work","sharedRoot":"/tmp/shared"}),
    );
    let result = roots.as_array().unwrap();
    assert_eq!(
        result
            .iter()
            .map(|layer| layer["source"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["global", "shared", "parent", "parent", "project"]
    );
    assert_eq!(result[2]["root"], "/tmp/work");
    assert_eq!(result[3]["root"], "/tmp/work/project");
    assert_eq!(result[4]["root"], "/tmp/work/project/sub");
}
#[test]
fn nested_heading_replace_and_extend_preserve_untouched_siblings() {
    let root = temp();
    let builtin = root.join("builtin");
    let project = root.join("project");
    put(&builtin,"planner.agent.md","---\nname: planner\nrole: builtin\n---\n# Planner\n## A\nOriginal A\n### G\nOriginal G\n## B\nOriginal B\n## C\nOriginal C");
    put(&project,"agents/planner.agent.md","---\nname: planner\nextends: relay/planner\nrole: project\nsections:\n  replace: [Planner/A/G]\n  extend: [Planner/B]\n---\n# Planner\n## A\n### G\nChanged G\n## B\nAdded B");
    let output = resolve_agent_markdown(
        "planner",
        builtin.to_str().unwrap(),
        project.to_str().unwrap(),
        None,
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
    put(&project,"agents/planner.agent.md","---\nname: planner\nextends: relay/planner\n---\n# Project\n[child](../docs/a.md#part)\n```md\n[example](../docs/leave.md)\n```");
    let result = resolve_agent_markdown(
        "planner",
        builtin.to_str().unwrap(),
        project.to_str().unwrap(),
        None,
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
        None,
    )
    .unwrap_err();
    assert_eq!(error, "Agent file escapes context root");
    fs::remove_file(&file).unwrap();
    put(
        &project,
        "agents/planner.agent.md",
        "---\nname: planner\nextends: relay/other\n---\n# Invalid",
    );
    assert!(resolve_agent_markdown(
        "planner",
        builtin.to_str().unwrap(),
        project.to_str().unwrap(),
        None,
        None
    )
    .unwrap_err()
    .contains("Only extends:"));
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
        "---\nname: special\nextends: shared/common\n---\n# Local\nSpecific rules",
    );
    let result = resolve_agent_markdown(
        "special",
        builtin.to_str().unwrap(),
        project.to_str().unwrap(),
        Some(shared.to_str().unwrap()),
        None,
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
            None,
            None
        )
        .unwrap_err(),
        "Unknown agent does-not-exist"
    );
    fs::remove_dir_all(root).unwrap();
}
