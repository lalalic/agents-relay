// Native Rust regression for Node src/cli-help.ts: all 47 current main command help texts and command/action fallback semantics.
use agents_relay_rust2::cli_help::{help_text, CLI_HELP_ENTRIES, CLI_USAGE};
#[test]
fn all_source_help_keys_are_present_and_not_empty() {
    assert_eq!(CLI_HELP_ENTRIES.len(), 47);
    for (key, content) in CLI_HELP_ENTRIES {
        assert!(!key.is_empty());
        assert!(!content.trim().is_empty(), "Missing Help for {key}");
        assert_eq!(help_text(Some(key), None), *content);
    }
}
#[test]
fn combined_action_help_preserves_correct_subcommands_and_unknown_fallback() {
    assert_eq!(
        help_text(Some("job"), Some("run")),
        help_text(Some("job run"), None)
    );
    assert_eq!(
        help_text(Some("task"), Some("comments")),
        help_text(Some("task comments"), None)
    );
    assert_eq!(
        help_text(Some("context"), Some("resolve")),
        help_text(Some("context resolve"), None)
    );
    assert_eq!(
        help_text(Some("blocker"), Some("resolve")),
        help_text(Some("blocker resolve"), None)
    );
    assert_eq!(
        help_text(Some("job"), Some("unsupported")),
        help_text(Some("job"), None)
    );
    assert_eq!(
        help_text(Some("projection"), Some("resolve")),
        help_text(Some("projection"), None)
    );
    assert_eq!(
        help_text(Some("unsupported"), Some("create")),
        help_text(None, None)
    );
    assert!(CLI_USAGE.starts_with("agents-relay <job|task|review|"));
}
