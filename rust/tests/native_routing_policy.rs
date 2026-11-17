// Native Rust regression for direct port of Node src/routing-policy.ts: eligibility, ranking, file IO, SHA-256 and sanitization.
use agents_relay_rust2::routing_policy::{
    execution_router_rules_path, load_execution_router_rules, load_routing_policy, policy_allows,
    policy_path, policy_rank, safe_policy, save_execution_router_rules,
};
use serde_json::json;
use std::{
    fs,
    time::{SystemTime, UNIX_EPOCH},
};

#[test]
fn sanitized_routing_policy_contains_only_declared_and_typed_fields() {
    let value = json!({"disabledProviders":["zai",4],"disabledProfiles":[],
        "preferredProviders":["openai"],"qualityByTaskKind":{"review":["id-1"],"invalid":["x",null]},
        "recovery":{"penalizePriorRoute":true,"unexpected":"ignored"},"unknown":42});
    let sanitized = safe_policy(&value);
    assert_eq!(
        sanitized,
        json!({"disabledProfiles":[],"preferredProviders":["openai"],
       "qualityByTaskKind":{"review":["id-1"]},"recovery":{"penalizePriorRoute":true}})
    );
}

#[test]
fn policy_ranking_respects_provider_and_profile_preferences() {
    let policy = json!({"disabledProviders":["zai"],"disabledProfiles":["slow"],
        "preferredProviders":["openai"],"preferredProfiles":["fast"],
        "qualityByTaskKind":{"code":["id-1"]}});
    assert!(!policy_allows(
        &json!({"provider":"zai","profile":"fast"}),
        &policy
    ));
    assert!(!policy_allows(
        &json!({"provider":"openai","profile":"slow"}),
        &policy
    ));
    assert!(policy_allows(
        &json!({"provider":"openai","profile":"fast"}),
        &policy
    ));
    assert_eq!(
        policy_rank(
            &json!({"id":"id-1","provider":"openai"}),
            Some("code"),
            &policy
        ),
        3
    );
    assert_eq!(
        policy_rank(
            &json!({"id":"id-0","provider":"x","profile":"fast"}),
            Some("code"),
            &policy
        ),
        2
    );
    assert_eq!(
        policy_rank(&json!({"id":"id-1","provider":"x"}), Some("code"), &policy),
        1
    );
}

#[test]
fn router_rules_persist_and_hash_in_isolated_temp_directory() {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "relay-rust2-routing-{}-{stamp}",
        std::process::id()
    ));
    let rules = dir.join("nested").join("router.md");
    let policy = dir.join("policy.json");
    let rule_path = rules.to_str().unwrap();
    assert_eq!(
        policy_path(None, None, &dir),
        dir.join(".agents-relay-routing-policy.json")
            .to_string_lossy()
    );
    assert_eq!(
        execution_router_rules_path(None, None, &dir),
        dir.join(".agents-relay/execution-router-rules.md")
            .to_string_lossy()
    );
    let missing = load_routing_policy(policy.to_str().unwrap(), rule_path);
    assert_eq!(missing["hash"], "none");
    assert_eq!(missing["rules"]["hash"], "none");
    let text = "[choices]\r\nopenai: gpt-6 HIGH\r\n[routing-instruction]\r\n Keep byte-exact\r\n";
    let saved = save_execution_router_rules(text, rule_path).unwrap();
    assert_eq!(saved["text"], text);
    assert_eq!(load_execution_router_rules(rule_path), saved);
    fs::write(&policy, "{\"disabledProviders\":[\"zai\"]}\n").unwrap();
    let loaded = load_routing_policy(policy.to_str().unwrap(), rule_path);
    assert_eq!(loaded["policy"]["disabledProviders"], json!(["zai"]));
    assert_eq!(loaded["snapshot"], loaded["policy"]);
    assert_eq!(loaded["rules"], saved);
    fs::remove_dir_all(&dir).unwrap();
}
