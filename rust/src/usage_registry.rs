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

// Provider observations publish complete immutable snapshots. Scheduler reads
// never wait for a network call; concurrent readers coalesce one refresh.
#[derive(Clone)]
pub struct SharedUsageCache{
    state:Arc<UsageCacheState>,
    fetch:Arc<dyn Fn()->Result<Value,String>+Send+Sync>,
}
#[derive(Default)]
struct UsageCacheState{
    result:arc_swap::ArcSwapOption<UsageObservation>,
    refreshing:std::sync::atomic::AtomicBool,
}
struct UsageObservation{
    at:std::time::Instant,
    result:Result<Value,String>,
}
impl SharedUsageCache{
    pub fn new(fetch:impl Fn()->Result<Value,String>+Send+Sync+'static)->Self{
        Self{state:Arc::new(UsageCacheState::default()),fetch:Arc::new(fetch)}
    }
    fn fresh(&self)->Option<Result<Value,String>>{
        self.state.result.load().as_ref().filter(|sample|
            sample.at.elapsed()<std::time::Duration::from_secs(
                if sample.result.is_ok(){60}else{5}))
            .map(|sample|sample.result.clone())
    }
    fn request(&self){
        use std::sync::atomic::Ordering;
        if self.state.refreshing.compare_exchange(false,true,
            Ordering::AcqRel,Ordering::Acquire).is_err(){return;}
        // Another reader may have completed a refresh after our first read.
        if self.fresh().is_some(){
            self.state.refreshing.store(false,Ordering::Release);return;
        }
        let cache=Arc::clone(&self.state);
        let fetch=Arc::clone(&self.fetch);
        let started=std::thread::Builder::new().name("relay-usage-observation".into()).spawn(move||{
            let result=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||fetch()))
                .unwrap_or_else(|_|Err("Usage observation panicked".into()));
            cache.result.store(Some(Arc::new(UsageObservation{at:std::time::Instant::now(),result})));
            cache.refreshing.store(false,Ordering::Release);
        });
        if let Err(error)=started{
            self.state.result.store(Some(Arc::new(UsageObservation{
                at:std::time::Instant::now(),result:Err(format!("Usage observation launch failed: {error}"))})));
            self.state.refreshing.store(false,Ordering::Release);
        }
    }
    /// A missing/expired sample is unknown, never eligible stale capacity.
    pub fn cached(&self)->Result<Value,String>{
        if let Some(result)=self.fresh(){return result;}
        self.request();
        Err("Provider usage observation refreshing".into())
    }
    /// Explicit detached diagnostics can await the same bounded refresh.
    /// No reader holds a shared lock while the provider is in flight.
    pub fn wait(&self)->Result<Value,String>{
        let deadline=std::time::Instant::now()+std::time::Duration::from_secs(35);
        loop{
            if let Some(result)=self.fresh(){return result;}
            self.request();
            let remaining=deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero(){return Err("Provider usage observation timed out".into());}
            std::thread::sleep(remaining.min(std::time::Duration::from_millis(25)));
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
