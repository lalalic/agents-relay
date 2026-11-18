// Native Reconciler.reconcile host contract. The caller owns one SQLite Store,
// Graph/SQLite CAS and effect adapters; none of the volatile effects can run
// before the durable Job transition succeeds.
use serde_json::Value;

/// The host must implement load and CAS against the same physical SQLite
/// Store, never a cache. Outbox publishes are observational; worker launch,
/// provider cancellation and delivery are Graph-selected effects.
pub trait ReconcileHost {
    fn load(&mut self,id:&str)->Result<Value,String>;
    fn persist(&mut self,id:&str,prior:&Value,next:&Value)->Result<Value,String>;
    fn launch(&mut self,action:&Value)->Result<(),String>;
    fn broadcast(&mut self,event:&Value)->Result<(),String>;
    /// Read the immutable generation's POSIX identity from the same SQLite
    /// Store. Missing infrastructure MUST fail closed, not mean no process.
    fn load_execution_process(&mut self,_job_id:&str,_task_id:&str,
        _execution_id:&str)->Result<Option<Value>,String>{
        Err("Execution process SQLite lookup is not wired".into())
    }
}
