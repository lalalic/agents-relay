// Real SQLite-backed Agent registry, scoped and unscoped. A confirmed
// empty registry must persist across daemon recreation; a rejected batch
// cannot erase previously observed state. All files are disposable /tmp.
use agents_relay_rust2::relay_store::SQLiteRelayStore;
use serde_json::json;
use std::{fs,path::PathBuf,time::{SystemTime,UNIX_EPOCH}};
fn temporary(name:&str)->PathBuf{
 let path=std::env::temp_dir().join(format!("rust2-agent-registry-{name}-{}-{}",
  std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
 fs::create_dir_all(&path).unwrap();
 path
}
#[test]
fn confirmed_empty_agent_inventory_survives_reopen_in_both_sqlite_modes(){
 for scope in [None,Some("17")]{
  let root=temporary(if scope.is_some(){"scoped"}else{"legacy"});
  let path=root.join("relay.sqlite");
  let store=SQLiteRelayStore::open(&path,scope).unwrap();
  if scope.is_some(){
   // A scoped Agent observation is attached to a registered source Job.
   // The strict FK rejects writes before that authoritative Job exists.
   store.save_job(&json!({"id":"17","repository":"fixture","prNumber":0,
    "projectRoot":root.join("fixture"),"title":"Scoped Store fixture",
    "state":"ACTIVE","tasks":[],"plans":[],
    "createdAt":"2026-11-20T00:00:00.000Z",
    "updatedAt":"2026-11-20T00:00:00.000Z"})).unwrap();
  }
  assert!(store.load_agents().unwrap().is_none(),
   "new Job Agent inventory must mean not yet observed");
  store.save_agents(&[]).unwrap();
  assert!(store.load_agents().unwrap().unwrap().is_empty(),
   "empty successfully loaded Agent inventory must NOT mean never fetched");
  store.close().unwrap();
  let after=SQLiteRelayStore::open_without_claim_reset(&path,scope).unwrap();
  assert!(after.load_agents().unwrap().unwrap().is_empty(),
   "observed empty inventory must survive process/daemon recreation");
  let first=json!({"id":"agent-a","name":"A","capabilities":["review"]});
  let second=json!({"id":"agent-b","name":"B","capabilities":["model"]});
  after.save_agents(&[first.clone(),second.clone()]).unwrap();
  assert_eq!(after.load_agents().unwrap().unwrap(),vec![first.clone(),second.clone()]);
  let rejected=after.save_agents(&[first.clone(),first.clone()]);
  assert!(rejected.is_err(),"Duplicate Agent identity must fail atomically");
  assert_eq!(after.load_agents().unwrap().unwrap(),vec![first.clone(),second],
   "failed replace may not erase existing Agent list or observed flag");
  after.save_agents(&[]).unwrap();
  assert!(after.load_agents().unwrap().unwrap().is_empty());
  assert!(after.mark_event_processed("shared-event-17",Some("nats"),Some(7)).unwrap());
  assert!(!after.mark_event_processed("shared-event-17",Some("nats"),Some(7)).unwrap());
  after.close().unwrap();
  let final_open=SQLiteRelayStore::open_without_claim_reset(&path,scope).unwrap();
  assert!(final_open.load_agents().unwrap().unwrap().is_empty());
  assert!(!final_open.mark_event_processed("shared-event-17",Some("nats"),Some(7)).unwrap(),
   "event receipt cannot be reprocessed after SQLite/daemon recreation");
  final_open.close().unwrap();
  fs::remove_dir_all(root).unwrap();
 }
}

#[test]
fn incomplete_pr_head_is_null_after_reopen_and_stale_facts_cannot_regress(){
 for scope in [None,Some("17")]{
  let root=temporary(if scope.is_some(){"pr-scoped"}else{"pr-legacy"});
  let path=root.join("relay.sqlite");
  let db=SQLiteRelayStore::open(&path,scope).unwrap();
  if scope.is_some(){
   db.save_job(&json!({"id":"17","repository":"fixture","prNumber":0,
    "projectRoot":root.join("fixture"),"title":"Scoped PR facts fixture",
    "state":"ACTIVE","tasks":[],"plans":[],
    "createdAt":"2026-11-20T00:00:00.000Z",
    "updatedAt":"2026-11-20T00:00:00.000Z"})).unwrap();
  }
  assert!(db.load_pull_request_facts().unwrap().is_none());
  db.save_pull_request_facts(&json!({"state":"UNKNOWN","head":null,
   "observedAt":"2026-11-15T00:00:00.000Z"})).unwrap();
  assert!(db.load_pull_request_facts().unwrap().is_none(),
   "UNKNOWN is not durable external evidence");
  db.save_pull_request_facts(&json!({"state":"OPEN","head":null,
   "observedAt":"2026-11-16T00:00:00.000Z"})).unwrap();
  assert!(db.load_pull_request_facts().unwrap().unwrap()["head"].is_null());
  db.save_pull_request_facts(&json!({"state":"OPEN",
   "head":{"ref":"refs/heads/main","sha":"0123456789"},
   "observedAt":"2026-11-17T00:00:00.000Z"})).unwrap();
  assert_eq!(db.load_pull_request_facts().unwrap().unwrap()["head"]["ref"],
   "refs/heads/main");
  db.save_pull_request_facts(&json!({"state":"CLOSED","head":null,
   "observedAt":"2026-11-16T00:00:00.000Z"})).unwrap();
  assert_eq!(db.load_pull_request_facts().unwrap().unwrap()["state"],"OPEN",
   "stale non-authoritative CLOSED state may not supersede newer OPEN evidence");
  db.save_pull_request_facts(&json!({"state":"MERGED","head":null,
   "observedAt":"2026-11-18T00:00:00.000Z"})).unwrap();
  assert_eq!(db.load_pull_request_facts().unwrap().unwrap()["state"],"MERGED");
  assert!(db.load_pull_request_facts().unwrap().unwrap()["head"].is_null());
  db.close().unwrap();
  let restarted=SQLiteRelayStore::open_without_claim_reset(&path,scope).unwrap();
  let recovered=restarted.load_pull_request_facts().unwrap().unwrap();
  assert_eq!(recovered["state"],"MERGED");
  assert!(recovered["head"].is_null(),
   "persisted merged PR with no complete HEAD must not publish a fake HeadRef");
  restarted.close().unwrap();
  fs::remove_dir_all(root).unwrap();
 }
}
