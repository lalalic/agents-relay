// Node provenance: src/usage.ts CodexApiUsageReader. Account quota is
// observational and cannot mutate Job/Task lifecycle. The actual Codex
// app-server is opt-in at runtime; offline tests use local fake executables.
use crate::{
    local_merge_lock::iso8601_now,
    owned_process::{OwnedProcessManager,OwnedProcessOptions,TerminationReason},
    usage::codex_app_server_usage_response,
    usage_registry::UsageReader,
};
use serde_json::{json,Value};
use std::{
    io::{BufRead,BufReader,Write},
    sync::{mpsc,Arc},
    thread,
    time::{Duration,Instant},
};

#[derive(Clone)]
pub struct CodexApiUsageReader {
    command:String,
    now:Arc<dyn Fn()->String+Send+Sync>,
}
impl Default for CodexApiUsageReader {
    fn default()->Self{Self::new()}
}
impl CodexApiUsageReader {
    pub fn new()->Self{
        Self::with_command_and_clock("codex",iso8601_now)
    }
    /// Command injection exists for *test fake executables only*. The real
    /// runtime uses `codex app-server --stdio` under OwnedProcessManager.
    pub fn with_command_and_clock(
        command:impl Into<String>,
        now:impl Fn()->String+Send+Sync+'static,
    )->Self{
        Self{command:command.into(),now:Arc::new(now)}
    }
    pub fn read(&self)->Value{
        let generated_at=(self.now)();
        let unavailable=|reason:&str|json!({
            "available":false,"generatedAt":generated_at,
            "fiveHour":null,"weekly":null,"reason":reason,
        });
        // Node's spawnOwnedProcess fails immediately on ENOENT. The Rust
        // supervised spawn is bootstrapped through `/bin/sh`, so without this
        // check an absent `codex` would turn into a misleading 10s timeout.
        let command_path=std::path::Path::new(&self.command);
        let available=if self.command.contains('/') {
            command_path.is_file()
        }else{
            std::env::var_os("PATH").is_some_and(|paths|
                std::env::split_paths(&paths).any(|dir|dir.join(&self.command).is_file()))
        };
        if !available{return unavailable("Codex app-server could not be started.");}
        let mut manager=OwnedProcessManager::default();
        let child=manager.spawn_owned_process_stdio(
            &self.command,&["app-server","--stdio"],OwnedProcessOptions{
                invocation:"usage.codex-app-server".into(),
                timeout_ms:Some(10_000),..OwnedProcessOptions::default()
            });
        let Ok(child)=child else{
            return unavailable("Codex app-server could not be started.");
        };
        let Some(stdout)=child.take_stdout() else{
            child.terminate(TerminationReason::Cancel,None);
            return unavailable("Codex app-server stdout unavailable.");
        };
        let Some(mut stdin)=child.take_stdin() else{
            child.terminate(TerminationReason::Cancel,None);
            return unavailable("Codex app-server stdout unavailable.");
        };
        let started=Instant::now();
        let (replies,received)=mpsc::channel();
        if thread::Builder::new().name("relay-codex-usage-reader".into())
            .spawn(move||{
                for line in BufReader::new(stdout).lines().flatten(){
                    if let Ok(reply)=serde_json::from_str::<Value>(&line){
                        if replies.send(reply).is_err(){break;}
                    }
                }
            }).is_err(){
            child.terminate(TerminationReason::Cancel,None);
            return unavailable("Codex app-server stdout reader could not be started.");
        }
        let initialize=json!({"jsonrpc":"2.0","id":1,"method":"initialize",
            "params":{"clientInfo":{"name":"agents-relay","version":"1"},
                "capabilities":{}}});
        if writeln!(stdin,"{initialize}").is_err(){
            child.terminate(TerminationReason::Cancel,None);
            return unavailable("Codex app-server initialization failed.");
        }
        let timeout=Duration::from_millis(10_000);
        loop{
            let remaining=timeout.saturating_sub(started.elapsed());
            if remaining.is_zero(){
                child.terminate(TerminationReason::Cancel,None);
                return unavailable("Codex app-server initialization timed out.");
            }
            match received.recv_timeout(remaining){
                Ok(reply) if reply.get("id").and_then(Value::as_f64)==Some(1.0)=>{
                    if reply.get("error").is_some()||reply.get("result").is_none(){
                        child.terminate(TerminationReason::Cancel,None);
                        return unavailable("Codex app-server initialization failed.");
                    }
                    break;
                }
                Ok(_)=>continue,
                Err(mpsc::RecvTimeoutError::Timeout)=>{
                    child.terminate(TerminationReason::Cancel,None);
                    return unavailable("Codex app-server initialization timed out.");
                }
                Err(mpsc::RecvTimeoutError::Disconnected)=>{
                    child.terminate(TerminationReason::Cancel,None);
                    return unavailable("Codex app-server closed during initialization.");
                }
            }
        }
        // app-server accepts account methods only after this JSON-RPC
        // initialization notification. Waiting for the initialize reply also
        // keeps the quota request in protocol order instead of relying on a
        // timing delay.
        if writeln!(stdin,"{}",json!({"jsonrpc":"2.0","method":"initialized","params":{}})).is_err(){
            child.terminate(TerminationReason::Cancel,None);
            return unavailable("Codex app-server initialization failed.");
        }
        let query=json!({"jsonrpc":"2.0","id":2,
            "method":"account/rateLimits/read","params":{}});
        if writeln!(stdin,"{query}").is_err(){
            child.terminate(TerminationReason::Cancel,None);
            return unavailable("Codex app-server rate-limit request timed out.");
        }
        loop{
            let remaining=timeout.saturating_sub(started.elapsed());
            if remaining.is_zero(){break;}
            match received.recv_timeout(remaining){
                Ok(reply) if reply.get("id").and_then(Value::as_f64)==Some(2.0)=>{
                    let mut snapshot=codex_app_server_usage_response(&reply);
                    snapshot["generatedAt"]=json!(generated_at);
                    child.terminate(TerminationReason::Cancel,None);
                    return snapshot;
                }
                Ok(_)=>continue,
                Err(mpsc::RecvTimeoutError::Timeout)=>break,
                Err(mpsc::RecvTimeoutError::Disconnected)=>{
                    child.terminate(TerminationReason::Cancel,None);
                    return unavailable("Codex app-server closed before returning rate limits.");
                }
            }
        }
        child.terminate(TerminationReason::Cancel,None);
        unavailable("Codex app-server rate-limit request timed out.")
    }
}
impl UsageReader for CodexApiUsageReader {
    fn read(&self)->Result<Value,String>{Ok(self.read())}
}
