// Direct parse/combine/contract port of src/outcome-review.ts.
// The external Codex runner and process.exitCode behavior are NOT ported:
// neither Rust nor test harness invokes a Codex CLI.
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    path::{Component, Path, PathBuf},
};
fn resolve(cwd: &Path, path: &str) -> PathBuf {
    let p = Path::new(path);
    let joined = if p.is_absolute() {
        p.to_path_buf()
    } else {
        cwd.join(p)
    };
    let mut out = PathBuf::new();
    for c in joined.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            _ => out.push(c),
        }
    }
    out
}
pub fn parse_outcome_review_args(args: &[String], cwd: &Path) -> Result<Value, String> {
    let mut opts = std::collections::HashMap::new();
    let mut i = 0;
    while i < args.len() {
        let flag = &args[i];
        if !matches!(
            flag.as_str(),
            "--prompt" | "--prompt-file" | "--agents" | "--project-path" | "--output"
        ) || args
            .get(i + 1)
            .is_none_or(|v| v.is_empty() || v.starts_with("--"))
        {
            return Err(format!("invalid review option: {flag}"));
        }
        opts.insert(flag.trim_start_matches("--"), args[i + 1].as_str());
        i += 2;
    }
    if opts.contains_key("prompt") == opts.contains_key("prompt-file") {
        return Err("review run requires exactly one of --prompt or --prompt-file".into());
    }
    let mut reviewers = vec!["reviewer".to_owned()];
    let mut seen = HashSet::from(["reviewer".to_string()]);
    if let Some(s) = opts.get("agents") {
        for name in s.split(',').filter(|s| !s.is_empty()) {
            if name.is_empty()
                || !name.starts_with(|c: char| c.is_ascii_lowercase())
                || !name
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
            {
                return Err("invalid reviewer agent name".into());
            }
            if seen.insert(name.to_owned()) {
                reviewers.push(name.into());
            }
        }
    }
    let project = resolve(cwd, opts.get("project-path").copied().unwrap_or("."));
    let prompt = if let Some(p) = opts.get("prompt-file") {
        let path = resolve(&project, p);
        fs::read_to_string(&path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                format!(
                    "ENOENT: no such file or directory, open '{}'",
                    path.display()
                )
            } else {
                format!("{}: {e}", path.display())
            }
        })?
    } else {
        opts.get("prompt").copied().unwrap_or("").to_owned()
    };
    if prompt.trim().is_empty() {
        return Err("review prompt must not be empty".into());
    }
    if !project.exists() {
        return Err(format!("project not found: {}", project.display()));
    }
    let mut result =
        json!({"prompt":prompt,"projectPath":project.to_string_lossy(),"reviewers":reviewers});
    if let Some(p) = opts.get("output") {
        result["output"] = json!(resolve(&project, p).to_string_lossy())
    }
    Ok(result)
}
pub fn reviewer_contract(
    name: &str,
    project: &Path,
    shared: Option<&Path>,
    root: &Path,
) -> Result<PathBuf, String> {
    if name == "reviewer" {
        return Ok(root.join("agents/outcome-reviewer.agent.md"));
    }
    let mut candidates = vec![project.join("agents").join(format!("{name}.agent.md"))];
    if let Some(shared) = shared {
        candidates.push(shared.join("agents").join(format!("{name}.agent.md")));
    }
    candidates.push(root.join("agents").join(format!("{name}.agent.md")));
    candidates
        .into_iter()
        .find(|p| p.exists())
        .ok_or_else(|| format!("professional reviewer not found: {name}"))
}
pub fn combine_outcome_reviews(reviews: &[Value]) -> Value {
    let verdict = if reviews.iter().any(|r| r["verdict"] == "BLOCKED") {
        "BLOCKED"
    } else if reviews.iter().any(|r| r["verdict"] == "CHANGE_REQUIRED") {
        "CHANGE_REQUIRED"
    } else {
        "PASS"
    };
    json!({"verdict":verdict,"reviews":reviews})
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cli_rejects_unknown() {
        assert_eq!(
            parse_outcome_review_args(&["--bad".into(), "x".into()], Path::new("/tmp"))
                .unwrap_err(),
            "invalid review option: --bad"
        );
    }
    #[test]
    fn highest_verdict() {
        assert_eq!(
            combine_outcome_reviews(&[
                json!({"verdict":"CHANGE_REQUIRED"}),
                json!({"verdict":"BLOCKED"})
            ])["verdict"],
            "BLOCKED"
        );
    }
}
