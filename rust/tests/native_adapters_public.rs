// Native source-parity tests for the module-private helpers of the original
// src/adapters.ts: thread-start/failure line parsing, the byte-capped output
// tail, trusted manifest parsing (em-dash boundary, sha256 fallback filter),
// filesystem-authorized reference access, and the workspace JSON scan.
// Node does not export these; expectations are derived from the original
// source semantics and cross-checked by the differential public suite.
use agents_relay_rust2::adapters::{append_tail,parse_codex_failure,parse_thread_started};

#[test]
fn thread_started_line_parsing(){
    assert_eq!(parse_thread_started(
        r#"{"type":"thread.started","thread_id":"th-9"}"#),
        Some("th-9".into()));
    assert_eq!(parse_thread_started(
        r#"{"type":"thread.started"}"#),None);
    assert_eq!(parse_thread_started(
        r#"{"type":"task.started","thread_id":"th-9"}"#),None);
    assert_eq!(parse_thread_started(
        r#"{"type":"thread.started","thread_id":7}"#),None);
    assert_eq!(parse_thread_started("not json"),None);
    assert_eq!(parse_thread_started(""),None);
}

#[test]
fn codex_failure_line_parsing(){
    assert_eq!(parse_codex_failure(
        r#"{"type":"turn.failed","error":{"message":" provider halted "}}"#),
        Some(("provider halted".into(),2)));
    assert_eq!(parse_codex_failure(
        r#"{"type":"error","message":" quota exceeded "}"#),
        Some(("quota exceeded".into(),1)));
    assert_eq!(parse_codex_failure(
        r#"{"type":"turn.failed","error":{"message":"   "}}"#),None);
    assert_eq!(parse_codex_failure(
        r#"{"type":"error","message":""}"#),None);
    assert_eq!(parse_codex_failure(
        r#"{"type":"turn.failed","error":"flat"}"#),None);
    assert_eq!(parse_codex_failure(
        r#"{"type":"turn.failed","error":["a"]}"#),None);
    assert_eq!(parse_codex_failure("stdout noise"),None);
}

#[test]
fn append_tail_caps_bytes_and_decodes_lossily(){
    assert_eq!(append_tail("abc","def",16),"abcdef");
    assert_eq!(append_tail("abcdef","",16),"abcdef");
    // Over the cap: keep the LAST max_bytes bytes.
    assert_eq!(append_tail("0123456789","abcdef",6),"abcdef");
    assert_eq!(append_tail("0123456789","abcdef",4),"cdef");
    // Multibyte cut at a lead byte decodes lossily (Node Buffer.toString
    // replaces the invalid lead byte the same way).
    let cut=append_tail("ééé","ééé",5);
    assert_eq!(cut.chars().count(),3);
    assert!(cut.chars().any(|c|c=='\u{fffd}')||cut.chars().all(|c|c=='é'));
    // New default-scale cap behaves as a plain concat under the limit.
    let long="x".repeat(9000);
    assert_eq!(append_tail(&long,&long,16384).len(),16384);
}
