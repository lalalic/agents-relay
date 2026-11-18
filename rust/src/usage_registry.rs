// Node provenance: src/usage.ts UsageRegistry/UnavailableUsageReader. Provider
// observations are parallel and best-effort, never authoritative Job state.
// Read callbacks are injected; no Codex CLI or external provider is launched.
use crate::local_merge_lock::iso8601_now;
use serde_json::{json,Value};
use std::sync::Arc;

pub trait UsageReader:Send+Sync{
    fn read(&self)->Result<Value,String>;
}
pub trait UsageSnapshotProvider:Send+Sync{
    fn snapshot(&self)->Result<Value,String>;
}
#[derive(Clone)]
pub struct UnavailableUsageReader{
    reason:String,
    now:Arc<dyn Fn()->String+Send+Sync>,
}
impl UnavailableUsageReader{
    pub fn new(reason:impl Into<String>)->Self{
        Self::with_now(reason,iso8601_now)
    }
    pub fn with_now(
        reason:impl Into<String>,now:impl Fn()->String+Send+Sync+'static,
    )->Self{
        Self{reason:reason.into(),now:Arc::new(now)}
    }
    pub fn read(&self)->Value{
        json!({"available":false,"generatedAt":(self.now)(),
            "fiveHour":null,"weekly":null,"reason":self.reason})
    }
}
impl UsageReader for UnavailableUsageReader{
    fn read(&self)->Result<Value,String>{Ok(self.read())}
}
/// Test/provider injection port: the reader may be a network/command provider
/// but registry orchestration never guesses capacity or marks a Task terminal.
pub struct UsageRegistry{
    pub openai:Box<dyn UsageReader>,
    pub zai:Box<dyn UsageReader>,
    pub deepseek:Option<Box<dyn UsageReader>>,
    pub openrouter:Option<Box<dyn UsageReader>>,
    pub browser:Option<Box<dyn UsageReader>>,
    now:Arc<dyn Fn()->String+Send+Sync>,
}
impl UsageRegistry{
    pub fn new(openai:Box<dyn UsageReader>,zai:Box<dyn UsageReader>,
        deepseek:Option<Box<dyn UsageReader>>,
        openrouter:Option<Box<dyn UsageReader>>,
        browser:Option<Box<dyn UsageReader>>,
    )->Self{
        Self::with_now(openai,zai,deepseek,openrouter,browser,iso8601_now)
    }
    pub fn with_now(
        openai:Box<dyn UsageReader>,zai:Box<dyn UsageReader>,
        deepseek:Option<Box<dyn UsageReader>>,
        openrouter:Option<Box<dyn UsageReader>>,
        browser:Option<Box<dyn UsageReader>>,
        now:impl Fn()->String+Send+Sync+'static,
    )->Self{
        Self{openai,zai,deepseek,openrouter,browser,now:Arc::new(now)}
    }
    pub fn snapshot(&self)->Result<Value,String>{
        // Node Promise.all starts every reader before the first is awaited.
        // Each reader stays independently injectable (no provider dependency).
        let (openai,zai,deepseek,openrouter,browser)=std::thread::scope(|scope|{
            let openai=scope.spawn(||self.openai.read());
            let zai=scope.spawn(||self.zai.read());
            let deepseek=self.deepseek.as_ref().map(|r|scope.spawn(||r.read()));
            let openrouter=self.openrouter.as_ref().map(|r|scope.spawn(||r.read()));
            let browser=self.browser.as_ref().map(|r|scope.spawn(||r.read()));
            let join=|h:std::thread::ScopedJoinHandle<'_,Result<Value,String>>|
                h.join().map_err(|_|"Usage reader panicked".to_owned())?;
            (join(openai),join(zai),deepseek.map(join),openrouter.map(join),browser.map(join))
        });
        // Match Promise.all rejection ordering without reporting a partially
        // successful registry snapshot.
        let openai=openai?;
        let zai=zai?;
        let deepseek=deepseek.transpose()?;
        let openrouter=openrouter.transpose()?;
        let browser=browser.transpose()?;
        let mut credits=Vec::new();
        if let Some(credit)=deepseek{credits.push(json!({"id":"deepseek","label":"DeepSeek","credits":credit}));}
        if let Some(credit)=openrouter{credits.push(json!({"id":"openrouter","label":"OpenRouter","credits":credit}));}
        let mut snapshot=json!({"generatedAt":(self.now)(),
            "providers":[{"id":"openai","label":"OpenAI","usage":openai},
                         {"id":"zai","label":"Z.ai","usage":zai}],
            "credits":credits});
        if let Some(browser)=browser{snapshot["browserWorkspace"]=browser;}
        Ok(snapshot)
    }
}
impl UsageSnapshotProvider for UsageRegistry{
    fn snapshot(&self)->Result<Value,String>{self.snapshot()}
}
pub fn read_usage_snapshot(source:&dyn UsageSnapshotProvider)->Result<Value,String>{
    source.snapshot()
}
