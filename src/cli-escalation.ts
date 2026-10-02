import { spawn } from 'node:child_process';
import { textOption, arg } from './cli-support.js';
import { runEscalationGraph, type EscalationRequest, type EscalationResult } from './workflow/escalation.js';

function runNeoEscalation(request: EscalationRequest): Promise<EscalationResult> {
  const args = ['escalation', '--intent', request.intent, '--blocked-on', request.blockedOn];
  if (request.context) args.push('--context', request.context);
  if (request.onNeedsUser) args.push('--on-needs-user', request.onNeedsUser);
  if (request.cwd) args.push('--cwd', request.cwd);
  return new Promise((resolve, reject) => {
    const child = spawn('neo', args, { cwd: request.cwd ?? process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      let parsed: EscalationResult;
      try {
        parsed = JSON.parse(stdout.trim()) as EscalationResult;
      } catch {
        reject(new Error(`neo escalation returned invalid JSON (exit ${code ?? 'unknown'}): ${stderr || stdout}`));
        return;
      }
      if (!['resolved', 'failed', 'needs_user'].includes(parsed.status)) {
        reject(new Error(`neo escalation returned invalid status ${String(parsed.status)}`));
        return;
      }
      resolve(parsed);
    });
  });
}

export async function runEscalationCommand(args: string[]): Promise<void> {
  const intent = await textOption(args, '--intent', '--intent-file');
  const blockedOn = await textOption(args, '--blocked-on', '--blocked-on-file');
  if (!intent.trim()) throw new Error('escalation requires --intent or --intent-file');
  if (!blockedOn.trim()) throw new Error('escalation requires --blocked-on or --blocked-on-file');
  const context = await textOption(args, '--context', '--context-file');
  const onNeedsUser = await textOption(args, '--on-needs-user', '--on-needs-user-file');
  const request: EscalationRequest = {
    intent,
    blockedOn,
    ...(context.trim() ? { context } : {}),
    ...(onNeedsUser.trim() ? { onNeedsUser } : {}),
    ...(arg(args, '--cwd') ? { cwd: arg(args, '--cwd') } : {}),
  };
  const outcome = await runEscalationGraph(request, { invoke: runNeoEscalation });
  console.log(JSON.stringify({ state: outcome.state, ...outcome.result }, null, 2));
  if (outcome.state === 'technical_failure') process.exitCode = 2;
}
