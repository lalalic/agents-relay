import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { textOption, arg } from './cli-support.js';
import { runEscalationGraph, type EscalationRequest, type EscalationResult } from './workflow/escalation.js';
import { spawnOwnedProcess } from './owned-process.js';

export function neoEscalationArgs(
  handoffPath: string,
  policyPath: string | undefined,
  cwd: string | undefined,
): string[] {
  return [
    'escalation', '--handoff-file', handoffPath,
    ...(policyPath ? ['--on-needs-user-file', policyPath] : []),
    ...(cwd ? ['--cwd', cwd] : []),
  ];
}

function handoffText(request: EscalationRequest): string {
  return [
    '# Intent', request.intent.trim(),
    '', '# Blocked on', request.blockedOn.trim(),
    ...(request.context?.trim() ? ['', '# Context', request.context.trim()] : []),
    '',
  ].join('\n');
}

export async function runNeoEscalation(request: EscalationRequest): Promise<EscalationResult> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'agents-relay-escalation-'));
  try {
    const handoffPath = join(tempRoot, 'handoff.md');
    await writeFile(handoffPath, handoffText(request), { encoding: 'utf8', mode: 0o600 });
    let policyPath: string | undefined;
    if (request.onNeedsUser) {
      policyPath = join(tempRoot, 'on-needs-user.md');
      await writeFile(policyPath, request.onNeedsUser, { encoding: 'utf8', mode: 0o600 });
    }
    const args = neoEscalationArgs(handoffPath, policyPath, request.cwd);
    return await new Promise((resolve, reject) => {
      const child = spawnOwnedProcess('neo', args, { invocation: 'escalation.neo', spawn: { cwd: request.cwd ?? process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] } });
      let stdout = '';
      let stderr = '';
      child.stdout?.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.stderr?.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
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
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
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
