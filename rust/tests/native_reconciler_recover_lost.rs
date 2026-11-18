// Authoritative SQLite execution recovery: recheck immutable execution
// generation, then Graph transition, before durable mutation. No PID kill.
use agents_relay_rust2::{reconciler::Reconciler,
    relay_store::SQLiteRelayStore,task_transitions::transition_task_event};
use serde_json::json;
use std::{cell::Cell,rc::Rc,path::PathBuf,
    future::Future,pin::pin,task::{Context,Poll,Waker},
    time::{SystemTime,UNIX_EPOCH}};
fn run<T>(future:impl Future<Output=T>)->T{
    let mut future=pin!(future);
    let mut cx=Context::from_waker(Waker::noop());
    match future.as_mut().poll(&mut cx){
        Poll::Ready(result)=>result,Poll::Pending=>panic!("no network futures")}
}
#[test]
fn expired_generation_mutates_real_sqlite_once_and_stale_observation_is_rejected(){
    let suffix=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root=std::env::temp_dir().join(format!("rust2-lease-recovery-{}-{suffix}",std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let graph=PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../workflow");
    let db=Rc::new(SQLiteRelayStore::open(&root.join("relay.sqlite"),Some("42")).unwrap());
    let old="2026-11-18T07:00:00Z";
    let job=json!({"id":"42","repository":"fixture","prNumber":0,
        "state":"ACTIVE","createdAt":old,"updatedAt":old,"plans":[],
        "tasks":[{"id":"7","jobId":"42","kind":"work","state":"RUNNING",
            "adapter":"codex","attempt":1,"maxAttempts":2,
            "executionId":"generation-1","leaseOwner":"closed-worker",
            "leaseExpiresAt":old,"createdAt":old,"updatedAt":old,
            "dependencies":[],"capabilities":[]}]});
    db.save_job(&job).unwrap();
    let initial=db.load_job("42").unwrap().unwrap();
    let calls=Rc::new(Cell::new(0));
    let mut reconciler=Reconciler::new(&graph,&root,&root,&root,&root,
        json!({"owner":"current-worker"}));
    for iteration in 0..2{
        let load_db=Rc::clone(&db);
        let write_db=Rc::clone(&db);
        let count=Rc::clone(&calls);
        let graph=graph.clone();
        let stale=initial.clone();
        run(reconciler.recover_lost_executions(&stale,
            chrono::DateTime::parse_from_rfc3339("2026-11-18T17:00:00Z")
                .unwrap().timestamp_millis(),
            move||std::future::ready(load_db.load_job("42")
                .and_then(|j|j.ok_or("SQLite Job missing".into()))),
            |_task|std::future::ready(Ok::<_,String>(true)),
            move|mut task,event,_reason|{
                count.set(count.get()+1);
                let result=(||{
                    let now=chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true);
                    transition_task_event(&graph,&mut task,&event,
                        &json!({"retryAvailable":true}),&now)?;
                    write_db.mutate_job("42",|mut job|{
                        let saved=&job["tasks"][0];
                        if saved["executionId"]!= "generation-1"
                            || saved["leaseOwner"]!="closed-worker"{
                            return Err("Execution generation changed before commit".into());
                        }
                        job["tasks"][0]=task.clone();Ok(job)
                    })?;
                    Ok::<_,String>(())
                })();
                std::future::ready(result)
            }
        )).unwrap();
        if iteration==0{
            let recovered=db.load_job("42").unwrap().unwrap();
            assert_eq!(recovered["tasks"][0]["state"],"FAILED");
            assert!(recovered["tasks"][0]["executionId"].is_null());
            assert_eq!(calls.get(),1);
        }else{assert_eq!(calls.get(),1);}
    }
    drop(reconciler);drop(db);
    std::fs::remove_dir_all(root).unwrap();
}
