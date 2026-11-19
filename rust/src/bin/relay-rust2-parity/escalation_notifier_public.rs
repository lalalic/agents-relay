// Original escalation-notifier.ts public API differential: environment
// validation, the durable delivery ledger semantics over injected notifier
// outcomes, and the real loopback HTTP transport demanding verified provider
// receipts (test-owned 127.0.0.1 server, no production network).
use agents_relay_rust2::escalation_notifier::{
    deliver_pending_escalations,escalation_notifier_from_environment,
    send_escalation_notification,NotificationMutation,
};
use serde_json::{json,Value};
use std::collections::HashMap;
use std::time::{Duration,SystemTime};

fn env_map(request:&Value)->HashMap<String,String>{
    request["env"].as_object().map(|object|object.iter()
        .map(|(key,value)|(key.clone(),value.as_str().unwrap_or("").to_string()))
        .collect()).unwrap_or_default()
}
pub fn invoke(request:&Value)->Option<Result<String,String>>{
    if request["op"]!="certEscalationNotifier"{return None;}
    Some((||{
        match request["method"].as_str().unwrap_or(""){
            "envConfig"=>match escalation_notifier_from_environment(&env_map(request)){
                Ok(None)=>Ok(json!({"configured":false}).to_string()),
                Ok(Some(config))=>Ok(json!({"configured":true,
                    "hasToken":config.token.is_some()}).to_string()),
                // Both stacks reject the same environment shapes; the parse
                // error text itself is HTTP-stack specific.
                Err(_message)=>Err("environment rejected".into()),
            },
            "deliver"=>{
                let job=request["job"].clone();
                let job_id=request["jobId"].as_str().unwrap_or("").to_string();
                let now=SystemTime::UNIX_EPOCH+Duration::from_millis(
                    request["nowMs"].as_u64().unwrap_or(0));
                let has_atomic=request["hasAtomicMutation"].as_bool().unwrap_or(true);
                let mode=request["notifierMode"].as_str().unwrap_or("none").to_string();
                let captured=std::sync::Arc::new(
                    std::sync::Mutex::new(Vec::<Value>::new()));
                let captured_for_closure=std::sync::Arc::clone(&captured);
                let notifier:Option<std::sync::Arc<dyn Fn(&Value)->Result<Value,String>>>=
                    if mode=="none"{None}else{
                        Some(std::sync::Arc::new(move |notification:&Value|{
                            captured_for_closure.lock().expect("capture lock")
                                .push(notification.clone());
                            match mode.as_str(){
                                "ok"=>Ok(json!({"channel":"loopback",
                                    "deliveryId":"rcpt-1",
                                    "deliveredAt":"2026-11-18T12:00:00.000Z"})),
                                "invalid"=>Ok(json!({"channel":"",
                                    "deliveryId":"rcpt-1",
                                    "deliveredAt":"2026-11-18T12:00:00.000Z"})),
                                "reject"=>Err("Notification endpoint HTTP 500".into()),
                                other=>Err(format!("mode {other} failed")),
                            }
                        }))
                    };
                let mut recorded:Vec<Value>=Vec::new();
                let counts=deliver_pending_escalations(&job,&job_id,now,
                    notifier.as_deref(),
                    |task_id,escalation_id,mutation|{
                        let entry=match mutation{
                            NotificationMutation::MissingChannel=>json!({
                                "kind":"missingChannel","taskId":task_id,
                                "escalationId":escalation_id}),
                            NotificationMutation::Delivered{receipt}=>json!({
                                "kind":"delivered","taskId":task_id,
                                "escalationId":escalation_id,"receipt":receipt}),
                            NotificationMutation::Failed{message,attempts,
                                last_attempt_at,next_attempt_at}=>json!({
                                "kind":"failed","taskId":task_id,
                                "escalationId":escalation_id,"message":message,
                                "attempts":attempts,"lastAttemptAt":last_attempt_at,
                                "nextAttemptAt":next_attempt_at}),
                        };
                        recorded.push(entry);
                        Ok(())
                    },has_atomic)?;
                let requests=captured.lock().expect("capture lock").split_off(0);
                Ok(json!({"delivered":counts.delivered,"pending":counts.pending,
                    "failed":counts.failed,"mutations":recorded,
                    "requests":requests}).to_string())
            },
            "httpSend"=>{
                let env=env_map(request);
                let config=escalation_notifier_from_environment(&env)?
                    .ok_or("notifier endpoint not configured")?;
                match send_escalation_notification(&config,&request["request"]){
                    Ok(receipt)=>Ok(json!({"ok":true,"receipt":receipt}).to_string()),
                    Err(message)=>Ok(json!({"ok":false,"message":message}).to_string()),
                }
            },
            value=>Err(format!("Unknown escalation-notifier method {value}")),
        }
    })())
}
