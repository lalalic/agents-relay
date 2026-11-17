// Companion of direct Node src/workflow/dispatcher.ts: actionVerification's durable
// action attempt fence, observed postcondition, and atomic SQLite transition/event outbox.
// Crucially, an unverified effect never commits the Graph-selected transition.
use super::{
    action_ledger::WorkflowActionLedger,
    conditions::ConditionRegistry,
    dispatcher::DispatchOptions,
    durable_publication::{DurableWorkflowPublication, PendingWorkflowEvent},
    graph_v2::GraphRuntime,
};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::time::SystemTime;
fn now() -> String {
    DateTime::<Utc>::from(SystemTime::now()).to_rfc3339_opts(SecondsFormat::Millis, true)
}
pub struct ActionVerification<'a> {
    pub ledger: &'a WorkflowActionLedger<'a>,
    pub publication: Option<&'a DurableWorkflowPublication<'a>>,
    pub conditions: &'a ConditionRegistry,
}
/// The Node verified dispatcher requires five independent caller-supplied
/// identity/action/observation/durable-state/event ports. Keep them explicit:
/// Graph policy must never be recreated or inferred from an effect receipt.
#[allow(clippy::too_many_arguments)]
pub fn dispatch_workflow_graph_verified_sync<
    Identity,
    Condition,
    Observed,
    Action,
    Persist,
    Emit,
    Transient,
>(
    runtime: &GraphRuntime,
    options: &DispatchOptions<'_>,
    verification: &ActionVerification<'_>,
    mut identity: Identity,
    mut condition_id: Condition,
    mut observed: Observed,
    mut execute: Action,
    mut persist: Option<Persist>,
    mut publish: Option<Emit>,
    mut is_transient: Transient,
) -> Result<Value, String>
where
    Identity: FnMut(&str) -> Value,
    Condition: FnMut(&str) -> String,
    Observed: FnMut(&str) -> Value,
    Action: FnMut(&str) -> Result<Value, String>,
    Persist: FnMut(&Connection, &str, &str) -> Result<(), String>,
    Emit: FnMut(&str, &Value) -> Result<(), String>,
    Transient: FnMut(&str) -> bool,
{
    let mut current = options.initial_state.to_string();
    for _ in 0..options.max_steps {
        let facts = json!({"currentState":current,"input":options.input,"durableFacts":options.durable_facts});
        let decision = runtime.evaluate_sync(&facts)?;
        if decision["accepted"] != true {
            if options.observe {
                super::dispatcher::observe_decision(
                    options.graph_name.as_deref(),
                    &options.input,
                    &decision,
                );
            }
            return Ok(decision);
        }
        let source = decision["source"].as_str().ok_or("missing source")?;
        let target = decision["target"].as_str().ok_or("missing target")?;
        let mut deferred = Vec::<(String, Value)>::new();
        let steps = decision["actions"]
            .as_array()
            .ok_or("missing action decisions")?;
        for step in steps {
            let action = step["id"].as_str().ok_or("missing action")?;
            let id = identity(action);
            let condition = condition_id(action);
            let was_new = verification.ledger.reserve_for_running_task(
                &id,
                &decision,
                &condition,
                &now(),
                "RUNNING",
            )?;
            if !was_new {
                return Err(
                    "action attempt already reserved: reconcile outcome; never repeat side effect"
                        .into(),
                );
            }
            let receipt = execute(action)?;
            if receipt.get("ok") == Some(&Value::Bool(false)) {
                return Err("action returned failure receipt: reconciliation required".into());
            }
            let attempt = id["attemptKey"].as_str().ok_or("attemptKey missing")?;
            let trace =
                verification
                    .ledger
                    .verify(attempt, verification.conditions, &observed(action))?;
            let outcome = trace["outcome"].as_str().unwrap_or("Unknown");
            if outcome != "Verified" {
                return Err(format!(
                    "action postcondition {outcome}: reconciliation required"
                ));
            }
            let payloads = receipt.get("payloads").unwrap_or(&Value::Null);
            for emitted in step["emittedEvents"].as_array().into_iter().flatten() {
                let Some(event_id) = emitted.as_str() else {
                    continue;
                };
                let payload = payloads.get(event_id).ok_or_else(|| {
                    format!(
                        "action '{action}' did not supply payload for emitted event '{event_id}'"
                    )
                })?;
                let definition = runtime
                    .registry
                    .events
                    .get(event_id)
                    .ok_or("unknown emitted event")?;
                if definition
                    .as_ref()
                    .is_some_and(|validator| !validator(payload))
                {
                    return Err(format!("invalid payload for emitted event '{event_id}'"));
                }
                deferred.push((event_id.to_string(), payload.clone()));
            }
        }
        let publication = verification
            .publication
            .ok_or("atomic SQLite transition and outbox required")?;
        let persist = persist
            .as_mut()
            .ok_or("atomic SQLite transition and outbox required")?;
        let first = steps.first();
        let mut outbox = Vec::new();
        for (index, (event_id, payload)) in deferred.iter().enumerate() {
            let action = first
                .and_then(|row| row["id"].as_str())
                .ok_or("missing durable action event identity")?;
            let id = identity(action);
            let attempt = id["attemptKey"].as_str().ok_or("attemptKey missing")?;
            outbox.push(PendingWorkflowEvent {
                key: format!("{attempt}/emit/{index}"),
                event_id: event_id.clone(),
                payload: payload.clone(),
            });
        }
        publication.commit_transition_and_events(|db| persist(db, source, target), &outbox)?;
        if let Some(emit) = publish.as_mut() {
            publication.replay(|event| emit(&event.event_id, &event.payload))?;
        }
        if options.observe {
            super::dispatcher::observe_decision(
                options.graph_name.as_deref(),
                &options.input,
                &decision,
            );
        }
        current = target.into();
        if !is_transient(&current) {
            return Ok(decision);
        }
    }
    Ok(json!({"accepted":false,"source":current,"reason":"no_transition"}))
}
