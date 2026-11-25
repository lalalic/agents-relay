// Adapter-level corrective turns within one owned execution; a reminder never counts as Task completion.
pub const MAX_TERMINAL_RECOVERY_TURNS: f64 = 2.0;

pub struct TerminalRecoveryFacts {
    pub has_session: bool,
    pub has_thread: bool,
    pub terminal_observed: bool,
    pub recovery_attempts: f64,
    pub outcome_uncertain: bool,
    pub cancelled: bool,
}

pub fn terminal_recovery_eligible(facts: &TerminalRecoveryFacts) -> bool {
    facts.has_session
        && facts.has_thread
        && !facts.terminal_observed
        && !facts.outcome_uncertain
        && !facts.cancelled
        && facts.recovery_attempts < MAX_TERMINAL_RECOVERY_TURNS
}

pub fn terminal_recovery_prompt(execution_id: &str) -> String {
    format!("[Relay terminal-event recovery: {execution_id}]\nContinue the ORIGINAL Task execution. The preceding Codex turn exited normally without a verified Relay terminal outcome. Read the authoritative execution-bound Task context and inspect existing artifacts, Git status and evidence before acting. This continuation instruction takes precedence over the initial START instruction: if task.started is already recorded, do not emit it again; otherwise start the original execution per its contract. Do not repeat completed operations or emit duplicate terminal events. Finish only remaining work, then follow the canonical completion contract above using the ORIGINAL execution identity. For source or DAG tasks use the existing validated agents-relay task complete CLI, never publish task.completed directly. If the task cannot be verified, report its real failure through the applicable contract. Do not merely summarize and exit.")
}
