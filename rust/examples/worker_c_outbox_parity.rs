// Rust half of isolated in-memory SQLite outbox fixture protocol.
use agents_relay_rust2::projection_outbox as projection;
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};
use std::io::{self, BufRead};
fn run(input: Value) -> Result<Value, String> {
    let db = Connection::open_in_memory().map_err(|e| e.to_string())?;
    let scope = input["scope"].as_str();
    let mut table = projection::create_table_sql("projection_outbox");
    let mut receipt = projection::create_receipt_table_sql().to_string();
    if scope.is_some() {
        table = table
            .replace(
                "id INTEGER PRIMARY KEY AUTOINCREMENT",
                "scope_job_id TEXT NOT NULL, id INTEGER NOT NULL",
            )
            .replace(
                "idempotency_key TEXT NOT NULL UNIQUE",
                "idempotency_key TEXT NOT NULL",
            );
        table = table.replacen(
            "\n      );",
            ",PRIMARY KEY(scope_job_id,id),UNIQUE(scope_job_id,idempotency_key)\n      );",
            1,
        );
        receipt = receipt
            .replace(
                "operation_key TEXT PRIMARY KEY",
                "scope_job_id TEXT NOT NULL,operation_key TEXT NOT NULL",
            )
            .replacen(
                "\n    );",
                ",PRIMARY KEY(scope_job_id,operation_key)\n    );",
                1,
            );
    }
    db.execute_batch(&format!(
        "{table} {} {receipt}",
        projection::create_index_sql()
    ))
    .map_err(|e| e.to_string())?;
    let outbox = projection::ProjectionOutbox::new(&db, scope);
    let mut results = Vec::new();
    for step in input["steps"].as_array().ok_or("missing steps")? {
        let action = step["action"].as_str().unwrap_or("");
        let at = step["now"].as_str().unwrap_or("2026-11-17T12:00:00.000Z");
        let id = step["id"].as_i64().unwrap_or(1);
        let key = step["operationKey"].as_str().unwrap_or("key");
        let attempts = step["attempts"].as_i64().unwrap_or(1);
        let output: Result<Value, String> = match action {
            "enqueue" => outbox.enqueue(&step["request"], at).map(|v| json!(v)),
            "claimDue" => outbox
                .claim_due(step["limit"].as_f64().unwrap_or(5.0), at)
                .map(|v| json!(v)),
            "complete" => outbox.complete(id).map(|_| Value::Null),
            "retryWithReceipt" => outbox
                .retry_with_receipt(
                    id,
                    key,
                    step["error"].as_str().unwrap_or("err"),
                    step["nextAttemptAt"].as_str().unwrap_or(at),
                    attempts,
                    &step["detail"],
                    at,
                )
                .map(|_| Value::Null),
            "completeWithReceipt" => outbox
                .complete_with_receipt(
                    id,
                    key,
                    step["status"].as_str().unwrap_or("succeeded"),
                    attempts,
                    &step["detail"],
                    at,
                )
                .map(|_| Value::Null),
            "recordReceipt" => outbox
                .record_receipt(
                    key,
                    step["status"].as_str().unwrap_or("succeeded"),
                    attempts,
                    &step["detail"],
                    at,
                )
                .map(|_| Value::Null),
            "recordConflict" => outbox
                .record_conflict(id, &step["diagnostic"])
                .map(|_| Value::Null),
            "listConflicts" => outbox.list_conflicts().map(|v| json!(v)),
            "pendingCount" => outbox.pending_count().map(|v| json!(v)),
            "terminalCount" => outbox.terminal_count().map(|v| json!(v)),
            "conflictCount" => outbox.conflict_count().map(|v| json!(v)),
            "resetProcessing" => outbox.reset_processing(at).map(|_| Value::Null),
            "snapshot" => {
                let mut stmt=db.prepare("SELECT id,idempotency_key,operation_key,coalesce_key,operation,payload_json,priority,status,attempts,next_attempt_at,last_error,created_at,updated_at,conflict_definition_json,conflict_evidence_json,conflict_detected_at,conflict_disposition,conflict_resolution_json FROM projection_outbox ORDER BY id").map_err(|e|e.to_string())?;
                let rows=stmt.query_map([],|row|Ok(json!({"id":row.get::<_,i64>(0)?,"idempotency_key":row.get::<_,String>(1)?,"operation_key":row.get::<_,Option<String>>(2)?,"coalesce_key":row.get::<_,Option<String>>(3)?,"operation":row.get::<_,String>(4)?,"payload_json":row.get::<_,String>(5)?,"priority":row.get::<_,i64>(6)?,"status":row.get::<_,String>(7)?,"attempts":row.get::<_,i64>(8)?,"next_attempt_at":row.get::<_,Option<String>>(9)?,"last_error":row.get::<_,Option<String>>(10)?,"created_at":row.get::<_,String>(11)?,"updated_at":row.get::<_,String>(12)?,"conflict_definition_json":row.get::<_,Option<String>>(13)?,"conflict_evidence_json":row.get::<_,Option<String>>(14)?,"conflict_detected_at":row.get::<_,Option<String>>(15)?,"conflict_disposition":row.get::<_,Option<String>>(16)?,"conflict_resolution_json":row.get::<_,Option<String>>(17)?}))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
                let mut receipts=db.prepare("SELECT operation_key,status,attempts,detail_json,recorded_at FROM projection_receipt ORDER BY operation_key").map_err(|e|e.to_string())?;
                let receipts=receipts.query_map([],|row|Ok(json!({"operation_key":row.get::<_,String>(0)?,"status":row.get::<_,String>(1)?,"attempts":row.get::<_,i64>(2)?,"detail_json":row.get::<_,Option<String>>(3)?,"recorded_at":row.get::<_,String>(4)?}))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
                Ok(json!({"rows":rows,"receipts":receipts}))
            }
            "upgrade" => projection::upgrade(&db, step["previousVersion"].as_i64().unwrap_or(4))
                .map(|_| Value::Null),
            "checkReceipt" => {
                let hit: Option<String> = db
                    .query_row(
                        "SELECT status FROM projection_receipt WHERE operation_key=?",
                        [key],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(|e| e.to_string())?;
                Ok(json!(hit))
            }
            other => Err(format!("unsupported action: {other}")),
        };
        results.push(match output {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(_) => json!({"ok":false}),
        });
    }
    Ok(json!(results))
}
fn main() {
    for line in io::stdin().lock().lines().map_while(Result::ok) {
        let output = serde_json::from_str::<Value>(&line)
            .map_err(|e| e.to_string())
            .and_then(run);
        println!(
            "{}",
            match output {
                Ok(v) => json!({"ok":true,"value":v}),
                Err(e) => json!({"ok":false,"error":e}),
            }
        );
    }
}
