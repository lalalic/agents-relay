//! Explicit shadow CLI. Never launches workers, writes SQLite or runs effects.
use agents_relay_rust::agent_graph::AgentGraph;
use agents_relay_rust::dispatch::ActionPorts;
use agents_relay_rust::graph::{Graph, GraphInput};
use agents_relay_rust::reconcile::propose_dependency_transitions;
use agents_relay_rust::store::RelayReader;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{self, BufRead};
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
struct DecisionRequest {
    #[serde(rename = "currentState")]
    current_state: String,
    input: GraphInput,
    #[serde(default)]
    guards: HashMap<String, bool>,
    #[serde(default)]
    receipts: HashMap<String, Value>,
}
#[derive(Default)]
struct ReplayPorts {
    receipts: HashMap<String, Value>,
    trace: Vec<Value>,
}
impl ActionPorts for ReplayPorts {
    fn persist_transition(&mut self, source: &str, target: &str) -> Result<(), String> {
        self.trace
            .push(json!({"type":"persist","source":source,"target":target}));
        Ok(())
    }
    fn execute_action(&mut self, id: &str, input: &GraphInput) -> Result<Value, String> {
        self.trace
            .push(json!({"type":"execute","id":id,"input":input}));
        Ok(self.receipts.get(id).cloned().unwrap_or(json!({})))
    }
    fn publish_event(&mut self, id: &str, payload: &Value) -> Result<(), String> {
        self.trace
            .push(json!({"type":"publish","id":id,"payload":payload}));
        Ok(())
    }
}
fn opt(args: &[String], name: &str) -> Result<String, String> {
    let position = args
        .iter()
        .position(|a| a == name)
        .ok_or_else(|| format!("missing {name}"))?;
    args.get(position + 1)
        .filter(|x| !x.starts_with("--"))
        .cloned()
        .ok_or_else(|| format!("missing value for {name}"))
}
fn load_graph(args: &[String]) -> Result<Graph, String> {
    let path = PathBuf::from(opt(args, "--graph")?);
    let source = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    Graph::parse(&source)
}
fn print_json(value: impl serde::Serialize) -> Result<(), String> {
    println!(
        "{}",
        serde_json::to_string(&value).map_err(|e| e.to_string())?
    );
    Ok(())
}
fn run(args: &[String]) -> Result<(), String> {
    if args.len() < 2 {
        return Err("usage: agents-relay-rust graph <validate|inventory|decide|batch|simulate> | store <list|get> --db PATH | scheduler inspect --db PATH --job-id ID --graph PATH".into());
    }
    match (args[0].as_str(),args[1].as_str()) {
        ("graph","validate") => {
            let graph=load_graph(args)?;
            print_json(json!({"valid":true,"direction":graph.direction,"initial":graph.initial,
                "nodes":graph.nodes.len(),"edges":graph.edges.len()}))
        }
        ("graph","inventory") => {
            let dir=PathBuf::from(opt(args,"--dir")?);
            let mut paths=std::fs::read_dir(&dir).map_err(|e|e.to_string())?
                .filter_map(|e|e.ok().map(|x|x.path())).filter(|p|p.extension().is_some_and(|x|x=="mmd"))
                .filter(|p|p.file_name().is_none_or(|n|n!="main.mmd")).collect::<Vec<_>>();
            paths.sort();
            let mut result=Vec::new();
            for path in paths {
                let graph=Graph::parse(&std::fs::read_to_string(&path).map_err(|e|e.to_string())?)
                    .map_err(|e|format!("{}: {e}",path.display()))?;
                result.push(json!({"file":path.file_name().unwrap().to_string_lossy(),
                    "nodes":graph.nodes.len(),"edges":graph.edges.len(),"initial":graph.initial}));
            }
            print_json(json!({"graphs":result,"count":result.len()}))
        }
        ("graph","decide") => {
            let graph=load_graph(args)?;
            let request: DecisionRequest=serde_json::from_str(&opt(args,"--request")?)
                .map_err(|e|e.to_string())?;
            print_json(graph.decide(&request.current_state,request.input,&request.guards)?)
        }
        ("graph","simulate") => {
            let graph=load_graph(args)?;
            let request:DecisionRequest=serde_json::from_str(&opt(args,"--request")?)
                .map_err(|e|e.to_string())?;
            let mut ports=ReplayPorts {receipts:request.receipts,trace:vec![]};
            let result=graph.dispatch(&request.current_state,request.input,&request.guards,&mut ports)?;
            print_json(json!({"result":result,"trace":ports.trace}))
        }
        ("graph","batch") => {
            let graph=load_graph(args)?;
            for line in io::stdin().lock().lines() {
                let line=line.map_err(|e|e.to_string())?;
                if line.trim().is_empty() {continue;}
                let output = serde_json::from_str::<DecisionRequest>(&line).map_err(|e|e.to_string())
                    .and_then(|r|graph.decide(&r.current_state,r.input,&r.guards))
                    .map_or_else(|error|json!({"error":error}),|decision|serde_json::to_value(decision).unwrap());
                print_json(output)?;
            }
            Ok(())
        }
        ("dag","parse") => {
            let path=PathBuf::from(opt(args,"--file")?);
            let source=std::fs::read_to_string(&path).map_err(|e|e.to_string())?;
            print_json(AgentGraph::parse(&source)?)
        }
        ("scheduler","inspect") => {
            let graph=load_graph(args)?;
            let db=PathBuf::from(opt(args,"--db")?);
            let job_id=opt(args,"--job-id")?;
            let store=RelayReader::open(&db)?;
            let job=store.get_job(&job_id)?.ok_or("Job not found")?;
            let proposals=propose_dependency_transitions(&job.job,&graph)?;
            print_json(json!({"jobId":job_id,"proposals":proposals}))
        }
        ("store","list") | ("store","get") => {
            // No default store path. An explicit read-only file is mandatory.
            let path=Path::new(&opt(args,"--db")?).to_path_buf();
            let store=RelayReader::open(&path)?;
            if args[1]=="get" {
                print_json(store.get_job(&opt(args,"--job-id")?)?)
            } else {
                let limit=opt(args,"--limit").unwrap_or_else(|_|"20".into()).parse::<u32>().map_err(|e|e.to_string())?;
                let offset=opt(args,"--offset").unwrap_or_else(|_|"0".into()).parse::<u32>().map_err(|e|e.to_string())?;
                print_json(store.list_jobs(limit,offset)?)
            }
        }
        _=>Err("unrecognized command; supported: graph validate/inventory/decide/batch/simulate, store list/get, scheduler inspect".into())
    }
}
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Err(error) = run(&args) {
        eprintln!("agents-relay-rust: {error}");
        std::process::exit(2);
    }
}
