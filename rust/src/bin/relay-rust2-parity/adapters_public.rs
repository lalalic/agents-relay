// Original src/adapters.ts public API differential: Codex argument
// construction, browser-driver receipt parsing, ChatGPT tab close policy,
// WebHelm readiness over an injected runner (the Node side uses a fixture
// executable through the real browserWorkspaceCli override), and adapter
// identity contracts.
use agents_relay_rust2::adapters::WorkerAdapter as _;
use agents_relay_rust2::adapters::{
    build_codex_args,chatgpt_tab_close_policy,ensure_chatgpt_web_helm_ready,
    parse_driver_json,ChatGptAdapter,CodexAdapter,
};
use serde_json::{json,Value};
use std::sync::atomic::AtomicBool;

pub fn invoke(request:&Value)->Option<Result<String,String>>{
    if request["op"]!="certAdaptersPublic"{return None;}
    Some((||{
        match request["method"].as_str().unwrap_or(""){
            "buildCodexArgs"=>Ok(json!({"ok":true,
                "args":build_codex_args(&request["route"],
                    request["input"].as_str().unwrap_or(""))}).to_string()),
            "parseDriverJson"=>match parse_driver_json(
                request["output"].as_str().unwrap_or("")){
                Ok(receipt)=>Ok(json!({"ok":true,"receipt":receipt}).to_string()),
                Err(message)=>Ok(json!({"ok":false,"error":message}).to_string()),
            },
            "tabClosePolicy"=>match chatgpt_tab_close_policy(
                request["value"].as_str(),
                request["fallback"].as_str().unwrap_or("after-start")){
                Ok(policy)=>Ok(json!({"ok":true,"policy":policy}).to_string()),
                Err(message)=>Ok(json!({"ok":false,"error":message}).to_string()),
            },
            "webhelmReady"=>{
                let scenario=request["scenario"].as_str().unwrap_or("ok");
                let outcome=ensure_chatgpt_web_helm_ready(
                    |argv:&[&str]|->Result<String,String>{
                        match argv.join(" ").as_str(){
                            "platform profile chatgpt"=>Ok(match scenario{
                                "wrong-platform"=>"{\"platform\":\"codex\"}".into(),
                                "profile-no-json"=>"loading skill...".into(),
                                _=>"{\"platform\":\"chatgpt\"}".into(),
                            }),
                            "status"=>Ok(match scenario{
                                "daemon-false"=>"{\"daemon\":{\"running\":false}}".into(),
                                "daemon-missing"=>"{}".into(),
                                "daemon-string"=>"{\"daemon\":{\"running\":\"yes\"}}".into(),
                                "status-no-json"=>"daemon: ok".into(),
                                _=>"{\"daemon\":{\"running\":true}}".into(),
                            }),
                            other=>Err(format!("unexpected argv {other}")),
                        }
                    });
                match outcome{
                    Ok(())=>Ok(json!({"ok":true}).to_string()),
                    Err(message)=>Ok(json!({"ok":false,"error":message}).to_string()),
                }
            }
            "codexLaunch"=>{
                // User-owned synthetic executable only; never Codex CLI/provider.
                let path=request["command"].as_str()
                    .ok_or("codexLaunch fixture executable missing")?;
                if !std::path::Path::new(path).is_absolute()
                    || !path.contains("rust2-adapter-launch-"){
                    return Ok(json!({"ok":false,
                        "error":"codexLaunch requires isolated fixture executable"}).to_string());
                }
                let adapter=CodexAdapter{command:path.to_string()};
                match adapter.launch(&request["task"],&request["context"],&AtomicBool::new(false)){
                    Ok(result)=>Ok(json!({"ok":true,
                        "threadId":result.thread_id,
                        "result":result.result,
                        "processExit":result.process_exit}).to_string()),
                    Err(error)=>Ok(json!({"ok":false,"error":error}).to_string()),
                }
            },
            "adapterIdentity"=>Ok(json!({
                "codex":{"name":CodexAdapter::default().name(),
                    "id":CodexAdapter::default().id(),
                    "capabilities":CodexAdapter::default().capabilities()},
                "chatgpt":{"name":ChatGptAdapter::default().name(),
                    "id":ChatGptAdapter::default().id(),
                    "capabilities":ChatGptAdapter::default().capabilities()},
                "chatgptDefaultPolicy":ChatGptAdapter::default().tab_close_policy,
            }).to_string()),
            other=>Err(format!("unknown certAdaptersPublic method {other}")),
        }
    })())
}
