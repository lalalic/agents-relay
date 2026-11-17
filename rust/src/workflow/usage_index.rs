// Direct port of Node src/workflow/usage-index.ts: readonly reverse symbol usage over executable local Graph files; never a second Graph authority.
use super::graph_v2::{parse_graph_v2, Graph};
use regex::Regex;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
#[cfg(target_os = "macos")]
fn locale_compare(left: &str, right: &str) -> std::cmp::Ordering {
    // Node uses Intl.Collator through String.localeCompare. The system's
    // Unicode en_US collation preserves its alphabetic casing and punctuation
    // order for canonical Workflow symbol identifiers.
    use std::ffi::CString;
    let (Ok(lhs), Ok(rhs), Ok(name)) = (
        CString::new(left),
        CString::new(right),
        CString::new("en_US.UTF-8"),
    ) else {
        return left.cmp(right);
    };
    let locale =
        unsafe { libc::newlocale(libc::LC_COLLATE_MASK, name.as_ptr(), std::ptr::null_mut()) };
    if locale.is_null() {
        return left.cmp(right);
    }
    unsafe extern "C" {
        fn strcoll_l(
            a: *const std::ffi::c_char,
            b: *const std::ffi::c_char,
            locale: libc::locale_t,
        ) -> libc::c_int;
    }
    let order = unsafe { strcoll_l(lhs.as_ptr(), rhs.as_ptr(), locale) };
    unsafe { libc::freelocale(locale) };
    order.cmp(&0)
}
#[cfg(not(target_os = "macos"))]
fn locale_compare(left: &str, right: &str) -> std::cmp::Ordering {
    left.cmp(right)
}
pub fn executable_graphs(directory: &Path) -> Result<BTreeMap<String, Graph>, String> {
    let allowed =
        Regex::new(r"^[a-z][a-z0-9-]*\.mmd$").expect("fixed canonical graph filename pattern");
    let mut result = BTreeMap::new();
    let entries = std::fs::read_dir(directory).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let filename = entry.file_name().to_string_lossy().to_string();
        if filename == "main.mmd" || !allowed.is_match(&filename) {
            continue;
        }
        let source = std::fs::read_to_string(entry.path()).map_err(|e| e.to_string())?;
        result.insert(filename, parse_graph_v2(&source)?);
    }
    Ok(result)
}
pub fn build_workflow_usage_index(graphs: &BTreeMap<String, Graph>) -> Vec<Value> {
    let mut usages = Vec::new();
    for (graph_name, graph) in graphs {
        for node in &graph.nodes {
            usages.push(json!({"graph":graph_name,"kind":node.kind,"id":node.semantic_id,"line":node.line,"node":node.id}));
        }
        for edge in &graph.edges {
            if matches!(edge.kind.as_str(), "on" | "emit" | "request") {
                if let Some(id) = edge.semantic_id.as_deref() {
                    usages.push(json!({"graph":graph_name,"kind":if edge.kind=="request"{"request"}else{"event"},"id":id,"line":edge.line}));
                }
            }
        }
    }
    usages.sort_by(|a, b| {
        let order = |key: &str| {
            locale_compare(a[key].as_str().unwrap_or(""), b[key].as_str().unwrap_or(""))
        };
        order("id")
            .then_with(|| order("graph"))
            .then_with(|| a["line"].as_i64().cmp(&b["line"].as_i64()))
    });
    usages
}
pub fn where_workflow_symbol(index: &[Value], id: &str, kind: Option<&str>) -> Vec<Value> {
    index
        .iter()
        .filter(|entry| {
            entry["id"].as_str() == Some(id)
                && kind.is_none_or(|kind| entry["kind"].as_str() == Some(kind))
        })
        .cloned()
        .collect()
}
pub fn default_workflow_directory() -> PathBuf {
    // Node uses import.meta.url; Cargo's source-relative root is the equivalent
    // when compiled in the source checkout. Production may explicitly provide
    // an independent deployment workflow directory to executable_graphs.
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("Rust crate inside repository root")
        .join("workflow")
}
