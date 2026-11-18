//! Isolated native daemon SQLite host: optimistic CAS and active outbox claims.
//! Tests run on a newly created unified SQLite fixture, never live stores.
use agents_relay_rust2::{
    relayd::{DaemonConfig,DaemonServices},
    relayd_sqlite_write::IsolatedSQLiteWriteHost,
    relay_store::SQLiteRelayStore,
};
use serde_json::{json,Value};
use std::{fs,path::{Path,PathBuf},time::{SystemTime,UNIX_EPOCH}};
fn fixture()->(PathBuf,DaemonConfig){
    let root=std::env::temp_dir().join(format!("rust2-sqlite-write-host-{}-{}",std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
    fs::create_dir_all(root.join("stores")).unwrap();
    let config=DaemonConfig{
        workspace_root:root.join("workspace"),store_directory:root.join("stores"),
        graph_directory:Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow"),
        profile_home:root.join("profiles"),policy_path:root.join("routing.json"),
        router_rules_path:root.join("rules.md"),dashboard_asset:root.join("index.html"),
        repositories:vec!["fixture".into()],port:9918,concurrency:1,interval_ms:100,
        lease_ms:300000,no_github:true,event_transport:json!({}),
    };
    (root,config)
}
fn job()->Value{
    json!({"id":"17","repository":"fixture","projectRoot":"/tmp/fixture",
        "state":"DRAFT","prNumber":0,"title":"one",
        "createdAt":"2026-11-18T00:00:00.000Z","updatedAt":"2026-11-18T00:00:00.000Z",
        "tasks":[],"plans":[]})
}
#[test]
fn native_daemon_cas_refuses_stale_writer_across_independent_sqlite_connections(){
    let (root,config)=fixture();
    let path=root.join("relay.sqlite");
    let initial=SQLiteRelayStore::open(&path,Some("17")).unwrap();
    initial.save_job(&job()).unwrap();initial.close().unwrap();
    let mut host=IsolatedSQLiteWriteHost::new(config);
    let old=host.load("17").unwrap();
    let outside=SQLiteRelayStore::open_without_claim_reset(&path,Some("17")).unwrap();
    let mut new=old.clone();new["title"]=json!("external writer");
    outside.save_job(&new).unwrap();
    let mut stale=old.clone();stale["title"]=json!("overwrite attempt");
    let rejection=host.save_exact("17",&old,&stale).unwrap_err();
    assert!(rejection.contains("Concurrent Job mutation"),"{rejection}");
    assert_eq!(outside.load_job("17").unwrap().unwrap()["title"],"external writer");
    let current=host.load("17").unwrap();
    assert_eq!(current["title"],"external writer");
    let mut accepted=current.clone();accepted["title"]=json!("new CAS success");
    assert_eq!(host.save_exact("17",&current,&accepted).unwrap()["title"],"new CAS success");
    assert_eq!(outside.load_job("17").unwrap().unwrap()["title"],"new CAS success");
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn live_daemon_http_reads_do_not_reset_outstanding_projection_claims(){
    let (root,config)=fixture();
    let path=root.join("relay.sqlite");
    let store=SQLiteRelayStore::open(&path,Some("17")).unwrap();
    store.save_job(&job()).unwrap();
    store.enqueue_projection(&json!({"idempotencyKey":"write:task:17:2",
        "operation":"save_task","payload":{"id":"2"},"priority":1})).unwrap();
    let claimed=store.claim_due_projections(1.0,"2100-01-01T00:00:00.000Z").unwrap();
    assert_eq!(claimed.len(),1);
    let status=|store:&SQLiteRelayStore|->String{
        store.db.query_row("SELECT status FROM projection_outbox WHERE idempotency_key='write:task:17:2'",
            [],|row|row.get::<_,String>(0)).unwrap()
    };
    assert_eq!(status(&store),"processing");
    let mut host=IsolatedSQLiteWriteHost::new(config);
    for _ in 0..5{
        assert_eq!(host.load("17").unwrap()["id"],"17");
    }
    assert_eq!(status(&store),"processing", "HTTP lookup must not reset a live lease");
    let probe=SQLiteRelayStore::open_without_claim_reset(&path,Some("17")).unwrap();
    assert_eq!(status(&probe),"processing");
    fs::remove_dir_all(root).unwrap();
}
