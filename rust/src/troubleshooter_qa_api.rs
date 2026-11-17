// Node provenance: src/troubleshooter-qa-api.ts; implements the Q&A HTTP handler contract as a transport-neutral request/response effect.
use serde_json::{json, Value};
use std::{fs, path::Path};
pub const MAX_BODY: usize = 128 * 1024;
#[derive(Debug, Clone)]
pub struct Request {
    pub method: String,
    pub content_type: Option<String>,
    pub body: Vec<u8>,
}
#[derive(Debug, Clone, PartialEq)]
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}
fn response(status: u16, body: impl Into<Vec<u8>>, json_headers: bool) -> Response {
    let mut headers = vec![];
    if json_headers {
        headers.push(("content-type".into(), "application/json".into()));
        headers.push(("cache-control".into(), "no-store".into()));
    }
    Response {
        status,
        headers,
        body: body.into(),
    }
}
pub fn handle(path: &Path, req: Request) -> Response {
    let result = (|| -> Result<Response, String> {
        let current = fs::read_to_string(path).map_err(|e| e.to_string())?;
        match req.method.as_str() {
            "GET" => Ok(response(
                200,
                serde_json::to_vec(&json!({"text":current,"hash":sha256(current.as_bytes())}))
                    .unwrap(),
                true,
            )),
            "PUT" => {
                if req.content_type.as_deref().unwrap_or("").split(';').next()
                    != Some("application/json")
                {
                    return Ok(response(415, b"Expected JSON".to_vec(), false));
                }
                if req.body.len() > MAX_BODY {
                    return Ok(response(413, b"Q&A too large".to_vec(), false));
                }
                let body: Value = serde_json::from_slice(&req.body).map_err(|e| e.to_string())?;
                let (Some(text), Some(hash)) = (
                    body.get("text").and_then(Value::as_str),
                    body.get("hash").and_then(Value::as_str),
                ) else {
                    return Ok(response(400, b"Invalid Q&A payload".to_vec(), false));
                };
                if hash != sha256(current.as_bytes()) {
                    return Ok(response(
                        409,
                        b"Q&A changed on disk; reload before saving".to_vec(),
                        false,
                    ));
                }
                if text.len() > MAX_BODY {
                    return Ok(response(413, b"Q&A too large".to_vec(), false));
                }
                fs::write(path, text).map_err(|e| e.to_string())?;
                Ok(response(
                    200,
                    serde_json::to_vec(&json!({"hash":sha256(text.as_bytes())})).unwrap(),
                    true,
                ))
            }
            _ => {
                let mut r = response(405, b"Method not allowed".to_vec(), false);
                r.headers.push(("allow".into(), "GET, PUT".into()));
                Ok(r)
            }
        }
    })();
    result.unwrap_or_else(|e| response(500, e, false))
}
fn sha256(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(data))
}
