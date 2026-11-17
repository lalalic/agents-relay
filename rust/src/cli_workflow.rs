// Direct Node src/cli-workflow.ts port: readonly Workflow Graph discovery,
// dry-run dispatch, authoritative SQLite verification and action trace lookup.
// Executable mutations are categorically rejected at this interface.
use crate::cli_core_support::arg;
use crate::workflow::{
    contracts::{WORKFLOW_EFFECT_NAMES, WORKFLOW_EVENT_NAMES, WORKFLOW_MUTATION_NAMES},
    dispatcher::{dispatch_workflow_graph_sync, DispatchOptions},
    graph_v2::{Graph, GraphRegistry, GraphRuntime},
    usage_index::{
        build_workflow_usage_index, default_workflow_directory, executable_graphs,
        where_workflow_symbol,
    },
};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use std::{path::Path, sync::Arc};
fn graph_source(graph: &Graph) -> String {
    graph.source.clone()
}
fn get(args: &[String], flag: &str) -> String {
    arg(args, flag, "").to_string()
}
fn sqlite(path: &str) -> Result<Connection, String> {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| e.to_string())
}
fn sql_err(e: rusqlite::Error) -> String {
    e.to_string()
}
fn gate(job: &Value) -> bool {
    let plans = job["plans"].as_array().cloned().unwrap_or_default();
    let latest = plans.iter().max_by(|a, b| {
        a["round"]
            .as_f64()
            .unwrap_or(0.)
            .total_cmp(&b["round"].as_f64().unwrap_or(0.))
    });
    let with_review = job["reviewEnabled"] != false;
    let plan = latest.is_some_and(|p| {
        p["status"] == "SUCCEEDED" && (with_review || p["objectiveStatus"] == "satisfied")
    });
    let tasks = job["tasks"].as_array().cloned().unwrap_or_default();
    let legacy = plans.is_empty()
        && tasks.iter().any(|t| {
            t["kind"] == "planner"
                && t["state"] == "SUCCEEDED"
                && (with_review || t["plannerResult"]["objective_status"] == "satisfied")
        });
    let coordinator = plans.is_empty()
        && tasks.iter().any(|t| {
            t["title"] == "Coordinator"
                && t.get("agentGraph")
                    .is_some_and(|v| v.as_str().is_some_and(|s| !s.is_empty()))
                && t["state"] == "SUCCEEDED"
        });
    let implementation = crate::runtime_status::implementation_tasks(job);
    (plan || legacy || coordinator)
        && !implementation.is_empty()
        && implementation
            .iter()
            .all(|task| task["state"] == "SUCCEEDED")
}
fn verify(
    db: &Connection,
    job_id: &str,
    predicate: &str,
    task_id: &str,
    exec_id: &str,
) -> Result<&'static str, String> {
    let json: Option<String> = db
        .query_row(
            "SELECT json FROM job_snapshot WHERE job_id=?",
            [job_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(sql_err)?;
    let Some(raw) = json else {
        return Ok("Unknown");
    };
    let job: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    if predicate == "job.objective-verified" {
        return Ok(if gate(&job) { "Verified" } else { "Failed" });
    }
    if predicate == "job.completed" {
        return Ok(if job["state"] == "COMPLETED" && gate(&job) {
            "Verified"
        } else {
            "Failed"
        });
    }
    let task = job["tasks"]
        .as_array()
        .and_then(|tasks| tasks.iter().find(|t| t["id"] == task_id));
    let Some(task) = task else {
        return Ok("Unknown");
    };
    Ok(match predicate {
        "task.queued" => {
            if task["state"] == "QUEUED" {
                "Verified"
            } else {
                "Failed"
            }
        }
        "task.succeeded" => {
            if task["state"] == "SUCCEEDED" {
                "Verified"
            } else {
                "Failed"
            }
        }
        "task.failed" => {
            if task["state"] == "FAILED" {
                "Verified"
            } else {
                "Failed"
            }
        }
        "task.routing-cleared" => {
            if task["executionId"].is_null()
                && task["leaseOwner"].as_str().is_none_or(str::is_empty)
            {
                "Verified"
            } else {
                "Failed"
            }
        }
        "task.execution-stopped" => {
            if exec_id.is_empty() {
                return Ok("Unknown");
            }
            if task["executionId"] == exec_id {
                return Ok("Failed");
            }
            if !task["executionHistory"]
                .as_array()
                .is_some_and(|h| h.iter().any(|e| e["id"] == exec_id))
            {
                return Ok("Unknown");
            }
            let exists:Option<String>=db.query_row("SELECT name FROM sqlite_master WHERE type='table' AND name='execution_process'",[],|r|r.get(0)).optional().map_err(sql_err)?;
            if exists.is_none() {
                return Ok("Unknown");
            }
            let ended:Option<String>=db.query_row(
                "SELECT ended_at FROM execution_process WHERE job_id=? AND task_id=? AND execution_id=?",
                (job_id,task["id"].as_str().unwrap_or(""),exec_id),|r|r.get(0)).optional().map_err(sql_err)?.flatten();
            if ended.as_deref().is_some_and(|e| !e.is_empty()) {
                "Verified"
            } else {
                "Unknown"
            }
        }
        _ => "Unknown",
    })
}
pub fn workflow_cli_result(args: &[String]) -> Result<Value, String> {
    let verb = args.first().map(String::as_str).unwrap_or("");
    let options = if args.is_empty() { &[][..] } else { &args[1..] };
    let graphs = executable_graphs(&default_workflow_directory())?;
    let index = build_workflow_usage_index(&graphs);
    if verb == "discover" {
        let mut symbols = index
            .iter()
            .filter_map(|item| item["id"].as_str())
            .map(str::to_string)
            .collect::<Vec<_>>();
        symbols.sort();
        symbols.dedup();
        return Ok(json!({"graphs":graphs.keys().collect::<Vec<_>>(),"symbols":symbols}));
    }
    if verb == "actions" {
        let mut ids = index
            .iter()
            .filter(|item| item["kind"] == "action")
            .filter_map(|item| item["id"].as_str())
            .map(str::to_string)
            .collect::<Vec<_>>();
        ids.sort();
        ids.dedup();
        let actions = ids
            .iter()
            .map(|id| {
                json!({"id":id,"graphReferences":where_workflow_symbol(&index,id,Some("action")),
            "cli":"inspect-only; execution requires owning Graph runtime"})
            })
            .collect::<Vec<_>>();
        return Ok(json!({"count":ids.len(),"actions":actions,"taskControls":[
            "task.retry","task.recover","task.cancel","task.unblock","task.escalate","task.resume-troubleshooter"],
            "warning":"Task controls are not equivalent to arbitrary internal Graph Action execution. No direct CLI bypass of guards or SQLite fencing."}));
    }
    if verb == "where" {
        return Ok(json!(where_workflow_symbol(
            &index,
            &get(options, "--id"),
            None
        )));
    }
    if verb == "inspect" || verb == "evaluate" {
        let name = get(options, "--graph");
        let graph = graphs.get(&name).ok_or("unknown executable graph")?;
        if verb == "inspect" {
            return Ok(
                json!({"graph":name,"initial":graph.initial,"nodes":graph.json()["nodes"],"edges":graph.json()["edges"]}),
            );
        }
        let event = get(options, "--event");
        let state = get(options, "--state");
        if event.is_empty() || state.is_empty() {
            return Err("evaluate requires --event and --state".into());
        }
        let raw = get(options, "--facts");
        let facts = if raw.is_empty() {
            json!({})
        } else {
            serde_json::from_str::<Value>(&raw).map_err(|e| e.to_string())?
        };
        if !facts.is_object() {
            return Err("facts must be a JSON object".into());
        }
        let mut registry = GraphRegistry {
            states: graph
                .nodes
                .iter()
                .filter(|node| node.kind == "state")
                .map(|node| node.semantic_id.clone())
                .collect(),
            ..GraphRegistry::default()
        };
        for guard in graph.nodes.iter().filter(|node| node.kind == "guard") {
            let id = guard.semantic_id.clone();
            let key = id.clone();
            registry.guards.insert(
                id,
                Arc::new(move |facts: &Value| facts["durableFacts"][&key] == true),
            );
        }
        for id in WORKFLOW_EFFECT_NAMES
            .iter()
            .chain(WORKFLOW_MUTATION_NAMES.iter())
            .map(|s| s.to_string())
            .chain(
                graph
                    .nodes
                    .iter()
                    .filter(|n| n.kind == "action")
                    .map(|n| n.semantic_id.clone()),
            )
        {
            registry.actions.insert(id, (None, None));
        }
        for id in WORKFLOW_EVENT_NAMES
            .iter()
            .map(|s| s.to_string())
            .chain(std::iter::once(event.clone()))
            .chain(
                graph
                    .edges
                    .iter()
                    .filter(|e| matches!(e.kind.as_str(), "on" | "emit"))
                    .filter_map(|e| e.semantic_id.clone()),
            )
        {
            registry.events.insert(id, None);
        }
        let runtime = GraphRuntime::new(&graph_source(graph), registry)?;
        let options = DispatchOptions {
            initial_state: &state,
            input: json!({"transport":"event","id":event,"payload":{}}),
            durable_facts: facts,
            max_steps: 1,
            observe: false,
            graph_name: None,
        };
        let decision = dispatch_workflow_graph_sync(
            &runtime,
            &options,
            |_| false,
            |_, _| Ok(()),
            |_| Ok(json!({"ok":true})),
            |_, _| Ok(()),
        )?;
        return Ok(json!({"mode":"dry-run","decision":decision}));
    }
    if verb == "verify" {
        let path = get(options, "--sqlite");
        let job_id = get(options, "--job");
        let predicate = get(options, "--condition");
        if path.is_empty()
            || !Path::new(&path).exists()
            || job_id.is_empty()
            || !matches!(
                predicate.as_str(),
                "task.queued"
                    | "task.succeeded"
                    | "task.failed"
                    | "task.routing-cleared"
                    | "task.execution-stopped"
                    | "job.objective-verified"
                    | "job.completed"
            )
        {
            return Err(
                "verify requires existing --sqlite, --job and supported --condition".into(),
            );
        }
        let db = sqlite(&path)?;
        let task = get(options, "--task");
        let execution = get(options, "--execution");
        let outcome = verify(&db, &job_id, &predicate, &task, &execution)?;
        return Ok(
            json!({"condition":predicate,"jobId":job_id,"taskId":if task.is_empty(){Value::Null}else{json!(task)},
            "outcome":outcome}),
        );
    }
    if verb == "trace" {
        let path = get(options, "--sqlite");
        let key = get(options, "--attempt-key");
        if path.is_empty() || key.is_empty() || !Path::new(&path).exists() {
            return Err("trace requires existing --sqlite path and --attempt-key".into());
        }
        let db = sqlite(&path)?;
        let exists:Option<String>=db.query_row("SELECT name FROM sqlite_master WHERE type='table' AND name='workflow_action_trace'",
            [],|r|r.get(0)).optional().map_err(sql_err)?;
        if exists.is_none() {
            return Ok(json!({"attemptKey":key,"trace":null}));
        }
        let found:Option<Value>=db.query_row(
          "SELECT attempt_key,execution_id,generation,graph,action_id,condition_id,outcome,observed_at FROM workflow_action_trace WHERE attempt_key=?",
          [&key],|row|{
            let fields=["attempt_key","execution_id","generation","graph","action_id","condition_id","outcome","observed_at"];
            let mut m=serde_json::Map::new();
            for (i,name) in fields.iter().enumerate(){
                let value:rusqlite::types::Value=row.get(i)?;
                let json=match value{rusqlite::types::Value::Null=>Value::Null,
                    rusqlite::types::Value::Integer(i)=>json!(i),
                    rusqlite::types::Value::Real(f)=>json!(f),
                    rusqlite::types::Value::Text(t)=>json!(t),
                    rusqlite::types::Value::Blob(b)=>json!(b)};
                m.insert((*name).into(),json);
            }
            Ok(Value::Object(m))
          }).optional().map_err(sql_err)?;
        return Ok(json!({"attemptKey":key,"trace":found}));
    }
    if verb == "action" {
        return Err("durable graph authorization required; unsafe action request refused".into());
    }
    Err("workflow supports discover, actions, inspect, where, evaluate, verify, trace; mutations require durable authorization".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn a(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }
    #[test]
    fn mutations_are_rejected_and_discovery_is_read_only() {
        assert_eq!(
            workflow_cli_result(&a(&["action"])).unwrap_err(),
            "durable graph authorization required; unsafe action request refused"
        );
        assert!(
            workflow_cli_result(&a(&["inspect", "--graph", "missing.mmd"]))
                .unwrap_err()
                .contains("unknown executable graph")
        );
        assert!(workflow_cli_result(&a(&["discover"])).unwrap()["graphs"]
            .as_array()
            .is_some_and(|a| !a.is_empty()));
        assert_eq!(
            workflow_cli_result(&a(&["trace"])).unwrap_err(),
            "trace requires existing --sqlite path and --attempt-key"
        );
    }
}
