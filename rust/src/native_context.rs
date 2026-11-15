//! Execution-bound project context discovery for native Workers.
//!
//! This module resolves references only. It never selects a Worker/provider or
//! reads credentials. The durable Task keeps the immutable execution decision;
//! the private request carries the selected Agent and relevant context paths.
use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextReference {
    pub path: PathBuf,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedExecutionContext {
    pub project_path: PathBuf,
    pub git_root: PathBuf,
    pub workspace_root: PathBuf,
    pub shared_root: Option<PathBuf>,
    pub global_root: PathBuf,
    pub role: String,
    pub instructions: Vec<ContextReference>,
    pub agent: Option<ContextReference>,
    pub skills: Vec<ContextReference>,
}

fn canonical_dir(path: &Path, label: &str) -> Result<PathBuf, String> {
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("{label} does not exist: {error}"))?;
    if !canonical.is_dir() {
        return Err(format!("{label} is not a directory"));
    }
    Ok(canonical)
}

fn optional_configured_root(key: &str, fallback: PathBuf) -> Result<PathBuf, String> {
    match std::env::var_os(key) {
        Some(value) if !value.is_empty() => canonical_dir(Path::new(&value), key),
        _ => Ok(fallback.canonicalize().unwrap_or(fallback)),
    }
}

fn within(path: &Path, root: &Path) -> bool {
    path == root || path.starts_with(root)
}

fn layer_roots(
    project: &Path,
    workspace: &Path,
    shared: Option<&Path>,
    global: &Path,
) -> Vec<(PathBuf, &'static str)> {
    let mut layers = Vec::new();
    layers.push((global.to_path_buf(), "global"));
    if let Some(shared) = shared {
        layers.push((shared.to_path_buf(), "shared"));
    }
    if within(project, workspace) {
        let relative = project.strip_prefix(workspace).unwrap_or(Path::new(""));
        let components: Vec<_> = relative.components().collect();
        let mut cursor = workspace.to_path_buf();
        layers.push((cursor.clone(), "parent"));
        for component in components.iter().take(components.len().saturating_sub(1)) {
            cursor.push(component);
            layers.push((cursor.clone(), "parent"));
        }
    }
    layers.push((project.to_path_buf(), "project"));
    let mut unique = Vec::new();
    for layer in layers {
        if !unique.iter().any(|(root, _)| root == &layer.0) {
            unique.push(layer);
        }
    }
    unique
}

fn name_from_frontmatter(path: &Path, key: &str) -> Option<String> {
    let contents = fs::read_to_string(path).ok()?;
    let mut lines = contents.lines();
    if lines.next()? != "---" {
        return None;
    }
    for line in lines {
        if line == "---" {
            break;
        }
        let Some((field, value)) = line.split_once(':') else {
            continue;
        };
        if field.trim() == key {
            let clean = value.trim().trim_matches(['\'', '"']);
            if !clean.is_empty() {
                return Some(clean.to_owned());
            }
        }
    }
    None
}

fn list_from_frontmatter(path: &Path, key: &str) -> Vec<String> {
    let Ok(contents) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut in_frontmatter = false;
    for line in contents.lines() {
        if line == "---" {
            if in_frontmatter {
                break;
            }
            in_frontmatter = true;
            continue;
        }
        if !in_frontmatter {
            continue;
        }
        if let Some((field, value)) = line.split_once(':') {
            if field.trim() == key {
                return value
                    .trim()
                    .trim_start_matches('[')
                    .trim_end_matches(']')
                    .split([',', '|'])
                    .map(|item| item.trim().trim_matches(['\'', '"']).to_owned())
                    .filter(|item| !item.is_empty())
                    .collect();
            }
        }
    }
    Vec::new()
}

fn selected_agent(layers: &[(PathBuf, &'static str)], name: &str) -> Option<ContextReference> {
    // Later source layers have higher precedence: project, nearest parent,
    // shared, global. This is the same ordering used for visible Agent content.
    let mut candidates = Vec::new();
    for (root, source) in layers {
        let direct = root.join("agents");
        if let Ok(entries) = fs::read_dir(direct) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_file() || path.extension().is_none_or(|ext| ext != "md") {
                    continue;
                }
                let stem = path.file_stem().and_then(|v| v.to_str()).unwrap_or("");
                if stem == name
                    || stem.strip_suffix(".agent") == Some(name)
                    || name_from_frontmatter(&path, "name").as_deref() == Some(name)
                {
                    candidates.push(ContextReference {
                        path,
                        source: (*source).into(),
                    });
                }
            }
        }
        let skills = root.join("skills");
        if let Ok(entries) = fs::read_dir(skills) {
            for entry in entries.flatten() {
                let path = entry.path().join("agents");
                if let Ok(agent_entries) = fs::read_dir(path) {
                    for agent_entry in agent_entries.flatten() {
                        let path = agent_entry.path();
                        let stem = path.file_stem().and_then(|v| v.to_str()).unwrap_or("");
                        if path.is_file()
                            && path.extension().is_some_and(|ext| ext == "md")
                            && (stem == name
                                || stem.strip_suffix(".agent") == Some(name)
                                || name_from_frontmatter(&path, "name").as_deref() == Some(name))
                        {
                            candidates.push(ContextReference {
                                path,
                                source: (*source).into(),
                            });
                        }
                    }
                }
            }
        }
    }
    candidates.pop()
}

fn visible_skills(layers: &[(PathBuf, &'static str)]) -> BTreeMap<String, ContextReference> {
    let mut skills = BTreeMap::new();
    for (root, source) in layers {
        let Ok(entries) = fs::read_dir(root.join("skills")) else {
            continue;
        };
        for entry in entries.flatten() {
            let fallback = entry.file_name().to_string_lossy().into_owned();
            let path = entry.path().join("SKILL.md");
            if !path.is_file() {
                continue;
            }
            let name = name_from_frontmatter(&path, "name").unwrap_or(fallback);
            skills.insert(
                name,
                ContextReference {
                    path,
                    source: (*source).into(),
                },
            );
        }
    }
    skills
}

pub fn resolve(
    project_path: &Path,
    git_root: &Path,
    role: &str,
    agent_name: &str,
) -> Result<ResolvedExecutionContext, String> {
    let project = canonical_dir(project_path, "Job projectRoot")?;
    let git_root = canonical_dir(git_root, "Job Git root")?;
    if !within(&project, &git_root) {
        return Err("Job projectPath escapes its canonical Git root".into());
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or("HOME is not configured")?;
    let workspace =
        optional_configured_root("AGENTS_RELAY_WORKSPACE_ROOT", home.join("Workspace"))?;
    let shared = match std::env::var_os("AGENTS_RELAY_SHARED_ROOT") {
        Some(value) if !value.is_empty() => Some(canonical_dir(
            Path::new(&value),
            "AGENTS_RELAY_SHARED_ROOT",
        )?),
        _ => None,
    };
    let global = optional_configured_root("AGENTS_HOME", home.join(".agents"))?;
    let layers = layer_roots(&project, &workspace, shared.as_deref(), &global);

    let mut instructions = Vec::new();
    for (root, source) in &layers {
        let path = root.join("AGENTS.md");
        if path.is_file() {
            let canonical = path.canonicalize().map_err(|e| e.to_string())?;
            if !instructions
                .iter()
                .any(|item: &ContextReference| item.path == canonical)
            {
                instructions.push(ContextReference {
                    path: canonical,
                    source: (*source).into(),
                });
            }
        }
    }
    let readme = project.join("README.md");
    if readme.is_file() {
        instructions.push(ContextReference {
            path: readme.canonicalize().map_err(|e| e.to_string())?,
            source: "project".into(),
        });
    }

    let agent = selected_agent(&layers, agent_name);
    let visible = visible_skills(&layers);
    let suggested = agent
        .as_ref()
        .map(|reference| list_from_frontmatter(&reference.path, "skills"))
        .unwrap_or_default();
    let skills = suggested
        .iter()
        .filter_map(|name| visible.get(name).cloned())
        .collect();

    Ok(ResolvedExecutionContext {
        project_path: project,
        git_root,
        workspace_root: workspace,
        shared_root: shared,
        global_root: global,
        role: role.to_owned(),
        instructions,
        agent,
        skills,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn execution_context_uses_project_over_shared_over_global_and_only_selected_skills() {
        let temp = tempfile::tempdir().unwrap();
        let global = temp.path().join("global");
        let shared = temp.path().join("shared");
        let workspace = temp.path().join("workspace");
        let project = workspace.join("repo");
        for root in [&global, &shared, &workspace, &project] {
            fs::create_dir_all(root.join("agents")).unwrap();
            fs::create_dir_all(root.join("skills")).unwrap();
        }
        fs::write(global.join("AGENTS.md"), "global").unwrap();
        fs::write(workspace.join("AGENTS.md"), "parent").unwrap();
        fs::write(project.join("AGENTS.md"), "project").unwrap();
        fs::write(
            shared.join("agents/implementer.agent.md"),
            "---\nname: implementer\nskills: [ shared-skill ]\n---\nshared",
        )
        .unwrap();
        fs::write(
            project.join("agents/implementer.agent.md"),
            "---\n# project override\nname: implementer\nskills: [ project-skill ]\n---\nproject",
        )
        .unwrap();
        fs::create_dir_all(shared.join("skills/project-skill")).unwrap();
        fs::create_dir_all(shared.join("skills/shared-skill")).unwrap();
        fs::create_dir_all(project.join("skills/project-skill")).unwrap();
        fs::write(
            shared.join("skills/project-skill/SKILL.md"),
            "---\nname: project-skill\n---\nshared skill",
        )
        .unwrap();
        fs::write(
            project.join("skills/project-skill/SKILL.md"),
            "---\nname: project-skill\n---\nproject skill",
        )
        .unwrap();
        fs::write(
            shared.join("skills/shared-skill/SKILL.md"),
            "---\nname: shared-skill\n---\nshared skill",
        )
        .unwrap();

        let project = project.canonicalize().unwrap();
        let workspace = workspace.canonicalize().unwrap();
        let shared = shared.canonicalize().unwrap();
        let global = global.canonicalize().unwrap();
        let layers = layer_roots(&project, &workspace, Some(&shared), &global);
        let resolved_agent = selected_agent(&layers, "implementer").unwrap();
        assert_eq!(resolved_agent.source, "project");
        assert_eq!(
            list_from_frontmatter(&resolved_agent.path, "skills"),
            ["project-skill"]
        );
        let skills = visible_skills(&layers);
        assert_eq!(skills["project-skill"].source, "project");
        assert_eq!(skills["shared-skill"].source, "shared");
        assert_eq!(
            layers.iter().map(|(_, source)| *source).collect::<Vec<_>>(),
            ["global", "shared", "parent", "project"]
        );
    }

    #[test]
    fn context_paths_do_not_follow_parent_outside_configured_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        let project = temp.path().join("elsewhere");
        let global = temp.path().join("global");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&global).unwrap();
        let layers = layer_roots(&project, &workspace, None, &global);
        assert_eq!(
            layers
                .iter()
                .map(|(path, _)| path.as_path())
                .collect::<Vec<_>>(),
            [global.as_path(), project.as_path()]
        );
    }
}
