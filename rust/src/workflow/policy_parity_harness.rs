// Isolated tests for Node workflow/dispatcher.ts + the nine Graph policy adapters.
// Mirrors caller-defined callback receipts but never touches a production Job or Relay DB.
use super::{
    dispatcher::{dispatch_workflow_graph_sync, DispatchOptions},
    policy_graph::load_policy_graph_source,
};
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    future::Future,
    path::Path,
    pin::pin,
    rc::Rc,
    task::{Context, Poll, Waker},
};
fn drive<T>(future: impl Future<Output = T>) -> T {
    let mut context = Context::from_waker(Waker::noop());
    let mut pinned = pin!(future);
    loop {
        if let Poll::Ready(value) = pinned.as_mut().poll(&mut context) {
            return value;
        }
        std::thread::yield_now();
    }
}
fn run_action(
    request: &Value,
    action_id: &str,
    log: &Rc<RefCell<Vec<String>>>,
) -> Result<Value, String> {
    log.borrow_mut().push(action_id.to_owned());
    if let Some(error) = request["actionErrors"]
        .get(action_id)
        .and_then(Value::as_str)
    {
        return Err(error.into());
    }
    Ok(request["receipts"]
        .get(action_id)
        .cloned()
        .unwrap_or(json!({})))
}
pub fn policy_scenario(request: &Value) -> Result<Value, String> {
    use super::{
        authoritative_unblock_v2 as au, blocker_recovery as br, blocker_resolution_v2 as bl,
        dependency_revision_v2 as dr, force_restate_validation_v2 as fr, planner_trigger_v2 as pt,
        projection_conflict_v2 as pc, revision_v2 as rev, troubleshooter_v2 as tr,
    };
    let directory = Path::new(request["directory"].as_str().ok_or("directory required")?);
    let name = request["policy"].as_str().ok_or("policy required")?;
    let facts = request.get("facts").unwrap_or(&Value::Null);
    let state = request["state"].as_str().unwrap_or("NONE");
    let event = request["event"].as_str().unwrap_or("unknown");
    let dispatch = request["dispatch"].as_bool().unwrap_or(false);
    let invoked = Rc::new(RefCell::new(Vec::new()));
    let log = Rc::clone(&invoked);
    let decision = match name {
        "dependency-revision" => dr::decide_dependency_revision(directory, event, facts, state),
        "authoritative-unblock" => {
            if dispatch {
                drive(au::dispatch_authoritative_unblock(
                    directory,
                    facts["blockedTroubleshooter"] == true,
                    |id| run_action(request, id, &log),
                ))
            } else {
                au::decide_authoritative_unblock(directory, facts["blockedTroubleshooter"] == true)
            }
        }
        "force-restate-validation" => fr::decide_force_restate_validation(directory, facts),
        "planner-trigger" => pt::dispatch_planner_trigger(directory, facts),
        "troubleshooter" => tr::dispatch_troubleshooter(directory, facts, || {
            log.borrow_mut().push("troubleshooter.create".into());
            if let Some(error) = request["actionErrors"]
                .get("troubleshooter.create")
                .and_then(Value::as_str)
            {
                return Err(error.into());
            }
            Ok(())
        }),
        "blocker-recovery" => drive(br::dispatch_blocker_recovery(directory, facts, |id| {
            run_action(request, id, &log)
        })),
        "blocker-resolution" => {
            if dispatch {
                drive(bl::dispatch_blocker_resolution(directory, facts, |id| {
                    run_action(request, id, &log)
                }))
            } else {
                bl::decide_blocker_resolution(directory, facts)
            }
        }
        "revision-lifecycle" => {
            if dispatch {
                drive(rev::dispatch_revision_lifecycle(
                    directory,
                    state,
                    event,
                    facts,
                    |id| run_action(request, id, &log),
                ))
            } else {
                rev::decide_revision_lifecycle(directory, state, event, facts)
            }
        }
        "projection-conflict" => pc::decide_projection_delivery(directory, state, event, facts),
        "projection-outbox-conflict" => pc::decide_projection_failure(directory, facts),
        _ => Err(format!("Unknown policy {name}")),
    }?;
    let executed = invoked.borrow().clone();
    Ok(json!({"decision":decision,"executed":executed}))
}
pub fn dispatcher_scenario(request: &Value) -> Result<Value, String> {
    let source = request["source"].as_str().ok_or("source required")?;
    let runtime = load_policy_graph_source(source)?;
    let initial = request["initialState"].as_str().unwrap_or("");
    let opts = DispatchOptions {
        initial_state: initial,
        input: request.get("input").cloned().unwrap_or(Value::Null),
        durable_facts: request.get("facts").cloned().unwrap_or(json!({})),
        max_steps: request["maxSteps"].as_u64().unwrap_or(1) as usize,
        observe: request["observe"] != false,
        graph_name: request["graphName"].as_str().map(str::to_owned),
    };
    let log = Rc::new(RefCell::new(Vec::<String>::new()));
    let transitions = Rc::new(RefCell::new(Vec::<Value>::new()));
    let events = Rc::new(RefCell::new(Vec::<Value>::new()));
    let on_action = Rc::clone(&log);
    let on_persist = Rc::clone(&transitions);
    let on_emit = Rc::clone(&events);
    let result = dispatch_workflow_graph_sync(
        &runtime,
        &opts,
        |state| {
            request["transientPrefix"]
                .as_str()
                .is_some_and(|prefix| state.starts_with(prefix))
        },
        |from, to| {
            on_persist
                .borrow_mut()
                .push(json!({"source":from,"target":to}));
            Ok(())
        },
        |id| run_action(request, id, &on_action),
        |id, payload| {
            on_emit
                .borrow_mut()
                .push(json!({"id":id,"payload":payload}));
            Ok(())
        },
    )?;
    let executed = log.borrow().clone();
    let persisted = transitions.borrow().clone();
    let published = events.borrow().clone();
    Ok(json!({"decision":result,"executed":executed,"transitions":persisted,"events":published}))
}

/// Actual in-memory SQLite execution of the Node dispatcher's `actionVerification`
/// branch, including duplicate attempts, unverified effects and atomic outbox.
pub fn verified_dispatcher_scenario(request: &Value) -> Result<Value, String> {
    use super::{
        action_ledger::WorkflowActionLedger,
        conditions::ConditionRegistry,
        dispatcher::DispatchOptions,
        dispatcher_verification::{dispatch_workflow_graph_verified_sync, ActionVerification},
        durable_publication::DurableWorkflowPublication,
    };
    use rusqlite::{params, Connection};
    let db = Connection::open_in_memory().map_err(|error| error.to_string())?;
    db.execute_batch("CREATE TABLE job_snapshot (job_id TEXT PRIMARY KEY,json TEXT NOT NULL); CREATE TABLE projected (state TEXT NOT NULL); INSERT INTO projected VALUES('ACTIVE')")
        .map_err(|error|error.to_string())?;
    let job = request.get("job").ok_or("authoritative Job missing")?;
    let job_id = job.get("id").and_then(Value::as_str).unwrap_or("j");
    db.execute(
        "INSERT INTO job_snapshot VALUES(?,?)",
        params![job_id, job.to_string()],
    )
    .map_err(|error| error.to_string())?;
    let ledger = WorkflowActionLedger::new(&db)?;
    let publication = if request["hasPublication"] == false {
        None
    } else {
        Some(DurableWorkflowPublication::new(&db)?)
    };
    let conditions = ConditionRegistry::new(vec![json!({"id":"merged","kind":"boolean"})])?;
    let verification = ActionVerification {
        ledger: &ledger,
        publication: publication.as_ref(),
        conditions: &conditions,
    };
    let runtime = load_policy_graph_source(request["source"].as_str().ok_or("source missing")?)?;
    let opts = DispatchOptions {
        initial_state: request["initialState"].as_str().unwrap_or("ACTIVE"),
        input: request
            .get("input")
            .cloned()
            .unwrap_or(json!({"transport":"event","id":"approved","payload":{}})),
        durable_facts: request.get("facts").cloned().unwrap_or(json!({})),
        max_steps: 1,
        observe: false,
        graph_name: None,
    };
    let action_count = Rc::new(RefCell::new(Vec::<String>::new()));
    let event_log = Rc::new(RefCell::new(Vec::<Value>::new()));
    let mut outputs = Vec::new();
    for _ in 0..request["calls"].as_u64().unwrap_or(2) {
        let events = Rc::clone(&event_log);
        let actions = Rc::clone(&action_count);
        let result = dispatch_workflow_graph_verified_sync(
            &runtime,
            &opts,
            &verification,
            |action| {
                let mut id = request.get("identity").cloned().unwrap_or(json!({}));
                id["actionId"] = json!(action);
                id
            },
            |_action| "merged".into(),
            |_action| request.get("observed").cloned().unwrap_or(json!({})),
            |action| {
                actions.borrow_mut().push(action.to_owned());
                if let Some(error) = request["actionErrors"].get(action).and_then(Value::as_str) {
                    return Err(error.to_owned());
                }
                Ok(request["receipts"]
                    .get(action)
                    .cloned()
                    .unwrap_or(json!({})))
            },
            if request["hasPersist"] == false {
                None
            } else {
                Some(|conn: &Connection, _source: &str, target: &str| {
                    conn.execute("UPDATE projected SET state=?", params![target])
                        .map_err(|error| error.to_string())?;
                    Ok(())
                })
            },
            if request["hasPublisher"] == false {
                None
            } else {
                Some(|id: &str, payload: &Value| {
                    if request["publishError"] == true {
                        return Err("fixture publish failed".into());
                    }
                    events.borrow_mut().push(json!({"id":id,"payload":payload}));
                    Ok(())
                })
            },
            |_| false,
        );
        outputs.push(match result {
            Ok(decision) => json!({"ok":true,"value":decision}),
            Err(error) => json!({"ok":false,"error":error}),
        });
    }
    let trace = ledger
        .trace(request["identity"]["attemptKey"].as_str().unwrap_or(""))?
        .map(|trace| trace["outcome"].clone())
        .unwrap_or(Value::Null);
    let state: String = db
        .query_row("SELECT state FROM projected", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    let pending = if let Some(publication) = publication.as_ref() {
        publication
            .pending()?
            .iter()
            .map(|item| item.as_value())
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let actions = action_count.borrow().clone();
    let events = event_log.borrow().clone();
    Ok(
        json!({"outputs":outputs,"trace":trace,"state":state,"pending":pending,"actions":actions,"events":events}),
    )
}

/// Isolated in-memory observability capture for Node's observeDecision source contract.
pub fn observation_scenario(request: &Value) -> Result<Value, String> {
    use crate::observability::{collect_observations, set_observability, RelayObservability};
    use std::sync::{Arc, Mutex};
    let records = Arc::new(Mutex::new(Vec::<Value>::new()));
    set_observability(RelayObservability::new(
        collect_observations(Arc::clone(&records)),
        "debug",
    ));
    let result = dispatcher_scenario(request);
    set_observability(RelayObservability::silent());
    let normalized = records
        .lock()
        .map_err(|error| error.to_string())?
        .iter()
        .map(|row| {
            let mut row = row.clone();
            if let Some(map) = row.as_object_mut() {
                map.shift_remove("ts");
            }
            row
        })
        .collect::<Vec<_>>();
    result.map(|result| json!({"result":result,"observations":normalized}))
}
