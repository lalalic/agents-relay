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
    sync::Arc,
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
        let initialize=json!({"jsonrpc":"2.0","id":1,"method":"initialize",
            "params":{"clientInfo":{"name":"agents-relay","version":"1"},
                "capabilities":{}}});
        // The async Node reader sends initialize immediately and the rate
        // limit query after 100 ms, preserving app-server handshake ordering.
        if writeln!(stdin,"{initialize}").is_err(){
            child.terminate(TerminationReason::Cancel,None);
            return unavailable("Codex app-server rate-limit request timed out.");
        }
        thread::sleep(Duration::from_millis(100));
        let query=json!({"jsonrpc":"2.0","id":2,
            "method":"account/rateLimits/read","params":{}});
        if writeln!(stdin,"{query}").is_err(){
            child.terminate(TerminationReason::Cancel,None);
            return unavailable("Codex app-server rate-limit request timed out.");
        }
        drop(stdin);
        for line in BufReader::new(stdout).lines(){
            if let Ok(line)=line{
                if let Ok(reply)=serde_json::from_str::<Value>(&line){
                    if reply.get("id").and_then(Value::as_f64)==Some(2.0){
                        let mut snapshot=codex_app_server_usage_response(&reply);
                        snapshot["generatedAt"]=json!(generated_at);
                        child.terminate(TerminationReason::Cancel,None);
                        return snapshot;
                    }
                }
            }
        }
        // EOF without id=2 does not mean success. Node still waits for its
        // bounded timeout; the eventual observation remains unavailable.
        let remaining=Duration::from_millis(10_000).saturating_sub(started.elapsed());
        if !remaining.is_zero(){thread::sleep(remaining);}
        child.terminate(TerminationReason::Cancel,None);
        unavailable("Codex app-server rate-limit request timed out.")
    }
}
impl UsageReader for CodexApiUsageReader {
    fn read(&self)->Result<Value,String>{Ok(self.read())}
}
