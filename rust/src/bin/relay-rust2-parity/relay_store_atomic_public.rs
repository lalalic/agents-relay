// Original Node src/relay-store.ts class facade, not direct Outbox class.
// This exercises real SQLiteRelayStore wrappers, exact rollback boundaries,
// durable receipts and callback-owned workflow events on :memory: SQLite.
use agents_relay_rust2::relay_store::SQLiteRelayStore;
use serde_json::{json,Value};
use std::path::Path;
fn string<'a>(value:&'a Value,key:&str)->&'a str{
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
pub fn invoke(request:&Value)->Option<Result<String,String>>{
    if request["op"]!="relayStoreAtomicPublic"{return None;}
    Some((||{
        let scope=request["scope"].as_str();
        let store=SQLiteRelayStore::open(Path::new(":memory:"),scope)?;
        let job=request["job"].clone();
        let id=string(&job,"id");
        let mut results=Vec::new();
        for action in request["actions"].as_array().ok_or("Store actions required")?{
            let method=string(action,"method");
            let outcome:Result<Value,String>=match method{
                "saveJob"=>store.save_job(&job).map(|_|Value::Null),
                "saveJobWithProjection"=>
                    store.save_job_with_projection(&job,&action["request"]).map(|_|Value::Null),
                "saveAgentWithProjection"=>
                    store.save_agent_with_projection(&action["agent"],&action["request"])
                        .map(|_|Value::Null),
                "enqueueProjection"=>
                    store.enqueue_projection(&action["request"]).map(|_|Value::Null),
                "enqueueExternalActionOnce"=>
                    store.enqueue_external_action_once(&action["request"]).map(|v|json!(v)),
                "commitWorkflowMutationWithEvents"=>{
                    let events=action["events"].as_array().cloned().unwrap_or_default();
                    let version=action["version"].as_i64().unwrap_or(1);
                    store.commit_workflow_mutation_with_events(id,|mut current|{
                        current["revision"]=json!(version);
                        Ok((current,events))
                    }).map(|_|Value::Null)
                },
                "commitWorkflowMutationAndEvents"=>{
                    let events=action["events"].as_array().cloned().unwrap_or_default();
                    let version=action["version"].as_i64().unwrap_or(1);
                    store.commit_workflow_mutation_and_events(id,|mut current|{
                        current["revision"]=json!(version);
                        Ok(current)
                    },&events).map(|_|Value::Null)
                },
                "mutateJob"=>{
                    let version=action["version"].as_i64().unwrap_or(1);
                    store.mutate_job(id,|mut current|{
                        current["revision"]=json!(version);
                        Ok(current)
                    }).map(|_|Value::Null)
                },
                "recordProjectionReceipt"=>store.record_projection_receipt(
                    string(action,"key"),"succeeded",1,&json!({"accepted":true}))
                    .map(|_|Value::Null),
                "loadJob"=>store.load_job(id).map(|v|
                    v.map(|job|job["revision"].clone()).unwrap_or(Value::Null)),
                "loadAgents"=>store.load_agents().map(|v|
                    json!(v.map(|rows|rows.iter().map(|agent|
                        string(agent,"id").to_string()).collect::<Vec<_>>()))),
                "counts"=>Ok(json!({"pending":store.pending_projection_count()?,
                    "terminal":store.terminal_projection_count()?,
                    "conflict":store.conflict_projection_count()?})),
                _=>Err(format!("Unsupported Store public action {method}")),
            };
            // Compare durable effects after EVERY action, including rejected
            // transactions; no fake claims based on return values alone.
            let latest=store.load_job(id)?;
            let agents=store.load_agents()?;
            let counts=json!({"pending":store.pending_projection_count()?,
                "terminal":store.terminal_projection_count()?,
                "conflict":store.conflict_projection_count()?});
            let row_count:i64=store.db.query_row(
                "SELECT COUNT(*) FROM workflow_event_outbox",[],|row|row.get(0))
                .unwrap_or(0);
            let observed=json!({"method":method,"ok":outcome.is_ok(),
                "value":outcome.unwrap_or(Value::Null),
                "jobRevision":latest.as_ref().and_then(|job|job["revision"].as_i64()),
                "jobPresent":latest.is_some(),
                "agentIds":agents.as_ref().map(|values|values.iter()
                    .map(|agent|agent["id"].as_str().unwrap_or("").to_string())
                    .collect::<Vec<_>>()),
                "counts":counts,"workflowOutboxCount":row_count});
            results.push(observed);
        }
        store.close()?;
        Ok(json!(results).to_string())
    })())
}
