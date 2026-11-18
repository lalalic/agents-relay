// Public Pool runtime ports: authoritative local reconciliation and event bus
// subscription mechanics. Graph/SQLite remain owned by the Reconciler/Store.
use super::{event_wake_signal,field,remaining_worker_slots,rows,unified_dag,RepositoryWorkerPool};
use crate::{events::{MemoryEventBus,NatsEventBus,Wake},
    reconcile_coordinator::ReconcileCoordinator};
use serde_json::Value;
use std::sync::Arc;

/// Event buses expose one owned unsubscribe per live subscription.
pub trait PoolEventBus {
    fn subscribe_pool(&self,wake:Wake)->Result<Box<dyn FnOnce()+Send>,String>;
}
impl PoolEventBus for MemoryEventBus {
    fn subscribe_pool(&self,wake:Wake)->Result<Box<dyn FnOnce()+Send>,String>{
        Ok(Box::new(self.subscribe_all(wake)))
    }
}
impl PoolEventBus for NatsEventBus {
    fn subscribe_pool(&self,wake:Wake)->Result<Box<dyn FnOnce()+Send>,String>{
        let subscription=self.subscribe_all(wake)?;
        Ok(Box::new(move||subscription.unsubscribe()))
    }
}
/// Direct local DAG continuation is dispatched before any unrelated Job scan.
/// Store load / inventory / Reconciler effects are supplied by the caller and
/// must be bound to the same authoritative local SQLite Job identity.
pub(super) fn reconcile_local_job<Resolve,Load,Inventory,Execute>(
    pool:&mut RepositoryWorkerPool,job_id:&str,mut resolve:Resolve,mut load:Load,
    mut inventory:Inventory,mut execute:Execute,
)->Result<(),String>
where
    Resolve:FnMut(&str)->Result<Option<Value>,String>,
    Load:FnMut(&str)->Result<Value,String>,
    Inventory:FnMut()->Result<Vec<Value>,String>,
    Execute:FnMut(&str,usize)->Result<Value,String>,
{
    if resolve(job_id)?.is_none(){
        return Err(format!("Local job not found: {job_id}"));
    }
    if !pool.in_reconcile.insert(job_id.to_owned()){
        return Err(format!("Duplicate concurrent Reconcile for {job_id}"));
    }
    let run:Result<(),String>=(||{
        let current=load(job_id)?;
        let dag=field(&current,"state")=="ACTIVE"
            &&rows(&current,"tasks").iter().any(|task|unified_dag(&current,task));
        let slots=if dag{
            let mut all=inventory()?.into_iter().filter_map(|entry|
                entry.get("job").cloned()).filter(|job|
                field(job,"id")!=job_id).collect::<Vec<_>>();
            all.push(current);
            remaining_worker_slots(pool.concurrency,&all)
        }else{0};
        execute(job_id,slots)?;
        Ok(())
    })();
    pool.in_reconcile.remove(job_id);
    run?;
    pool.reconcile_discovered(&inventory()?,resolve,execute)?;
    Ok(())
}
/// Wake-only bus transport; neither an EventBus receipt nor a GitHub webhook
/// can claim an execution lease or a terminal Graph transition.
pub(super) fn watch(bus:&dyn PoolEventBus,coordinator:&ReconcileCoordinator)
    ->Result<Box<dyn FnOnce()+Send>,String>{
    let queue=coordinator.clone();
    bus.subscribe_pool(Arc::new(move|event|{
        if let Some(signal)=event_wake_signal(event){
            drop(queue.accept_transport(signal));
        }
        Ok(())
    }))
}
