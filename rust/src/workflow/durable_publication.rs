// Direct port of Node src/workflow/durable-publication.ts: independent transactional SQLite outbox/inbox for graph events.
use crate::observability::json_wire;
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::time::SystemTime;
fn now() -> String {
    DateTime::<Utc>::from(SystemTime::now()).to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn valid(key: &str, event_id: &str) -> Result<(), String> {
    if key.is_empty() || event_id.is_empty() {
        Err("event identity required".into())
    } else {
        Ok(())
    }
}
#[derive(Clone, Debug)]
pub struct PendingWorkflowEvent {
    pub key: String,
    pub event_id: String,
    pub payload: Value,
}
impl PendingWorkflowEvent {
    pub fn from_value(value: &Value) -> Self {
        Self {
            key: value
                .get("key")
                .and_then(Value::as_str)
                .unwrap_or("")
                .into(),
            event_id: value
                .get("eventId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .into(),
            payload: value.get("payload").cloned().unwrap_or(Value::Null),
        }
    }
    pub fn as_value(&self) -> Value {
        json!({"key":self.key,"eventId":self.event_id,"payload":self.payload})
    }
}
pub struct DurableWorkflowPublication<'a> {
    db: &'a Connection,
}
impl<'a> DurableWorkflowPublication<'a> {
    pub fn new(db: &'a Connection) -> Result<Self, String> {
        db.execute_batch("CREATE TABLE IF NOT EXISTS workflow_event_outbox (event_key TEXT PRIMARY KEY,event_id TEXT NOT NULL,payload_json TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','published')),created_at TEXT NOT NULL,published_at TEXT); CREATE INDEX IF NOT EXISTS workflow_event_pending ON workflow_event_outbox(created_at,event_key) WHERE state='pending'")
            .map_err(|error|error.to_string())?;
        Ok(Self { db })
    }
    pub fn enqueue(&self, key: &str, event_id: &str, payload: &Value) -> Result<(), String> {
        valid(key, event_id)?;
        let encoded = json_wire(payload);
        self.db.execute("INSERT OR IGNORE INTO workflow_event_outbox(event_key,event_id,payload_json,created_at) VALUES(?,?,?,?)",
            params![key,event_id,encoded,now()]).map_err(|error|error.to_string())?;
        let prior = self
            .db
            .query_row(
                "SELECT event_id,payload_json FROM workflow_event_outbox WHERE event_key=?",
                params![key],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .map_err(|error| error.to_string())?;
        if prior.0 != event_id || prior.1 != encoded {
            return Err("workflow event key collision".into());
        }
        Ok(())
    }
    pub fn commit_transition_and_events<F>(
        &self,
        transition: F,
        events: &[PendingWorkflowEvent],
    ) -> Result<(), String>
    where
        F: FnOnce(&Connection) -> Result<(), String>,
    {
        self.db
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(|error| error.to_string())?;
        let result = (|| {
            transition(self.db)?;
            for item in events {
                self.enqueue(&item.key, &item.event_id, &item.payload)?;
            }
            Ok(())
        })();
        if result.is_ok() {
            self.db
                .execute_batch("COMMIT")
                .map_err(|error| error.to_string())?;
        } else {
            self.db
                .execute_batch("ROLLBACK")
                .map_err(|error| error.to_string())?;
        }
        result
    }
    pub fn pending(&self) -> Result<Vec<PendingWorkflowEvent>, String> {
        let mut query=self.db.prepare("SELECT event_key,event_id,payload_json FROM workflow_event_outbox WHERE state='pending' ORDER BY created_at,event_key")
            .map_err(|error|error.to_string())?;
        let items = query
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        items
            .into_iter()
            .map(|(key, event_id, raw)| {
                let payload = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
                Ok(PendingWorkflowEvent {
                    key,
                    event_id,
                    payload,
                })
            })
            .collect()
    }
    pub fn replay<F>(&self, mut publish: F) -> Result<usize, String>
    where
        F: FnMut(&PendingWorkflowEvent) -> Result<(), String>,
    {
        let mut delivered = 0;
        for item in self.pending()? {
            publish(&item)?;
            self.db.execute("UPDATE workflow_event_outbox SET state='published',published_at=? WHERE event_key=? AND state='pending'",
                params![now(),item.key]).map_err(|error|error.to_string())?;
            delivered += 1;
        }
        Ok(delivered)
    }
}
pub struct DurableWorkflowConsumer<'a> {
    db: &'a Connection,
}
impl<'a> DurableWorkflowConsumer<'a> {
    pub fn new(db: &'a Connection) -> Result<Self, String> {
        db.execute_batch("CREATE TABLE IF NOT EXISTS workflow_event_inbox (consumer_id TEXT NOT NULL,event_key TEXT NOT NULL,event_id TEXT NOT NULL,payload_json TEXT NOT NULL,consumed_at TEXT NOT NULL,PRIMARY KEY(consumer_id,event_key))")
            .map_err(|error|error.to_string())?;
        Ok(Self { db })
    }
    pub fn consume<F>(
        &self,
        consumer_id: &str,
        event: &PendingWorkflowEvent,
        apply: F,
    ) -> Result<bool, String>
    where
        F: FnOnce(&Connection) -> Result<(), String>,
    {
        if consumer_id.is_empty() || event.key.is_empty() || event.event_id.is_empty() {
            return Err("consumer and event identity required".into());
        }
        let encoded = json_wire(&event.payload);
        self.db
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(|error| error.to_string())?;
        let result = (|| {
            let prior=self.db.query_row("SELECT event_id,payload_json FROM workflow_event_inbox WHERE consumer_id=? AND event_key=?",params![consumer_id,event.key],|row|
                Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?))).optional().map_err(|error|error.to_string())?;
            if let Some(prior) = prior {
                if prior.0 != event.event_id || prior.1 != encoded {
                    return Err("consumer event key collision".into());
                }
                return Ok(false);
            }
            apply(self.db)?;
            self.db.execute("INSERT INTO workflow_event_inbox(consumer_id,event_key,event_id,payload_json,consumed_at) VALUES(?,?,?,?,?)",
                params![consumer_id,event.key,event.event_id,encoded,now()]).map_err(|error|error.to_string())?;
            Ok(true)
        })();
        if result.is_ok() {
            self.db
                .execute_batch("COMMIT")
                .map_err(|error| error.to_string())?;
        } else {
            self.db
                .execute_batch("ROLLBACK")
                .map_err(|error| error.to_string())?;
        }
        result
    }
}
