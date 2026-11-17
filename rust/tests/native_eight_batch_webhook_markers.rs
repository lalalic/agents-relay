// Native regressions for Node src/github-webhook.ts and src/markers.ts: trusted publication markers, safe HMAC verification and JSON comment roundtrip.
use agents_relay_rust2::{
    github_webhook::{parse_github_webhook, verify_github_webhook, DeliveryDeduper},
    markers::{
        marker, parse_job, parse_marker, parse_task, render_job_body, render_task_comment,
        JOB_MARKER,
    },
};
use serde_json::json;
#[test]
fn signed_webhook_is_constant_time_checked_and_untrusted_publication_rejected() {
    let body=br#"{"action":"synchronize","repository":{"full_name":"owner/repo"},"pull_request":{"number":9,"head":{"ref":"main","sha":"abc123"}}}"#;
    assert!(!verify_github_webhook("secret", body, None));
    assert!(!verify_github_webhook("secret", body, Some("sha256=bad")));
    let signature = hex_hmac_sha256_reference("secret", body);
    assert!(verify_github_webhook("secret", body, Some(&signature)));
    let headers = json!({"x-github-delivery":"delivery","x-github-event":"pull_request"});
    assert_eq!(
        parse_github_webhook(&headers, body).unwrap()["pullRequestFacts"]["state"],
        "OPEN"
    );
}
// Independent fixture known HMAC-SHA256 of a fixed byte string; its value is
// cross-checked against Node's crypto.createHmac in the head-to-head suite.
fn hex_hmac_sha256_reference(secret: &str, body: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut key = [0u8; 64];
    key[..secret.len()].copy_from_slice(secret.as_bytes());
    let mut ipad = [0x36u8; 64];
    let mut opad = [0x5cu8; 64];
    for i in 0..64 {
        ipad[i] ^= key[i];
        opad[i] ^= key[i];
    }
    let mut first = Sha256::new();
    first.update(ipad);
    first.update(body);
    let mut second = Sha256::new();
    second.update(opad);
    second.update(first.finalize());
    format!(
        "sha256={}",
        second
            .finalize()
            .iter()
            .map(|value| format!("{value:02x}"))
            .collect::<String>()
    )
}
#[test]
fn markers_escape_inline_html_and_preserve_work_text_exactly() {
    let value = json!({"id":"1","title":"unsafe --> tag","tasks":[]});
    let string = marker(JOB_MARKER, &value);
    assert!(string.contains("\\u003e"));
    assert_eq!(parse_marker(&string, JOB_MARKER).unwrap(), value);
    let job = json!({"id":"1","title":"Job","state":"ACTIVE","objective":"Build toy","tasks":[]});
    let recovered = parse_job(&render_job_body(&job)).unwrap();
    assert_eq!(recovered["objective"], "Build toy");
    let task = json!({"id":"t","state":"SUCCEEDED","kind":"work","input":"Line one\nLine two"});
    assert_eq!(
        parse_task(&render_task_comment(&task)).unwrap()["input"],
        "Line one\nLine two"
    );
}
#[test]
fn delivery_receipt_ttl_and_maximum_size_ensure_idempotency() {
    let mut dedupe = DeliveryDeduper::new(1000, 2);
    assert!(dedupe.accept("a", 0));
    assert!(!dedupe.accept("a", 100));
    assert!(dedupe.accept("b", 100));
    assert!(dedupe.accept("c", 200));
    assert!(!dedupe.has("a", 300));
    assert!(dedupe.has("c", 300));
    assert!(dedupe.accept("a", 301));
    assert!(dedupe.accept("c", 1201));
}
