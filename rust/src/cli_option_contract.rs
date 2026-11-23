// Current native CLI option contract. Unknown flags fail before any effects.
pub fn validate_cli_options(args:&[String])->Result<(),String>{
    const ALLOWED:&[&str]=&[
        "--action", "--adapter", "--after", "--agent", "--agent-graph",
        "--agent-graph-file", "--agent-id", "--agents", "--args-file", "--artifact",
        "--attachments", "--attempt-key", "--authorized", "--auto-merge", "--availability",
        "--blocked-on", "--blocked-on-file", "--boundaries", "--canary-webhelm-executable",
        "--canary-webhelm-socket", "--canary-webhelm-workspace", "--capabilities", "--chatgpt-project", "--chatgpt-tab-close-policy",
        "--classification", "--codex", "--commit-sha", "--concurrency", "--condition",
        "--content-only", "--context", "--context-file", "--continue-input", "--continue-kind",
        "--continue-target", "--coordinator-graph", "--coordinator-graph-file", "--coordinator-input", "--coordinator-input-file",
        "--coordinator-output-path", "--coordinator-project-root", "--coordinator-workspace-root", "--creator-thread-id", "--cron",
        "--cwd", "--dependency-validity", "--dependent-job", "--dependent-task", "--deps",
        "--draft", "--endpoint", "--endpoint-kind", "--ephemeral", "--eval-file",
        "--event", "--event-history-api", "--event-json", "--events", "--evidence",
        "--evidence-file", "--exclude-current-route", "--execution", "--execution-id", "--execution-mode",
        "--execution-router-rules", "--explore", "--facts", "--failure-kind", "--file",
        "--findings-file", "--force-restate", "--foreground", "--from",
        "--global-root", "--graph", "--handoff-file", "--head-sha", "--help",
        "--host", "--id", "--idempotency-key", "--implementation-thread-id", "--initial-plan",
        "--input", "--input-file", "--intent", "--intent-file", "--interval",
        "--isolated-nats-token-file", "--isolated-nats-url", "--isolated-store-dir", "--isolated-write-store-dir", "--job",
        "--labels", "--lease-ms", "--legacy-shortcut-runtime", "--limit", "--live-codex-allow-repositories",
        "--live-codex-executable", "--live-store-dir", "--live-webhelm-executable", "--live-webhelm-socket", "--live-webhelm-workspace",
        "--local-merge-source", "--local-merge-target", "--max-attempts", "--message", "--message-file",
        "--missed-run-policy", "--mode", "--model", "--model-nats-token-file", "--model-nats-url",
        "--name", "--nats-url", "--no-auto-merge", "--no-content-only", "--no-review",
        "--objective", "--objective-file", "--on-needs-user", "--on-needs-user-file", "--order",
        "--origin", "--output", "--output-path", "--output-schema", "--owner",
        "--parent", "--path", "--plan-id", "--planner-command", "--port",
        "--priority", "--profile", "--project", "--project-path", "--project-root",
        "--prompt", "--prompt-file", "--provider", "--queue", "--reason",
        "--reason-file", "--reasoning", "--recovery-task-id", "--regions", "--repo",
        "--request-id", "--required-action", "--reroute", "--resolution", "--resolution-condition",
        "--response", "--responsibility", "--review", "--review-task-id", "--reviewer-thread-id",
        "--role", "--runtime", "--sandbox", "--schedule", "--schedule-concurrency",
        "--schedule-cron", "--schedule-next-run", "--schedule-timezone", "--schema", "--shadow-live-store-dir",
        "--shortcut-execution", "--shortcut-local", "--show-toplevel", "--skills", "--skip-git-repo-check",
        "--sqlite", "--start", "--state", "--store-dir", "--story-size",
        "--subject-prefix", "--summary", "--tag", "--target-repo", "--target-task-id",
        "--task", "--task-id", "--task-kind", "--thread-id", "--timeout",
        "--title", "--trust-domain", "--trust-domains", "--trust-isolated-model-events", "--trust-model-events",
        "--version", "--workspace", "--workspace-root",
    ];
    for argument in args {
        if !argument.starts_with("--"){continue;}
        let name=argument.split_once('=').map(|(name,_)|name).unwrap_or(argument);
        if !ALLOWED.contains(&name){
            return Err(format!("Unknown option {name}"));
        }
    }
    Ok(())
}

// Current native CLI option contract. Unknown flags fail before any effects.
pub fn validate_daemon_options(args:&[String])->Result<(),String>{
    const ALLOWED:&[&str]=&[
        "--canary-webhelm-executable", "--canary-webhelm-socket", "--canary-webhelm-workspace", "--concurrency", "--event-history-api",
        "--execution-router-rules", "--help", "--interval", "--isolated-nats-token-file", "--isolated-nats-url",
        "--isolated-store-dir", "--isolated-write-store-dir", "--lease-ms", "--live-codex-allow-repositories", "--live-codex-executable",
        "--live-store-dir", "--live-webhelm-executable", "--live-webhelm-socket", "--live-webhelm-workspace", "--model-nats-token-file",
        "--model-nats-url", "--port", "--repo", "--shadow-live-store-dir", "--trust-isolated-model-events",
        "--trust-model-events", "--version", "--workspace", "--workspace-root",
    ];
    for argument in args {
        if !argument.starts_with("--"){continue;}
        let name=argument.split_once('=').map(|(name,_)|name).unwrap_or(argument);
        if !ALLOWED.contains(&name){
            return Err(format!("Unknown option {name}"));
        }
    }
    Ok(())
}
