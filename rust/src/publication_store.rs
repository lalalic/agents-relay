// Direct port of Node src/publication-store.ts: one-transaction webhook delivery deduplication and monotonic Job publication state.
use crate::{json_wire_parse::parse_js_json, observability::json_wire};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use std::time::SystemTime;
pub fn load_publication_from_database(
    db: &Connection,
    job_id: &str,
) -> Result<Option<Value>, String> {
    let stored = db
        .query_row(
            "SELECT json FROM publication_state WHERE job_id=?",
            params![job_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    stored.map(|raw| parse_js_json(&raw)).transpose()
}
pub fn list_publication_events_from_database(
    db: &Connection,
    job_id: &str,
) -> Result<Vec<Value>, String> {
    let mut query=db.prepare("SELECT delivery_id,type,json,observed_at FROM publication_delivery WHERE job_id=? ORDER BY observed_at,delivery_id").map_err(|error|error.to_string())?;
    let rows = query
        .query_map(params![job_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    rows.into_iter().map(|(delivery_id,kind,raw,observed_at)|Ok(json!({"deliveryId":delivery_id,"type":kind,"observedAt":observed_at,"payload":parse_js_json(&raw)?}))).collect()
}
pub fn record_publication_in_database(
    db: &mut Connection,
    job_id: &str,
    delivery_id: &str,
    publication: Option<&Value>,
    failure: Option<&Value>,
    observed_at: Option<&str>,
) -> Result<bool, String> {
    if publication.is_none() && failure.is_none() {
        return Ok(false);
    }
    let now = observed_at.map(str::to_string).unwrap_or_else(|| {
        DateTime::<Utc>::from(SystemTime::now()).to_rfc3339_opts(SecondsFormat::Millis, true)
    });
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let payload = publication
        .or(failure)
        .ok_or("publication or failure required")?;
    let kind = if publication.is_some() {
        "package.published"
    } else {
        "package.publish_failed"
    };
    let count=tx.execute("INSERT OR IGNORE INTO publication_delivery(job_id,delivery_id,type,json,observed_at) VALUES(?,?,?,?,?)",
        params![job_id,delivery_id,kind,json_wire(payload),now]).map_err(|error|error.to_string())?;
    if count == 0 {
        tx.commit().map_err(|error| error.to_string())?;
        return Ok(false);
    }
    let previous = load_publication_from_database(&tx, job_id)?;
    let is_newer = previous.as_ref().is_none_or(|prior| {
        now.as_str() >= prior.get("updatedAt").and_then(Value::as_str).unwrap_or("")
    });
    let next = if is_newer {
        json!({"latest":publication.cloned().or_else(||previous.as_ref().and_then(|previous|previous.get("latest")).cloned()).unwrap_or(Value::Null),
            "failure":failure.cloned().or_else(||if publication.is_some(){None}else{previous.as_ref().and_then(|previous|previous.get("failure")).cloned()}).unwrap_or(Value::Null),
            "updatedAt":now})
    } else {
        previous.unwrap_or(Value::Null)
    };
    tx.execute("INSERT INTO publication_state(job_id,json) VALUES(?,?) ON CONFLICT(job_id) DO UPDATE SET json=excluded.json",
        params![job_id,json_wire(&next)]).map_err(|error|error.to_string())?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(true)
}
