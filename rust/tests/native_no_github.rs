// Native fail-closed regression for Node src/no-github.ts: four GitHub API methods reject and flags are exact.
use agents_relay_rust2::no_github::{no_github_mode, DisabledGitHubClient};
use std::{
    future::Future,
    pin::pin,
    task::{Context, Poll, Waker},
};
fn drive<T>(work: impl Future<Output = T>) -> T {
    let mut work = pin!(work);
    let mut cx = Context::from_waker(Waker::noop());
    loop {
        if let Poll::Ready(outcome) = work.as_mut().poll(&mut cx) {
            return outcome;
        }
    }
}
fn strings(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| (*s).to_string()).collect()
}
#[test]
fn argv_and_environment_flags_are_exact_and_boolean_independent() {
    assert!(!no_github_mode(&[], &[], None));
    assert!(no_github_mode(&strings(&["--no-github"]), &[], None));
    assert!(no_github_mode(&[], &strings(&["--no-github"]), None));
    assert!(no_github_mode(&[], &[], Some("1")));
    for value in ["0", "yes", "true", "false", ""] {
        assert!(!no_github_mode(&[], &[], Some(value)));
    }
    assert!(!no_github_mode(&strings(&["--no-github=true"]), &[], None));
}
#[test]
fn disabled_adapter_cannot_escape_by_using_any_of_four_network_operations() {
    let client = DisabledGitHubClient::new();
    let expected = "GitHub disabled by --no-github";
    assert_eq!(drive(client.request()).unwrap_err(), expected);
    assert_eq!(drive(client.graphql()).unwrap_err(), expected);
    assert_eq!(drive(client.rate_limit_snapshot()).unwrap_err(), expected);
    assert_eq!(drive(client.current_login()).unwrap_err(), expected);
}
