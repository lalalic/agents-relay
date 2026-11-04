/** Shared, adapter-neutral terminal-event recovery policy.
 * A recovery turn is not a Task retry, progress event, or completion proof.
 * Only an existing resumable conversation for the ORIGINAL execution qualifies.
 */
export const MAX_TERMINAL_RECOVERY_TURNS = 1;

export function terminalRecoveryEligible(facts: {
  hasSession: boolean; hasThread: boolean; terminalObserved: boolean;
  recoveryAttempts: number; outcomeUncertain: boolean; cancelled: boolean;
}): boolean {
  return facts.hasSession && facts.hasThread && !facts.terminalObserved
    && !facts.outcomeUncertain && !facts.cancelled
    && facts.recoveryAttempts < MAX_TERMINAL_RECOVERY_TURNS;
}

export function terminalRecoveryPrompt(executionId: string): string {
  return `[Relay terminal-event recovery: ${executionId}]\nThis is ONE reminder for the ORIGINAL Task execution, not a new task or authorization to restart work. Inspect the authoritative Task context, Neo event history, and actual output. If a correlated terminal event already exists, do not publish a duplicate. If work is complete with verified evidence, publish task.completed with the ORIGINAL execution identity. If unfinished or unverified, publish task.failed with the real reason; do not claim success. Follow the canonical event contract. Do not emit task.progress merely because this reminder arrived.`;
}
