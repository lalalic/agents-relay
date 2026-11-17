// Native Rust regression for src/dashboard-jel.ts: durable Job DAG, Final Review, retry lineage, timing and Unicode-safe diagrams.
use agents_relay_rust2::dashboard_jel::{job_jel_diagram_at, job_jel_diagram_json_wire_at};
use chrono::DateTime;
use serde_json::json;
fn stamp(text: &str) -> i64 {
    DateTime::parse_from_rfc3339(text)
        .unwrap()
        .timestamp_millis()
}
fn now() -> i64 {
    stamp("2026-11-20T18:00:00Z")
}

#[test]
fn basic_graph_has_immutable_create_execute_review_merge_finish_chain() {
    let diagram = job_jel_diagram_at(&json!({"state":"ACTIVE"}), now());
    assert!(diagram.starts_with("flowchart LR\n"));
    assert!(diagram.contains("  created[\"Create (—)\"]"));
    assert!(diagram.contains("  created --> execute_1"));
    assert!(diagram.contains("  execute_1 --> review_1"));
    assert!(diagram.contains("  review_1 --> merge"));
    assert!(diagram.contains("  merge --> finished"));
}

#[test]
fn dag_lineage_and_review_retries_render_distinct_verifiable_nodes() {
    let data = json!({"state":"COMPLETED","createdAt":"2026-11-10T08:00:00Z","updatedAt":"2026-11-10T15:00:00Z",
      "plans":[{"id":"p","round":1,"status":"SUCCEEDED","createdAt":"2026-11-10T08:00:00Z",
          "updatedAt":"2026-11-10T09:00:00Z","generatedTaskIds":["root"]}],
      "tasks":[
       {"id":"root","title":"Coordinator","kind":"coordinator","state":"SUCCEEDED","createdAt":"2026-11-10T09:00:00Z","updatedAt":"2026-11-10T13:00:00Z","planningDecisionId":"p"},
       {"id":"child","title":"Render","parentTaskId":"root","state":"FAILED","createdAt":"2026-11-10T10:00:00Z","updatedAt":"2026-11-10T11:00:00Z","attempt":2,
        "executionHistory":[{"attempt":2,"startedAt":"2026-11-10T10:59:00Z"}]},
       {"id":"recovery","title":"Troubleshooter","agentName":"troubleshooter","parentTaskId":"child","state":"SUCCEEDED","recoveryForAttempt":2,"createdAt":"2026-11-10T11:00:00Z","updatedAt":"2026-11-10T11:20:00Z"},
       {"id":"review","title":"Final Review","agentName":"job-acceptance-reviewer","state":"SUCCEEDED","createdAt":"2026-11-10T13:00:00Z","updatedAt":"2026-11-10T14:00:00Z"}],
      "review":{"outcome":"approved","updatedAt":"2026-11-10T14:00:00Z"},
      "localMerge":{"status":"succeeded","updatedAt":"2026-11-10T15:00:00Z"}});
    let diagram = job_jel_diagram_at(&data, now());
    assert!(diagram.contains("plan_1 --> execute_1"));
    assert!(diagram.contains("  task_0 -->|DAG child| task_1"));
    assert!(diagram.contains("  class task_1 jelFailed"));
    assert!(diagram.contains("  class retry_1_0 jelRetry"));
    assert!(diagram.contains("  class troubleshooter_1_0 jelTroubleshooter"));
    assert!(diagram.contains("  class task_3 jelReviewer"));
    assert!(diagram.contains("  merge[\"Merge (1h00m)\"]"));
}

#[test]
fn potentially_unsafe_mermaid_text_is_sanitized_and_cannot_inject_links() {
    let diagram = job_jel_diagram_at(
        &json!({"tasks":[{"id":"evil","title":"bad! click https://exfil.test/whatever<br>\\n💥","state":"RUNNING"}]}),
        now(),
    );
    assert!(diagram.contains("bad click"));
    assert!(!diagram.contains("https://"));
    assert!(!diagram.contains("<br>"));
    assert!(!diagram.contains('💥'));
}

#[test]
fn utf16_slice_crossing_astral_letter_preserves_js_lone_surrogate_on_json_wire() {
    let title = format!("{}𝒜suffix", "A".repeat(79));
    let job = json!({"tasks":[{"id":"1","title":title,"state":"RUNNING"}]});
    let wire = job_jel_diagram_json_wire_at(&job, now());
    assert!(
        wire.contains("\\ud835"),
        "expected escaped high surrogate, not a dropped character"
    );
    assert!(!wire.contains("\\ufffd"));
    let renderable = job_jel_diagram_at(&job, now());
    assert!(
        renderable.contains('�'),
        "Rust scalar strings render JavaScript unpaired surrogates with replacement glyphs"
    );
}
