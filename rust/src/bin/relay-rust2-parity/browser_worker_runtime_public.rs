// Original Node browser-worker-runtime.ts public pooledWebHelmRun, exercised
// against caller-owned Unix WebHelm IPC and owned native CLI. This adapter
// executes real Rust Browser Pool leases; it never talks to a live browser.
use agents_relay_rust2::{
    browser_worker_pool::{BrowserPoolOptions,BrowserWorkerPoolManager},
    browser_worker_runtime::pooled_web_helm_run,
};
use serde_json::{json,Value};
use std::{path::PathBuf,sync::atomic::AtomicBool};
pub fn invoke(request:&Value)->Option<Result<String,String>>{
    if request["op"]!="certBrowserWorkerRuntime"{return None;}
    Some((||{
        let read=|key:&str|request[key].as_str().unwrap_or("").to_owned();
        let socket=PathBuf::from(read("socketPath"));
        let cli=PathBuf::from(read("cliPath"));
        let provider=read("provider");
        let behavior=read("behavior");
        let path=PathBuf::from(read("poolPath"));
        let mut pool=BrowserWorkerPoolManager::open(BrowserPoolOptions{
            path:Some(path),capacity:1,queue_wait_ms:1500,poll_ms:5,
            ..Default::default()
        }).map_err(|e|e.to_string())?;
        let stopped=AtomicBool::new(false);
        let result=pooled_web_helm_run(&socket,&cli,"Relay",&mut pool,
            &provider,"cert-browser-runtime-execution",&stopped,
            ||Ok(json!({"action":"new-thread",
                "config":{"message":"isolated parity fixture","wait":false}})));
        let (accepted,receipt,error,activity,heartbeat,recovered,recovery_turns)=match result{
            Ok((mut state,received))=>{
                let mut activity=false;
                let mut heartbeat=false;
                let mut recovered=false;
                if behavior=="activity"{
                    state.heartbeat(&socket)?;
                    heartbeat=true;
                    // Node runtime monitors this same read-only assistant
                    // output in an interval. Rust exposes the probes to the
                    // owning adapter; no browser heartbeat counts as model
                    // progress.
                    for _ in 0..2{
                        state.probe(&socket,&pool,90_000,120_000,
                            |_|{activity=true;Ok(())},
                            |_|Ok(json!({})))?;
                    }
                }
                if behavior.starts_with("recovery"){
                    state.probe_with_recovery(&socket,&pool,100,40,
                        |_|Ok(()),
                        |_|Ok(json!({"thread_id":"fixture-thread-123",
                            "message":"Verify exact terminal EventBus"})),
                        |id,verified|{
                            if behavior=="recovery-callback-fails"{
                                return Err("callback failure after send".into());
                            }
                            recovered=id=="fixture-thread-123"&&!verified.is_empty();
                            Ok(())
                        })?;
                    std::thread::sleep(std::time::Duration::from_millis(90));
                    state.probe_with_recovery(&socket,&pool,100,40,
                        |_|Ok(()),
                        |_|Ok(json!({"thread_id":"fixture-thread-123",
                            "message":"Verify exact terminal EventBus"})),
                        |id,verified|{
                            if behavior=="recovery-callback-fails"{
                                return Err("callback failure after send".into());
                            }
                            recovered=id=="fixture-thread-123"&&!verified.is_empty();
                            Ok(())
                        })?;
                }
                let recovery_turns=state.recoveries;
                if behavior=="cancel"{
                    state.cancel(&pool,&socket)?;
                }else if behavior!="hold"{
                    // In the original browser runtime, a verified terminal
                    // event calls PooledRun.release, not a submission receipt.
                    state.release(&pool,&socket)?;
                }
                (true,received.receipt,String::new(),activity,heartbeat,recovered,recovery_turns)
            },
            Err(error)=>(false,Value::Null,error,false,false,false,0),
        };
        let snapshot=pool.snapshot(&provider).map_err(|e|e.to_string())?;
        Ok(json!({
            "accepted":accepted,
            "activity":activity,
            "heartbeat":heartbeat,
            "recovered":recovered,
            "recoveryTurns":recovery_turns,
            "status":receipt["status"],
            "threadId":receipt["thread_id"],
            "threadUrl":receipt["thread_url"],
            "verifiedBy":receipt["verified_by"],
            "idle":snapshot.idle,
            "leased":snapshot.leased,
            "quarantined":snapshot.quarantined,
            "health":snapshot.health,
            "error": if accepted{""}else if error.contains("Submission outcome unknown")
                {"uncertain-submission"}else{"other-failure"}
        }).to_string())
    })())
}
