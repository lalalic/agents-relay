// Native Pool public entrypoints use authoritative local SQLite and the
// shared event coordinator; transport never directly changes Task lifecycle.
use agents_relay_rust2::{
    events::MemoryEventBus,pool::RepositoryWorkerPool,
    reconcile_coordinator::ReconcileCoordinator,relay_store::SQLiteRelayStore,
};
use serde_json::{json,Value};
use std::{cell::RefCell,rc::Rc,sync::{Arc,Mutex},time::{SystemTime,UNIX_EPOCH}};
#[test]
fn direct_local_reconcile_uses_sqlite_and_recovers_after_execution_failure(){
    let suffix=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root=std::env::temp_dir().join(format!("rust2-pool-local-{}-{suffix}",std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let db=Rc::new(SQLiteRelayStore::open(&root.join("jobs.sqlite"),Some("41")).unwrap());
    let job=json!({"id":"41","repository":"example","prNumber":0,"state":"ACTIVE",
        "createdAt":"2026-11-18T09:00:00Z","updatedAt":"2026-11-18T09:00:00Z",
        "reviewEnabled":false,"headSha":"head", "plans":[],
        "tasks":[{"id":"task-1","state":"QUEUED","agentGraph":"graph TD; A-->B",
            "executionId":null,"leaseOwner":null,"leaseExpiresAt":null,
            "dependencies":[]}]});
    db.save_job(&job).unwrap();
    let baseline=db.load_job("41").unwrap().unwrap();
    let mut pool=RepositoryWorkerPool::new(2,root.join("workflow"));
    let seen=Rc::new(RefCell::new(Vec::<(String,usize)>::new()));
    for iteration in 0..3{
        let lookup=Rc::clone(&db);
        let load=Rc::clone(&db);
        let observed=Rc::clone(&seen);
        let result=pool.reconcile_local_job("41",
            move|id|lookup.load_job(id),
            move|id|load.load_job(id)?.ok_or("Not in SQLite".into()),
            ||Ok(vec![]),
            move|id,slots|{
                observed.borrow_mut().push((id.to_owned(),slots));
                if iteration==0{return Err("Injected Reconciler failure".into());}
                Ok(Value::Null)
            });
        if iteration==0{assert_eq!(result.unwrap_err(),"Injected Reconciler failure");}
        else{result.unwrap();}
    }
    assert_eq!(seen.borrow().as_slice(),&[("41".to_owned(),2),
        ("41".to_owned(),2),("41".to_owned(),2)]);
    assert_eq!(db.load_job("41").unwrap().unwrap(),baseline);
    let lookup=Rc::clone(&db);let load=Rc::clone(&db);
    let missing=pool.reconcile_local_job("unknown",
        move|id|lookup.load_job(id),
        move|id|load.load_job(id)?.ok_or("Not in SQLite".into()),
        ||Ok(vec![]),|_,_|->Result<Value,String>{panic!("must fail before dispatch")});
    assert!(missing.unwrap_err().contains("Wrong scoped Job ID unknown"));
    drop(pool);drop(db);
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn watch_routes_only_lifecycle_and_unsubscribes_exact_bus_handler(){
    let bus=MemoryEventBus::new();
    let signals=Arc::new(Mutex::new(Vec::<Value>::new()));
    let observed=Arc::clone(&signals);
    let coordinator=ReconcileCoordinator::new(move |_,batch|{
        observed.lock().unwrap().extend_from_slice(batch);Ok(())
    },None);
    let pool=RepositoryWorkerPool::new(2,"workflow");
    let unsubscribe=pool.watch(&bus,&coordinator).unwrap();
    bus.publish(&json!({"job_id":"j","type":"github.webhook"})).unwrap();
    bus.publish(&json!({"job_id":"j","type":"task.interactive_decision"})).unwrap();
    bus.publish(&json!({"job_id":"j","type":"job.wake"})).unwrap();
    coordinator.settle();
    assert_eq!(signals.lock().unwrap().len(),2);
    assert_eq!(signals.lock().unwrap()[0]["event"]["type"],"task.interactive_decision");
    assert!(signals.lock().unwrap()[1].get("event").is_none());
    unsubscribe();
    bus.publish(&json!({"job_id":"j","type":"task.failed"})).unwrap();
    coordinator.settle();
    assert_eq!(signals.lock().unwrap().len(),2);
    pool.webhook_signal(Some(&bus),&json!({"deliveryId":"ignored"})).unwrap();
    assert_eq!(signals.lock().unwrap().len(),2);
}
