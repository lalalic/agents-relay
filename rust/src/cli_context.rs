// Direct CLI port of Node src/cli-context.ts, with the execution-context
// resolver's readonly filesystem mechanics. Agent inheritance delegates to
// the existing native src/agent-content-resolver.ts port.
// No durable Job/task state or Harness-specific provider is introduced.
use crate::agent_content_resolver::{agent_source_layers, resolve_agent_markdown};
use crate::cli_core_support::arg;
use serde_json::{json, Map, Value};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::{Path, PathBuf},
    process::Command,
};
fn absolute(path: &str) -> PathBuf {
    let p = Path::new(path);
    let joined = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(p)
    };
    let mut cleaned = PathBuf::new();
    for c in joined.components() {
        use std::path::Component::*;
        match c {
            ParentDir => {
                cleaned.pop();
            }
            CurDir => {}
            other => cleaned.push(other.as_os_str()),
        }
    }
    cleaned
}
fn as_str(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
fn env_or(option: Option<&str>, environment: &str, default: String) -> String {
    option
        .map(str::to_string)
        .or_else(|| std::env::var(environment).ok())
        .unwrap_or(default)
}
fn home_agents() -> String {
    std::env::var("HOME")
        .map(|s| format!("{s}/.agents"))
        .unwrap_or("/.agents".into())
}
fn workspace(explicit: Option<&str>) -> Result<String, String> {
    let configured = explicit
        .map(str::to_string)
        .or_else(|| std::env::var("AGENTS_RELAY_WORKSPACE_ROOT").ok());
    let Some(raw) = configured else {
        return Ok(std::env::var("HOME")
            .map(|s| format!("{s}/Workspace"))
            .unwrap_or("/Workspace".into()));
    };
    let path = absolute(&raw);
    let valid = fs::metadata(&path).is_ok_and(|m| m.is_dir());
    if !valid {
        return Err(format!(
            "Configured Workspace Root is not an accessible directory: {}",
            path.display()
        ));
    }
    Ok(as_str(&fs::canonicalize(&path).map_err(|e| e.to_string())?))
}
fn frontmatter(contents: &str) -> BTreeMap<String, String> {
    let mut fields = BTreeMap::new();
    let Some(after) = contents.strip_prefix("---\n") else {
        return fields;
    };
    let Some(end) = after.find("\n---") else {
        return fields;
    };
    for line in after[..end].lines() {
        let Some((name, raw)) = line.split_once(':') else {
            continue;
        };
        if name.is_empty()
            || !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            continue;
        }
        let trimmed = raw.trim();
        let cleaned = trimmed
            .trim_start_matches(['\'', '"'])
            .trim_end_matches(['\'', '"']);
        fields.insert(name.to_string(), cleaned.to_string());
    }
    fields
}
fn list(raw: Option<&str>) -> Vec<String> {
    let value = raw.unwrap_or("").trim();
    if value.is_empty() {
        return vec![];
    }
    let text = if value.starts_with('[') && value.ends_with(']') {
        &value[1..value.len() - 1]
    } else {
        value
    };
    text.split([',', '|'])
        .map(|s| {
            s.trim()
                .trim_start_matches(['\'', '"'])
                .trim_end_matches(['\'', '"'])
                .to_string()
        })
        .filter(|s| !s.is_empty())
        .collect()
}
fn fields(path: &Path) -> Result<BTreeMap<String, String>, String> {
    Ok(frontmatter(
        &fs::read_to_string(path).map_err(|e| e.to_string())?,
    ))
}
fn meta<'a>(fields: &'a BTreeMap<String, String>, key: &str) -> Option<&'a str> {
    fields
        .get(key)
        .filter(|v| !v.is_empty())
        .map(String::as_str)
}
fn add_optional(target: &mut Map<String, Value>, name: &str, value: Option<&str>) {
    if let Some(value) = value {
        target.insert(name.into(), json!(value));
    }
}
fn discover_skills(root: &Path, source: &str) -> Result<Vec<Value>, String> {
    let mut skills = Vec::new();
    let directory = root.join("skills");
    let Ok(entries) = fs::read_dir(directory) else {
        return Ok(skills);
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if !kind.is_dir() {
            continue;
        }
        let skill = entry.path().join("SKILL.md");
        if !skill.exists() {
            continue;
        }
        let metadata = fields(&skill)?;
        let mut record = json!({"name":meta(&metadata,"name").unwrap_or(&entry.file_name().to_string_lossy()),
            "path":as_str(&fs::canonicalize(skill).map_err(|e|e.to_string())?),"source":source});
        if let Some(description) = meta(&metadata, "description") {
            record["description"] = json!(description);
        }
        skills.push(record);
    }
    skills.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    Ok(skills)
}
fn agent_files(root: &Path, source: &str, skills: &[Value]) -> Result<Vec<Value>, String> {
    let mut files = Vec::new();
    let skill_dirs = skills
        .iter()
        .filter(|s| s["source"] == source)
        .filter_map(|s| s["path"].as_str())
        .filter_map(|p| Path::new(p).parent())
        .map(Path::to_path_buf)
        .collect::<Vec<_>>();
    for dir in skill_dirs
        .iter()
        .map(|dir| dir.join("agents"))
        .chain(std::iter::once(root.join("agents")))
    {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if !entry.file_type().is_ok_and(|f| f.is_file())
                || !entry.file_name().to_string_lossy().ends_with(".md")
            {
                continue;
            }
            files.push(entry.path());
        }
    }
    let mut found = Vec::new();
    for path in files {
        let metadata = fields(&path)?;
        let filename = path.file_name().unwrap_or_default().to_string_lossy();
        let base = filename
            .strip_suffix(".agent.md")
            .or_else(|| filename.strip_suffix(".md"))
            .unwrap_or(&filename);
        found.push(json!({"name":meta(&metadata,"name").unwrap_or(base),"path":as_str(&path),"source":source}));
    }
    Ok(found)
}
fn named_filter(list: Vec<Value>, names: &[String], kind: &str) -> Result<Vec<Value>, String> {
    if names.is_empty() {
        return Ok(list);
    }
    names
        .iter()
        .map(|name| {
            list.iter()
                .find(|item| item["name"] == name.as_str())
                .cloned()
                .ok_or_else(|| {
                    format!(
                        "Explicit {kind} {name} is not visible in the resolved execution context"
                    )
                })
        })
        .collect()
}
fn instructions(
    project: &Path,
    workspace: &Path,
    global: &Path,
) -> Vec<Value> {
    let mut found = Vec::<Value>::new();
    let mut seen = HashSet::new();
    let mut add = |path: PathBuf, source: &str| {
        if let Ok(actual) = fs::canonicalize(path) {
            let key = as_str(&actual);
            if seen.insert(key.clone()) {
                found.push(json!({"path":key,"source":source}));
            }
        }
    };
    add(global.join("AGENTS.md"), "global");
    if let Ok(relative) = project.strip_prefix(workspace) {
        let mut cursor = workspace.to_path_buf();
        add(cursor.join("AGENTS.md"),if cursor==project{"project"}else{"parent"});
        for part in relative.components() {
            cursor.push(part.as_os_str());
            add(cursor.join("AGENTS.md"),if cursor==project{"project"}else{"parent"});
        }
    } else {
        add(project.join("AGENTS.md"), "project");
    }
    add(project.join("README.md"), "project");
    found
}
pub fn resolve_context(
    project_path: &str,
    role: &str,
    workspace_root: Option<&str>,
    global_root: Option<&str>,
    explicit_skills: &[String],
    explicit_agents: &[String],
) -> Result<Value, String> {
    if project_path.is_empty() {
        return Err("projectPath is required".into());
    }
    let resolved = absolute(project_path);
    let project = fs::canonicalize(&resolved)
        .map_err(|_| format!("Project path not found: {project_path}"))?;
    if !fs::metadata(&project).is_ok_and(|metadata| metadata.is_dir()) {
        return Err(format!("Project path is not a directory: {project_path}"));
    }
    let project_string = as_str(&project);
    let git = Command::new("git")
        .args(["-C", &project_string, "rev-parse", "--show-toplevel"])
        .output();
    let git_root = git
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .and_then(|p| fs::canonicalize(p.trim()).ok())
        .unwrap_or_else(|| project.clone());
    let workspace = workspace(workspace_root)?;
    let global = absolute(&env_or(global_root, "AGENTS_HOME", home_agents()));
    let global = fs::canonicalize(&global).unwrap_or(global);
    let workspace_path = PathBuf::from(workspace.clone());
    let layer_roots = agent_source_layers(
        &project_string,
        &json!({
            "workspaceRoot":workspace,"globalRoot":as_str(&global)
        }),
    );
    let layers = layer_roots
        .as_array()
        .ok_or("invalid agent source layer data")?;
    let mut skill_map = BTreeMap::<String, Value>::new();
    let mut skills_by_layer = BTreeMap::<String, Vec<Value>>::new();
    let mut names = HashSet::<String>::new();
    let builtin = crate::runtime_resources::package_root()?.join("skills/agents-relay/agents");
    for agent in agent_files(builtin.parent().expect("skills root"), "builtin", &[])? {
        if let Some(name) = agent["name"].as_str() {
            names.insert(name.to_string());
        }
    }
    for layer in layers {
        let Some(root) = layer["root"].as_str() else {
            continue;
        };
        let source = layer["source"].as_str().unwrap_or("project");
        let skills = discover_skills(Path::new(root), source)?;
        for skill in &skills {
            if let Some(name) = skill["name"].as_str() {
                skill_map.insert(name.into(), skill.clone());
            }
        }
        for agent in agent_files(Path::new(root), source, &skills)? {
            if let Some(name) = agent["name"].as_str() {
                names.insert(name.into());
            }
        }
        skills_by_layer.insert(root.into(), skills);
    }
    let skills = named_filter(skill_map.into_values().collect(), explicit_skills, "skill")?;
    let mut agents = Vec::<Value>::new();
    for name in names {
        let resolved = resolve_agent_markdown(
            &name,
            &as_str(&builtin),
            &project_string,
            Some(&layer_roots),
        )?;
        let Some(sources) = resolved["sources"].as_array() else {
            continue;
        };
        let path = sources.last().and_then(Value::as_str).unwrap_or("");
        if path.is_empty() {
            continue;
        }
        let source = layers
            .iter()
            .filter_map(|layer| {
                let root = layer["root"].as_str()?;
                if Path::new(path).starts_with(root) {
                    Some((root.len(), layer["source"].as_str().unwrap_or("project")))
                } else {
                    None
                }
            })
            .max_by_key(|(len, _)| *len)
            .map(|(_, source)| source)
            .unwrap_or("builtin");
        let fields = &resolved["metadata"];
        let strings = |keys: &[&str]| {
            keys.iter()
                .find_map(|k| fields[*k].as_str())
                .filter(|s| !s.is_empty())
        };
        let mut value = json!({"name":name,"path":path,"source":source,
            "capabilities":list(strings(&["capabilities"])),"trustDomains":list(strings(&["trustDomains","trust_domains","trust"])),
            "delegation":list(strings(&["delegation"])),"restrictions":list(strings(&["restrictions","boundaries"]))});
        let m = value.as_object_mut().unwrap();
        add_optional(m, "description", strings(&["description"]));
        add_optional(m, "runtime", strings(&["runtime", "runtimes"]));
        let skills = list(strings(&["skills"]));
        m.insert("suggestedSkills".into(), json!(skills));
        add_optional(m, "preferredModel", strings(&["model"]));
        add_optional(m, "preferredReasoning", strings(&["reasoning"]));
        agents.push(value);
    }
    agents.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    let agents = named_filter(agents, explicit_agents, "agent")?;
    Ok(json!({
        "project":{"name":project.file_name().unwrap_or_default().to_string_lossy(),
          "path":project_string,"gitRoot":as_str(&git_root),"workspaceRoot":workspace,
          "globalRoot":as_str(&global)},
        "role":role,
        "instructions":instructions(&project,&workspace_path,&global),
        "skills":skills,"agents":agents,"runtimes":[],
        "delegation":{"mode":"relay-child-task","parentTaskIdRequired":role=="nested-worker"}
    }))
}
pub fn run_context_command(action: &str, args: &[String]) -> Result<Value, String> {
    if action != "resolve" {
        return Err(crate::cli_help::usage.into());
    }
    let project = arg(args, "--project-path", "");
    if project.is_empty() {
        return Err("context resolve requires --project-path".into());
    }
    let role = arg(args, "--role", "orchestrator");
    if !matches!(
        role,
        "orchestrator" | "planner" | "reviewer" | "worker" | "nested-worker"
    ) {
        return Err(
            "--role must be orchestrator, planner, reviewer, worker, or nested-worker".into(),
        );
    }
    let value = |flag| {
        let v = arg(args, flag, "");
        if v.is_empty() {
            None
        } else {
            Some(v)
        }
    };
    let split = |flag| {
        arg(args, flag, "")
            .split(',')
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>()
    };
    resolve_context(
        project,
        role,
        value("--workspace-root"),
        value("--global-root"),
        &split("--skills"),
        &split("--agents"),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validation_matches_cli() {
        assert_eq!(
            run_context_command("resolve", &[]).unwrap_err(),
            "context resolve requires --project-path"
        );
        assert_eq!(
            run_context_command("bad", &[]).unwrap_err(),
            crate::cli_help::usage
        );
        assert_eq!(
            run_context_command("resolve", &["--project-path".into(), "/not-real".into()])
                .unwrap_err(),
            "Project path not found: /not-real"
        );
        assert_eq!(list(Some("['a' | b]")), vec!["a", "b"]);
    }
}
