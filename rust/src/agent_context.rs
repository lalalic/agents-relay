//! Role-selected, on-demand references. Discovery does not imply injection.
//! The Agent's merged metadata is authoritative; no DAG/worker-role heuristic.
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

/// Inherited prompt-presentation preference; never disables execution Contracts.
pub fn execution_bootstrap_enabled(metadata: &Value) -> Result<bool, String> {
    match metadata.get("execution_bootstrap") {
        None => Ok(true),
        Some(Value::Bool(value)) => Ok(*value),
        Some(Value::String(value)) if value == "true" => Ok(true),
        Some(Value::String(value)) if value == "false" => Ok(false),
        _ => Err("Agent execution_bootstrap must be true or false".into()),
    }
}

fn list(metadata: &Value, key: &str) -> Result<Vec<String>, String> {
    let Some(raw) = metadata.get(key).filter(|v| !v.is_null()) else {
        return Ok(vec![]);
    };
    let raw = raw
        .as_str()
        .ok_or_else(|| format!("Agent {key} must be an inline list"))?
        .trim();
    if raw.is_empty() {
        // A frontmatter field with no value means no dependency.
        // In the merged Agent it also clears a parent's declaration.
        return Ok(vec![]);
    }
    if !raw.starts_with('[') || !raw.ends_with(']') {
        return Err(format!("Agent {key} must use [item, item] syntax"));
    }
    let contents = &raw[1..raw.len() - 1];
    if contents.trim().is_empty() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for item in contents.split(',') {
        let item = item.trim().trim_matches(['\'', '"']).trim();
        if item.is_empty() || item.contains(['\n', '\r', '[', ']']) {
            return Err(format!("Invalid Agent {key} entry"));
        }
        out.push(item.to_owned());
    }
    Ok(out)
}
fn scoped_path(source: &str, package_root: &Path, project_root: &Path) -> Result<PathBuf, String> {
    let (scope, relative) = source
        .split_once(':')
        .ok_or("Agent reference must use project: or relay:")?;
    let root = match scope {
        "project" => project_root,
        "relay" => package_root,
        _ => return Err(format!("Unsupported Agent reference scope {scope}")),
    };
    let rel = Path::new(relative);
    if relative.is_empty()
        || rel.is_absolute()
        || rel
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err(format!("Unsafe Agent reference: {source}"));
    }
    let parent = root
        .canonicalize()
        .map_err(|e| format!("Invalid reference root {}: {e}", root.display()))?;
    let full = parent
        .join(rel)
        .canonicalize()
        .map_err(|e| format!("Missing required Agent reference {source}: {e}"))?;
    if !full.starts_with(&parent) || !full.is_file() {
        return Err(format!(
            "Agent reference outside authorized root or not a file: {source}"
        ));
    }
    Ok(full)
}
// The array declares candidate harness-native instruction filenames, not
// several files to load. The effective inherited Agent declaration is the
// only source of candidates; absence or [] means no project Context.
fn native_context_filename(harness: &str) -> Result<&'static str, String> {
    match harness {
        "codex" | "xchat" | "webchatgpt" => Ok("AGENTS.md"),
        "claude" => Ok("CLAUDE.md"),
        _ => Err(format!("Unsupported Context harness: {harness}")),
    }
}
// A Context is always resolved inside the current independent project root.
// No author-facing scope prefix or Relay-package lookup is supported.
fn candidate_reference(entry: &str) -> Result<(String, &'static str), String> {
    if entry.contains(':') {
        return Err(format!(
            "Context must be a plain project-relative path without a scope: {entry}"
        ));
    }
    let relative_path = Path::new(entry);
    if entry.is_empty()
        || relative_path.is_absolute()
        || relative_path
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err(format!("Unsafe project Context candidate: {entry}"));
    }
    let basename = relative_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let filename = if basename.eq_ignore_ascii_case("AGENTS.md") {
        "AGENTS.md"
    } else if basename.eq_ignore_ascii_case("CLAUDE.md") {
        "CLAUDE.md"
    } else {
        return Err(format!(
            "Context candidates must be AGENTS.md or CLAUDE.md: {entry}"
        ));
    };
    let normalized = relative_path.with_file_name(filename);
    Ok((normalized.to_string_lossy().into_owned(), filename))
}
fn project_context_path(relative: &str, project_root: &Path) -> Result<PathBuf, String> {
    let root = project_root.canonicalize().map_err(|e| {
        format!(
            "Invalid project Context root {}: {e}",
            project_root.display()
        )
    })?;
    let file = root
        .join(relative)
        .canonicalize()
        .map_err(|e| format!("Missing required project Context {relative}: {e}"))?;
    if !file.starts_with(&root) || !file.is_file() {
        return Err(format!(
            "Project Context escapes its Git root or is not a file: {relative}"
        ));
    }
    Ok(file)
}
/// Required Skills are *names*, not file references. The Harness owns
/// the Skill catalog and its path resolution; the Agent discovers and
/// reads matching SKILL.md on demand. Never infer a file path in Relay.
pub fn required_skill_names(metadata: &Value) -> Result<Vec<String>, String> {
    let names = list(metadata, "required_skills")?;
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for name in names {
        if name.len() > 128
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
            || name == "."
            || name == ".."
        {
            return Err(format!("Invalid required Skill name: {name}"));
        }
        if seen.insert(name.clone()) {
            result.push(name)
        }
    }
    Ok(result)
}
pub fn selected_references(
    metadata: &Value,
    context: &Value,
    package_root: &Path,
    harness: &str,
) -> Result<Value, String> {
    let candidates = list(metadata, "contexts")?;
    let contracts = list(metadata, "contracts")?;
    if candidates.is_empty() && contracts.is_empty() {
        // No declaration means no Context, even if project AGENTS.md exists.
        // No need for a project root or a catalog lookup.
        return Ok(json!([]));
    }
    let mut selected_context = None;
    let preferred = if candidates.is_empty() {
        None
    } else {
        Some(native_context_filename(harness)?)
    };
    for candidate in &candidates {
        let (normalized, filename) = candidate_reference(candidate)?;
        if Some(filename) == preferred && selected_context.is_none() {
            selected_context = Some(normalized);
        }
    }
    let git_root = context
        .pointer("/project/gitRoot")
        .and_then(Value::as_str)
        .filter(|root| Path::new(root).is_absolute());
    if selected_context.is_some() && git_root.is_none() {
        return Err(
            "Selected project Context requires a resolved canonical project Git root".into(),
        );
    }
    let project = git_root.or_else(|| context.pointer("/project/path").and_then(Value::as_str));
    let needs_project =
        selected_context.is_some() || contracts.iter().any(|c| c.starts_with("project:"));
    if needs_project && project.is_none() {
        return Err("Selected Agent references require a resolved project path".into());
    }
    let project = Path::new(project.unwrap_or(""));
    let mut refs = Vec::<Value>::new();
    let mut seen = HashSet::new();
    let mut add = |file: PathBuf, kind: &str| -> Result<(), String> {
        let file = file.canonicalize().map_err(|e| e.to_string())?;
        if !file.is_file() {
            return Err(format!(
                "Required Agent reference not a file: {}",
                file.display()
            ));
        }
        if seen.insert(file.clone()) {
            refs.push(json!({"kind":kind,"path":file.to_string_lossy()}))
        }
        Ok(())
    };
    if let Some(reference) = selected_context {
        let file = project_context_path(
            &reference,
            Path::new(git_root.expect("Context selection already requires canonical Git root")),
        )?;
        let expected = preferred.expect("selected Context implies supported Harness");
        if file.file_name().and_then(|n| n.to_str()) != Some(expected) {
            return Err(format!(
                "Selected native Context resolves to a non-{expected} file"
            ));
        }
        add(file, "context")?;
    }
    for entry in contracts {
        add(scoped_path(&entry, package_root, project)?, "contract")?;
    }
    Ok(json!(refs))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_and_validates_candidates() {
        assert_eq!(
            list(&json!({"contexts":"[AGENTS.md, CLAUDE.md]"}), "contexts")
                .unwrap()
                .len(),
            2
        );
        assert!(list(&json!({"contexts":"AGENTS.md"}), "contexts").is_err());
        assert!(candidate_reference("project:../AGENTS.md").is_err());
        assert!(candidate_reference("system:AGENTS.md").is_err());
        assert!(candidate_reference("project:AGENTS.md").is_err());
        assert_eq!(candidate_reference("claude.md").unwrap().1, "CLAUDE.md");
        assert_eq!(candidate_reference("agents.md").unwrap().1, "AGENTS.md");
    }
    #[test]
    fn harness_selects_at_most_one_and_missing_means_none() {
        let dir = std::env::temp_dir().join(format!("agent-context-names-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("nested")).unwrap();
        std::fs::write(dir.join("AGENTS.md"), "codex instructions").unwrap();
        std::fs::write(dir.join("CLAUDE.md"), "claude instructions").unwrap();
        std::fs::write(dir.join("nested/AGENTS.md"), "nested instructions").unwrap();
        std::fs::write(dir.join("nested/editor.md"), "not context").unwrap();
        let ctx = json!({"project":{"path":dir,"gitRoot":dir},"skills":[]});
        let declarations = json!({"contexts":"[claude.md, agents.md]"});
        let codex = selected_references(&declarations, &ctx, &dir, "codex").unwrap();
        let claude = selected_references(&declarations, &ctx, &dir, "claude").unwrap();
        assert_eq!(codex.as_array().unwrap().len(), 1);
        assert_eq!(claude.as_array().unwrap().len(), 1);
        assert_eq!(
            Path::new(codex[0]["path"].as_str().unwrap())
                .file_name()
                .unwrap(),
            "AGENTS.md"
        );
        assert_eq!(
            Path::new(claude[0]["path"].as_str().unwrap())
                .file_name()
                .unwrap(),
            "CLAUDE.md"
        );
        let nested = selected_references(
            &json!({"contexts":"[nested/AGENTS.md, AGENTS.md, CLAUDE.md]"}),
            &ctx,
            &dir,
            "codex",
        )
        .unwrap();
        assert_eq!(nested.as_array().unwrap().len(), 1);
        assert!(nested[0]["path"]
            .as_str()
            .unwrap()
            .contains("nested/AGENTS.md"));
        assert_eq!(
            selected_references(&json!({}), &ctx, &dir, "codex").unwrap(),
            json!([])
        );
        assert_eq!(
            selected_references(&json!({"contexts":"[]"}), &ctx, &dir, "codex").unwrap(),
            json!([])
        );
        assert_eq!(
            selected_references(&json!({}), &json!({}), &dir, "codex").unwrap(),
            json!([])
        );
        for invalid in ["editor.md", "AGENTS.override.md", "project:../AGENTS.md"] {
            assert!(selected_references(
                &json!({"contexts":format!("[{invalid}]")}),
                &ctx,
                &dir,
                "codex"
            )
            .is_err());
        }
        assert_eq!(
            selected_references(&json!({"contexts":"[CLAUDE.md]"}), &ctx, &dir, "codex").unwrap(),
            json!([])
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn project_context_requires_git_root_and_never_uses_nested_project_path() {
        let root =
            std::env::temp_dir().join(format!("agent-context-git-root-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("nested")).unwrap();
        std::fs::write(root.join("AGENTS.md"), "authorized root").unwrap();
        std::fs::write(root.join("nested/AGENTS.md"), "wrong nested file").unwrap();
        let context = json!({"project":{"path":root.join("nested"),"gitRoot":root}});
        let selected =
            selected_references(&json!({"contexts":"[AGENTS.md]"}), &context, &root, "codex")
                .unwrap();
        assert_eq!(
            selected[0]["path"],
            root.join("AGENTS.md")
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .as_ref()
        );
        let missing = json!({"project":{"path":root.join("nested")}});
        assert!(
            selected_references(&json!({"contexts":"[AGENTS.md]"}), &missing, &root, "codex")
                .unwrap_err()
                .contains("canonical project Git root")
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn contracts_and_skills_are_distinct_from_optional_context() {
        let dir = std::env::temp_dir().join(format!("agent-context-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("AGENTS.md"), "project").unwrap();
        let ctx = json!({"project":{"path":dir,"gitRoot":dir},"skills":[]});
        assert_eq!(
            selected_references(
                &json!({"contexts":"[AGENTS.md]","contracts":"[]","required_skills":"[]"}),
                &ctx,
                &dir,
                "codex"
            )
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
            1
        );
        assert_eq!(
            selected_references(
                &json!({"required_skills":"[ponytail]"}),
                &ctx,
                &dir,
                "codex"
            )
            .unwrap(),
            json!([])
        );
        assert_eq!(
            required_skill_names(&json!({"required_skills":"[ponytail, markcut, ponytail]"}))
                .unwrap(),
            vec!["ponytail", "markcut"]
        );
        assert!(required_skill_names(&json!({"required_skills":"[../SKILL.md]"})).is_err());
        assert_eq!(
            selected_references(&json!({}), &ctx, &dir, "codex").unwrap(),
            json!([])
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
