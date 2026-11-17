// Isolated Rust FileFeedbackStore fixture. Every root is a newly created /tmp directory,
// removed after the run; never reads the user's Relay store.
use agents_relay_rust2::feedback::{
    self, FeedbackAttachmentInput, FeedbackLimits, FeedbackSubmission, FileFeedbackStore,
};
use serde_json::{json, Value};
use std::io::{self, BufRead};
use std::path::Path;
fn run(req: Value) -> Result<Value, String> {
    let path = std::env::temp_dir().join(format!(
        "rust2-worker-c-feedback-parity-{}",
        std::process::id()
    ));
    let root = path.join(format!("case-{}", req["case"].as_u64().unwrap_or(0)));
    let limits = req.get("limits").map(|v| FeedbackLimits {
        max_text_length: v["maxTextLength"].as_u64().unwrap_or(20_000) as usize,
        max_attachments: v["maxAttachments"].as_u64().unwrap_or(5) as usize,
        max_attachment_bytes: v["maxAttachmentBytes"].as_u64().unwrap_or(10 * 1024 * 1024) as usize,
    });
    let mut store = FileFeedbackStore::new(&root, limits);
    if let Some(types) = req["allowedMediaTypes"].as_array() {
        store.set_allowed_media_types(
            types
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect(),
        );
    }
    let raw = &req["submission"];
    let attachments = raw["attachments"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|v| FeedbackAttachmentInput {
                    filename: v["filename"].as_str().unwrap_or("").to_string(),
                    media_type: v["mediaType"].as_str().unwrap_or("").to_string(),
                    data: v["data"]
                        .as_array()
                        .map(|bytes| {
                            bytes
                                .iter()
                                .map(|n| n.as_u64().unwrap_or(0) as u8)
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default(),
                })
                .collect()
        })
        .unwrap_or_default();
    let submission = FeedbackSubmission {
        text: raw["text"].as_str().unwrap_or("").to_string(),
        attachments,
        provenance: raw["provenance"].clone(),
        idempotency_key: raw["idempotencyKey"].as_str().map(str::to_string),
    };
    let result = match store.submit(&submission) {
        Err(error) => {
            let left = std::fs::read_dir(&root)
                .map(|entries| entries.count())
                .unwrap_or(0);
            json!({"ok":false,"error":error,"rootEntryCount":left})
        }
        Ok(materialization) => {
            let record = &materialization.record;
            let mut att = Vec::new();
            for item in record["attachments"].as_array().into_iter().flatten() {
                let bytes = feedback::read_feedback_attachment(&root, item)?;
                att.push(json!({"filename":item["filename"],"mediaType":item["mediaType"],"sizeBytes":item["sizeBytes"],"sha256":item["sha256"],"bytes":bytes}));
            }
            let id = record["id"].as_str().ok_or("missing id")?;
            let read = store.read(id)?;
            let again = store.submit(&submission)?;
            let mut normalized = record.clone();
            for field in ["id", "createdAt"] {
                if let Some(o) = normalized.as_object_mut() {
                    o.remove(field);
                }
            }
            normalized["triage"]
                .as_object_mut()
                .map(|o| o.remove("updatedAt"));
            if let Some(rows) = normalized["attachments"].as_array_mut() {
                for row in rows {
                    if let Some(o) = row.as_object_mut() {
                        for key in ["id", "storageRef", "uploadedAt"] {
                            o.remove(key);
                        }
                    }
                }
            }
            json!({"ok":true,"record":normalized,"attachments":att,"readSame":read==*record,"dedupSame":again.record==*record&&again.record_ref==materialization.record_ref,"recordExists":Path::new(&materialization.record_ref).exists()})
        }
    };
    let _ = std::fs::remove_dir_all(&root);
    Ok(result)
}
fn main() {
    for line in io::stdin().lock().lines().map_while(Result::ok) {
        let result = serde_json::from_str::<Value>(&line)
            .map_err(|e| e.to_string())
            .and_then(run);
        println!(
            "{}",
            match result {
                Ok(v) => json!({"ok":true,"value":v}),
                Err(e) => json!({"ok":false,"error":e}),
            }
        );
    }
}
