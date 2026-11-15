//! Explicit shadow CLI. Never launches workers, writes SQLite or runs effects.
use agents_relay_rust::agent_graph::AgentGraph;
use agents_relay_rust::authority::probe_process;
use agents_relay_rust::dispatch::ActionPorts;
use agents_relay_rust::final_review::propose_final_review;
use agents_relay_rust::graph::{Graph, GraphInput};
use agents_relay_rust::reconcile::propose_dependency_transitions;
use agents_relay_rust::recovery::inspect_expired_execution;
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
fn inspection_options(
    args: &[String],
    allowed: &[&str],
) -> Result<HashMap<String, String>, String> {
    let mut options = HashMap::new();
    let mut index = 2;
    while index < args.len() {
        let name = args[index].as_str();
        if !allowed.contains(&name) {
            return Err(format!(
                "unrecognized argument for inspection command: {name}"
            ));
        }
        if options.contains_key(name) {
            return Err(format!("duplicate argument: {name}"));
        }
        let value = args
            .get(index + 1)
            .filter(|value| !value.starts_with("--") && !value.is_empty())
            .ok_or_else(|| format!("missing value for {name}"))?;
        options.insert(name.to_string(), value.clone());
        index += 2;
    }
    for required in allowed {
        if !options.contains_key(*required) {
            return Err(format!("missing {required}"));
        }
    }
    Ok(options)
}
fn optional_inspection_options(
    args: &[String],
    allowed: &[&str],
    required: &[&str],
) -> Result<HashMap<String, String>, String> {
    let mut options = HashMap::new();
    let mut index = 2;
    while index < args.len() {
        let name = args[index].as_str();
        if !allowed.contains(&name) {
            return Err(format!(
                "unrecognized argument for inspection command: {name}"
            ));
        }
        if options.contains_key(name) {
            return Err(format!("duplicate argument: {name}"));
        }
        let value = args
            .get(index + 1)
            .filter(|value| !value.starts_with("--") && !value.is_empty())
            .ok_or_else(|| format!("missing value for {name}"))?;
        options.insert(name.to_string(), value.clone());
        index += 2;
    }
    for name in required {
        if !options.contains_key(*name) {
            return Err(format!("missing {name}"));
        }
    }
    Ok(options)
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
fn job_timestamp(job: &Value) -> i64 {
    [job["updatedAt"].as_str(), job["createdAt"].as_str()]
        .into_iter()
        .flatten()
        .find_map(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .map_or(0, |timestamp| timestamp.timestamp_millis())
}
fn run(args: &[String]) -> Result<(), String> {
    if args.len() < 2 {
        return Err("usage: agents-relay-rust graph <validate|inventory|decide|batch|simulate> | store <list|get> --db PATH | job <list --db PATH [--repo NAME]|show --db PATH --job-id ID> | task <list|show|events> --db PATH --job-id ID [--task-id ID] | scheduler inspect/recovery --db PATH --job-id ID | dag parse --file PATH".into());
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
        ("review","inspect") => {
            let db=PathBuf::from(opt(args,"--db")?);
            let job_id=opt(args,"--job-id")?;
            let head=opt(args,"--verified-local-head")?;
            let store=RelayReader::open(&db)?;
            let job=store.get_job(&job_id)?.ok_or("Final Review Job not found")?;
            print_json(propose_final_review(&job.job,&head)?)
        }
        ("scheduler","recovery") => {
            let db=PathBuf::from(opt(args,"--db")?);
            let job_id=opt(args,"--job-id")?;
            let task_id=opt(args,"--task-id")?;
            let now=opt(args,"--now")?;
            let owner_active=match opt(args,"--owner-activity")?.as_str() {
                "active"=>true,"inactive"=>false,
                _=>return Err("--owner-activity must be active or inactive".into()),
            };
            let store=RelayReader::open(&db)?;
            let job=store.get_job(&job_id)?.ok_or("Recovery Job not found")?;
            let execution=job.job["tasks"].as_array().ok_or("Job tasks missing")?
                .iter().find(|t|t["id"]==task_id).and_then(|t|t["executionId"].as_str())
                .ok_or("Recovery Task has no active execution")?;
            let process=store.get_process(&job_id,&task_id,execution)?;
            let probe=probe_process(process.as_ref());
            let assessment=inspect_expired_execution(&job.job,&task_id,&now,probe,owner_active)?;
            print_json(json!({"processProbe":probe,"assessment":assessment}))
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
        ("job", "list") => {
            let options = optional_inspection_options(args, &["--db", "--repo"], &["--db"])?;
            let store = RelayReader::open(Path::new(&options["--db"]))?;
            let requested_repo = options.get("--repo");
            let mut offset = 0_u32;
            let mut jobs = Vec::new();
            loop {
                let page = store.list_jobs(1000, offset)?;
                let count = page.len() as u32;
                jobs.extend(page.into_iter()
                    .filter(|snapshot| requested_repo.is_none_or(|repo| snapshot.job["repository"].as_str() == Some(repo)))
                    .map(|snapshot| snapshot.job));
                if count < 1000 { break; }
                offset = offset.checked_add(count).ok_or("Job list offset overflow")?;
            }
            jobs.sort_by(|left, right| {
                job_timestamp(right).cmp(&job_timestamp(left))
                    .then_with(|| left["repository"].as_str().unwrap_or("").cmp(right["repository"].as_str().unwrap_or("")))
                    .then_with(|| left["id"].as_str().unwrap_or("").cmp(right["id"].as_str().unwrap_or("")))
            });
            print_json(jobs)
        }
        ("job", "show") => {
            let options = inspection_options(args, &["--db", "--job-id"])?;
            let store = RelayReader::open(Path::new(&options["--db"]))?;
            let job_id = &options["--job-id"];
            let job = store
                .get_job(job_id)?
                .ok_or_else(|| format!("Job {job_id} not found"))?;
            print_json(job.job)
        }
        ("task", "list") => {
            let options = inspection_options(args, &["--db", "--job-id"])?;
            let store = RelayReader::open(Path::new(&options["--db"]))?;
            let job_id = &options["--job-id"];
            let job = store
                .get_job(job_id)?
                .ok_or_else(|| format!("Job {job_id} not found"))?;
            let tasks = job
                .job
                .get("tasks")
                .and_then(Value::as_array)
                .ok_or_else(|| format!("Job {job_id} has no task list"))?;
            print_json(tasks)
        }
        ("task", "show") => {
            let options = inspection_options(args, &["--db", "--job-id", "--task-id"])?;
            let store = RelayReader::open(Path::new(&options["--db"]))?;
            let job_id = &options["--job-id"];
            let task_id = &options["--task-id"];
            let job = store
                .get_job(job_id)?
                .ok_or_else(|| format!("Job {job_id} not found"))?;
            let tasks = job
                .job
                .get("tasks")
                .and_then(Value::as_array)
                .ok_or_else(|| format!("Job {job_id} has no task list"))?;
            let task = tasks
                .iter()
                .find(|task| task.get("id").and_then(Value::as_str) == Some(task_id))
                .ok_or_else(|| format!("Task {task_id} not found in Job {job_id}"))?;
            print_json(task)
        }
        ("task", "events") => {
            let options = optional_inspection_options(
                args,
                &["--db", "--job-id", "--task-id", "--limit", "--order", "--after"],
                &["--db", "--job-id", "--task-id"],
            )?;
            let limit = options.get("--limit").map_or(Ok(60), |value| value.parse::<usize>()
                .map_err(|_| "task events --limit must be an integer from 1 to 60".to_string()))?;
            let order = options.get("--order").map(String::as_str).unwrap_or("desc");
            let after = options.get("--after").map_or(Ok(0), |value| value.parse::<i64>()
                .map_err(|_| "task events --after must be a non-negative integer cursor".to_string()))?;
            if after > 9_007_199_254_740_991 {
                return Err("task events --after must be a safe integer cursor".into());
            }
            if options.contains_key("--after") && order != "asc" {
                return Err("task events --after requires --order asc".into());
            }
            let store = RelayReader::open(Path::new(&options["--db"]))?;
            let job_id = &options["--job-id"];
            let task_id = &options["--task-id"];
            if store.get_job(job_id)?.is_none() {
                return Err(format!("Job {job_id} not found"));
            }
            if store.get_task(job_id, task_id)?.is_none() {
                return Err(format!("Task {task_id} not found in Job {job_id}"));
            }
            print_json(store.task_events(
                job_id, Some(task_id), limit, order, after,
            )?)
        }
        _=>Err("unrecognized command; supported: graph validate/inventory/decide/batch/simulate, store list/get, job list/show, task list/show/events, scheduler inspect/recovery".into())
    }
}
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Err(error) = run(&args) {
        eprintln!("agents-relay-rust: {error}");
        std::process::exit(2);
    }
}
