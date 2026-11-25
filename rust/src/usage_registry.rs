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

// A single provider observation may be expensive (network or owned CLI).
// Both scheduler and dashboard share the same in-flight refresh; only the
// detached observational request may wait for it. No network I/O under
// the cache mutex. Unknown/expired capacity is not presented as healthy.
#[derive(Clone)]
pub struct SharedUsageCache{
    state:Arc<(std::sync::Mutex<UsageCacheState>,std::sync::Condvar)>,
    fetch:Arc<dyn Fn()->Result<Value,String>+Send+Sync>,
}
#[derive(Default)]
struct UsageCacheState{
    result:Option<(std::time::Instant,Result<Value,String>)>,
    refreshing:bool,
}
impl SharedUsageCache{
    pub fn new(fetch:impl Fn()->Result<Value,String>+Send+Sync+'static)->Self{
        Self{state:Arc::new((std::sync::Mutex::new(UsageCacheState::default()),
            std::sync::Condvar::new())),fetch:Arc::new(fetch)}
    }
    fn fresh(state:&UsageCacheState)->Option<Result<Value,String>>{
        state.result.as_ref().filter(|(at,result)|at.elapsed()<std::time::Duration::from_secs(
            if result.is_ok(){60}else{5})).map(|(_,result)|result.clone())
    }
    fn request(&self,state:&mut UsageCacheState){
        if state.refreshing{return;}
        state.refreshing=true;
        let cache=Arc::clone(&self.state);
        let fetch=Arc::clone(&self.fetch);
        let started=std::thread::Builder::new().name("relay-usage-observation".into()).spawn(move||{
            let result=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||fetch()))
                .unwrap_or_else(|_|Err("Usage observation panicked".into()));
            let (lock,ready)=&*cache;
            if let Ok(mut state)=lock.lock(){
                state.result=Some((std::time::Instant::now(),result));
                state.refreshing=false;
                ready.notify_all();
            }
        });
        if let Err(error)=started{
            state.refreshing=false;
            state.result=Some((std::time::Instant::now(),Err(format!("Usage observation launch failed: {error}"))));
            self.state.1.notify_all();
        }
    }
    /// Scheduler reads never wait on external services. Preserve the existing
    /// unavailable-observation semantics when a fresh sample is not ready.
    pub fn cached(&self)->Result<Value,String>{
        let mut state=self.state.0.lock().map_err(|_|"Usage cache poisoned")?;
        if let Some(result)=Self::fresh(&state){return result;}
        self.request(&mut state);
        Err("Provider usage observation refreshing".into())
    }
    /// Detached UI/test requests may wait, but not indefinitely.
    pub fn wait(&self)->Result<Value,String>{
        let (lock,ready)=&*self.state;
        let mut state=lock.lock().map_err(|_|"Usage cache poisoned")?;
        let deadline=std::time::Instant::now()+std::time::Duration::from_secs(35);
        loop{
            if let Some(result)=Self::fresh(&state){return result;}
            self.request(&mut state);
            let remaining=deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero(){return Err("Provider usage observation timed out".into());}
            let (next,_)=ready.wait_timeout(state,remaining).map_err(|_|"Usage cache poisoned")?;
            state=next;
        }
    }
}

#[cfg(test)]
mod shared_usage_cache_tests{
    use super::*;
    use std::{sync::{mpsc,Mutex,atomic::{AtomicUsize,Ordering}},time::Duration};
    #[test]
    fn scheduler_never_waits_and_detached_readers_share_one_refresh(){
        let (started,seen)=mpsc::channel();
        let (release,gate)=mpsc::channel();
        let gate=Mutex::new(gate);
        let count=Arc::new(AtomicUsize::new(0));
        let calls=Arc::clone(&count);
        let cache=SharedUsageCache::new(move||{
            calls.fetch_add(1,Ordering::SeqCst);
            started.send(()).unwrap();
            gate.lock().unwrap().recv_timeout(Duration::from_secs(5)).unwrap();
            Ok(json!({"providers":[]}))
        });
        assert!(cache.cached().is_err());
        seen.recv_timeout(Duration::from_secs(1)).unwrap();
        let (done,received)=mpsc::channel();
        for _ in 0..4{
            let c=cache.clone();let done=done.clone();
            std::thread::spawn(move||{done.send(c.wait()).unwrap();});
        }
        for _ in 0..10{assert!(cache.cached().is_err());}
        assert_eq!(count.load(Ordering::SeqCst),1);
        release.send(()).unwrap();
        for _ in 0..4{assert!(received.recv_timeout(Duration::from_secs(1)).unwrap().is_ok());}
        assert_eq!(cache.cached().unwrap(),json!({"providers":[]}));
        assert_eq!(count.load(Ordering::SeqCst),1);
    }
}
