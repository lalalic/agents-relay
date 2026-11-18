// Node Reconciler.planJob native SQLite transaction fence. No managed jobs,
// Planner binaries, network, GitHub or production artifacts are touched.
use agents_relay_rust2::{reconciler::Reconciler,relay_store::SQLiteRelayStore};
use serde_json::{json,Value};
use std::{rc::Rc,cell::Cell,path::PathBuf,
    future::Future,pin::pin,task::{Context,Poll,Waker},
    time::{SystemTime,UNIX_EPOCH}};
fn run<T>(future:impl Future<Output=T>)->T{
    let mut future=pin!(future);
    let mut cx=Context::from_waker(Waker::noop());
    match future.as_mut().poll(&mut cx){
        Poll::Ready(result)=>result,Poll::Pending=>panic!("local Store must be immediate")
    }
}
#[test]
fn force_restate_pending_round_rejects_inside_sqlite_mutation_without_durable_change(){
    let suffix=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root=std::env::temp_dir().join(format!("rust2-planner-job-{}-{suffix}",std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let db=Rc::new(SQLiteRelayStore::open(&root.join("relay.sqlite"),Some("41")).unwrap());
    let graph=PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../workflow");
    let baseline="2026-11-18T10:00:00Z";
    let job=json!({"id":"41","repository":"fixture","prNumber":0,
        "state":"DRAFT","title":"A plan","objective":"Do work", "headSha":"aaa",
        "createdAt":baseline,"updatedAt":baseline,"tasks":[],"plans":[]});
    db.save_job(&job).unwrap();
    let mut rec=Reconciler::new(&graph,&root,&root,&root,&root,
        json!({"owner":"fixture","plannerTimeoutMs":120000}));
    let load_db=Rc::clone(&db);
    let mutate_db=Rc::clone(&db);
    let launch_db=Rc::clone(&db);
    let launches=Rc::new(Cell::new(0));
    let launch_count=Rc::clone(&launches);
    let (planned,round)=run(rec.plan_job("41",Some("One Task"),false,true,
        move||std::future::ready(load_db.load_job("41")
            .and_then(|job|job.ok_or("Job missing".into()))),
        move|operation|mutate_db.mutate_job("41",operation),
        |_plan|std::future::ready(Err::<(),String>("Atomic path must not append Plan".into())),
        |_job|std::future::ready(Err::<(),String>("Atomic path must not save Job".into())),
        move|_job,round|{
            launch_count.set(launch_count.get()+1);
            let result=launch_db.mutate_job("41",|mut candidate|{
                let plan=candidate["plans"].as_array_mut().unwrap().iter_mut()
                    .find(|plan|plan["id"]==round["id"])
                    .ok_or::<String>("Round missing in SQLite".into())?;
                plan["status"]=json!("SUCCEEDED");
                Ok(candidate)
            }).map(|_|());
            std::future::ready(result)
        }
    )).unwrap();
    assert_eq!(planned["state"],"ACTIVE");
    assert_eq!(round["status"],"SUCCEEDED");
    assert_eq!(round["guidance"],"One Task");
    assert_eq!(launches.get(),1);
    let persisted=db.load_job("41").unwrap().unwrap();
    assert_eq!(persisted["state"],"ACTIVE");
    assert_eq!(persisted["plans"][0]["status"],"SUCCEEDED");
    db.mutate_job("41",|mut candidate|{
        candidate["plans"][0]["status"]=json!("PLANNING");
        candidate["plans"][0]["executionId"]=Value::Null;
        Ok(candidate)
    }).unwrap();
    let before=db.load_job("41").unwrap().unwrap();
    let load_db=Rc::clone(&db);
    let mutate_db=Rc::clone(&db);
    let mut entered_mutation=0;
    let result=run(rec.plan_job("41",Some("Must reject"),true,true,
        move||std::future::ready(load_db.load_job("41")
            .and_then(|job|job.ok_or("Job missing".into()))),
        |operation|{
            entered_mutation+=1;
            mutate_db.mutate_job("41",operation)
        },
        |_plan|std::future::ready(Err::<(),String>("Must not append".into())),
        |_job|std::future::ready(Err::<(),String>("Must not save".into())),
        |_job,_round|std::future::ready(Err::<(),String>("Must not launch".into()))
    ));
    assert_eq!(result.unwrap_err(),"--force-restate requires no pending Plan (plan-1)");
    assert_eq!(entered_mutation,1);
    assert_eq!(db.load_job("41").unwrap().unwrap(),before);
    drop(rec);drop(db);
    std::fs::remove_dir_all(root).unwrap();
}
