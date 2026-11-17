// Companion parser for src/workflow/graph-v2.ts; separated to preserve one-to-one Graph semantics without a >500-line source file.
use crate::js_text::trim_js;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GraphNode {
    pub id: String,
    pub kind: String,
    pub semantic_id: String,
    pub line: usize,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GraphEdge {
    pub from: String,
    pub to: String,
    pub kind: String,
    pub semantic_id: Option<String>,
    pub line: usize,
}
#[derive(Clone, Debug)]
pub struct Graph {
    pub source: String,
    pub direction: String,
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub initial: String,
}
impl Graph {
    pub fn node(&self, id: &str) -> Option<&GraphNode> {
        self.nodes.iter().find(|node| node.id == id)
    }
    pub fn json(&self) -> Value {
        json!({"source":self.source,"direction":self.direction,"nodes":self.nodes.iter().map(|node|
            json!({"id":node.id,"kind":node.kind,"semanticId":node.semantic_id,"line":node.line})).collect::<Vec<_>>(),
            "edges":self.edges.iter().map(|edge|json!({"from":edge.from,"to":edge.to,"kind":edge.kind,"semanticId":edge.semantic_id,"line":edge.line})).collect::<Vec<_>>(),"initial":self.initial})
    }
}
fn parse_fail(line: usize, message: impl AsRef<str>) -> String {
    format!("line {line}: {}", message.as_ref())
}
fn name(value: &str) -> bool {
    Regex::new(r"^[A-Za-z_][A-Za-z0-9_.-]*$")
        .expect("fixed identifier regex")
        .is_match(value)
}
fn parse_label(label: Option<&str>, line: usize) -> Result<(String, Option<String>), String> {
    let Some(label) = label else {
        return Ok(("unlabelled".into(), None));
    };
    let label = trim_js(label);
    if matches!(label, "true" | "false") {
        return Ok((label.into(), None));
    }
    let expression = Regex::new(r"^(on|request|to|emit):\s*(.*)$").expect("fixed edge label");
    let captures = expression
        .captures(label)
        .ok_or_else(|| parse_fail(line, format!("unsupported edge label '{label}'")))?;
    if !name(&captures[2]) {
        return Err(parse_fail(
            line,
            format!("unsupported edge label '{label}'"),
        ));
    }
    Ok((captures[1].to_owned(), Some(captures[2].to_owned())))
}
pub fn parse_graph_v2(source: &str) -> Result<Graph, String> {
    let lines = source
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect::<Vec<_>>();
    let mut graph_start = 0;
    if lines.first().is_some_and(|line| trim_js(line) == "---") {
        let mut close = None;
        for (index, line) in lines.iter().enumerate().skip(1) {
            if trim_js(line) == "---" {
                close = Some(index);
                break;
            }
        }
        let end = close.ok_or_else(|| parse_fail(1, "unterminated graph frontmatter"))?;
        if end == 1 {
            return Err(parse_fail(1, "empty graph frontmatter"));
        }
        graph_start = end + 1;
    }
    let node_re=Regex::new(r#"^([A-Za-z_][A-Za-z0-9_.-]*)\["(state|guard|action|emit):\s*([^|\]"]+?)(?:\s*\|[^\]"]*)?"\]$"#).expect("fixed graph node");
    let edge_re=Regex::new(r"^([A-Za-z_][A-Za-z0-9_.-]*)\s+-->\s*(?:\|\s*([^|]+?)\s*\|\s*)?([A-Za-z_][A-Za-z0-9_.-]*)$").expect("fixed graph edge");
    let header_re = Regex::new(r"^flowchart (LR|RL|TD|TB)$").expect("fixed graph header");
    let initial_re =
        Regex::new(r"^%%\s*relay:\s*initial\s+(.+)$").expect("fixed initial directive");
    let unsupported_shape = Regex::new(r"[({<]").expect("fixed unsupported shape");
    let mut direction = None;
    let mut initial: Option<String> = None;
    let mut nodes = Vec::<GraphNode>::new();
    let mut edges = Vec::<GraphEdge>::new();
    for (index, line) in lines.iter().enumerate().skip(graph_start) {
        let number = index + 1;
        let line = trim_js(line);
        if line.is_empty() {
            continue;
        }
        if line.starts_with("%%") {
            if let Some(directive) = initial_re.captures(line) {
                if initial.is_some() {
                    return Err(parse_fail(number, "duplicate initial declaration"));
                }
                let value = trim_js(&directive[1]);
                if !name(value) {
                    return Err(parse_fail(
                        number,
                        format!("invalid initial state '{value}'"),
                    ));
                }
                initial = Some(value.to_string());
            }
            continue;
        }
        if direction.is_none() {
            let header = header_re
                .captures(line)
                .ok_or_else(|| parse_fail(number, "expected flowchart LR, RL, TD, or TB"))?;
            direction = Some(header[1].to_string());
            continue;
        }
        if let Some(node) = node_re.captures(line) {
            if nodes.iter().any(|item| item.id == node[1]) {
                return Err(parse_fail(number, format!("duplicate node '{}'", &node[1])));
            }
            let semantic_id = trim_js(&node[3]);
            if !name(semantic_id) {
                return Err(parse_fail(
                    number,
                    format!("invalid {} identifier '{semantic_id}'", &node[2]),
                ));
            }
            if &node[2] == "state"
                && nodes
                    .iter()
                    .any(|item| item.kind == "state" && item.semantic_id == semantic_id)
            {
                return Err(parse_fail(
                    number,
                    format!("duplicate semantic declaration 'state: {semantic_id}'"),
                ));
            }
            nodes.push(GraphNode {
                id: node[1].into(),
                kind: node[2].into(),
                semantic_id: semantic_id.into(),
                line: number,
            });
            continue;
        }
        if let Some(edge) = edge_re.captures(line) {
            let (kind, semantic_id) =
                parse_label(edge.get(2).map(|capture| capture.as_str()), number)?;
            edges.push(GraphEdge {
                from: edge[1].into(),
                to: edge[3].into(),
                kind,
                semantic_id,
                line: number,
            });
            continue;
        }
        if let Some(shape) = unsupported_shape.find(line) {
            let unsupported = if shape.as_str() == "{" {
                "{...}".to_string()
            } else {
                format!("{}...", shape.as_str())
            };
            return Err(parse_fail(
                number,
                format!("unsupported node shape '{unsupported}'; expected '[\"...\"]'"),
            ));
        }
        return Err(parse_fail(number, format!("unsupported syntax '{line}'")));
    }
    let direction = direction.ok_or_else(|| {
        "line 1: executable graph is empty; expected flowchart header".to_string()
    })?;
    let initial = initial.ok_or_else(|| {
        "graph requires exactly one %% relay: initial STATE declaration".to_string()
    })?;
    if !nodes
        .iter()
        .any(|node| node.id == initial && node.kind == "state")
    {
        return Err(format!(
            "initial state '{initial}' is not a declared state node"
        ));
    }
    if !nodes.iter().any(|node| node.kind == "state") {
        return Err("graph requires at least one state node".into());
    }
    if edges.is_empty() {
        return Err("graph requires at least one executable edge".into());
    }
    for edge in &edges {
        if !nodes.iter().any(|node| node.id == edge.from) {
            return Err(parse_fail(
                edge.line,
                format!("edge source '{}' is not declared", edge.from),
            ));
        }
        if !nodes.iter().any(|node| node.id == edge.to) {
            return Err(parse_fail(
                edge.line,
                format!("edge target '{}' is not declared", edge.to),
            ));
        }
    }
    let graph = Graph {
        source: source.into(),
        direction,
        nodes,
        edges,
        initial,
    };
    validate_topology(&graph)?;
    Ok(graph)
}
fn validate_topology(graph: &Graph) -> Result<(), String> {
    for node in &graph.nodes {
        let exits = graph
            .edges
            .iter()
            .filter(|edge| edge.from == node.id)
            .collect::<Vec<_>>();
        if node.kind == "state" {
            let mut groups = HashMap::<(String, Option<String>), Vec<&GraphEdge>>::new();
            for edge in exits {
                if !matches!(edge.kind.as_str(), "on" | "request") {
                    return Err(parse_fail(
                        edge.line,
                        format!(
                            "state '{}' may only have on:/request: exits",
                            node.semantic_id
                        ),
                    ));
                }
                let target = graph.node(&edge.to).expect("validated declared edge");
                if !matches!(target.kind.as_str(), "state" | "guard" | "action") {
                    return Err(parse_fail(
                        edge.line,
                        format!("{} edge must lead to a state, guard, or action", edge.kind),
                    ));
                }
                groups
                    .entry((edge.kind.clone(), edge.semantic_id.clone()))
                    .or_default()
                    .push(edge);
            }
            for ((kind, event), group) in groups {
                if group.len() < 2 {
                    continue;
                }
                let destinations = group
                    .iter()
                    .map(|edge| edge.to.as_str())
                    .collect::<HashSet<_>>();
                if group.iter().any(|edge| {
                    graph
                        .node(&edge.to)
                        .is_none_or(|target| target.kind != "guard")
                }) || destinations.len() != group.len()
                {
                    return Err(parse_fail(
                        group[1].line,
                        format!(
                            "ambiguous input path for {kind} '{}' from state '{}'",
                            event.unwrap_or_default(),
                            node.semantic_id
                        ),
                    ));
                }
            }
        } else if node.kind == "guard" {
            let branches = exits
                .iter()
                .map(|edge| edge.kind.as_str())
                .collect::<HashSet<_>>();
            if exits.is_empty()
                || exits.len() > 2
                || exits
                    .iter()
                    .any(|edge| !matches!(edge.kind.as_str(), "true" | "false"))
                || branches.len() != exits.len()
            {
                return Err(parse_fail(
                    node.line,
                    format!(
                        "guard '{}' requires one or two unique true/false exits",
                        node.semantic_id
                    ),
                ));
            }
            for edge in exits {
                if !matches!(
                    graph.node(&edge.to).expect("declared edge").kind.as_str(),
                    "state" | "guard" | "action"
                ) {
                    return Err(parse_fail(
                        edge.line,
                        format!(
                            "guard edge '{}' must lead to a state, guard, or action",
                            edge.kind
                        ),
                    ));
                }
            }
        } else if node.kind == "action" {
            let continuation = exits
                .iter()
                .filter(|edge| matches!(edge.kind.as_str(), "to" | "unlabelled"))
                .collect::<Vec<_>>();
            if continuation.len() > 1 {
                return Err(parse_fail(
                    node.line,
                    format!("action '{}' has multiple continuations", node.semantic_id),
                ));
            }
            for edge in &continuation {
                let target = graph.node(&edge.to).expect("declared edge");
                if edge.kind == "to" {
                    if target.kind != "state" {
                        return Err(parse_fail(
                            edge.line,
                            "to: action continuation must target a state",
                        ));
                    }
                    if edge.semantic_id.as_deref() != Some(&target.semantic_id) {
                        return Err(parse_fail(
                            edge.line,
                            format!(
                                "to edge names state '{}' but targets state '{}'",
                                edge.semantic_id.as_deref().unwrap_or_default(),
                                target.semantic_id
                            ),
                        ));
                    }
                } else if !matches!(target.kind.as_str(), "state" | "action") {
                    return Err(parse_fail(
                        edge.line,
                        "unlabelled action continuation must lead to an action or state",
                    ));
                }
            }
            for edge in exits.iter().filter(|edge| edge.kind == "emit") {
                let target = graph.node(&edge.to).expect("declared edge");
                if target.kind != "emit" {
                    return Err(parse_fail(edge.line, "emit edge must lead to an emit node"));
                }
                if edge.semantic_id.as_deref() != Some(&target.semantic_id) {
                    return Err(parse_fail(
                        edge.line,
                        format!(
                            "emit edge names event '{}' but targets emit '{}'",
                            edge.semantic_id.as_deref().unwrap_or_default(),
                            target.semantic_id
                        ),
                    ));
                }
            }
            if continuation.is_empty() {
                return Err(parse_fail(
                    node.line,
                    format!("action '{}' must have one continuation", node.semantic_id),
                ));
            }
        } else if !exits.is_empty() {
            return Err(parse_fail(
                node.line,
                format!(
                    "emit node '{}' must not have outgoing edges",
                    node.semantic_id
                ),
            ));
        }
    }
    let mut reachable = HashSet::new();
    reachable.insert(graph.initial.clone());
    loop {
        let before = reachable.len();
        for edge in &graph.edges {
            if reachable.contains(&edge.from) {
                reachable.insert(edge.to.clone());
            }
        }
        if reachable.len() == before {
            break;
        }
    }
    for node in &graph.nodes {
        if node.kind == "state" && !reachable.contains(&node.id) {
            return Err(parse_fail(
                node.line,
                format!(
                    "state '{}' is unreachable from initial state '{}'",
                    node.semantic_id, graph.initial
                ),
            ));
        }
    }
    Ok(())
}
