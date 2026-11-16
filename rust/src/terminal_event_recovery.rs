// Direct port of Node src/terminal-event-recovery.ts: a recovery reminder never counts as Task completion.
pub const MAX_TERMINAL_RECOVERY_TURNS: f64 = 1.0;

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
    format!("[Relay terminal-event recovery: {execution_id}]\nThis is ONE reminder for the ORIGINAL Task execution, not a new task or authorization to restart work. Inspect the authoritative Task context, Neo event history, and actual output. If a correlated terminal event already exists, do not publish a duplicate. If work is complete with verified evidence, publish task.completed with the ORIGINAL execution identity. If unfinished or unverified, publish task.failed with the real reason; do not claim success. Follow the canonical event contract. Do not emit task.progress merely because this reminder arrived.")
}
