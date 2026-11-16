// Direct port of Node src/github-branch-projection.ts: derive authoritative push argv.
pub fn authoritative_branch_push_args(
    source_ref: &str,
    branch: &str,
    remote_head_sha: Option<&str>,
    remote_tree_matches_base: bool,
) -> Vec<String> {
    let refspec = format!("{source_ref}:refs/heads/{branch}");
    if let Some(sha) = remote_head_sha.filter(|sha| !sha.is_empty()) {
        if remote_tree_matches_base {
            return vec![
                "push".into(),
                "origin".into(),
                format!("--force-with-lease=refs/heads/{branch}:{sha}"),
                refspec,
            ];
        }
    }
    vec!["push".into(), "origin".into(), refspec]
}
