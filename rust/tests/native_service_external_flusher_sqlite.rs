// Real SQLite projection outbox + native external flusher transport. The
// "GitHub" effect is an injected in-memory receipt, never a real provider.
use agents_relay_rust2::{
    projected_store::GitHubProjectionWriter,
    relay_store::SQLiteRelayStore,
    service_external_actions::start_service_external_action_flusher_with_ports,
};
use serde_json::{json,Value};
use std::{
    fs,future::Future,path::PathBuf,pin::pin,
    sync::{Arc,atomic::{AtomicUsize,Ordering}},
    task::{Context,Poll,Waker},thread,time::{Duration,SystemTime,UNIX_EPOCH},
};
fn drive<T>(future:impl Future<Output=T>)->T{
    let mut future=pin!(future);
    let mut context=Context::from_waker(Waker::noop());
    loop{if let Poll::Ready(value)=future.as_mut().poll(&mut context){return value;}thread::yield_now();}
}
fn fixture()->(PathBuf,PathBuf){
    let root=std::env::temp_dir().join(format!("rust2-flusher-sqlite-{}-{}",
        std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
    fs::create_dir_all(&root).unwrap();
    let path=root.join("relay.sqlite");
    let store=SQLiteRelayStore::open_without_claim_reset(&path,Some("17")).unwrap();
    store.save_job(&json!({"id":"17","repository":"project","projectRoot":root.join("project"),
        "state":"ACTIVE","tasks":[],"plans":[],"prNumber":0,"title":"test"})).unwrap();
    store.enqueue_projection(&json!({
        "idempotencyKey":"test:external-once","operation":"append_task_comment",
        "payload":{"value":{"jobId":"17","id":"comment-1","message":"test"}},
        "priority":2
    })).unwrap();
    drop(store);
    (root,path)
}
#[test]
fn native_timer_real_sqlite_outbox_once_then_no_reconcile_without_new_projection(){
    let (root,db)=fixture();
    let effects=Arc::new(AtomicUsize::new(0));
    let reconciles=Arc::new(AtomicUsize::new(0));
    let errors=Arc::new(AtomicUsize::new(0));
    let cb=Arc::clone(&effects);
    let rc=Arc::clone(&reconciles);
    let er=Arc::clone(&errors);
    let graph=PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../workflow");
    let db_for_tick=db.clone();
    let handle=start_service_external_action_flusher_with_ports(
        true,false,Duration::from_millis(30),
        move||{
            let store=SQLiteRelayStore::open_without_claim_reset(&db_for_tick,Some("17"))?;
            let projection=GitHubProjectionWriter::new(&store,false);
            let now=chrono::Utc::now().to_rfc3339();
            let count=Arc::clone(&cb);
            let result=drive(projection.flush_once(
                &graph,8.0,&now,move |_item|{
                    let counter=Arc::clone(&count);
                    async move{
                        counter.fetch_add(1,Ordering::SeqCst);
                        Ok::<(),Value>(())
                    }
                },|_event|async{Ok::<(),String>(())}
            ))?;
            Ok(result["projected"].as_u64().unwrap_or(0) as usize)
        },
        move||{rc.fetch_add(1,Ordering::SeqCst);Ok(())},
        move|_error|{er.fetch_add(1,Ordering::SeqCst);}
    ).expect("enabled projected store must have timer");
    thread::sleep(Duration::from_millis(145));
    handle.stop();
    let store=SQLiteRelayStore::open_without_claim_reset(&db,Some("17")).unwrap();
    assert_eq!(effects.load(Ordering::SeqCst),1,
        "only one external effect may run even across repeated ticks");
    assert_eq!(reconciles.load(Ordering::SeqCst),1,
        "only a positive flush requires a new Graph pass");
    assert_eq!(store.pending_projection_count().unwrap(),0);
    assert_eq!(errors.load(Ordering::SeqCst),0);
    assert_eq!(store.list_publication_events("17").unwrap().len(),0);
    drop(store);
    fs::remove_dir_all(root).unwrap();
}
