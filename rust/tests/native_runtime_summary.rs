// Native tests for Node src/runtime-summary.ts: lease expiry, owned execution and worker/model aggregation, no process queries.
use agents_relay_rust2::runtime_summary::{has_live_execution, running_worker, summarize_runtime};
use serde_json::json;
const NOW: i64 = 1794888000000;
#[test]
fn expired_or_ownerless_run_flags_never_count_as_live() {
    let job = json!({"state":"ACTIVE"});
    for task in [
        json!({"state":"RUNNING","executionId":null,"leaseOwner":"relay","leaseExpiresAt":"2026-11-17T06:00:00Z"}),
        json!({"state":"RUNNING","executionId":"exec","leaseOwner":null,"leaseExpiresAt":"2026-11-17T06:00:00Z"}),
        json!({"state":"QUEUED","executionId":"exec","leaseOwner":"relay","leaseExpiresAt":"2026-11-17T06:00:00Z"}),
        json!({"state":"RUNNING","executionId":"exec","leaseOwner":"relay","leaseExpiresAt":"2026-10-17T06:00:00Z"}),
    ] {
        assert!(!has_live_execution(&job, &task, NOW));
    }
}
#[test]
fn selected_worker_overrides_default_adapter_when_run_is_active() {
    let worker =
        json!({"state":"RUNNING","adapter":"orchestrator","workerSelection":{"adapter":"chatgpt"}});
    assert_eq!(running_worker(&worker), Some("chatgpt"));
}
#[test]
fn summary_tracks_model_counts_and_execution_scoped_identity_order() {
    let job = json!({"id":"j1","title":"Job","repository":"repo","prNumber":0,"state":"ACTIVE","tasks":[
   {"id":"t1","state":"RUNNING","adapter":"chatgpt","agentName":"worker","executionId":"e1","leaseOwner":"relay","leaseExpiresAt":"2026-11-17T06:00:00Z","routing":{"model":"gpt-6","provider":"openai"}},
   {"id":"t2","state":"RUNNING","adapter":"codex","executionId":"e2","leaseOwner":"relay","leaseExpiresAt":"2026-11-17T06:00:00Z","routing":{"model":"gpt-6","provider":"openai"}},
   {"id":"t3","state":"RUNNING","adapter":"codex","executionId":"e3","leaseOwner":"relay","leaseExpiresAt":"2026-11-16T06:00:00Z"}]});
    let summary = summarize_runtime(&[job], NOW);
    assert_eq!(summary["runningTasks"], 2);
    assert_eq!(summary["workers"]["chatgpt"], 1);
    assert_eq!(summary["workers"]["codex"], 1);
    assert_eq!(summary["models"][0]["count"], 2);
    assert_eq!(summary["running"][0]["executionId"], "e1");
}
