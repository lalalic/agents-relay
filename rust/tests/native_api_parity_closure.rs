// Node provenance: src/projected-store.ts + src/relay-store.ts.
// Verify the isolated Agent+Outbox transaction never produces a partial durable
// write when projection enqueue fails. No production Job/store is accessed.
use agents_relay_rust2::relay_store::SQLiteRelayStore;
use serde_json::json;
use std::path::Path;

#[test]
fn save_agent_and_outbox_are_one_transaction_and_retry_is_idempotent() {
    let store=SQLiteRelayStore::open(Path::new(":memory:"),None).unwrap();
    let agent=json!({"id":"agent-1","name":"Reviewer"});
    let projection=json!({
        "idempotencyKey":"save_agent:agent-1","coalesceKey":"agent:agent-1",
        "operation":"save_agent",
        "payload":{"operation":"save_agent","value":agent},
        "priority":10
    });
    assert!(store.load_agents().unwrap().is_none());
    store.save_agent_with_projection(&agent,&projection).unwrap();
    assert_eq!(store.load_agents().unwrap().unwrap(),vec![agent.clone()]);
    assert_eq!(store.pending_projection_count().unwrap(),1);
    store.save_agent_with_projection(&agent,&projection).unwrap();
    assert_eq!(store.pending_projection_count().unwrap(),1,
        "retries must not enqueue duplicate provider side effects");
}
#[test]
fn failed_outbox_insert_rolls_back_agent_and_metadata() {
    let store=SQLiteRelayStore::open(Path::new(":memory:"),None).unwrap();
    store.db.execute_batch("DROP TABLE projection_outbox").unwrap();
    let agent=json!({"id":"new-agent","name":"Must rollback"});
    let projection=json!({
        "idempotencyKey":"save_agent:new-agent",
        "operation":"save_agent","payload":{"operation":"save_agent","value":agent},
        "priority":10
    });
    assert!(store.save_agent_with_projection(&agent,&projection).is_err());
    assert!(store.load_agents().unwrap().is_none(),
        "neither agent_snapshot nor observed registry metadata may commit");
    let count:i64=store.db.query_row(
        "SELECT COUNT(*) FROM agent_snapshot",[],|r|r.get(0)).unwrap();
    assert_eq!(count,0);
}
