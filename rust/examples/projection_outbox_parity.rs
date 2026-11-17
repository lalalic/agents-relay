// Direct in-memory-only SQLite fixture adapter for Node src/projection-outbox.ts.
// No filesystem SQLite handles, daemon process, or production state.
use agents_relay_rust2::projection_outbox::{self as p, ProjectionOutbox};
use rusqlite::{types::ValueRef, Connection};
use serde_json::{json, Map, Value};
use std::io::{self, BufRead};
fn wire_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let mut obj = Map::new();
    let row = r.as_ref();
    for i in 0..row.column_count() {
        let key = row.column_name(i)?.to_string();
        let value = match r.get_ref(i)? {
            ValueRef::Null => Value::Null,
            ValueRef::Integer(n) => json!(n),
            ValueRef::Real(n) => json!(n),
            ValueRef::Text(bytes) => json!(String::from_utf8_lossy(bytes).to_string()),
            ValueRef::Blob(bytes) => json!(bytes),
        };
        obj.insert(key, value);
    }
    Ok(Value::Object(obj))
}
fn snapshot(db: &Connection, scoped: bool) -> Result<Value, String> {
    let mut stmt=db.prepare(&format!("SELECT {} FROM projection_outbox ORDER BY {}id",if scoped{"scope_job_id,id,idempotency_key,operation_key,coalesce_key,operation,payload_json,priority,status,attempts,next_attempt_at,last_error,created_at,updated_at,conflict_definition_json,conflict_evidence_json,conflict_detected_at,conflict_disposition,conflict_resolution_json"}else{"id,idempotency_key,operation_key,coalesce_key,operation,payload_json,priority,status,attempts,next_attempt_at,last_error,created_at,updated_at,conflict_definition_json,conflict_evidence_json,conflict_detected_at,conflict_disposition,conflict_resolution_json"},if scoped{"scope_job_id,"}else{""})).map_err(|e|e.to_string())?;
    let rows = stmt
        .query_map([], wire_row)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let receipt_rows=match db.prepare(&format!("SELECT {}operation_key,status,attempts,detail_json,recorded_at FROM projection_receipt ORDER BY {}operation_key",if scoped{"scope_job_id,"}else{""},if scoped{"scope_job_id,"}else{""})){Ok(mut stmt)=>stmt.query_map([],wire_row).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?,Err(_)=>vec![]};
    Ok(json!({"rows":rows,"receipts":receipt_rows}))
}
fn run(req: &Value) -> Result<Value, String> {
    let db = Connection::open_in_memory().map_err(|e| e.to_string())?;
    let scoped = req["scoped"] == true;
    let legacy = req["legacy"] == true;
    if scoped {
        db.execute_batch("CREATE TABLE projection_outbox(scope_job_id TEXT NOT NULL,id INTEGER NOT NULL,idempotency_key TEXT NOT NULL,operation_key TEXT,coalesce_key TEXT,operation TEXT NOT NULL,payload_json TEXT NOT NULL,priority INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT,last_error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,conflict_definition_json TEXT,conflict_evidence_json TEXT,conflict_detected_at TEXT,conflict_disposition TEXT,conflict_resolution_json TEXT,PRIMARY KEY(scope_job_id,id),UNIQUE(scope_job_id,idempotency_key));CREATE TABLE projection_receipt(scope_job_id TEXT NOT NULL,operation_key TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL,detail_json TEXT,recorded_at TEXT,PRIMARY KEY(scope_job_id,operation_key));").map_err(|e|e.to_string())?;
    } else if legacy {
        db.execute_batch("CREATE TABLE projection_outbox(id INTEGER PRIMARY KEY AUTOINCREMENT,idempotency_key TEXT NOT NULL UNIQUE,coalesce_key TEXT,operation TEXT NOT NULL,payload_json TEXT NOT NULL,priority INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','dead')),attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT,last_error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);").map_err(|e|e.to_string())?;
    } else {
        db.execute_batch(&format!(
            "{}{}{}",
            p::create_table_sql("projection_outbox"),
            p::create_index_sql(),
            p::create_receipt_table_sql()
        ))
        .map_err(|e| e.to_string())?;
    }
    let mut results = vec![];
    for step in req["steps"].as_array().ok_or("steps missing")? {
        let action = step["action"].as_str().unwrap_or("");
        let now = step["now"].as_str().unwrap_or("2026-01-01T00:00:00.000Z");
        let scope = step["scope"]
            .as_str()
            .or(if scoped { Some("job-a") } else { None });
        let id = step["id"].as_i64().unwrap_or(1);
        let key = step["key"].as_str().unwrap_or("operation");
        let attempts = step["attempts"].as_i64().unwrap_or(1);
        let store = ProjectionOutbox::new(&db, scope);
        let outcome:Result<Value,String>=match action{
            "enqueue"=>store.enqueue(&step["request"],now).map(|v|json!(v)),
            "claim"=>store.claim_due(step["limit"].as_f64().or(step["limit"].as_i64().map(|n|n as f64)).unwrap_or(1.),now).map(Value::Array),
            "resetProcessing"=>store.reset_processing(now).map(|_|Value::Null),
            "complete"=>store.complete(id).map(|_|Value::Null),
            "completeWithReceipt"=>store.complete_with_receipt(id,key,step["status"].as_str().unwrap_or("succeeded"),attempts,&step["detail"],now).map(|_|Value::Null),
            "retryWithReceipt"=>store.retry_with_receipt(id,key,step["error"].as_str().unwrap_or("error"),step["nextAt"].as_str().unwrap_or(now),attempts,&step["detail"],now).map(|_|Value::Null),
            "recordReceipt"=>store.record_receipt(key,step["status"].as_str().unwrap_or("succeeded"),attempts,&step["detail"],now).map(|_|Value::Null),
            "retry"=>store.retry(id,step["error"].as_str().unwrap_or("error"),step["nextAt"].as_str().unwrap_or(now)).map(|_|Value::Null),
            "deadLetter"=>store.dead_letter(id,step["error"].as_str().unwrap_or("error")).map(|_|Value::Null),
            "recordConflict"=>store.record_conflict(id,&step["diagnostic"]).map(|_|Value::Null),
            "listConflicts"=>store.list_conflicts().map(Value::Array),
            "resolveConflict"=>store.resolve_conflict(id,&step["resolution"]).map(|v|json!(v)),
            "counts"=>Ok(json!({"conflict":store.conflict_count()?,"pending":store.pending_count()?,"terminal":store.terminal_count()?})),
            "dropReceipts"=>db.execute_batch("DROP TABLE projection_receipt").map(|_|Value::Null).map_err(|e|e.to_string()),
            "corruptPayload"=>db.execute("UPDATE projection_outbox SET payload_json='[invalid' WHERE id=?",[id]).map(|_|Value::Null).map_err(|e|e.to_string()),
            "upgrade"=>p::upgrade(&db,step["previousVersion"].as_i64().unwrap_or(4)).map(|_|Value::Null),
            "seedLegacyConflict"=>db.execute("INSERT INTO projection_outbox(idempotency_key,coalesce_key,operation,payload_json,priority,status,attempts,last_error,created_at,updated_at) VALUES(?,'legacy','append_plan','{}',0,'dead',2,'already exists with a different definition',?,?)",rusqlite::params![key,now,now]).map(|_|Value::Null).map_err(|e|e.to_string()),
            _=>Err(format!("unknown action {action}"))};
        let mut value = match outcome {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(error) => json!({"ok":false,"error":error}),
        };
        if let Ok(rows) = snapshot(&db, scoped) {
            value["snapshot"] = rows;
        }
        results.push(value);
    }
    Ok(Value::Array(results))
}
fn main() {
    for line in io::stdin().lock().lines() {
        let output = line
            .map_err(|e| e.to_string())
            .and_then(|l| serde_json::from_str::<Value>(&l).map_err(|e| e.to_string()))
            .and_then(|req| run(&req));
        println!(
            "{}",
            match output {
                Ok(v) => json!({"ok":true,"value":v}),
                Err(e) => json!({"ok":false,"error":e}),
            }
        );
    }
}
