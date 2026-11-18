use agents_relay_rust2::{projected_store::ProjectedDurableStore,
    relay_store::SQLiteRelayStore};
use serde_json::json;
use std::path::Path;
use std::sync::{Arc,atomic::{AtomicUsize,Ordering}};
#[test]
fn projected_comments_never_invent_an_empty_remote_on_unwired_provider(){
    let relay=SQLiteRelayStore::open(Path::new(":memory:"),None).unwrap();
    let mut projected=ProjectedDurableStore::new(relay,None);
    assert_eq!(projected.comments().unwrap_err(),
        "Projected GitHub comments require an attached GitHub Store");
    assert_eq!(projected.relay.pending_projection_count().unwrap(),0);
}
#[test]
fn projected_comments_use_attached_remote_without_sqlite_projection_effects(){
    let relay=SQLiteRelayStore::open(Path::new(":memory:"),None).unwrap();
    let calls=Arc::new(AtomicUsize::new(0));
    let counter=Arc::clone(&calls);
    let mut projected=ProjectedDurableStore::new(relay,None)
        .with_github_comments(move||{
            counter.fetch_add(1,Ordering::SeqCst);
            Ok(vec![json!({"id":1,"body":"remote","authorLogin":"trusted"})])
        });
    assert_eq!(projected.comments().unwrap()[0]["body"],"remote");
    assert_eq!(projected.comments().unwrap()[0]["authorLogin"],"trusted");
    assert_eq!(calls.load(Ordering::SeqCst),2);
    assert_eq!(projected.relay.pending_projection_count().unwrap(),0);
}
