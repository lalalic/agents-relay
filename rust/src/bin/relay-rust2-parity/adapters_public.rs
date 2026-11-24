// Original src/adapters.ts public API differential: Codex argument
// construction, browser-driver receipt parsing, ChatGPT tab close policy,
// WebHelm readiness over an injected runner (the Node side uses a fixture
// executable through the real browserWorkspaceCli override), and adapter
// identity contracts.
use agents_relay_rust2::adapters::WorkerAdapter as _;
use agents_relay_rust2::adapters::{
    build_codex_args,CodexAdapter,
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
            }).to_string()),
            other=>Err(format!("unknown certAdaptersPublic method {other}")),
        }
    })())
}
