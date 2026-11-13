//! Strict Mermaid parsing and topology checks for the canonical Graph DSL.
use super::{Edge, Graph, Node};
use regex::Regex;
use std::collections::{HashMap, HashSet};

pub(super) fn is_id(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}
fn parse_label(raw: Option<&str>, line: usize) -> Result<(String, Option<String>), String> {
    let Some(raw) = raw else {
        return Ok(("unlabelled".into(), None));
    };
    let label = raw.trim();
    if label == "true" || label == "false" {
        return Ok((label.into(), None));
    }
    let Some((kind, value)) = label.split_once(':') else {
        return Err(format!("line {line}: unsupported edge label '{label}'"));
    };
    let value = value.trim();
    if !matches!(kind, "on" | "request" | "to" | "emit") || !is_id(value) {
        return Err(format!("line {line}: unsupported edge label '{label}'"));
    }
    Ok((kind.into(), Some(value.into())))
}
fn err(line: usize, msg: impl AsRef<str>) -> String {
    format!("line {line}: {}", msg.as_ref())
}

impl Graph {
    pub fn parse(source: &str) -> Result<Self, String> {
        let node_re = Regex::new(r#"^([A-Za-z_][A-Za-z0-9_.-]*)\["(state|guard|action|emit):\s*([^|\]"]+?)(?:\s*\|[^\]"]*)?"\]$"#).unwrap();
        let edge_re = Regex::new(r"^([A-Za-z_][A-Za-z0-9_.-]*)\s+-->\s*(?:\|\s*([^|]+?)\s*\|\s*)?([A-Za-z_][A-Za-z0-9_.-]*)$").unwrap();
        let lines: Vec<_> = source.lines().collect();
        let mut begin = 0;
        if lines.first().is_some_and(|x| x.trim() == "---") {
            let closing = lines
                .iter()
                .enumerate()
                .skip(1)
                .find(|(_, x)| x.trim() == "---")
                .map(|(i, _)| i)
                .ok_or_else(|| err(1, "unterminated graph frontmatter"))?;
            if closing == 1 {
                return Err(err(1, "empty graph frontmatter"));
            }
            begin = closing + 1;
        }
        let mut direction = None;
        let mut initial: Option<String> = None;
        let mut nodes: Vec<Node> = Vec::new();
        let mut edges: Vec<Edge> = Vec::new();
        for (index, raw) in lines.iter().enumerate().skip(begin) {
            let line_no = index + 1;
            let line = raw.trim();
            if line.is_empty() {
                continue;
            }
            if line.starts_with("%%") {
                if let Some(rest) = line.strip_prefix("%% relay: initial ") {
                    if initial.is_some() {
                        return Err(err(line_no, "duplicate initial declaration"));
                    }
                    if !is_id(rest.trim()) {
                        return Err(err(line_no, "invalid initial state"));
                    }
                    initial = Some(rest.trim().into());
                }
                continue;
            }
            if direction.is_none() {
                if let Some(v) = line.strip_prefix("flowchart ") {
                    if matches!(v, "LR" | "RL" | "TD" | "TB") {
                        direction = Some(v.to_string());
                        continue;
                    }
                }
                return Err(err(line_no, "expected flowchart LR, RL, TD, or TB"));
            }
            if let Some(c) = node_re.captures(line) {
                let (id, kind, semantic) =
                    (c[1].to_string(), c[2].to_string(), c[3].trim().to_string());
                if nodes.iter().any(|x| x.id == id) {
                    return Err(err(line_no, format!("duplicate node '{id}'")));
                }
                if !is_id(&semantic) {
                    return Err(err(
                        line_no,
                        format!("invalid {kind} identifier '{semantic}'"),
                    ));
                }
                if kind == "state"
                    && nodes
                        .iter()
                        .any(|x| x.kind == "state" && x.semantic_id == semantic)
                {
                    return Err(err(
                        line_no,
                        format!("duplicate semantic declaration 'state: {semantic}'"),
                    ));
                }
                nodes.push(Node {
                    id,
                    kind,
                    semantic_id: semantic,
                    line: line_no,
                });
                continue;
            }
            if let Some(c) = edge_re.captures(line) {
                let (kind, semantic_id) = parse_label(c.get(2).map(|m| m.as_str()), line_no)?;
                edges.push(Edge {
                    from: c[1].into(),
                    to: c[3].into(),
                    kind,
                    semantic_id,
                    line: line_no,
                });
                continue;
            }
            return Err(err(line_no, format!("unsupported syntax '{line}'")));
        }
        let direction = direction
            .ok_or_else(|| err(1, "executable graph is empty; expected flowchart header"))?;
        let initial =
            initial.ok_or("graph requires exactly one %% relay: initial STATE declaration")?;
        let graph = Self {
            direction,
            initial,
            nodes,
            edges,
        };
        graph.validate()?;
        Ok(graph)
    }

    pub fn validate(&self) -> Result<(), String> {
        let by_id: HashMap<_, _> = self.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
        if by_id
            .get(self.initial.as_str())
            .is_none_or(|n| n.kind != "state")
        {
            return Err(format!(
                "initial state '{}' is not a declared state node",
                self.initial
            ));
        }
        if self.edges.is_empty() {
            return Err("graph requires at least one executable edge".into());
        }
        let mut outgoing: HashMap<&str, Vec<&Edge>> = HashMap::new();
        for e in &self.edges {
            if !by_id.contains_key(e.from.as_str()) {
                return Err(err(
                    e.line,
                    format!("edge source '{}' is not declared", e.from),
                ));
            }
            if !by_id.contains_key(e.to.as_str()) {
                return Err(err(
                    e.line,
                    format!("edge target '{}' is not declared", e.to),
                ));
            }
            outgoing.entry(&e.from).or_default().push(e);
        }
        for node in &self.nodes {
            let exits = outgoing
                .get(node.id.as_str())
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            match node.kind.as_str() {
                "state" => {
                    let mut groups: HashMap<(&str, Option<&str>), Vec<&Edge>> = HashMap::new();
                    for e in exits {
                        if !matches!(e.kind.as_str(), "on" | "request") {
                            return Err(err(
                                e.line,
                                format!(
                                    "state '{}' may only have on:/request: exits",
                                    node.semantic_id
                                ),
                            ));
                        }
                        let target = by_id[e.to.as_str()];
                        if !matches!(target.kind.as_str(), "state" | "guard" | "action") {
                            return Err(err(
                                e.line,
                                "event/request edge must lead to state, guard, or action",
                            ));
                        }
                        groups
                            .entry((&e.kind, e.semantic_id.as_deref()))
                            .or_default()
                            .push(e);
                    }
                    for group in groups.values() {
                        if group.len() > 1
                            && (group.iter().any(|e| by_id[e.to.as_str()].kind != "guard")
                                || group.iter().map(|e| &e.to).collect::<HashSet<_>>().len()
                                    != group.len())
                        {
                            return Err(err(group[1].line, "ambiguous input path"));
                        }
                    }
                }
                "guard" => {
                    if exits.is_empty()
                        || exits.len() > 2
                        || exits
                            .iter()
                            .any(|e| !matches!(e.kind.as_str(), "true" | "false"))
                        || exits.iter().map(|e| &e.kind).collect::<HashSet<_>>().len()
                            != exits.len()
                    {
                        return Err(err(
                            node.line,
                            format!(
                                "guard '{}' requires one or two unique true/false exits",
                                node.semantic_id
                            ),
                        ));
                    }
                    for e in exits {
                        if !matches!(
                            by_id[e.to.as_str()].kind.as_str(),
                            "state" | "guard" | "action"
                        ) {
                            return Err(err(
                                e.line,
                                "guard edge must lead to state, guard, or action",
                            ));
                        }
                    }
                }
                "action" => {
                    let continuation: Vec<_> = exits
                        .iter()
                        .filter(|e| matches!(e.kind.as_str(), "to" | "unlabelled"))
                        .collect();
                    if continuation.len() != 1 {
                        return Err(err(node.line, "action requires exactly one continuation"));
                    }
                    for e in exits {
                        let target = by_id[e.to.as_str()];
                        match e.kind.as_str() {
                            "to" if target.kind == "state"
                                && e.semantic_id.as_deref()
                                    == Some(target.semantic_id.as_str()) => {}
                            "unlabelled" if matches!(target.kind.as_str(), "state" | "action") => {}
                            "emit"
                                if target.kind == "emit"
                                    && e.semantic_id.as_deref()
                                        == Some(target.semantic_id.as_str()) => {}
                            _ => return Err(err(e.line, "invalid action continuation/emission")),
                        }
                    }
                }
                "emit" => {
                    if !exits.is_empty() {
                        return Err(err(node.line, "emit node must not have outgoing edges"));
                    }
                }
                _ => return Err(err(node.line, "unknown node kind")),
            }
        }
        let mut reachable = HashSet::from([self.initial.as_str()]);
        loop {
            let before = reachable.len();
            for e in &self.edges {
                if reachable.contains(e.from.as_str()) {
                    reachable.insert(&e.to);
                }
            }
            if reachable.len() == before {
                break;
            }
        }
        for n in &self.nodes {
            if n.kind == "state" && !reachable.contains(n.id.as_str()) {
                return Err(err(
                    n.line,
                    format!(
                        "state '{}' is unreachable from initial state '{}'",
                        n.semantic_id, self.initial
                    ),
                ));
            }
        }
        Ok(())
    }
}
