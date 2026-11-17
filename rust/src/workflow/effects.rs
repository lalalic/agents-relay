// Direct port of Node src/workflow/effects.ts: registered async Effect callbacks, durable receipt abstraction, ordered execution, deduplication and failure observations.
use crate::observability::{classify_failure, js_string, observability};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
};

#[derive(Clone, Debug)]
pub struct WorkflowEffectError {
    pub value: Value,
    pub is_error: bool,
}
impl WorkflowEffectError {
    pub fn new(message: &str) -> Self {
        Self {
            value: json!({"message":message}),
            is_error: true,
        }
    }
    pub fn display(&self) -> String {
        if self.is_error {
            self.value["message"].as_str().unwrap_or("").to_string()
        } else {
            js_string(&self.value)
        }
    }
}
pub type EffectFuture = Pin<Box<dyn Future<Output = Result<(), WorkflowEffectError>> + Send>>;
pub type ReceiptFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, WorkflowEffectError>> + Send + 'a>>;
pub type EffectCallback = Arc<dyn Fn(Value) -> EffectFuture + Send + Sync>;
pub type KeyCallback = Arc<dyn Fn(&Value) -> Option<String> + Send + Sync>;
pub type OutcomeCallback = Arc<dyn Fn(Value) -> EffectFuture + Send + Sync>;

pub trait WorkflowEffectReceiptStore: Send + Sync {
    fn has<'a>(&'a self, key: &'a str) -> ReceiptFuture<'a, bool>;
    fn mark_completed<'a>(&'a self, key: &'a str) -> ReceiptFuture<'a, ()>;
}
#[derive(Default)]
pub struct MemoryWorkflowEffectReceiptStore {
    completed: Mutex<HashSet<String>>,
}
impl MemoryWorkflowEffectReceiptStore {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn completed_keys(&self) -> Vec<String> {
        let mut keys = self
            .completed
            .lock()
            .expect("receipt store mutex")
            .iter()
            .cloned()
            .collect::<Vec<_>>();
        keys.sort();
        keys
    }
    pub fn mark_preexisting(&self, key: &str) {
        self.completed
            .lock()
            .expect("receipt store mutex")
            .insert(key.into());
    }
}
impl WorkflowEffectReceiptStore for MemoryWorkflowEffectReceiptStore {
    fn has<'a>(&'a self, key: &'a str) -> ReceiptFuture<'a, bool> {
        Box::pin(async move {
            Ok(self
                .completed
                .lock()
                .expect("receipt store mutex")
                .contains(key))
        })
    }
    fn mark_completed<'a>(&'a self, key: &'a str) -> ReceiptFuture<'a, ()> {
        Box::pin(async move {
            self.completed
                .lock()
                .expect("receipt store mutex")
                .insert(key.into());
            Ok(())
        })
    }
}

#[derive(Clone)]
pub struct WorkflowEffectHandler {
    pub name: String,
    pub callback: EffectCallback,
    pub key: Option<KeyCallback>,
}
// Node exports the callback concrete class in addition to the base Handler.
// Keep both public Rust types: the concrete wrapper delegates to the same
// idempotency and async execution implementation without duplicating policy.
#[derive(Clone)]
pub struct CallbackWorkflowEffectHandler {
    inner: WorkflowEffectHandler,
}
impl CallbackWorkflowEffectHandler {
    pub fn new(name: &str, callback: EffectCallback) -> Self {
        Self {
            inner: WorkflowEffectHandler::new(name, callback),
        }
    }
    pub fn with_key(name: &str, callback: EffectCallback, key: KeyCallback) -> Self {
        Self {
            inner: WorkflowEffectHandler::with_key(name, callback, key),
        }
    }
    pub fn idempotency_key(&self, context: &Value) -> String {
        self.inner.idempotency_key(context)
    }
    pub async fn execute(&self, context: &Value) -> Result<(), WorkflowEffectError> {
        self.inner.execute(context).await
    }
    pub fn into_handler(self) -> WorkflowEffectHandler {
        self.inner
    }
}
impl From<CallbackWorkflowEffectHandler> for WorkflowEffectHandler {
    fn from(value: CallbackWorkflowEffectHandler) -> Self {
        value.inner
    }
}

impl WorkflowEffectHandler {
    pub fn new(name: &str, callback: EffectCallback) -> Self {
        Self {
            name: name.into(),
            callback,
            key: None,
        }
    }
    pub fn with_key(name: &str, callback: EffectCallback, key: KeyCallback) -> Self {
        Self {
            name: name.into(),
            callback,
            key: Some(key),
        }
    }
    pub fn idempotency_key(&self, context: &Value) -> String {
        if let Some(key) = &self.key {
            if let Some(result) = key(context) {
                return result;
            }
        }
        let job = context
            .get("jobId")
            .map(js_string)
            .unwrap_or_else(|| "undefined".into());
        let task = context
            .get("taskId")
            .filter(|value| !value.is_null())
            .map(js_string)
            .unwrap_or_else(|| "job".into());
        let transition = context
            .get("transitionKey")
            .map(js_string)
            .unwrap_or_else(|| "undefined".into());
        format!("{}:{job}:{task}:{transition}", self.name)
    }
    pub async fn execute(&self, context: &Value) -> Result<(), WorkflowEffectError> {
        (self.callback)(context.clone()).await
    }
}

pub struct WorkflowEffectExecutor {
    handlers: HashMap<String, WorkflowEffectHandler>,
    receipts: Arc<dyn WorkflowEffectReceiptStore>,
}
impl WorkflowEffectExecutor {
    pub fn new(
        handlers: Vec<WorkflowEffectHandler>,
        receipts: Arc<dyn WorkflowEffectReceiptStore>,
    ) -> Result<Self, String> {
        let mut result = Self {
            handlers: HashMap::new(),
            receipts,
        };
        for handler in handlers {
            result.register(handler)?;
        }
        Ok(result)
    }
    pub fn with_memory(handlers: Vec<WorkflowEffectHandler>) -> Result<Self, String> {
        Self::new(handlers, Arc::new(MemoryWorkflowEffectReceiptStore::new()))
    }
    pub fn register(&mut self, handler: WorkflowEffectHandler) -> Result<(), String> {
        if self.handlers.contains_key(&handler.name) {
            return Err(format!(
                "Workflow effect handler already registered: {}",
                handler.name
            ));
        }
        self.handlers.insert(handler.name.clone(), handler);
        Ok(())
    }
    pub async fn execute(
        &self,
        effects: &[String],
        context: &Value,
        on_outcome: Option<&OutcomeCallback>,
    ) -> Result<Vec<Value>, WorkflowEffectError> {
        let mut outcomes = Vec::new();
        for effect in effects {
            let handler = self.handlers.get(effect).ok_or_else(|| {
                WorkflowEffectError::new(&format!(
                    "No workflow effect handler registered for {effect}"
                ))
            })?;
            let key = handler.idempotency_key(context);
            if self.receipts.has(&key).await? {
                let outcome = json!({"effect":effect,"key":key,"status":"deduplicated"});
                outcomes.push(outcome.clone());
                self.record_effect(context, &outcome, None);
                if let Some(on_outcome) = on_outcome {
                    on_outcome(outcome).await?;
                }
                continue;
            }
            let attempt = async {
                handler.execute(context).await?;
                self.receipts.mark_completed(&key).await?;
                let outcome = json!({"effect":effect,"key":key,"status":"completed"});
                outcomes.push(outcome.clone());
                self.record_effect(context, &outcome, None);
                if let Some(on_outcome) = on_outcome {
                    on_outcome(outcome).await?;
                }
                Ok::<(), WorkflowEffectError>(())
            }
            .await;
            if let Err(error) = attempt {
                let outcome =
                    json!({"effect":effect,"key":key,"status":"failed","error":error.display()});
                outcomes.push(outcome.clone());
                self.record_effect(context, &outcome, Some(&error));
                if let Some(on_outcome) = on_outcome {
                    on_outcome(outcome).await?;
                }
            }
        }
        Ok(outcomes)
    }
    fn record_effect(&self, context: &Value, outcome: &Value, error: Option<&WorkflowEffectError>) {
        let effect = outcome["effect"].as_str().unwrap_or("");
        let status = outcome["status"].as_str().unwrap_or("");
        let is_failed = status == "failed";
        let mut data = json!({"effect":effect,"idempotencyKey":outcome["key"],"transitionKey":context["transitionKey"]});
        if let Some(error) = error {
            data["classification"] =
                classify_failure(&error.value, error.is_error)["classification"].clone();
        }
        let mut correlation = json!({"jobId":context["jobId"]});
        if let Some(task) = context.get("taskId") {
            correlation["taskId"] = task.clone();
        }
        let message = if is_failed {
            format!(
                "Effect {effect} failed: {}",
                outcome["error"].as_str().unwrap_or("unknown error")
            )
        } else {
            format!("Effect {effect} {status}")
        };
        observability().record(&json!({
            "stage":"transition","event":if is_failed{"workflow.effect.failed"}else{"workflow.effect"},
            "level":if is_failed{"error"}else{"info"},
            "outcome":if status=="deduplicated"{"deduplicated"}else if is_failed{"failed"}else{"succeeded"},
            "message":message,"correlation":correlation,
            "transition":{"graph":"workflow.effect","from":null,"to":null,"actions":[effect]},
            "data":data,
        }));
    }
}
