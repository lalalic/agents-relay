// Native tests for Node src/github-runtime-usage.ts; fake transport responses only, no real GitHub/network API calls.
use agents_relay_rust2::github_runtime_usage::{
    empty_github_runtime_rate_usage, observe_runtime_rate_limit, parse_github_cli_headers,
    runtime_rejection,
};
use serde_json::json;
#[test]
fn normal_transport_observation_preserves_full_available_resource_headers() {
    let transport = json!({"status":200,"headers":{"x-ratelimit-resource":"graphql","x-ratelimit-limit":"5000",
        "x-ratelimit-used":"42","x-ratelimit-remaining":"4958","x-ratelimit-reset":"1893456000"},"body":"OK"});
    let record =
        observe_runtime_rate_limit("rest", &transport, "2026-11-16T21:00:00.000Z").unwrap();
    assert_eq!(record["resource"], "graphql");
    assert_eq!(record["available"], true);
    assert_eq!(record["used"], 42);
    assert_eq!(record["remaining"], 4958);
    assert_eq!(record["resetAt"], "2030-01-01T00:00:00.000Z");
    assert_eq!(record["reason"], serde_json::Value::Null);
    assert_eq!(runtime_rejection(&record).unwrap(), serde_json::Value::Null);
}
#[test]
fn error_403_remaining_zero_means_primary_throttle_and_cooldown() {
    let transport = json!({"status":403,"headers":{"x-ratelimit-remaining":"0","retry-after":"15"},"body":"secondary rate limit"});
    let record =
        observe_runtime_rate_limit("rest", &transport, "2026-11-16T22:00:00.000Z").unwrap();
    assert_eq!(record["throttled"], true);
    assert_eq!(record["available"], false);
    let rejection = runtime_rejection(&record).unwrap();
    assert_eq!(rejection["kind"], "primary");
    assert_eq!(rejection["cooldownUntil"], "2026-11-16T22:00:15.000Z");
}
#[test]
fn secondary_rate_detection_differs_from_graphql_tag_only() {
    let graphql =
        json!({"status":403,"headers":{"x-ratelimit-remaining":"10"},"body":"graphql_rate_limit"});
    let record = observe_runtime_rate_limit("rest", &graphql, "2026-11-16T22:00:00.000Z").unwrap();
    assert_eq!(record["throttled"], true);
    assert_eq!(runtime_rejection(&record).unwrap()["kind"], "unknown");
    let rate_limit =
        json!({"status":403,"headers":{"x-ratelimit-remaining":"10"},"body":"rate limit"});
    let record =
        observe_runtime_rate_limit("rest", &rate_limit, "2026-11-16T22:00:00.000Z").unwrap();
    assert_eq!(runtime_rejection(&record).unwrap()["kind"], "secondary");
}
#[test]
fn parse_cli_headers_recognizes_status_duplicate_keys_and_crlf() {
    let body="HTTP/2 429 Too Many Requests\r\nX-RateLimit-Remaining: 12\r\nX-RateLimit-Remaining: 0\r\nRetry-After: 15\r\n\r\n{\"ok\":false}";
    let parsed = parse_github_cli_headers(body, true);
    assert_eq!(parsed["status"], 429);
    assert_eq!(parsed["headers"]["x-ratelimit-remaining"], "0");
    assert_eq!(parsed["headers"]["retry-after"], "15");
    assert_eq!(parsed["body"], "{\"ok\":false}");
    assert_eq!(parse_github_cli_headers(body, false)["body"], body);
}
#[test]
fn absence_of_headers_and_empty_usage_do_not_invent_rate_limits() {
    assert_eq!(
        empty_github_runtime_rate_usage(),
        json!({"resources":{},"rejection":null})
    );
    let response = json!({"status":null,"headers":{},"body":"unavailable"});
    let observation =
        observe_runtime_rate_limit("graphql", &response, "2026-11-16T22:00:00.000Z").unwrap();
    assert_eq!(observation["available"], serde_json::Value::Null);
    assert_eq!(observation["resource"], "graphql");
    assert_eq!(observation["headersCaptured"], false);
    assert_eq!(
        runtime_rejection(&observation).unwrap(),
        serde_json::Value::Null
    );
}
