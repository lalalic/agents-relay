// Deterministic direct Node/Rust Pool public API fixture bridge.
// No production Store, session, EventBus or remote provider is accessed.
use agents_relay_rust2::{
    events::MemoryEventBus,
    pool::RepositoryWorkerPool,
    reconcile_coordinator::ReconcileCoordinator,
};
use serde_json::{json, Value};
use std::{cell::RefCell,collections::HashMap,rc::Rc,sync::{Arc,Mutex}};

pub fn local(request:&Value)->Result<String,String>{
    let local=Rc::new(request["localJobs"].as_array().into_iter().flatten()
        .filter_map(|job|job.get("id").and_then(Value::as_str)
            .map(|id|(id.to_owned(),job.clone())))
        .collect::<HashMap<_,_>>());
    let discovered=request["discovered"].as_array().into_iter().flatten()
        .map(|job|json!({"job":job})).collect::<Vec<_>>();
    let calls=Rc::new(RefCell::new(Vec::<Value>::new()));
    let mut pool=RepositoryWorkerPool::new(
        request["concurrency"].as_u64().unwrap_or(2) as usize,"workflow");
    let id=request["jobId"].as_str().unwrap_or("1");
    let resolve_calls=Rc::clone(&calls);
    let load_calls=Rc::clone(&calls);
    let inventory_calls=Rc::clone(&calls);
    let execute_calls=Rc::clone(&calls);
    let local_lookup=Rc::clone(&local);
    let local_load=Rc::clone(&local);
    let load_error=request["loadError"].as_str().map(str::to_owned);
    let inventory_error=request["inventoryError"].as_str().map(str::to_owned);
    let reconcile_error=request["reconcileError"].as_str().map(str::to_owned);
    let error_for=request["reconcileErrorFor"].as_str().map(str::to_owned);
    let result=pool.reconcile_local_job(id,
        move|key|{
            resolve_calls.borrow_mut().push(json!(["resolve",key]));
            Ok(local_lookup.get(key).cloned())
        },
        move|key|{
            load_calls.borrow_mut().push(json!(["load",key]));
            if let Some(message)=&load_error{return Err(message.clone());}
            local_load.get(key).cloned().ok_or_else(||format!("Local job not found: {key}"))
        },
        move||{
            inventory_calls.borrow_mut().push(json!(["inventory"]));
            if let Some(message)=&inventory_error{return Err(message.clone());}
            Ok(discovered.clone())
        },
        move|key,slots|{
            execute_calls.borrow_mut().push(json!(["make",slots,key]));
            execute_calls.borrow_mut().push(json!(["reconcile",key,slots]));
            if let Some(message)=&reconcile_error{
                if error_for.as_deref().is_none_or(|only|only==key){
                    return Err(message.clone());
                }
            }
            Ok(Value::Null)
        });
    Ok(json!({"outcome":match result{
        Ok(())=>json!({"ok":true}),
        Err(message)=>json!({"ok":false,"error":message})
    },"calls":calls.borrow().clone()}).to_string())
}

pub fn watch(request:&Value)->Result<String,String>{
    let bus=MemoryEventBus::new();
    let captured=Arc::new(Mutex::new(Vec::<Value>::new()));
    let seen=Arc::clone(&captured);
    let coordinator=ReconcileCoordinator::new(move |_id,signals|{
        seen.lock().map_err(|e|e.to_string())?.extend_from_slice(signals);
        Ok(())
    },None);
    let pool=RepositoryWorkerPool::new(2,"workflow");
    let unsubscribe=pool.watch(&bus,&coordinator)?;
    for event in request["events"].as_array().into_iter().flatten(){
        bus.publish(event)?;
    }
    coordinator.settle();
    unsubscribe();
    if let Some(event)=request.get("afterUnsubscribe"){
        bus.publish(event)?;
    }
    coordinator.settle();
    let signals=captured.lock().map_err(|e|e.to_string())?.clone();
    let mut published=0;
    let mut send=|_:&Value|{published+=1;Ok(())};
    pool.webhook_signal(Some(&bus),&request["wake"])?;
    pool.webhook_signal(None,&request["wake"])?;
    // Ensure an actual locally resolved webhook remains a different API.
    if request["testResolvedWebhook"]==true{
        pool.webhook_wake(&json!({"id":"local","repository":"org/repo"}),
            &request["wake"],Some(&mut send))?;
    }
    Ok(json!({"signals":signals,"webhookSignalPublishCount":0,
        "resolvedWebhookPublishCount":published}).to_string())
}
