// Original startServiceExternalActionFlusher vs native observable timing/stop
// contract. This differential uses only in-memory fake provider ports.
use agents_relay_rust2::service_external_actions::
    start_service_external_action_flusher_with_ports;
use serde_json::{json,Value};
use std::{
    sync::{Arc,atomic::{AtomicUsize,Ordering}},
    thread,time::Duration,
};
pub fn invoke(request:&Value)->Result<Option<String>,String>{
    if request["op"]!="serviceFlusherProbe"{return Ok(None);}
    let local=request["local"].as_bool().unwrap_or(false);
    let disabled=request["noGitHub"].as_bool().unwrap_or(false);
    let projected=request["projected"].as_u64().unwrap_or(0);
    let fail=request["fail"].as_str().unwrap_or("");
    let fail_flush=fail=="flush";
    let fail_reconcile=fail=="reconcile";
    let interval=request["intervalMs"].as_u64().unwrap_or(45).clamp(15,100);
    let ticks=Arc::new(AtomicUsize::new(0));
    let reconciles=Arc::new(AtomicUsize::new(0));
    let errors=Arc::new(AtomicUsize::new(0));
    let tick_sink=Arc::clone(&ticks);
    let recon_sink=Arc::clone(&reconciles);
    let error_sink=Arc::clone(&errors);
    let mut handle=start_service_external_action_flusher_with_ports(
        local,disabled,Duration::from_millis(interval),
        move||{
            tick_sink.fetch_add(1,Ordering::SeqCst);
            if fail_flush{return Err("fixture projection failed".into());}
            Ok(projected as usize)
        },
        move||{
            recon_sink.fetch_add(1,Ordering::SeqCst);
            if fail_reconcile{return Err("fixture reconcile failed".into());}
            Ok(())
        },
        move|_|{error_sink.fetch_add(1,Ordering::SeqCst);}
    );
    let enabled=local&&!disabled;
    let immediate=(!enabled&&ticks.load(Ordering::SeqCst)==0)
        ||(enabled&&ticks.load(Ordering::SeqCst)>=1);
    thread::sleep(Duration::from_millis(interval*4+35));
    let count=ticks.load(Ordering::SeqCst);
    let repeated=(!enabled&&count==0)||(enabled&&count>=3);
    if let Some(item)=handle.take(){item.stop();}
    let stopped_at=ticks.load(Ordering::SeqCst);
    thread::sleep(Duration::from_millis(interval*2+20));
    let stopped=ticks.load(Ordering::SeqCst)==stopped_at;
    let once=enabled&&projected>0&&!fail_flush;
    let result=json!({
        "immediate":immediate,"repeated":repeated,"stopped":stopped,
        "reconcileOnlyAfterProjection":if once{reconciles.load(Ordering::SeqCst)>0}
            else{reconciles.load(Ordering::SeqCst)==0},
        "errorReported":if enabled&&(fail_flush||fail_reconcile&&projected>0){
            errors.load(Ordering::SeqCst)>0
        }else{errors.load(Ordering::SeqCst)==0},
    });
    Ok(Some(result.to_string()))
}
