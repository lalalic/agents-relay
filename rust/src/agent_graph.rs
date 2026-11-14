//! Agent Graph structural parser. The canonical agentGraph Mermaid source is
//! supplied by the caller; no Task generation or Worker policy lives here.
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::LazyLock;

static HEADER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^flowchart\s+(?:TD|TB|LR|RL)$").unwrap());
static EDGE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([A-Za-z_][A-Za-z0-9_.-]*)(?:\[agent:([A-Za-z_][A-Za-z0-9_.-]*)\])?\s*-->\s*([A-Za-z_][A-Za-z0-9_.-]*)(?:\[agent:([A-Za-z_][A-Za-z0-9_.-]*)\])?$").unwrap()
});
static NODE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([A-Za-z_][A-Za-z0-9_.-]*)\[agent:([A-Za-z_][A-Za-z0-9_.-]*)\]$").unwrap()
});
#[derive(Debug, Clone, Serialize, Deserialize, Eq, PartialEq)]
pub struct AgentNode {
    pub id: String,
    pub agent: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, Eq, PartialEq)]
pub struct AgentEdge {
    pub from: String,
    pub to: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, Eq, PartialEq)]
pub struct AgentGraph {
    pub source: String,
    pub nodes: Vec<AgentNode>,
    pub edges: Vec<AgentEdge>,
    pub waves: Vec<Vec<String>>,
}
impl AgentGraph {
    pub fn parse(source: &str) -> Result<Self, String> {
        let mut header = false;
        // JS Map insertion order matters in nodes; do not sort these.
        let mut nodes = Vec::<AgentNode>::new();
        let mut edges = Vec::<AgentEdge>::new();
        let mut seen = BTreeMap::<String, usize>::new();
        fn set_agent(
            nodes: &mut Vec<AgentNode>,
            seen: &mut BTreeMap<String, usize>,
            id: &str,
            agent: Option<&str>,
        ) {
            match seen.get(id) {
                Some(index) => {
                    if let Some(agent) = agent {
                        nodes[*index].agent = agent.into();
                    }
                }
                None => {
                    seen.insert(id.into(), nodes.len());
                    nodes.push(AgentNode {
                        id: id.into(),
                        agent: agent.unwrap_or(id).into(),
                    });
                }
            }
        }
        for (index, raw) in source.lines().enumerate() {
            let line = raw.trim();
            if line.is_empty() || line.starts_with("%%") {
                continue;
            }
            if !header {
                if !HEADER.is_match(line) {
                    return Err(format!(
                        "Agent Graph must start with Mermaid flowchart TD/TB/LR/RL (line {})",
                        index + 1
                    ));
                }
                header = true;
                continue;
            }
            if let Some(edge) = EDGE.captures(line) {
                let (from, to) = (&edge[1], &edge[3]);
                set_agent(&mut nodes, &mut seen, from, edge.get(2).map(|v| v.as_str()));
                set_agent(&mut nodes, &mut seen, to, edge.get(4).map(|v| v.as_str()));
                edges.push(AgentEdge {
                    from: from.into(),
                    to: to.into(),
                });
                continue;
            }
            if let Some(node) = NODE.captures(line) {
                set_agent(&mut nodes, &mut seen, &node[1], Some(&node[2]));
                continue;
            }
            return Err(format!(
                "Unsupported Agent Graph syntax at line {}: {line}",
                index + 1
            ));
        }
        if !header {
            return Err("Agent Graph is empty".into());
        }
        if nodes.is_empty() {
            return Err("Agent Graph requires at least one agent node".into());
        }
        let mut incoming = nodes
            .iter()
            .map(|n| (n.id.clone(), 0i64))
            .collect::<BTreeMap<_, _>>();
        let mut outgoing = nodes
            .iter()
            .map(|n| (n.id.clone(), Vec::<String>::new()))
            .collect::<BTreeMap<_, _>>();
        for edge in &edges {
            if edge.from == edge.to {
                return Err(format!("Agent Graph self-cycle at {}", edge.from));
            }
            *incoming.get_mut(&edge.to).ok_or("undefined target")? += 1;
            outgoing
                .get_mut(&edge.from)
                .ok_or("undefined source")?
                .push(edge.to.clone());
        }
        let mut ready = incoming
            .iter()
            .filter(|(_, degree)| **degree == 0)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        let mut waves = Vec::new();
        let mut visited = 0usize;
        while !ready.is_empty() {
            ready.sort();
            visited += ready.len();
            let mut next = BTreeSet::new();
            for id in &ready {
                for to in outgoing.get(id).ok_or("missing graph edge")? {
                    let degree = incoming.get_mut(to).ok_or("missing incoming edge")?;
                    *degree -= 1;
                    if *degree == 0 {
                        next.insert(to.clone());
                    }
                }
            }
            waves.push(ready);
            ready = next.into_iter().collect();
        }
        if visited != nodes.len() {
            return Err("Agent Graph contains a cycle".into());
        }
        Ok(Self {
            source: source.into(),
            nodes,
            edges,
            waves,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn waves_and_agent_overrides_are_topological() {
        let src="flowchart TD\nC[agent:reviewer]\nA[agent:vision]\nA --> C\nA --> B[agent:editor]\nB --> C";
        let graph = AgentGraph::parse(src).unwrap();
        assert_eq!(graph.waves, [vec!["A"], vec!["B"], vec!["C"]]);
        assert_eq!(
            graph.nodes.iter().find(|n| n.id == "C").unwrap().agent,
            "reviewer"
        );
        assert!(AgentGraph::parse("flowchart LR\nA --> B\nB --> A").is_err());
    }
}
