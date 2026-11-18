// Node provenance: src/usage.ts. Public reader facades select existing native
// observation primitives; these are never authoritative Job/Task state.
// Provider calls are opt-in and tests use missing API keys / isolated files.
use crate::{usage,usage_registry::UsageReader};
use serde_json::Value;
use std::{path::{Path,PathBuf},sync::{Arc,Mutex},time::{SystemTime,UNIX_EPOCH}};

fn now_ms()->i64 {
    SystemTime::now().duration_since(UNIX_EPOCH)
        .map(|time|time.as_millis() as i64).unwrap_or(0)
}
fn home()->PathBuf { std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default() }
fn api_key(explicit:Option<&str>,name:&str)->Option<String> {
    explicit.map(str::to_string)
        .or_else(||std::env::var(name).ok())
}

pub struct BrowserWorkspaceUsageReader {
    command:PathBuf,
    timeout_ms:u64,
}
impl BrowserWorkspaceUsageReader {
    pub fn new(command:Option<&Path>,timeout_ms:Option<u64>)->Self {
        let path=command.map(Path::to_path_buf).unwrap_or_else(||
            std::env::var_os("AGENTS_RELAY_WEBHELM_COMMAND")
                .map(PathBuf::from).unwrap_or_else(||home().join(".local/bin/webhelm")));
        Self{command:path,timeout_ms:timeout_ms.unwrap_or(30_000)}
    }
    pub fn read(&self)->Value {usage::browser_workspace_usage(&self.command,self.timeout_ms)}
}
impl UsageReader for BrowserWorkspaceUsageReader {
    fn read(&self)->Result<Value,String>{Ok(self.read())}
}

#[derive(Clone)]
pub struct CodexSessionUsageReader {
    codex_home:PathBuf,
    lookback_days:i64,
    cache_ttl_ms:i64,
    now:Arc<dyn Fn()->i64+Send+Sync>,
    cache:Arc<Mutex<Option<(i64,Value)>>>,
}
impl CodexSessionUsageReader {
    pub fn new(codex_home:Option<&Path>,lookback_days:Option<i64>,
        cache_ttl_ms:Option<i64>)->Self {
        Self::with_clock(codex_home,lookback_days,cache_ttl_ms,now_ms)
    }
    pub fn with_clock(codex_home:Option<&Path>,lookback_days:Option<i64>,
        cache_ttl_ms:Option<i64>,now:impl Fn()->i64+Send+Sync+'static)->Self {
        Self{codex_home:codex_home.map(Path::to_path_buf)
                .unwrap_or_else(||home().join(".codex")),
            lookback_days:lookback_days.unwrap_or(8),
            cache_ttl_ms:cache_ttl_ms.unwrap_or(10_000),
            now:Arc::new(now),cache:Arc::new(Mutex::new(None))}
    }
    pub fn read(&self)->Value {
        let now=(self.now)();
        let mut cache=self.cache.lock().expect("Codex session usage cache");
        if let Some((at,value))=cache.as_ref(){
            if now.saturating_sub(*at)<self.cache_ttl_ms{return value.clone();}
        }
        let value=usage::codex_session_usage(&self.codex_home,self.lookback_days,now);
        *cache=Some((now,value.clone()));
        value
    }
}
impl UsageReader for CodexSessionUsageReader {
    fn read(&self)->Result<Value,String>{Ok(self.read())}
}

pub struct ZaiUsageReader {api_key:Option<String>}
impl ZaiUsageReader {
    pub fn new(key:Option<&str>)->Self{Self{api_key:api_key(key,"ZAI_API_KEY")}}
    pub fn read(&self)->Value{usage::zai_usage_reader(self.api_key.as_deref())}
}
impl UsageReader for ZaiUsageReader {
    fn read(&self)->Result<Value,String>{Ok(self.read())}
}
pub struct DeepSeekCreditReader {api_key:Option<String>}
impl DeepSeekCreditReader {
    pub fn new(key:Option<&str>)->Self{Self{api_key:api_key(key,"DEEPSEEK_API_KEY")}}
    pub fn read(&self)->Value{usage::deepseek_credit_reader(self.api_key.as_deref())}
}
impl UsageReader for DeepSeekCreditReader {
    fn read(&self)->Result<Value,String>{Ok(self.read())}
}
pub struct OpenRouterCreditReader {api_key:Option<String>}
impl OpenRouterCreditReader {
    pub fn new(key:Option<&str>)->Self{Self{api_key:api_key(key,"OPENROUTER_API_KEY")}}
    pub fn read(&self)->Value{usage::openrouter_credit_reader(self.api_key.as_deref())}
}
impl UsageReader for OpenRouterCreditReader {
    fn read(&self)->Result<Value,String>{Ok(self.read())}
}
