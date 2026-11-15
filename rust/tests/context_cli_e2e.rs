use rusqlite::Connection;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tempfile::tempdir;

fn add_layer(root: &Path, instruction: &str, skill_body: &str, agent_body: &str) {
    fs::create_dir_all(root.join("skills/demo")).unwrap();
    fs::create_dir_all(root.join("agents")).unwrap();
    fs::write(root.join("AGENTS.md"), instruction).unwrap();
    fs::write(root.join("skills/demo/SKILL.md"), skill_body).unwrap();
    fs::write(root.join("agents/implementer.agent.md"), agent_body).unwrap();
}

fn context_args(project: &Path, workspace: &Path, shared: &Path, global: &Path) -> Vec<String> {
    [
        "context",
        "resolve",
        "--project-path",
        project.to_str().unwrap(),
        "--role",
        "worker",
        "--workspace-root",
        workspace.to_str().unwrap(),
        "--shared-root",
        shared.to_str().unwrap(),
        "--global-root",
        global.to_str().unwrap(),
        "--skills",
        "demo",
        "--agents",
        "implementer",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

#[test]
fn context_resolve_precedence_security_and_node_parity() {
    let temp = tempdir().unwrap();
    let home = temp.path().join("home");
    let workspace = temp.path().join("workspace");
    let project = workspace.join("org/repo");
    let shared = temp.path().join("shared");
    let global = temp.path().join("global");
    for root in [&workspace, &project, &shared, &global] {
        fs::create_dir_all(root).unwrap();
    }
    add_layer(
        &workspace,
        "parent",
        "---\nname: demo\n---\nparent skill",
        "---\nname: implementer\nskills: [demo]\n---\nparent agent",
    );
    add_layer(
        &shared,
        "shared",
        "---\nname: demo\n---\nshared skill",
        "---\nname: implementer\nskills: [demo]\n---\nshared agent",
    );
    add_layer(
        &global,
        "global",
        "---\nname: demo\n---\nglobal skill",
        "---\nname: implementer\nskills: [demo]\n---\nglobal agent",
    );
    add_layer(
        &project,
        "project",
        "---\nname: demo\ndescription: project skill\n---\nproject skill",
        "---\nname: implementer\nskills: [demo]\ndescription: project agent\n---\nproject agent",
    );
    let args = context_args(&project, &workspace, &shared, &global);
    let out = Command::new(env!("CARGO_BIN_EXE_relay-native-job"))
        .args(&args)
        .env("HOME", &home)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let rust: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(
        rust["skills"][0]["path"],
        project
            .join("skills/demo/SKILL.md")
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .as_ref()
    );
    assert_eq!(
        rust["agents"][0]["path"],
        project
            .join("agents/implementer.agent.md")
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .as_ref()
    );
    assert_eq!(rust["agents"][0]["description"], "project agent");
    let sources = rust["instructions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["source"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(sources, vec!["global", "project", "project"]);

    let node_cli = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("dist/cli.js");
    if node_cli.is_file() {
        let node = Command::new("node")
            .arg(node_cli)
            .args(&args)
            .env("HOME", &home)
            .env_remove("AGENTS_RELAY_SHARED_ROOT")
            .env_remove("AGENTS_RELAY_WORKSPACE_ROOT")
            .env_remove("AGENTS_HOME")
            .output()
            .unwrap();
        assert!(
            node.status.success(),
            "{}",
            String::from_utf8_lossy(&node.stderr)
        );
        let node: Value = serde_json::from_slice(&node.stdout).unwrap();
        for key in ["project", "role", "instructions", "skills", "agents"] {
            assert_eq!(rust[key], node[key], "Node/Rust mismatch at {key}");
        }
    }

    let escape = temp.path().join("escape");
    fs::create_dir_all(&escape).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(
        escape.join("SKILL.md"),
        project.join("skills/demo/linked.md"),
    )
    .unwrap();
    #[cfg(unix)]
    {
        fs::write(escape.join("SKILL.md"), "secret").unwrap();
        fs::remove_file(project.join("skills/demo/SKILL.md")).unwrap();
        std::os::unix::fs::symlink(
            escape.join("SKILL.md"),
            project.join("skills/demo/SKILL.md"),
        )
        .unwrap();
        let leaked = Command::new(env!("CARGO_BIN_EXE_relay-native-job"))
            .args(&args)
            .env("HOME", &home)
            .output()
            .unwrap();
        assert!(
            leaked.status.success(),
            "{}",
            String::from_utf8_lossy(&leaked.stderr)
        );
        let resolved: Value = serde_json::from_slice(&leaked.stdout).unwrap();
        assert_ne!(
            resolved["skills"][0]["path"],
            escape.join("SKILL.md").to_string_lossy().as_ref(),
            "symlink escape must not become visible"
        );
    }
    let traversal = Command::new(env!("CARGO_BIN_EXE_relay-native-job"))
        .args([
            "context",
            "resolve",
            "--project-path",
            project.to_str().unwrap(),
            "--workspace-root",
            workspace.join("..").to_str().unwrap(),
        ])
        .env("HOME", &home)
        .output()
        .unwrap();
    assert!(
        !traversal.status.success(),
        "parent traversal should be rejected"
    );
}

#[test]
fn prompt_requires_a_recorded_task_and_uses_its_execution_binding() {
    let temp = tempdir().unwrap();
    let store = tempfile::Builder::new()
        .prefix("relay-rust-authority-")
        .tempdir_in(std::env::temp_dir())
        .unwrap();
    fs::write(
        store.path().join(".relay-rust-authority-isolated-test"),
        "test only",
    )
    .unwrap();
    let db = store.path().join("relay.sqlite");
    let project = temp.path().join("project");
    fs::create_dir_all(project.join("agents")).unwrap();
    fs::write(project.join("AGENTS.md"), "project policy").unwrap();
    fs::write(
        project.join("agents/implementation.agent.md"),
        "---\nname: implementation\nskills: [ponytail]\n---\nUse small focused changes.",
    )
    .unwrap();
    let job = serde_json::json!({
        "id":"job-context-e2e", "repository":"org/repo", "title":"Implement feature",
        "projectPath":project, "tasks":[{"id":"task-recorded","agentName":"implementation","adapter":"codex","title":"Do the assigned work","executionId":"exec-actual","state":"QUEUED","input":"durable task input","output":{"kind":"file","path":"result.txt"}}]
    });
    let conn = Connection::open(&db).unwrap();
    conn.execute_batch("CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL);").unwrap();
    conn.execute(
        "INSERT INTO job_snapshot VALUES (?1,?2,?3)",
        ("job-context-e2e", job.to_string(), "2026-11-15T00:00:00Z"),
    )
    .unwrap();
    drop(conn);
    let output = Command::new(env!("CARGO_BIN_EXE_relay-native-job"))
        .args([
            "prompt",
            "--db",
            db.to_str().unwrap(),
            "--id",
            "job-context-e2e",
            "--task-id",
            "task-recorded",
            "--adapter",
            "codex",
        ])
        .env("HOME", temp.path().join("home"))
        .env("RELAY_RUST_EXPERIMENTAL_TEST_ONLY", "isolated-test")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let prompt = String::from_utf8(output.stdout).unwrap();
    assert!(prompt.contains("# Role"));
    assert!(prompt.contains("Use small focused changes."));
    assert!(prompt.contains("job/job-context-e2e/task/task-recorded/execution/exec-actual"));
    assert!(prompt.contains("task-job-contract.md"));
    let missing = Command::new(env!("CARGO_BIN_EXE_relay-native-job"))
        .args([
            "prompt",
            "--db",
            db.to_str().unwrap(),
            "--id",
            "job-context-e2e",
            "--task-id",
            "not-recorded",
        ])
        .env("HOME", temp.path().join("home"))
        .env("RELAY_RUST_EXPERIMENTAL_TEST_ONLY", "isolated-test")
        .output()
        .unwrap();
    assert!(
        !missing.status.success(),
        "unknown Tasks must not get fabricated prompts"
    );
}
