// Direct port of src/workflow/mermaid.ts: parse executable Mermaid graphs and evaluate bound workflow guards/actions.
use crate::js_text::trim_js;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkflowTransition {
    pub from: String,
    pub to: String,
    pub event: String,
    pub guard: Option<String>,
    pub actions: Vec<String>,
    pub line: usize,
}

impl WorkflowTransition {
    pub fn json(&self) -> Value {
        json!({"from":self.from,"to":self.to,"event":self.event,"guard":self.guard,"actions":self.actions,"line":self.line})
    }
}

#[derive(Clone, Debug)]
pub struct WorkflowGraph {
    pub source: String,
    pub states: Vec<String>,
    pub initial: String,
    pub finals: Vec<String>,
    pub transitions: Vec<WorkflowTransition>,
}

impl WorkflowGraph {
    pub fn json(&self) -> Value {
        json!({"source":self.source,"states":self.states,"initial":self.initial,"finals":self.finals,
            "transitions":self.transitions.iter().map(WorkflowTransition::json).collect::<Vec<_>>()})
    }
}

fn transition_regex() -> Regex {
    let state = r"(?:[A-Za-z_][A-Za-z0-9_.-]*|\[\*\])";
    let js_ws = r"[\x09-\x0D\x20\u{00A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]";
    Regex::new(&format!(r"^({state}){js_ws}*-->{js_ws}*({state})(?:{js_ws}*:{js_ws}*([^\r\n\u{{2028}}\u{{2029}}]+))?$"))
        .expect("fixed executable transition regex")
}

fn valid_name(value: &str) -> bool {
    Regex::new(r"^[A-Za-z_][A-Za-z0-9_.-]*$")
        .expect("fixed name regex")
        .is_match(value)
}

fn parse_label(
    label: Option<&str>,
    line: usize,
    terminal: bool,
) -> Result<(String, Option<String>, Vec<String>), String> {
    let label = label.map(trim_js).unwrap_or("");
    if label.is_empty() {
        if terminal {
            return Ok((String::new(), None, Vec::new()));
        }
        return Err(format!(
            "Executable Mermaid transition at line {line} requires an event label"
        ));
    }
    let pieces = label.split('/').collect::<Vec<_>>();
    if pieces.len() > 2 {
        return Err(format!(
            "Executable Mermaid label at line {line} may contain at most one '/' action separator"
        ));
    }
    let left = trim_js(pieces[0]);
    // Greedy-with-backtracking JavaScript event pattern and optional bracketed
    // guard, with JS whitespace rather than Rust's Unicode White_Space.
    let js_ws = r"[\x09-\x0D\x20\u{00A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]";
    let regex = Regex::new(&format!(
        r"^(.*?)(?:{js_ws}+\[([A-Za-z_][A-Za-z0-9_.-]*)\])?$"
    ))
    .expect("fixed workflow label regex");
    let Some(captures) = regex.captures(left) else {
        return Err(format!("Invalid executable Mermaid label at line {line}"));
    };
    let event = trim_js(captures.get(1).map(|m| m.as_str()).unwrap_or(""));
    let guard = captures.get(2).map(|m| m.as_str().to_string());
    if event.is_empty() || !valid_name(event) {
        return Err(format!("Invalid event '{event}' at line {line}"));
    }
    let mut actions = Vec::new();
    if let Some(actions_src) = pieces.get(1) {
        for item in actions_src.split(',') {
            let action = trim_js(item);
            if action.is_empty() {
                continue;
            }
            if !valid_name(action) {
                return Err(format!("Invalid action '{action}' at line {line}"));
            }
            actions.push(action.to_string());
        }
    }
    Ok((event.to_string(), guard, actions))
}

fn include_once(values: &mut Vec<String>, value: &str) {
    if !values.iter().any(|stored| stored == value) {
        values.push(value.to_string());
    }
}

pub fn parse_executable_mermaid(source: &str) -> Result<WorkflowGraph, String> {
    let regex = transition_regex();
    let mut header_seen = false;
    let mut states = Vec::new();
    let mut finals = Vec::new();
    let mut transitions = Vec::<WorkflowTransition>::new();
    let mut initials = Vec::<String>::new();
    for (index, raw_line) in source.split('\n').enumerate() {
        let number = index + 1;
        let line = trim_js(raw_line);
        if line.is_empty() || line.starts_with("%%") {
            continue;
        }
        if !header_seen {
            if line != "stateDiagram-v2" {
                return Err(format!(
                    "Executable Mermaid must start with stateDiagram-v2 (line {number})"
                ));
            }
            header_seen = true;
            continue;
        }
        let captures = regex.captures(line).ok_or_else(|| {
            format!("Unsupported executable Mermaid syntax at line {number}: {line}")
        })?;
        let from = captures[1].to_string();
        let to = captures[2].to_string();
        let label = captures.get(3).map(|m| m.as_str());
        let from_terminal = from == "[*]";
        let to_terminal = to == "[*]";
        if from_terminal && to_terminal {
            return Err(format!("Invalid [*] -> [*] transition at line {number}"));
        }
        if !from_terminal {
            include_once(&mut states, &from);
        }
        if !to_terminal {
            include_once(&mut states, &to);
        }
        if from_terminal {
            if label.is_some_and(|value| !trim_js(value).is_empty()) {
                return Err(format!(
                    "Initial transition at line {number} must not have an event label"
                ));
            }
            initials.push(to);
            continue;
        }
        if to_terminal {
            if label.is_some_and(|value| !trim_js(value).is_empty()) {
                return Err(format!(
                    "Final transition at line {number} must not have an event label"
                ));
            }
            include_once(&mut finals, &from);
            continue;
        }
        let (event, guard, actions) = parse_label(label, number, false)?;
        transitions.push(WorkflowTransition {
            from,
            to,
            event,
            guard,
            actions,
            line: number,
        });
    }
    if !header_seen {
        return Err("Executable Mermaid is empty".to_string());
    }
    if initials.len() != 1 {
        return Err(format!(
            "Executable Mermaid requires exactly one [*] initial transition; found {}",
            initials.len()
        ));
    }
    if transitions.is_empty() {
        return Err("Executable Mermaid requires at least one executable transition".to_string());
    }
    let mut seen = HashSet::new();
    let mut deterministic = HashSet::new();
    for transition in &transitions {
        let guard = transition.guard.as_deref().unwrap_or("");
        let key = format!(
            "{}\0{}\0{}\0{}",
            transition.from, transition.event, guard, transition.to
        );
        if !seen.insert(key) {
            return Err(format!(
                "Duplicate executable transition at line {}: {} --{}--> {}",
                transition.line, transition.from, transition.event, transition.to
            ));
        }
        let deterministic_key = format!("{}\0{}\0{}", transition.from, transition.event, guard);
        if !deterministic.insert(deterministic_key) {
            let guard_text = if guard.is_empty() { "unguarded" } else { guard };
            return Err(format!("Ambiguous executable transition at line {}: duplicate source/event/guard {} --{} [{}]",
                transition.line, transition.from, transition.event,guard_text));
        }
    }
    Ok(WorkflowGraph {
        source: source.to_string(),
        states,
        initial: initials.remove(0),
        finals,
        transitions,
    })
}

pub type AsyncGuard = Pin<Box<dyn Future<Output = Result<bool, String>> + Send>>;
pub type AsyncAction = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;

// Callback failures are propagated just as Node's throwing/rejected
// Guard/Action handlers reject the selected Graph transition.
pub type SyncGuardHandler = Arc<dyn Fn(&Value) -> Result<bool, String> + Send + Sync>;
pub type AsyncGuardHandler = Arc<dyn Fn(&Value) -> AsyncGuard + Send + Sync>;
pub type SyncActionHandler =
    Arc<dyn Fn(&Value, &WorkflowTransition) -> Result<(), String> + Send + Sync>;
pub type AsyncActionHandler = Arc<dyn Fn(&Value, &WorkflowTransition) -> AsyncAction + Send + Sync>;
pub enum WorkflowGuard {
    Sync(SyncGuardHandler),
    Async(AsyncGuardHandler),
}
pub enum WorkflowAction {
    Declarative,
    Sync(SyncActionHandler),
    Async(AsyncActionHandler),
}

pub struct WorkflowEngine {
    pub graph: WorkflowGraph,
    guards: HashMap<String, WorkflowGuard>,
    actions: HashMap<String, WorkflowAction>,
}

impl WorkflowEngine {
    pub fn new(
        graph: WorkflowGraph,
        guards: HashMap<String, WorkflowGuard>,
        actions: HashMap<String, WorkflowAction>,
    ) -> Result<Self, String> {
        for transition in &graph.transitions {
            if let Some(guard) = &transition.guard {
                if !guards.contains_key(guard) {
                    return Err(format!(
                        "Unknown workflow guard {guard} referenced at line {}",
                        transition.line
                    ));
                }
            }
            for action in &transition.actions {
                if !actions.contains_key(action) {
                    return Err(format!(
                        "Unknown workflow action {action} referenced at line {}",
                        transition.line
                    ));
                }
            }
        }
        Ok(Self {
            graph,
            guards,
            actions,
        })
    }

    pub fn transitions_from(&self, state: &str) -> Result<Vec<&WorkflowTransition>, String> {
        if !self.graph.states.iter().any(|name| name == state) {
            return Err(format!("Unknown workflow state {state}"));
        }
        Ok(self
            .graph
            .transitions
            .iter()
            .filter(|transition| transition.from == state)
            .collect())
    }

    pub fn assert_state_transition(&self, from: &str, to: &str, kind: &str) -> Result<(), String> {
        if from == to {
            return Ok(());
        }
        if !self.graph.states.iter().any(|name| name == from) {
            return Err(format!("Unknown {kind} state {from}"));
        }
        if !self.graph.states.iter().any(|name| name == to) {
            return Err(format!("Unknown {kind} state {to}"));
        }
        if !self
            .graph
            .transitions
            .iter()
            .any(|t| t.from == from && t.to == to)
        {
            return Err(format!("Invalid {kind} transition {from} -> {to}"));
        }
        Ok(())
    }

    pub fn enabled_sync(
        &self,
        state: &str,
        event: &str,
        context: &Value,
    ) -> Result<Vec<&WorkflowTransition>, String> {
        let mut enabled = Vec::new();
        for transition in self
            .transitions_from(state)?
            .into_iter()
            .filter(|t| t.event == event)
        {
            match transition
                .guard
                .as_deref()
                .and_then(|name| self.guards.get(name))
            {
                None => enabled.push(transition),
                Some(WorkflowGuard::Sync(call)) => {
                    if call(context)? {
                        enabled.push(transition);
                    }
                }
                Some(WorkflowGuard::Async(call)) => {
                    drop(call(context));
                    return Err(format!("Workflow guard {} is asynchronous and cannot be used in a synchronous transition",transition.guard.as_deref().unwrap_or("")));
                }
            }
        }
        Ok(enabled)
    }

    pub fn transition_sync(
        &self,
        state: &str,
        event: &str,
        context: &Value,
    ) -> Result<String, String> {
        let enabled = self.enabled_sync(state, event, context)?;
        let transition = self.select_transition(&enabled, state, event)?;
        for action_name in &transition.actions {
            match self.actions.get(action_name) {
                Some(WorkflowAction::Sync(call)) => call(context, transition)?,
                Some(WorkflowAction::Async(call)) => {
                    drop(call(context, transition));
                    return Err(format!("Workflow action {action_name} is asynchronous and cannot be used in a synchronous transition"));
                }
                _ => {}
            }
        }
        Ok(transition.to.clone())
    }

    pub async fn enabled(
        &self,
        state: &str,
        event: &str,
        context: &Value,
    ) -> Result<Vec<&WorkflowTransition>, String> {
        let mut enabled = Vec::new();
        for transition in self
            .transitions_from(state)?
            .into_iter()
            .filter(|t| t.event == event)
        {
            let accepted = match transition
                .guard
                .as_deref()
                .and_then(|name| self.guards.get(name))
            {
                None => true,
                Some(WorkflowGuard::Sync(call)) => call(context)?,
                Some(WorkflowGuard::Async(call)) => call(context).await?,
            };
            if accepted {
                enabled.push(transition);
            }
        }
        Ok(enabled)
    }

    pub async fn transition(
        &self,
        state: &str,
        event: &str,
        context: &Value,
    ) -> Result<String, String> {
        let enabled = self.enabled(state, event, context).await?;
        let transition = self.select_transition(&enabled, state, event)?;
        for action_name in &transition.actions {
            match self.actions.get(action_name) {
                Some(WorkflowAction::Sync(call)) => call(context, transition)?,
                Some(WorkflowAction::Async(call)) => call(context, transition).await?,
                _ => {}
            }
        }
        Ok(transition.to.clone())
    }

    fn select_transition<'a>(
        &self,
        enabled: &'a [&WorkflowTransition],
        state: &str,
        event: &str,
    ) -> Result<&'a WorkflowTransition, String> {
        match enabled {
            [] => Err(format!(
                "No enabled workflow transition from {state} on {event}"
            )),
            [single] => Ok(single),
            _ => Err(format!(
                "Ambiguous workflow transition from {state} on {event}"
            )),
        }
    }
}
