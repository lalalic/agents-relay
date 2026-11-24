// Direct Node src/agent-script-discovery.ts port. Reuse the native layered Model
// Agent resolver; only source-owned .shortcut scripts may be returned.
// Never execute scripts while discovering them.
use crate::agent_content_resolver::{agent_source_layers, resolve_agent_markdown};
use crate::agent_graph::parse_agent_graph;
use serde_json::{json, Value};
use std::{fs, path::Path};

fn global_root(explicit: Option<&str>) -> String {
    if let Some(root) = explicit {
        return root.to_string();
    }
    if let Ok(root) = std::env::var("AGENTS_HOME") {
        if !root.is_empty() {
            return root;
        }
    }
    std::env::var("HOME")
        .map(|home| format!("{home}/.agents"))
        .unwrap_or("/.agents".into())
}
use crate::runtime_resources::bundled_agents_root;
pub fn discover_script_agent(
    agent: &str,
    project_path: &str,
    workspace_root: Option<&str>,
    global_root_option: Option<&str>,
) -> Result<Option<String>, String> {
    let global = global_root(global_root_option);
    let layers = agent_source_layers(
        project_path,
        &json!({
"workspaceRoot":workspace_root,"globalRoot":global
        }),
    );
    let resolved = match resolve_agent_markdown(
        agent,
        &bundled_agents_root()?,
        project_path,
        Some(&layers),
    ) {
        Ok(value) => value,
        Err(error) if error == format!("Unknown agent {agent}") => return Ok(None),
        Err(error) => return Err(error),
    };
    let sources = resolved["sources"]
        .as_array()
        .ok_or("missing resolved agent sources")?;
    for source in sources.iter().rev().filter_map(Value::as_str) {
        let source = Path::new(source);
        let directory = source.parent().ok_or("Agent source has no directory")?;
        let name = source
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("invalid Agent filename")?;
        let name = name
            .strip_suffix(".agent.md")
            .or_else(|| name.strip_suffix(".md"))
            .unwrap_or(name);
        let shortcut = directory.join(".shortcut");
        let shortcut_root = match fs::canonicalize(&shortcut) {
            Ok(root) => root,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.to_string()),
        };
        if shortcut_root != shortcut {
            return Err(format!(
                "Agent Script directory symlink escapes Agent source: {}",
                shortcut.display()
            ));
        }
        let candidate = shortcut.join(format!("{name}.agent.mjs"));
        let actual = match fs::canonicalize(&candidate) {
            Ok(root) => root,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.to_string()),
        };
        if actual.parent() != Some(shortcut_root.as_path()) {
            return Err(format!(
                "Agent Script symlink escapes source directory: {}",
                candidate.display()
            ));
        }
        if !fs::metadata(&actual).map_err(|e| e.to_string())?.is_file() {
            return Err(format!(
                "Agent Script is not a regular file: {}",
                candidate.display()
            ));
        }
        return Ok(Some(actual.to_string_lossy().into_owned()));
    }
    Ok(None)
}
pub fn missing_script_agents(
    graph: &str,
    project_path: &str,
    workspace_root: Option<&str>,
    global_root: Option<&str>,
) -> Result<Vec<String>, String> {
    let graph = parse_agent_graph(graph)?;
    let mut missing = Vec::new();
    for (id, agent) in graph.nodes {
        if discover_script_agent(
            &agent,
            project_path,
                workspace_root,
            global_root,
        )?
        .is_none()
        {
            missing.push(id);
        }
    }
    Ok(missing)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn tmp_dir() -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "rust2-script-agent-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
    }
    #[test]
    fn layered_discovery_missing_and_path_escape() {
        let root = tmp_dir();
        let agents = root.join("agents");
        fs::create_dir_all(agents.join(".shortcut")).unwrap();
        fs::write(
            agents.join("builder.agent.md"),
            "---\nname: builder\n---\n# Builder",
        )
        .unwrap();
        let script = agents.join(".shortcut/builder.agent.mjs");
        fs::write(&script, "export default () => {}").unwrap();
        let project = root.to_string_lossy();
        assert_eq!(
            discover_script_agent("builder", &project, None, Some("/nonexistent")).unwrap(),
            Some(
                fs::canonicalize(&script)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            )
        );
        assert_eq!(
            discover_script_agent("unknown", &project, None, Some("/nonexistent")).unwrap(),
            None
        );
        assert_eq!(
            missing_script_agents(
                "flowchart TD\nBuild[agent:builder]\nTest[agent:unknown]",
                &project,
                None,
                Some("/nonexistent")
            )
            .unwrap(),
            vec!["Test"]
        );
        fs::remove_file(&script).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(agents.join("builder.agent.md"), &script).unwrap();
        assert!(
            discover_script_agent("builder", &project, None, Some("/nonexistent"))
                .unwrap_err()
                .contains("symlink escapes")
        );
        fs::remove_dir_all(root).unwrap();
    }
}
