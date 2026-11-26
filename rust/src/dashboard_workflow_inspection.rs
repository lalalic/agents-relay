// Node provenance: src/dashboard-workflow-inspection.ts; searches canonical graph, contracts, source and tests for read-only symbol evidence.
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};
fn valid(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
}
fn safe(root: &Path, rel: &str) -> Option<PathBuf> {
    let p = root.join(rel);
    let c = p.canonicalize().ok()?;
    let r = root.canonicalize().ok()?;
    c.starts_with(r).then_some(c)
}
fn files(root: &Path, rel: &str, out: &mut Vec<String>) {
    let Some(dir) = safe(root, rel) else { return };
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut entries = entries.filter_map(Result::ok).collect::<Vec<_>>();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let child = format!("{rel}/{}", e.file_name().to_string_lossy());
        if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            files(root, &child, out)
        } else if e.file_type().map(|t| t.is_file()).unwrap_or(false)
            && ["ts", "js", "mjs", "md"]
                .iter()
                .any(|x| child.ends_with(&format!(".{x}")))
        {
            out.push(child)
        }
    }
}
fn boundary(b: Option<u8>) -> bool {
    b.map(|x| !(x.is_ascii_alphanumeric() || b"_.-".contains(&x)))
        .unwrap_or(true)
}
fn matches(content: &str, sym: &str, path: &str, max: usize) -> Vec<Value> {
    let mut out = Vec::new();
    for (i, line) in content.lines().enumerate() {
        let mut from = 0;
        while let Some(p) = line[from..].find(sym) {
            let a = from + p;
            let z = a + sym.len();
            if boundary(
                a.checked_sub(1)
                    .and_then(|k| line.as_bytes().get(k).copied()),
            ) && boundary(line.as_bytes().get(z).copied())
            {
                out.push(json!({"path":path,"line":i+1,"evidence":"text-search"}));
                break;
            }
            from = z;
            if from >= line.len() {
                break;
            }
        }
        if out.len() >= max {
            break;
        }
    }
    out
}
fn refs(root: &Path, paths: &[String], sym: &str, max: usize) -> Vec<Value> {
    let mut out = Vec::new();
    for p in paths {
        if let Some(file) = safe(root, p) {
            if let Ok(s) = fs::read_to_string(file) {
                out.extend(matches(&s, sym, p, max - out.len()))
            }
        }
        if out.len() >= max {
            break;
        }
    }
    out
}
pub fn inspect_workflow_symbol(root: &Path, graph: &str, kind: &str, name: &str) -> Option<Value> {
    if !valid(graph) || !valid(name) || !["Event", "Guard", "Action", "State"].contains(&kind) {
        return None;
    }
    let gp = format!("workflow/{graph}.mmd");
    let source = fs::read_to_string(safe(root, &gp)?).ok()?;
    let pattern = if kind == "Event" {
        format!(r"\|on:\s*{}\|", regex::escape(name))
    } else {
        format!(
            r#"\[\"{}:\s*{}\"\]"#,
            kind.to_lowercase(),
            regex::escape(name)
        )
    };
    let matcher = regex::Regex::new(&pattern).ok()?;
    let line = source.lines().position(|l| matcher.is_match(l))? + 1;
    let contracts = include_str!("../../docs/workflow-symbol-index.md")
        .lines()
        .filter_map(|line| line.strip_prefix("- "))
        .collect::<Vec<_>>();
    let mut cr = Vec::new();
    for p in contracts {
        if let Some(f) = safe(root, p) {
            if let Ok(s) = fs::read_to_string(f) {
                cr.extend(matches(&s, name, p, 2))
            }
        }
    }
    let mut src = Vec::new();
    files(root, "src", &mut src);
    src.sort_by_key(|p| (!p.starts_with("src/workflow/"), p.clone()));
    let mut tests = Vec::new();
    files(root, "test", &mut tests);
    Some(
        json!({"graph":{"path":gp,"line":line,"evidence":"exact-token"},"contracts":cr,"implementation":refs(root,&src,name,8),"tests":refs(root,&tests,name,8)}),
    )
}
