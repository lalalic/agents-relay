// Direct Node src/feedback.ts port. Two legacy/new formats intentionally remain distinct.
// Filesystem records are atomic, attachments content-hashed, and errors leave no record.
use crate::{events::random_uuid, js_text::trim_js};
use chrono::{DateTime, SecondsFormat, Utc};
use regex::{Regex, RegexBuilder};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, Write},
    path::{Component, Path, PathBuf},
    time::SystemTime,
};

pub const FEEDBACK_MARKER: &str = "agents-relay:feedback:v1";
pub const FEEDBACK_SCHEMA: &str = "agents-relay.feedback";
pub const FEEDBACK_SCHEMA_VERSION: i64 = 1;
pub const FEEDBACK_MAX_TEXT_LENGTH: usize = 20_000;
pub const FEEDBACK_MAX_ATTACHMENTS: usize = 10;
pub const FEEDBACK_MAX_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;
pub const FEEDBACK_IMAGE_TYPES: [&str; 4] = ["image/gif", "image/jpeg", "image/png", "image/webp"];
pub const DEFAULT_FEEDBACK_LIMITS: FeedbackLimits = FeedbackLimits {
    max_text_length: 20_000,
    max_attachments: 5,
    max_attachment_bytes: 10 * 1024 * 1024,
};

#[derive(Clone, Copy, Debug)]
pub struct FeedbackLimits {
    pub max_text_length: usize,
    pub max_attachments: usize,
    pub max_attachment_bytes: usize,
}
#[derive(Clone, Debug)]
pub struct FeedbackAttachmentInput {
    pub filename: String,
    pub media_type: String,
    pub data: Vec<u8>,
}
#[derive(Clone, Debug)]
pub struct FeedbackSubmission {
    pub text: String,
    pub attachments: Vec<FeedbackAttachmentInput>,
    pub provenance: Value,
    pub idempotency_key: Option<String>,
}
#[derive(Clone, Debug)]
pub struct FeedbackMaterialization {
    pub record: Value,
    pub record_ref: PathBuf,
}
pub struct FileFeedbackStore {
    pub root: PathBuf,
    pub limits: FeedbackLimits,
    pub allowed_media_types: Vec<String>,
}
fn fail(message: &str) -> String {
    format!("Invalid feedback: {message}")
}
fn now() -> String {
    DateTime::<Utc>::from(SystemTime::now()).to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn json_wire(value: &Value) -> String {
    crate::observability::json_wire(value)
}
fn json_pretty(value: &Value) -> Result<String, String> {
    serde_json::to_string_pretty(value).map_err(|e| e.to_string())
}
fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}
fn filename(value: &str) -> Result<String, String> {
    let base = value.rsplit('/').next().unwrap_or("");
    let clean = base
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .take(120)
        .collect::<String>();
    if clean.is_empty() || clean == "." || clean == ".." {
        Err(fail("attachment filename is invalid"))
    } else {
        Ok(clean)
    }
}
fn safe_id(value: &str) -> Result<&str, String> {
    if value.len() == 36 && value.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
        Ok(value)
    } else {
        Err(fail("feedback id is invalid"))
    }
}
fn validate_time(raw: &str) -> Result<String, String> {
    let parsed = DateTime::parse_from_rfc3339(raw)
        .map_err(|_| fail("provenance.submittedAt must be an ISO timestamp"))?;
    Ok(parsed
        .with_timezone(&Utc)
        .to_rfc3339_opts(SecondsFormat::Millis, true))
}
fn string<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
fn optional_text(input: &Value, field: &str) -> Result<Option<String>, String> {
    if let Some(value) = input.get(field).and_then(Value::as_str) {
        if utf16_len(value) > 500 {
            return Err(fail(&format!("{field} is too long")));
        }
        return Ok(Some(value.into()));
    }
    Ok(None)
}
fn put_if(map: &mut Value, key: &str, value: Option<String>) {
    if let Some(text) = value {
        map[key] = text.into()
    }
}

pub fn validate_provenance(input: &Value) -> Result<Value, String> {
    let product = trim_js(string(input, "product"));
    if product.is_empty() {
        return Err(fail("provenance.product is required"));
    }
    let submitted_at = validate_time(string(input, "submittedAt"))?;
    if let Some(contact) = input.get("contact") {
        if trim_js(string(contact, "value")).is_empty() {
            return Err(fail("contact value must not be empty"));
        }
    }
    // Node's property insertion order is preserved for SHA-256 fingerprints.
    let mut result =
        json!({"source":input["source"],"product":product.chars().take(200).collect::<String>()});
    put_if(&mut result, "surface", optional_text(input, "surface")?);
    put_if(&mut result, "setupStep", optional_text(input, "setupStep")?);
    result["actorClass"] = input["actorClass"].clone();
    put_if(&mut result, "version", optional_text(input, "version")?);
    put_if(&mut result, "build", optional_text(input, "build")?);
    result["submittedAt"] = submitted_at.into();
    if let Some(contact) = input.get("contact") {
        result["contact"] = json!({"channel":contact["channel"],"value":trim_js(string(contact,"value")).chars().take(500).collect::<String>()});
    }
    Ok(result)
}
pub fn marker(label: &str, value: &Value) -> String {
    format!(
        "<!-- {label} {} -->",
        json_wire(value).replace('>', "\\u003e")
    )
}
pub fn render_feedback_marker(record: &Value) -> String {
    let mut metadata = record.clone();
    if let Some(object) = metadata.as_object_mut() {
        object.shift_remove("userContent");
    }
    marker(FEEDBACK_MARKER, &metadata)
}
pub fn parse_feedback_marker(input: &str) -> Option<Value> {
    let pattern = Regex::new(r"(?s)<!--\s*agents-relay:feedback:v1\s+(.*?)\s*-->").ok()?;
    let body = pattern.captures(input)?.get(1)?.as_str();
    let record = serde_json::from_str::<Value>(body).ok()?;
    if record["schema"] == FEEDBACK_MARKER && record["schemaVersion"] == FEEDBACK_SCHEMA_VERSION {
        Some(record)
    } else {
        None
    }
}

impl FileFeedbackStore {
    pub fn new(root: impl AsRef<Path>, limits: Option<FeedbackLimits>) -> Self {
        Self {
            root: root.as_ref().to_path_buf(),
            limits: limits.unwrap_or(DEFAULT_FEEDBACK_LIMITS),
            allowed_media_types: vec![
                "image/png".into(),
                "image/jpeg".into(),
                "image/webp".into(),
                "image/gif".into(),
            ],
        }
    }
    pub fn set_allowed_media_types(&mut self, types: Vec<String>) {
        self.allowed_media_types = types;
    }
    fn record_path(&self, id: &str) -> PathBuf {
        self.root.join("records").join(format!("{id}.json"))
    }
    fn find_by_idempotency_key(&self, key: &str) -> Result<Option<Value>, String> {
        let directory = self.root.join("records");
        let Ok(entries) = fs::read_dir(directory) else {
            return Ok(None);
        };
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.path().extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let record: Value =
                serde_json::from_str(&fs::read_to_string(entry.path()).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            if record.get("idempotencyKey").and_then(Value::as_str) == Some(key) {
                return Ok(Some(record));
            }
        }
        Ok(None)
    }
    pub fn read(&self, id: &str) -> Result<Value, String> {
        let raw = fs::read_to_string(self.record_path(safe_id(id)?)).map_err(|e| e.to_string())?;
        let record: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        if record["schema"] != FEEDBACK_MARKER || record["schemaVersion"] != FEEDBACK_SCHEMA_VERSION
        {
            return Err(fail("record schema is unsupported"));
        }
        Ok(record)
    }
    pub fn submit(
        &self,
        submission: &FeedbackSubmission,
    ) -> Result<FeedbackMaterialization, String> {
        if let Some(key) = &submission.idempotency_key {
            if let Some(record) = self.find_by_idempotency_key(key)? {
                let path = self.record_path(string(&record, "id"));
                return Ok(FeedbackMaterialization {
                    record,
                    record_ref: path,
                });
            }
        }
        let text = trim_js(&submission.text);
        if text.is_empty() {
            return Err(fail("text is required"));
        };
        if utf16_len(text) > self.limits.max_text_length {
            return Err(fail(&format!(
                "text exceeds {} characters",
                self.limits.max_text_length
            )));
        }
        if submission.attachments.len() > self.limits.max_attachments {
            return Err(fail(&format!(
                "at most {} attachments are allowed",
                self.limits.max_attachments
            )));
        }
        let now = now();
        let id = random_uuid();
        let dir = self.root.join("attachments").join(&id);
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let materialize = (|| -> Result<FeedbackMaterialization, String> {
            let mut attachments = Vec::<Value>::new();
            for input in &submission.attachments {
                let media = input.media_type.to_lowercase();
                if !self.allowed_media_types.contains(&media) {
                    return Err(fail(&format!(
                        "unsupported attachment type: {}",
                        input.media_type
                    )));
                }
                if input.data.is_empty() || input.data.len() > self.limits.max_attachment_bytes {
                    return Err(fail(&format!(
                        "attachment exceeds {} bytes",
                        self.limits.max_attachment_bytes
                    )));
                }
                let attachment_id = random_uuid();
                let name = filename(&input.filename)?;
                let relative = format!("attachments/{id}/{attachment_id}-{name}");
                let path = self.root.join(&relative);
                let mut writer = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(path)
                    .map_err(|e| e.to_string())?;
                use io::Write;
                writer.write_all(&input.data).map_err(|e| e.to_string())?;
                attachments.push(json!({"id":attachment_id,"filename":name,"mediaType":media,"sizeBytes":input.data.len(),"sha256":digest(&input.data),"storageRef":relative,"uploadedAt":now}));
            }
            let provenance = validate_provenance(&submission.provenance)?;
            let mut record =
                json!({"schema":FEEDBACK_MARKER,"schemaVersion":FEEDBACK_SCHEMA_VERSION,"id":id});
            if let Some(key) = &submission.idempotency_key {
                if !key.is_empty() {
                    record["idempotencyKey"] = key.clone().into();
                }
            }
            record["userContent"] = json!({"text":text});
            record["attachments"] = Value::Array(attachments);
            record["systemProvenance"] = provenance;
            record["triage"] = json!({"status":"new","updatedAt":now});
            record["downstream"] = json!([]);
            record["createdAt"] = now.clone().into();
            fs::create_dir_all(self.root.join("records")).map_err(|e| e.to_string())?;
            let record_ref = self.record_path(&id);
            let temp = PathBuf::from(format!("{}.{}.tmp", record_ref.display(), random_uuid()));
            let mut writer = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)
                .map_err(|e| e.to_string())?;
            writer
                .write_all(format!("{}\n", json_pretty(&record)?).as_bytes())
                .map_err(|e| e.to_string())?;
            fs::rename(&temp, &record_ref).map_err(|e| e.to_string())?;
            Ok(FeedbackMaterialization { record, record_ref })
        })();
        if materialize.is_err() {
            let _ = fs::remove_dir_all(&dir);
        }
        materialize
    }
}
pub fn materialize_feedback_record(
    root: impl AsRef<Path>,
    submission: &FeedbackSubmission,
    limits: Option<FeedbackLimits>,
) -> Result<FeedbackMaterialization, String> {
    FileFeedbackStore::new(root, limits).submit(submission)
}

// Node materializeFeedback() overload: preserve the two legacy and modern
// paths behind one public entrypoint, with a typed discriminator instead of
// interpreting caller strings as workflow policy.
pub enum FeedbackMaterializeInput<'a> {
    Submission {
        root: &'a Path,
        submission: &'a FeedbackSubmission,
        limits: Option<FeedbackLimits>,
    },
    Legacy {
        record: &'a Value,
        path: &'a Path,
        format: Option<&'a str>,
    },
}

pub fn materialize_feedback(
    input: FeedbackMaterializeInput<'_>,
) -> Result<Option<FeedbackMaterialization>, String> {
    match input {
        FeedbackMaterializeInput::Submission {
            root,
            submission,
            limits,
        } => materialize_feedback_record(root, submission, limits).map(Some),
        FeedbackMaterializeInput::Legacy {
            record,
            path,
            format,
        } => materialize_feedback_legacy(record, path, format).map(|()| None),
    }
}

pub fn redact_sensitive_text(text: &str) -> String {
    let bearer = RegexBuilder::new(r"\bBearer\s+[A-Za-z0-9._~+/=-]+")
        .case_insensitive(true)
        .build()
        .expect("static bearer regex");
    let key = Regex::new(r"\b(?:sk|pk)_[A-Za-z0-9_-]{12,}\b").expect("static API key regex");
    let secret = RegexBuilder::new(r"\b(?:api[_-]?key|token|secret)\s*[:=]\s*[^\s,;]+")
        .case_insensitive(true)
        .build()
        .expect("static secret regex");
    let first = bearer.replace_all(text, "Bearer [REDACTED]");
    let second = key.replace_all(&first, "[REDACTED_KEY]");
    secret
        .replace_all(&second, |caps: &regex::Captures<'_>| {
            let value = caps.get(0).map(|m| m.as_str()).unwrap_or("");
            let _key = value.split([':', '=']).next().unwrap_or("token").trim_end();
            "$1=[REDACTED]".to_string()
        })
        .into_owned()
}
fn ensure_reference(reference: &str) -> Result<(), String> {
    let credential = Regex::new(r"://[^/]*:[^@]+@").expect("static credential regex");
    if reference.is_empty()
        || utf16_len(reference) > 2_000
        || reference.contains(['?', '#'])
        || credential.is_match(reference)
    {
        return Err(fail(
            "attachment reference must be a stable, credential-free reference",
        ));
    }
    Ok(())
}
pub fn create_feedback_record(
    submission: &Value,
    options: Option<&Value>,
) -> Result<Value, String> {
    let text = submission
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            fail(&format!(
                "text must contain 1-{FEEDBACK_MAX_TEXT_LENGTH} characters"
            ))
        })?;
    if text.is_empty() || utf16_len(text) > FEEDBACK_MAX_TEXT_LENGTH {
        return Err(fail(&format!(
            "text must contain 1-{FEEDBACK_MAX_TEXT_LENGTH} characters"
        )));
    }
    let inputs = submission
        .get("attachments")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut attachments = Vec::new();
    for (index, input) in inputs.iter().enumerate() {
        let mime = string(input, "mimeType");
        if !FEEDBACK_IMAGE_TYPES.contains(&mime) {
            return Err(fail(&format!(
                "attachments[{index}] has an unsupported image format"
            )));
        }
        let size = input["sizeBytes"].as_i64().unwrap_or(0);
        if size <= 0 || size > FEEDBACK_MAX_ATTACHMENT_BYTES as i64 {
            return Err(fail(&format!(
                "attachments[{index}] exceeds the {FEEDBACK_MAX_ATTACHMENT_BYTES} byte limit"
            )));
        }
        ensure_reference(string(input, "reference"))?;
        let mut attachment = input.clone();
        attachment["id"] = format!("attachment-{}", index + 1).into();
        attachments.push(attachment);
    }
    if attachments.len() > FEEDBACK_MAX_ATTACHMENTS {
        return Err(fail(&format!(
            "at most {FEEDBACK_MAX_ATTACHMENTS} attachments are supported"
        )));
    }
    let visibility = submission
        .get("visibility")
        .and_then(Value::as_str)
        .unwrap_or("private");
    let sanitized = options
        .and_then(|o| o.get("sanitize"))
        .and_then(Value::as_bool)
        == Some(true)
        || submission["sanitized"] == true;
    if visibility == "public" && !sanitized {
        return Err(fail("public feedback must be explicitly sanitized"));
    }
    let provenance = validate_provenance(&submission["provenance"])?;
    let id = options
        .and_then(|o| o.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("feedback-{}", random_uuid()));
    let received = options
        .and_then(|o| o.get("receivedAt"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(now);
    let mut record = json!({"schema":FEEDBACK_SCHEMA,"schemaVersion":FEEDBACK_SCHEMA_VERSION,"id":id,"userContent":{"text":if sanitized{redact_sensitive_text(text)}else{text.into()}},"attachments":attachments,"provenance":provenance,"systemMetadata":{"receivedAt":received,"visibility":visibility,"sanitized":sanitized}});
    if let Some(contact) = submission
        .get("contact")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        record["contact"] = contact.into()
    }
    record["triage"] = json!({"status":"new"});
    record["downstream"] = json!({"work":[]});
    Ok(record)
}
pub fn feedback_work_provenance(record: &Value) -> Value {
    json!({"feedbackId":record["id"],"feedbackSchema":format!("{}/v{}",string(record,"schema"),record["schemaVersion"]),"feedbackReference":format!("feedback://{}",string(record,"id")),"feedbackSubmittedAt":record["provenance"]["submittedAt"]})
}
pub fn feedback_fingerprint(record: &Value) -> String {
    let attachments = record["attachments"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|a| {
            a.get("sha256")
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or_else(|| a["reference"].clone())
        })
        .collect::<Vec<_>>();
    let value = json!({"text":record["userContent"]["text"],"attachments":attachments,"provenance":record["provenance"]});
    digest(json_wire(&value).as_bytes())
}
pub fn render_feedback_markdown(record: &Value) -> String {
    let attachments = record["attachments"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let ids = attachments
        .iter()
        .map(|a| a["id"].clone())
        .collect::<Vec<_>>();
    let meta = json!({"schema":record["schema"],"schemaVersion":record["schemaVersion"],"id":record["id"],"provenance":record["provenance"],"attachmentIds":ids,"triage":record["triage"],"downstream":record["downstream"]});
    let items = if attachments.is_empty() {
        "_None._".into()
    } else {
        attachments
            .iter()
            .map(|a| {
                format!(
                    "- {}: {}, {} bytes, ref `{}`",
                    string(a, "id"),
                    string(a, "mimeType"),
                    a["sizeBytes"],
                    string(a, "reference")
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    format!(
        "{}\n# Feedback {}\n\n## User report\n\n{}\n\n## Attachments\n\n{}\n",
        marker(FEEDBACK_MARKER, &meta),
        string(record, "id"),
        string(&record["userContent"], "text"),
        items
    )
}
pub fn materialize_feedback_legacy(
    record: &Value,
    path: &Path,
    format: Option<&str>,
) -> Result<(), String> {
    if path.as_os_str().is_empty() || path.to_string_lossy().contains('\0') {
        return Err("Feedback materialization path is invalid".into());
    }
    fs::create_dir_all(path.parent().unwrap_or(Path::new("."))).map_err(|e| e.to_string())?;
    let body = if format == Some("markdown") {
        render_feedback_markdown(record)
    } else {
        format!("{}\n", json_pretty(record)?)
    };
    use std::io::Write;
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .and_then(|mut out| out.write_all(body.as_bytes()))
        .map_err(|e| e.to_string())
}
fn normalized_path(root: &Path, ref_: &str) -> PathBuf {
    let mut resolved = if Path::new(ref_).is_absolute() {
        PathBuf::new()
    } else {
        root.to_path_buf()
    };
    for part in Path::new(ref_).components() {
        match part {
            Component::ParentDir => {
                resolved.pop();
            }
            Component::CurDir => {}
            Component::Normal(v) => resolved.push(v),
            Component::RootDir => resolved = PathBuf::from("/"),
            Component::Prefix(_) => {}
        }
    }
    resolved
}
pub fn read_feedback_attachment(root: &Path, attachment: &Value) -> Result<Vec<u8>, String> {
    let root = normalized_path(Path::new("/"), &root.to_string_lossy());
    let path = normalized_path(&root, string(attachment, "storageRef"));
    if !path.starts_with(&root) || path == root {
        return Err(fail("attachment reference escapes storage root"));
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.len() as i64 != attachment["sizeBytes"].as_i64().unwrap_or(-1)
        || digest(&bytes) != string(attachment, "sha256")
    {
        return Err(fail("attachment integrity check failed"));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn provenance() -> Value {
        json!({"source":"app","product":" ToyAlive ","actorClass":"pilot-user","submittedAt":"2026-01-01T10:00:00Z","contact":{"channel":"email","value":" x@example.test "}})
    }
    fn legacy() -> Value {
        json!({"text":"Hello world","provenance":provenance(),"attachments":[{"reference":"blob://media/123","mimeType":"image/png","sizeBytes":8,"sha256":"abcdef"}]})
    }
    fn root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "rust2-feedback-{label}-{}-{}",
            std::process::id(),
            random_uuid()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }
    #[test]
    fn legacy_validation_sanitization_and_fingerprint() {
        let mut input = legacy();
        let options = json!({"id":"feedback-fixed","receivedAt":"2026-01-01T00:00:00Z"});
        let rec = create_feedback_record(&input, Some(&options)).unwrap();
        assert_eq!(rec["id"], "feedback-fixed");
        assert_eq!(rec["provenance"]["product"], "ToyAlive");
        assert_eq!(rec["attachments"][0]["id"], "attachment-1");
        assert_eq!(feedback_fingerprint(&rec), feedback_fingerprint(&rec));
        input["visibility"] = "public".into();
        assert_eq!(
            create_feedback_record(&input, None).unwrap_err(),
            "Invalid feedback: public feedback must be explicitly sanitized"
        );
        input["sanitized"] = true.into();
        input["text"] = "Bearer abcDEF123456 and sk_abcdefghijklmnopqrstuvwxyz".into();
        let redacted = create_feedback_record(&input, Some(&options)).unwrap();
        assert!(!redacted["userContent"]["text"]
            .as_str()
            .unwrap()
            .contains("abcDEF"));
        let rendered = render_feedback_markdown(&rec);
        assert!(rendered.contains("## User report\n\nHello world"));
        assert!(parse_feedback_marker(&rendered).is_none());
    }
    #[test]
    fn legacy_validation_rejects_unsafe_references() {
        for bad in [
            "https://alice:pw@example.test/item",
            "abc?token=x",
            "file#hash",
            "",
        ] {
            let mut input = legacy();
            input["attachments"][0]["reference"] = bad.into();
            assert!(create_feedback_record(&input, None)
                .unwrap_err()
                .contains("attachment reference"));
        }
        let mut input = legacy();
        input["attachments"][0]["sizeBytes"] = 0.into();
        assert!(create_feedback_record(&input, None)
            .unwrap_err()
            .contains("byte limit"));
    }
    #[test]
    fn markers_redact_metadata_and_decode_gt() {
        let rec = create_feedback_record(&legacy(), Some(&json!({"id":"fixed"}))).unwrap();
        let html = render_feedback_marker(&rec);
        assert!(!html.contains("Hello world"));
        assert!(parse_feedback_marker(&html).is_none());
        let modern = json!({"schema":FEEDBACK_MARKER,"schemaVersion":1,"id":"fixed","userContent":{"text":"PRIVATE"}});
        let parsed = parse_feedback_marker(&render_feedback_marker(&modern)).unwrap();
        assert!(parsed.get("userContent").is_none());
        assert_eq!(parsed["id"], "fixed");
        assert_eq!(parse_feedback_marker("plain text"), None);
        assert!(marker("custom", &json!({"a":">"})).contains("\\u003e"));
    }
    #[test]
    fn stored_upload_hash_idempotency_and_rollback() {
        let root = root("upload");
        let store = FileFeedbackStore::new(&root, None);
        let submission = FeedbackSubmission {
            text: " Hi \n".into(),
            attachments: vec![FeedbackAttachmentInput {
                filename: "../a*b?.png".into(),
                media_type: "IMAGE/PNG".into(),
                data: vec![1, 2, 3, 4],
            }],
            provenance: provenance(),
            idempotency_key: Some("key".into()),
        };
        let first = store.submit(&submission).unwrap();
        assert_eq!(first.record["userContent"]["text"], "Hi");
        assert_eq!(first.record["attachments"][0]["filename"], "a_b_.png");
        let second = store.submit(&submission).unwrap();
        assert_eq!(first.record_ref, second.record_ref);
        let id = first.record["id"].as_str().unwrap();
        assert_eq!(store.read(id).unwrap()["id"], id);
        assert_eq!(
            read_feedback_attachment(&root, &first.record["attachments"][0]).unwrap(),
            vec![1, 2, 3, 4]
        );
        let bytes = root.join(
            first.record["attachments"][0]["storageRef"]
                .as_str()
                .unwrap(),
        );
        fs::write(bytes, [3]).unwrap();
        assert!(
            read_feedback_attachment(&root, &first.record["attachments"][0])
                .unwrap_err()
                .contains("integrity")
        );
        let mut bad = submission.clone();
        bad.idempotency_key = None;
        bad.attachments.push(FeedbackAttachmentInput {
            filename: "broken".into(),
            media_type: "text/plain".into(),
            data: vec![1],
        });
        assert!(store
            .submit(&bad)
            .unwrap_err()
            .contains("unsupported attachment"));
        let record_count = fs::read_dir(root.join("records")).unwrap().count();
        assert_eq!(record_count, 1);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn materialize_feedback_public_overload_dispatches_both_node_signatures() {
        let root = root("public-overload");
        let submission = FeedbackSubmission {
            text: " One submission ".into(),
            attachments: vec![],
            provenance: provenance(),
            idempotency_key: Some("same-key".into()),
        };
        let result = materialize_feedback(FeedbackMaterializeInput::Submission {
            root: &root,
            submission: &submission,
            limits: None,
        })
        .unwrap()
        .expect("modern overload returns materialization");
        assert!(result.record_ref.exists());
        assert_eq!(result.record["userContent"]["text"], "One submission");
        let path = root.join("legacy.md");
        let legacy =
            create_feedback_record(&legacy(), Some(&json!({"id":"legacy-fixed"}))).unwrap();
        assert!(materialize_feedback(FeedbackMaterializeInput::Legacy {
            record: &legacy,
            path: &path,
            format: Some("markdown"),
        })
        .unwrap()
        .is_none());
        assert!(fs::read_to_string(&path)
            .unwrap()
            .contains("## User report"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn attachment_root_fence_and_size() {
        let root = root("fence");
        assert!(read_feedback_attachment(
            &root,
            &json!({"storageRef":"../../secret","sizeBytes":1,"sha256":"x"})
        )
        .unwrap_err()
        .contains("escapes storage root"));
        let empty = FeedbackSubmission {
            text: "ok".into(),
            attachments: vec![FeedbackAttachmentInput {
                filename: "x.png".into(),
                media_type: "image/png".into(),
                data: vec![],
            }],
            provenance: provenance(),
            idempotency_key: None,
        };
        assert!(FileFeedbackStore::new(&root, None)
            .submit(&empty)
            .unwrap_err()
            .contains("attachment exceeds"));
        fs::remove_dir_all(root).unwrap();
    }
}
