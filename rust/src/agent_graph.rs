// Direct port of Node src/agent-graph.ts: canonical Mermaid Agent DAG parser, visible-agent gate and per-node contract prompt assembly.
use crate::js_text::trim_js;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
#[derive(Clone, Debug)]
pub struct AgentGraph {
    pub source: String,
    pub nodes: Vec<(String, String)>,
    pub edges: Vec<(String, String)>,
    pub waves: Vec<Vec<String>>,
}
impl AgentGraph {
    pub fn json(&self) -> Value {
        json!({"source":self.source,"nodes":self.nodes.iter().map(|(id,agent)|json!({"id":id,"agent":agent})).collect::<Vec<_>>(),
        "edges":self.edges.iter().map(|(from,to)|json!({"from":from,"to":to})).collect::<Vec<_>>(),"waves":self.waves})
    }
}
pub fn parse_agent_graph(source: &str) -> Result<AgentGraph, String> {
    let edge=Regex::new(r"^([A-Za-z_][A-Za-z0-9_.-]*)(?:\[agent:([A-Za-z_][A-Za-z0-9_.-]*)\])?\s*-->\s*([A-Za-z_][A-Za-z0-9_.-]*)(?:\[agent:([A-Za-z_][A-Za-z0-9_.-]*)\])?$").expect("fixed DAG edge");
    let node = Regex::new(r"^([A-Za-z_][A-Za-z0-9_.-]*)\[agent:([A-Za-z_][A-Za-z0-9_.-]*)\]$")
        .expect("fixed DAG node");
    let header = Regex::new(r"^flowchart\s+(?:TD|TB|LR|RL)$").expect("fixed DAG header");
    let mut has_header = false;
    let mut agents = Vec::<(String, String)>::new();
    let mut edges = Vec::<(String, String)>::new();
    let add = |id: &str, annotation: Option<&str>, agents: &mut Vec<(String, String)>| {
        if let Some((_, value)) = agents.iter_mut().find(|(existing, _)| existing == id) {
            if let Some(override_agent) = annotation {
                *value = override_agent.to_string();
            }
        } else {
            agents.push((id.to_string(), annotation.unwrap_or(id).to_string()));
        }
    };
    for (index, raw) in source.split('\n').enumerate() {
        let line = trim_js(raw);
        if line.is_empty() || line.starts_with("%%") {
            continue;
        }
        if !has_header {
            if !header.is_match(line) {
                return Err(format!(
                    "Agent Graph must start with Mermaid flowchart TD/TB/LR/RL (line {})",
                    index + 1
                ));
            }
            has_header = true;
            continue;
        }
        if let Some(edge) = edge.captures(line) {
            let from = &edge[1];
            let to = &edge[3];
            add(from, edge.get(2).map(|match_| match_.as_str()), &mut agents);
            add(to, edge.get(4).map(|match_| match_.as_str()), &mut agents);
            edges.push((from.to_string(), to.to_string()));
            continue;
        }
        if let Some(node) = node.captures(line) {
            add(&node[1], Some(&node[2]), &mut agents);
            continue;
        }
        return Err(format!(
            "Unsupported Agent Graph syntax at line {}: {line}",
            index + 1
        ));
    }
    if !has_header {
        return Err("Agent Graph is empty".into());
    }
    if agents.is_empty() {
        return Err("Agent Graph requires at least one agent node".into());
    }
    let mut incoming = agents
        .iter()
        .map(|(id, _)| (id.clone(), 0usize))
        .collect::<BTreeMap<_, _>>();
    let mut outgoing = agents
        .iter()
        .map(|(id, _)| (id.clone(), Vec::<String>::new()))
        .collect::<HashMap<_, _>>();
    for (from, to) in &edges {
        if from == to {
            return Err(format!("Agent Graph self-cycle at {from}"));
        }
        if let Some(count) = incoming.get_mut(to) {
            *count += 1;
        }
        if let Some(next) = outgoing.get_mut(from) {
            next.push(to.clone());
        }
    }
    let mut remaining = incoming;
    let mut ready = remaining
        .iter()
        .filter(|(_, count)| **count == 0)
        .map(|(id, _)| id.clone())
        .collect::<Vec<_>>();
    let mut waves = Vec::new();
    let mut visited = 0;
    while !ready.is_empty() {
        visited += ready.len();
        waves.push(ready.clone());
        let mut next = HashSet::new();
        for id in &ready {
            for target in outgoing.get(id).into_iter().flatten() {
                let count = remaining.get_mut(target).expect("known DAG node");
                *count -= 1;
                if *count == 0 {
                    next.insert(target.clone());
                }
            }
        }
        ready = next.into_iter().collect();
        ready.sort();
    }
    if visited != agents.len() {
        return Err("Agent Graph contains a cycle".into());
    }
    Ok(AgentGraph {
        source: source.into(),
        nodes: agents,
        edges,
        waves,
    })
}
pub fn validate_agent_selection(
    visible: &HashSet<String>,
    agent_name: Option<&str>,
    source: Option<&str>,
) -> Result<(), String> {
    if let Some(name) = agent_name.filter(|name| !name.is_empty()) {
        if !visible.contains(name) {
            return Err(format!(
                "Agent {name} is not visible in the resolved planning/execution context"
            ));
        }
    }
    if let Some(source) = source.filter(|source| !source.is_empty()) {
        for (id, agent) in parse_agent_graph(source)?.nodes {
            if !visible.contains(&agent) {
                return Err(format!("Agent {agent} referenced by agentGraph node {id} is not visible in the resolved planning/execution context"));
            }
        }
    }
    Ok(())
}
pub fn agent_graph_prompt<F>(
    visible: &HashSet<String>,
    source: &str,
    mut contract: F,
) -> Result<String, String>
where
    F: FnMut(&str) -> Result<String, String>,
{
    let graph = parse_agent_graph(source)?;
    validate_agent_selection(visible, None, Some(source))?;
    let mut texts = Vec::new();
    for (id, agent) in &graph.nodes {
        let predecessors = graph
            .edges
            .iter()
            .filter(|(_, to)| to == id)
            .map(|(from, _)| from.clone())
            .collect::<Vec<_>>();
        let body = contract(agent)?;
        texts.push(format!(
            "[Node {id}; predecessors={}]\n{body}",
            if predecessors.is_empty() {
                "none".into()
            } else {
                predecessors.join(",")
            }
        ));
    }
    let waves = graph
        .waves
        .iter()
        .enumerate()
        .map(|(index, wave)| format!("{}:{}", index + 1, wave.join(",")))
        .collect::<Vec<_>>()
        .join(" | ");
    Ok(format!("[Task Agent Graph]\n{}\n\nExecution waves: {}\n\nThe Coordinator materializes each graph node as its own durable Agent Task when its predecessors succeed. All Agent Tasks use the ordinary Reconciler and Task Lifecycle. Each child receives only the original Job/Task context and structured outputs of its declared predecessors. Independent nodes may run concurrently. Never execute the entire graph inside one Model Worker, invent additional Tasks, or publish another Task's lifecycle events.\n\n{}",
        trim_js(source),waves,texts.join("\n\n")))
}
