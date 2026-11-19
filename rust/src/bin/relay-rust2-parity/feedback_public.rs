// Original feedback.ts public API differential: pure marker/redaction/record
// helpers plus the real filesystem FileFeedbackStore behavior (submit/read,
// limits, idempotency, attachment integrity). PROVENANCE QUARANTINE cleared:
// written fresh from the current canonical sources.
use agents_relay_rust2::feedback::{
    create_feedback_record, feedback_fingerprint, feedback_work_provenance, marker,
    parse_feedback_marker, read_feedback_attachment, redact_sensitive_text,
    render_feedback_markdown, render_feedback_marker, validate_provenance,
    FileFeedbackStore, FeedbackAttachmentInput, FeedbackLimits, FeedbackSubmission,
};
use regex::Regex;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

fn submission_from(request: &Value) -> FeedbackSubmission {
    FeedbackSubmission {
        text: request["text"].as_str().unwrap_or("").to_string(),
        attachments: request["attachments"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .map(|item| FeedbackAttachmentInput {
                        filename: item["filename"].as_str().unwrap_or("").to_string(),
                        media_type: item["mediaType"].as_str().unwrap_or("").to_string(),
                        data: match item.get("data") {
                            Some(Value::String(text)) => text.as_bytes().to_vec(),
                            Some(Value::Array(bytes)) => bytes
                                .iter()
                                .filter_map(|b| b.as_u64().map(|v| v as u8))
                                .collect(),
                            _ => Vec::new(),
                        },
                    })
                    .collect()
            })
            .unwrap_or_default(),
        provenance: request["provenance"].clone(),
        idempotency_key: request["idempotencyKey"].as_str().map(str::to_owned),
    }
}
fn limits_from(request: &Value) -> Option<FeedbackLimits> {
    // Rust FeedbackLimits keeps usize fields; allowed media types come from
    // the store constructor's separate field. Node defaults fill the gaps.
    let limits = request.get("limits")?;
    let get = |key: &str, default: usize| {
        limits[key]
            .as_u64()
            .map(|v| v as usize)
            .unwrap_or(default)
    };
    Some(FeedbackLimits {
        max_text_length: get("maxTextLength", 20_000),
        max_attachments: get("maxAttachments", 5),
        max_attachment_bytes: get("maxAttachmentBytes", 10 * 1024 * 1024),
    })
}
fn store_result(value: &Value, root: &Path) -> Result<String, String> {
    // Common normalization: strip the root prefix so both stacks compare the
    // same relative shape, and mask uuid/timestamp fields.
    let record = value["record"].clone();
    let record_ref = value["recordRef"].as_str().unwrap_or("");
    let relative = record_ref
        .strip_prefix(root.to_str().unwrap_or(""))
        .unwrap_or(record_ref)
        .to_string();
    // The record filename embeds the generated record id; normalize it so
    // both stacks compare the same relative shape.
    let normalized_ref = relative
        .replace('\\', "/")
        .replace(
            &record["id"].as_str().unwrap_or("x").to_string(),
            "<dynamic>",
        );
    Ok(json!({"ok":true,"record":normalize(&record),
        "recordRef":normalized_ref}).to_string())
}
fn normalize(value: &Value) -> Value {
    let mut out = value.clone();
    if let Some(object) = out.as_object_mut() {
        for (key, slot) in object.iter_mut() {
            if key == "id" || key == "createdAt" || key == "uploadedAt"
                || key == "updatedAt" || key == "submittedAt" {
                // Only normalize genuinely generated timestamps; fixture
                // suppliedAt strings must survive verbatim. triage.updatedAt
                // is always generated, handled below.
                if key != "submittedAt" && slot.as_str().is_some() {
                    *slot = json!("<dynamic>");
                }
            }
            if key == "triage" {
                if let Some(triage) = slot.get_mut("updatedAt") {
                    if triage.as_str().is_some() {
                        *triage = json!("<dynamic>");
                    }
                }
            }
            if key == "attachments" {
                if let Some(attachments) = slot.as_array_mut() {
                    for attachment in attachments.iter_mut() {
                        if let Some(id) = attachment.get_mut("id") {
                            *id = json!("<dynamic>");
                        }
                        if let Some(uploaded) = attachment.get_mut("uploadedAt") {
                            if uploaded.as_str().is_some() {
                                *uploaded = json!("<dynamic>");
                            }
                        }
                        if let Some(storage) = attachment.get_mut("storageRef") {
                            if let Some(text) = storage.as_str() {
                                // Keep the suffix after "attachments/<record>/":
                                // "<attachmentId>-<filename>" still embeds the
                                // generated attachment id — mask it too.
                                let suffix = text
                                    .splitn(3, '/')
                                    .nth(2)
                                    .unwrap_or(text)
                                    .to_string();
                                // A generated attachment id is a full UUID;
                                // mask it without splitting on the UUID's
                                // own dashes.
                                let masked = Regex::new(
                                    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}-",
                                )
                                .expect("static uuid prefix regex")
                                .replace(&suffix, "<dynamic>-")
                                .to_string();
                                *storage = json!(masked);
                            }
                        }
                    }
                }
            }
        }
    }
    out
}
pub fn invoke(request: &Value) -> Option<Result<String, String>> {
    if request["op"] != "certFeedback" {
        return None;
    }
    Some((|| {
        let root = PathBuf::from(request["root"].as_str().unwrap_or(""));
        match request["method"].as_str().unwrap_or("") {
            "marker" => Ok(json!({"ok":true,"value":marker(
                request["label"].as_str().unwrap_or(""),
                &request["value"])}).to_string()),
            "renderMarker" => Ok(json!({"ok":true,"value":render_feedback_marker(
                &request["record"])}).to_string()),
            "parseMarker" => Ok(match parse_feedback_marker(
                request["value"].as_str().unwrap_or(""),
            ) {
                Some(parsed) => json!({"ok":true,"parsed":parsed}).to_string(),
                None => json!({"ok":true,"parsed":null}).to_string(),
            }),
            "redact" => Ok(json!({"ok":true,"value":redact_sensitive_text(
                request["value"].as_str().unwrap_or(""))}).to_string()),
            "validateProvenance" => match validate_provenance(&request["value"]) {
                Ok(value) => Ok(json!({"ok":true,"value":normalize(&value)}).to_string()),
                Err(error) => Ok(json!({"ok":false,"error":error}).to_string()),
            },
            "createRecord" => {
                let options = request.get("options").cloned();
                match create_feedback_record(&request["submission"], options.as_ref()) {
                    Ok(record) => {
                        let fixed_id = options
                            .as_ref()
                            .and_then(|o| o.get("id"))
                            .and_then(Value::as_str)
                            .map(str::to_owned);
                        let fixed_received = options
                            .as_ref()
                            .and_then(|o| o.get("receivedAt"))
                            .and_then(Value::as_str)
                            .map(str::to_owned);
                        // An explicit options.id / options.receivedAt is
                        // caller-controlled and comparable verbatim;
                        // generated values are normalized to a stable token.
                        let mut normalized = normalize(&record);
                        if let Some(object) = normalized.as_object_mut() {
                            if fixed_id.is_some() {
                                if let Some(id) = object.get_mut("id") {
                                    *id = json!(fixed_id);
                                }
                            }
                            if let Some(metadata) =
                                object.get_mut("systemMetadata")
                            {
                                if let Some(received) =
                                    metadata.get_mut("receivedAt")
                                {
                                    *received = match fixed_received {
                                        Some(fixed)=>json!(fixed),
                                        // Generated timestamps normalize to a
                                        // stable token on both stacks.
                                        None=>json!("<dynamic>"),
                                    };
                                }
                            }
                        }
                        Ok(json!({"ok":true,"record":normalized}).to_string())
                    }
                    Err(error) => Ok(json!({"ok":false,"error":error}).to_string()),
                }
            }
            "workProvenance" => Ok(json!({"ok":true,"value":feedback_work_provenance(
                &request["record"])}).to_string()),
            "fingerprint" => Ok(json!({"ok":true,"value":feedback_fingerprint(
                &request["record"])}).to_string()),
            "renderMarkdown" => Ok(json!({"ok":true,"value":render_feedback_markdown(
                &request["record"])}).to_string()),
            // Raw submit for mirror fixtures: the differential harness
            // needs the true storageRef to feed read checks; normalization
            // would corrupt it.
            "storeSubmitRaw" => {
                let store = FileFeedbackStore::new(&root, limits_from(request));
                match store.submit(&submission_from(request)) {
                    Ok(result) => Ok(json!({"ok":true,
                        "record":result.record,
                        "recordRef":result.record_ref}).to_string()),
                    Err(error) => Ok(json!({"ok":false,"error":error}).to_string()),
                }
            }
            "storeSubmit" => {
                let mut store = FileFeedbackStore::new(&root, limits_from(request));
                if let Some(types) = request.pointer("/limits/allowedMediaTypes")
                    .and_then(Value::as_array){
                    store.set_allowed_media_types(types.iter()
                        .filter_map(|v| v.as_str().map(str::to_owned))
                        .collect());
                }
                match store.submit(&submission_from(request)) {
                    Ok(result) => store_result(
                        &json!({"record":result.record,"recordRef":result.record_ref}),
                        &root,
                    ),
                    Err(error) => Ok(json!({"ok":false,"error":error}).to_string()),
                }
            }
            "storeRead" => {
                let store = FileFeedbackStore::new(&root, limits_from(request));
                match store.read(request["id"].as_str().unwrap_or("")) {
                    Ok(record) => Ok(json!({"ok":true,"record":normalize(&record)}).to_string()),
                    Err(error) => Ok(json!({"ok":false,"error":error}).to_string()),
                }
            }
            "readAttachment" => match read_feedback_attachment(
                &root,
                &request["attachment"],
            ) {
                Ok(bytes) => Ok(json!({"ok":true,"bytes":bytes}).to_string()),
                Err(error) => Ok(json!({"ok":false,"error":error}).to_string()),
            },
            value => Err(format!("Unknown feedback method {value}")),
        }
    })())
}
