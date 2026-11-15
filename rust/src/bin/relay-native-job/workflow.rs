//! Read-only compatibility for Node workflow discovery and Graph introspection.
//! Graph transitions remain authorized by native reconciliation only.
use agents_relay_rust::graph::{Graph, GraphInput};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;
#[path = "workflow_graphs.rs"]
mod workflow_graphs;
#[path = "workflow_verify.rs"]
mod workflow_verify;

#[derive(Clone)]
struct Usage {
    graph: String,
    kind: String,
    id: String,
    line: usize,
    node: Option<String>,
}

impl Usage {
    fn value(&self) -> Value {
        match &self.node {
            Some(node) => json!({"graph":self.graph,"kind":self.kind,"id":self.id,
                "line":self.line,"node":node}),
            None => json!({"graph":self.graph,"kind":self.kind,"id":self.id,"line":self.line}),
        }
    }
}

fn all() -> Result<(BTreeMap<&'static str, Graph>, Vec<Usage>), String> {
    let mut graphs = BTreeMap::new();
    let mut symbols = Vec::new();
    for &(name, text) in workflow_graphs::GRAPHS {
        let graph = Graph::parse(text).map_err(|e| format!("Graph {name}: {e}"))?;
        for node in &graph.nodes {
            symbols.push(Usage {
                graph: name.into(),
                kind: node.kind.clone(),
                id: node.semantic_id.clone(),
                line: node.line,
                node: Some(node.id.clone()),
            });
        }
        for edge in &graph.edges {
            if matches!(edge.kind.as_str(), "on" | "emit" | "request") {
                if let Some(id) = &edge.semantic_id {
                    symbols.push(Usage {
                        graph: name.into(),
                        kind: if edge.kind == "request" {
                            "request".into()
                        } else {
                            "event".into()
                        },
                        id: id.clone(),
                        line: edge.line,
                        node: None,
                    });
                }
            }
        }
        if graphs.insert(name, graph).is_some() {
            return Err(format!("duplicate executable Graph {name}"));
        }
    }
    symbols.sort_by(|a, b| {
        a.id.cmp(&b.id)
            .then_with(|| a.graph.cmp(&b.graph))
            .then_with(|| a.line.cmp(&b.line))
    });
    Ok((graphs, symbols))
}

fn parse(args: &[String], allowed: &[&str]) -> Result<HashMap<String, String>, String> {
    let mut options = HashMap::new();
    let mut i = 0;
    while i < args.len() {
        let key = args[i].as_str();
        if !allowed.contains(&key) {
            return Err(format!("unknown workflow option {key}"));
        }
        if options.contains_key(key) {
            return Err(format!("duplicate workflow option {key}"));
        }
        let value = args
            .get(i + 1)
            .filter(|v| !v.starts_with("--") && (!v.is_empty() || key == "--id"))
            .ok_or_else(|| format!("workflow option {key} requires value"))?;
        options.insert(key.to_owned(), value.clone());
        i += 2;
    }
    Ok(options)
}

pub fn run(args: &[String]) -> Result<(), String> {
    let action = args
        .first()
        .map(String::as_str)
        .ok_or("workflow action required")?;
    if action == "action" {
        let selected = args
            .iter()
            .position(|v| v == "--action")
            .and_then(|index| args.get(index + 1))
            .map(String::as_str)
            .unwrap_or("");
        if !matches!(
            selected,
            "task.retry"
                | "task.recover"
                | "task.cancel"
                | "task.unblock"
                | "task.escalate"
                | "task.resume-troubleshooter"
        ) {
            return Err(
                "workflow action requires a supported Graph-authorized task Action ID".into(),
            );
        }
        for key in ["--repo", "--id", "--task-id"] {
            if !args
                .windows(2)
                .any(|pair| pair[0] == key && !pair[1].is_empty() && !pair[1].starts_with("--"))
            {
                return Err("workflow action requires --repo, --id and --task-id".into());
            }
        }
        return Err("workflow action requires native Graph-authorized Task control, not yet ported; refusing unsafe dispatch".into());
    }
    fn action_trace(options: &HashMap<String, String>) -> Result<Value, String> {
        let path = options.get("--sqlite").ok_or("trace requires --sqlite")?;
        let key = options
            .get("--attempt-key")
            .ok_or("trace requires --attempt-key")?;
        if !Path::new(path).is_file() {
            return Err("trace requires an existing SQLite file".into());
        }
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| e.to_string())?;
        conn.execute_batch("PRAGMA query_only=ON")
            .map_err(|e| e.to_string())?;
        let exists:i64=conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_action_trace')",[],|row|row.get(0))
        .map_err(|e|e.to_string())?;
        if exists == 0 {
            return Ok(json!({"attemptKey":key,"trace":null}));
        }
        let trace=conn.query_row(
        "SELECT attempt_key,execution_id,generation,graph,action_id,condition_id,outcome,observed_at FROM workflow_action_trace WHERE attempt_key=?1",
        [key],|row|{
            Ok(json!({
                "attempt_key":row.get::<_,String>(0)?,
                "execution_id":row.get::<_,String>(1)?,
                "generation":row.get::<_,i64>(2)?,
                "graph":row.get::<_,String>(3)?,
                "action_id":row.get::<_,String>(4)?,
                "condition_id":row.get::<_,String>(5)?,
                "outcome":row.get::<_,String>(6)?,
                "observed_at":row.get::<_,String>(7)?,
            }))
        }
    ).optional().map_err(|e|e.to_string())?;
        Ok(json!({"attemptKey":key,"trace":trace}))
    }

    let allowed = match action {
        "discover" | "actions" => &[][..],
        "where" => &["--id"][..],
        "inspect" => &["--graph"][..],
        "trace" => &["--sqlite", "--attempt-key"][..],
        "verify" => &["--sqlite", "--job", "--condition", "--task", "--execution"][..],
        "evaluate" => &["--graph", "--state", "--event", "--facts"][..],
        _ => return Err(
            "native workflow supports discover, actions, where, inspect, evaluate, trace, verify"
                .into(),
        ),
    };
    let options = parse(&args[1..], allowed)?;
    let (graphs, symbols) = all()?;
    let result = match action {
        "trace" => action_trace(&options)?,
        "verify" => workflow_verify::run(&options)?,
        "discover" => {
            let ids: BTreeSet<_> = symbols.iter().map(|s| s.id.clone()).collect();
            json!({"graphs":graphs.keys().collect::<Vec<_>>(),"symbols":ids})
        }
        "inspect" => {
            let name = options
                .get("--graph")
                .ok_or("workflow inspect requires --graph")?;
            let graph = graphs
                .get(name.as_str())
                .ok_or("unknown executable graph")?;
            json!({"graph":name,"initial":graph.initial,"nodes":graph.nodes,"edges":graph.edges})
        }
        "evaluate" => {
            let name = options
                .get("--graph")
                .ok_or("workflow evaluate requires --graph")?;
            let graph = graphs
                .get(name.as_str())
                .ok_or("unknown executable graph")?;
            let state = options
                .get("--state")
                .ok_or("workflow evaluate requires --state")?;
            let event = options
                .get("--event")
                .ok_or("workflow evaluate requires --event")?;
            let facts: Value =
                serde_json::from_str(options.get("--facts").map(String::as_str).unwrap_or("{}"))
                    .map_err(|e| format!("--facts invalid JSON: {e}"))?;
            let record = facts.as_object().ok_or("facts must be a JSON object")?;
            let mut guards = HashMap::new();
            for node in graph.nodes.iter().filter(|node| node.kind == "guard") {
                guards.insert(
                    node.semantic_id.clone(),
                    record
                        .get(&node.semantic_id)
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                );
            }
            let decision = match graph.decide(
                state,
                GraphInput {
                    transport: "event".into(),
                    id: event.clone(),
                    payload: json!({}),
                },
                &guards,
            ) {
                Ok(decision) => serde_json::to_value(decision).map_err(|e| e.to_string())?,
                Err(error) if error.starts_with("unknown event '") => {
                    if !graph
                        .nodes
                        .iter()
                        .any(|node| node.kind == "state" && node.semantic_id == *state)
                    {
                        return Err(format!("unknown state '{state}'"));
                    }
                    json!({"accepted":false,"source":state,"reason":"no_transition"})
                }
                Err(error) => return Err(error),
            };
            json!({"mode":"dry-run","decision":decision})
        }
        "where" => {
            let requested = options.get("--id").map(String::as_str).unwrap_or("");
            json!(symbols
                .iter()
                .filter(|usage| usage.id == requested)
                .map(Usage::value)
                .collect::<Vec<_>>())
        }
        "actions" => {
            let ids: BTreeSet<_> = symbols
                .iter()
                .filter(|usage| usage.kind == "action")
                .map(|usage| usage.id.clone())
                .collect();
            let actions = ids
                .iter()
                .map(|id| {
                    let refs = symbols
                        .iter()
                        .filter(|usage| usage.kind == "action" && usage.id == *id)
                        .map(Usage::value)
                        .collect::<Vec<_>>();
                    json!({"id":id,"graphReferences":refs,
                        "cli":"inspect-only; execution requires owning Graph runtime"})
                })
                .collect::<Vec<_>>();
            json!({
                "count":actions.len(),"actions":actions,
                "taskControls":[
                    "task.retry","task.recover","task.cancel","task.unblock",
                    "task.escalate","task.resume-troubleshooter"
                ],
                "warning":"Task controls are not equivalent to arbitrary internal Graph Action execution. No direct CLI bypass of guards or SQLite fencing."
            })
        }
        _ => unreachable!(),
    };
    println!("{result}");
    Ok(())
}
