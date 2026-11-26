//! Only the Markdown global Contract manifest is automatic.
//! Other trusted and assignment sections require effective Agent declarations.
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Component, Path, PathBuf},
};
#[derive(Debug)]
pub struct Loaded {
    pub system: String,
    pub provenance: Vec<Value>,
}
fn items(raw: &str) -> Result<Vec<String>, String> {
    let raw = raw.trim();
    if !raw.starts_with('[') || !raw.ends_with(']') {
        return Err("Contract list must use [item, item]".into());
    }
    let raw = &raw[1..raw.len() - 1];
    if raw.trim().is_empty() {
        return Ok(vec![]);
    }
    raw.split(',')
        .map(|item| {
            let s = item.trim().trim_matches(['\'', '"']).trim();
            if s.is_empty() || s.contains(['\n', '\r', '[', ']']) {
                Err("Invalid Contract list item".into())
            } else {
                Ok(s.into())
            }
        })
        .collect()
}
fn declared(meta: &Value, key: &str) -> Result<Vec<String>, String> {
    match meta.get(key) {
        None | Some(Value::Null) => Ok(vec![]),
        Some(Value::String(s)) if s.trim().is_empty() => Ok(vec![]),
        Some(Value::String(s)) => items(s),
        _ => Err(format!("Contract {key} must be an inline list")),
    }
}
fn source(name: &str, root: &Path) -> Result<PathBuf, String> {
    if name.contains('#') {
        return Err("Contract declaration requires a whole purpose-specific Markdown document, not a #section".into());
    }
    let name = name
        .strip_prefix("relay:")
        .ok_or("Required Contract needs relay: scope")?;
    let rel = Path::new(name);
    if rel.as_os_str().is_empty()
        || rel.is_absolute()
        || rel.components().any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("Required Contract has unsafe relative path".into());
    }
    let base = root.canonicalize().map_err(|e| e.to_string())?;
    let file = base
        .join(rel)
        .canonicalize()
        .map_err(|e| format!("Missing required Contract {name}: {e}"))?;
    if !file.starts_with(&base) || !file.is_file() || !file.extension().is_some_and(|s| s == "md") {
        return Err("Required Contract escaped package root or is not Markdown".into());
    }
    Ok(file)
}
fn global(root: &Path) -> Result<Vec<String>, String> {
    // The Agent Definition Contract owns the automatic global shared
    // Contract declaration; no generic global manifest is needed.
    let file = root.join("skills/agents-relay/contracts/agent-contract.md");
    let data = fs::read_to_string(&file).map_err(|e| {
        format!(
            "Agent Definition Contract unavailable {}: {e}",
            file.display()
        )
    })?;
    let mut lines = data.lines();
    if lines.next() != Some("---") {
        return Err("Agent Definition Contract requires global frontmatter".into());
    }
    let mut kind = false;
    let mut entries = None;
    let mut closed = false;
    for line in lines {
        if line == "---" {
            closed = true;
            break;
        }
        if line == "kind: relay-agent-definition-contract" {
            kind = true
        } else if let Some(value) = line.strip_prefix("global_startup_contracts:") {
            if entries.is_some() {
                return Err("Duplicate global_startup_contracts".into());
            }
            entries = Some(items(value)?);
        } else {
            return Err(format!(
                "Unsupported Agent Definition Contract frontmatter: {line}"
            ));
        }
    }
    if !closed || !kind {
        return Err("Invalid Agent Definition Contract frontmatter".into());
    }
    let contracts =
        entries.ok_or("Global startup contracts must be declared in agent-contract.md")?;
    if contracts.is_empty() {
        return Err("Global shared Contract set cannot be empty".into());
    }
    Ok(contracts)
}
// Every Job Task receives the bundled Worker's Contract declarations
// as an execution layer; this does not modify its Agent inheritance.
// Agents may ALSO explicitly extend worker as an ordinary Agent parent.
// Duplicate Contract paths load once; project Worker overlays cannot
// weaken the mandatory Task protocol.
fn worker_contract_metadata(root: &Path) -> Result<Value, String> {
    let builtin = root.join("skills/agents-relay/agents");
    let empty_layers = json!([]);
    let resolved = crate::agent_content_resolver::resolve_agent_markdown(
        "worker",
        &builtin.to_string_lossy(),
        &root.to_string_lossy(),
        Some(&empty_layers),
    )?;
    Ok(resolved["metadata"].clone())
}
fn worker_required(meta: &Value, field: &str) -> Result<Vec<String>, String> {
    let selected = declared(meta, field)?;
    if selected.is_empty() {
        return Err(format!(
            "Required Worker execution Contract declaration missing: {field}"
        ));
    }
    Ok(selected)
}
fn combined(worker: Option<&Value>, agent: &Value, field: &str) -> Result<Vec<String>, String> {
    let mut selected = match worker {
        Some(metadata) => worker_required(metadata, field)?,
        None => Vec::new(),
    };
    selected.extend(declared(agent, field)?);
    Ok(selected)
}
fn add(
    list: Vec<String>,
    root: &Path,
    dedup: &mut HashMap<PathBuf, String>,
    text: &mut Vec<String>,
    refs: &mut Vec<Value>,
    placement: &str,
) -> Result<(), String> {
    for name in list {
        let path = source(&name, root)?;
        let bytes = fs::read(&path).map_err(|e| e.to_string())?;
        if bytes.is_empty() || bytes.len() > 1024 * 1024 {
            return Err(format!("Required Contract has invalid size: {name}"));
        }
        let data = String::from_utf8(bytes.clone()).map_err(|e| e.to_string())?;
        if data.trim().is_empty() {
            return Err(format!("Required Contract is empty: {name}"));
        }
        if let Some(existing) = dedup.get(&path) {
            if existing != placement {
                return Err("Contract document assigned to both trusted System and User".into());
            }
            continue;
        }
        dedup.insert(path.clone(), placement.to_owned());
        refs.push(
            json!({"kind":"startup-contract","path":path,"placement":placement,
            "loaded":true}),
        );
        text.push(data);
    }
    Ok(())
}
pub fn load(
    meta: &Value,
    root: &Path,
    operation: &str,
    terminal: Option<&str>,
    artifact: bool,
) -> Result<Loaded, String> {
    if !matches!(operation, "worker" | "plan" | "eval") {
        return Err("Unsupported Contract operation".into());
    }
    let worker = if matches!(operation, "worker" | "eval") {
        Some(worker_contract_metadata(root)?)
    } else {
        None
    };
    let task_contracts = worker.as_ref();
    let mut system = vec![];
    let mut refs = vec![];
    let mut dedup = HashMap::new();
    add(
        global(root)?,
        root,
        &mut dedup,
        &mut system,
        &mut refs,
        "system",
    )?;
    let startup = if operation == "eval" {
        "eval_contracts"
    } else {
        "startup_contracts"
    };
    add(
        combined(task_contracts, meta, startup)?,
        root,
        &mut dedup,
        &mut system,
        &mut refs,
        "system",
    )?;
    if operation == "worker" && artifact {
        add(
            combined(task_contracts, meta, "artifact_contracts")?,
            root,
            &mut dedup,
            &mut system,
            &mut refs,
            "system",
        )?;
    }
    let assignment = if operation == "eval" {
        "eval_assignment_contracts"
    } else {
        "assignment_contracts"
    };
    add(
        combined(
            if operation == "worker" {
                task_contracts
            } else {
                None
            },
            meta,
            assignment,
        )?,
        root,
        &mut dedup,
        &mut system,
        &mut refs,
        "system",
    )?;
    if operation == "worker" {
        let field = match terminal {
            Some("dag") => "dag_contracts",
            Some("source") => "source_contracts",
            Some("event") => "event_contracts",
            _ => return Err("Missing Task terminal kind".into()),
        };
        add(
            combined(task_contracts, meta, field)?,
            root,
            &mut dedup,
            &mut system,
            &mut refs,
            "system",
        )?;
    }
    Ok(Loaded {
        system: system.join("\n\n"),
        provenance: refs,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn global_declared_and_complete_contracts_only() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let shared = load(&json!({}), root, "worker", Some("event"), false).unwrap();
        assert_eq!(shared.provenance.len(), 4);
        assert!(shared.system.contains("Relay Execution Boundary"));
        assert!(shared.system.contains("Managed Worker Lifecycle"));
        assert!(shared.system.contains("Event Task Completion"));
        assert!(shared.system.contains("Managed Task Execution"));
        // No independent Agent ancestor is required for Task Contracts.

        let invalid = json!({"startup_contracts":"[relay:skills/agents-relay/contracts/event-contract.md#producer-contract]"});
        assert!(load(&invalid, root, "worker", Some("event"), false)
            .unwrap_err()
            .contains("whole purpose-specific"));
        let absent =
            json!({"startup_contracts":"[relay:skills/agents-relay/contracts/not-present.md]"});
        assert!(load(&absent, root, "worker", Some("event"), false)
            .unwrap_err()
            .contains("Missing required Contract"));
    }
    #[test]
    fn inherited_worker_and_independent_planner_contracts() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let base = root.join("skills/agents-relay/agents");
        let dir = base.to_string_lossy().to_string();
        let project = root.to_string_lossy().to_string();
        let worker = crate::agent_content_resolver::resolve_agent_markdown(
            "implementation",
            &dir,
            &project,
            None,
        )
        .unwrap();
        let loaded = load(&worker["metadata"], root, "worker", Some("dag"), true).unwrap();
        assert!(loaded.system.contains("Managed Worker Lifecycle"));
        assert!(loaded
            .system
            .contains("Artifact-changing Worker Self-Review"));
        assert!(loaded.system.contains("DAG Task Completion"));
        assert!(!loaded.system.contains("Git Source Task Completion"));
        assert_eq!(loaded.provenance.len(), 5);
        let explicit_worker =
            crate::agent_content_resolver::resolve_agent_markdown("worker", &dir, &project, None)
                .unwrap();
        let explicitly_inherited = load(
            &explicit_worker["metadata"],
            root,
            "worker",
            Some("dag"),
            true,
        )
        .unwrap();
        assert_eq!(
            explicitly_inherited.provenance.len(),
            loaded.provenance.len(),
            "extends: worker must deduplicate execution-level Contracts"
        );
        let planner =
            crate::agent_content_resolver::resolve_agent_markdown("planner", &dir, &project, None)
                .unwrap();
        let plan = load(&planner["metadata"], root, "plan", None, false).unwrap();
        assert!(plan.system.contains("Managed Planner Execution"));
        assert!(!plan.system.contains("Managed Worker Lifecycle"));
        assert_eq!(plan.provenance.len(), 2);
        assert!(plan.system.contains("Managed Planner Execution"));
    }
    #[test]
    fn named_parent_remains_untouched_by_task_contract_composition() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let base = root.join("skills/agents-relay/agents");
        let dir = base.to_string_lossy().to_string();
        let project = root.to_string_lossy().to_string();
        let reviewer = crate::agent_content_resolver::resolve_agent_markdown(
            "job-acceptance-reviewer",
            &dir,
            &project,
            None,
        )
        .unwrap();
        let before = reviewer["sources"].as_array().unwrap();
        assert!(before
            .iter()
            .any(|x| x.as_str().unwrap_or("").ends_with("/reviewer.agent.md")));
        assert!(before.iter().any(|x| x
            .as_str()
            .unwrap_or("")
            .ends_with("/job-acceptance-reviewer.agent.md")));
        assert!(!before
            .iter()
            .any(|x| x.as_str().unwrap_or("").ends_with("/worker.agent.md")));
        let loaded = load(&reviewer["metadata"], root, "worker", Some("event"), false).unwrap();
        assert_eq!(loaded.provenance.len(), 4);
        assert!(loaded.system.contains("Managed Worker Lifecycle"));
        assert!(loaded.system.contains("Event Task Completion"));
        let after = reviewer["sources"].as_array().unwrap();
        assert_eq!(
            before, after,
            "execution contract binding must not modify Agent ancestry"
        );
    }
    #[test]
    fn child_override_and_duplicate_placement() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let child =
            json!({"startup_contracts":"[]","assignment_contracts":"[]","event_contracts":"[]"});
        assert_eq!(
            load(&child, root, "worker", Some("event"), false)
                .unwrap()
                .provenance
                .len(),
            4,
            "Agent may clear its own declarations but not Task execution Contracts"
        );
        let conflict = json!({"startup_contracts":"[relay:skills/agents-relay/contracts/task-execution.md]",
            "assignment_contracts":"[relay:skills/agents-relay/contracts/task-execution.md]"});
        let deduplicated = load(&conflict, root, "plan", None, false).unwrap();
        assert_eq!(deduplicated.provenance.len(), 2);
        assert_eq!(
            deduplicated
                .system
                .matches("Managed Task Execution Contract")
                .count(),
            1
        );
    }
}
