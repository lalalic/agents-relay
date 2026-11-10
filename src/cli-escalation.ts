import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { textOption, arg } from './cli-support.js';
import { runEscalationGraph, type EscalationRequest, type EscalationResult } from './workflow/escalation.js';
import { spawnOwnedProcess, terminateOwnedProcess } from './owned-process.js';

/** A caller-selected argv vector. Only the trusted operator supplies this
 * environment value; task input is never parsed as a shell command. */
export function escalationCommand(env: NodeJS.ProcessEnv = process.env): { executable: string; prefixArgs: string[] } | null {
  const raw = env.AGENTS_RELAY_ESCALATION_COMMAND?.trim();
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = raw.startsWith('[') ? JSON.parse(raw) : [raw]; }
  catch { throw new Error('AGENTS_RELAY_ESCALATION_COMMAND must be an absolute executable or JSON argv array'); }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 12 ||
      !parsed.every(x => typeof x === 'string' && x.length > 0 && x.length <= 4096 && !/[\r\n\0]/.test(x)) ||
      !isAbsolute(parsed[0]))
    throw new Error('AGENTS_RELAY_ESCALATION_COMMAND must be an absolute executable or JSON argv array');
  return { executable: parsed[0], prefixArgs: parsed.slice(1) };
}

/** Generic executor contract. No Neo-specific subcommand is assumed. */
export function escalationExecutorArgs(handoffPath: string, policyPath: string | undefined, cwd: string | undefined): string[] {
  return [
    '--handoff-file', handoffPath,
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

const failed = (summary: string): EscalationResult => ({ status: 'failed', summary, reason: summary });

export async function runConfiguredEscalation(
  request: EscalationRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EscalationResult> {
  let selected: ReturnType<typeof escalationCommand>;
  try { selected = escalationCommand(env); }
  catch (error) { return failed(error instanceof Error ? error.message : String(error)); }
  if (!selected) return failed('Escalation executor not configured: set AGENTS_RELAY_ESCALATION_COMMAND');
  const tempRoot = await mkdtemp(join(tmpdir(), 'agents-relay-escalation-'));
  try {
    const handoffPath = join(tempRoot, 'handoff.md');
    await writeFile(handoffPath, handoffText(request), { encoding: 'utf8', mode: 0o600 });
    let policyPath: string | undefined;
    if (request.onNeedsUser) {
      policyPath = join(tempRoot, 'on-needs-user.md');
      await writeFile(policyPath, request.onNeedsUser, { encoding: 'utf8', mode: 0o600 });
    }
    const argv = [...selected.prefixArgs, ...escalationExecutorArgs(handoffPath, policyPath, request.cwd)];
    return await new Promise<EscalationResult>(resolve => {
      let stdout = '';
      let exceeded = false;
      const child = spawnOwnedProcess(selected.executable, argv, {
        invocation: 'escalation.configured',
        timeoutMs: 600_000,
        spawn: { cwd: request.cwd ?? process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
      });
      child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
        if (stdout.length + chunk.length > 256_000) { exceeded = true; void terminateOwnedProcess(child, 'abort'); }
        else stdout += chunk;
      });
      // Do not reflect stderr into the Job result: it can contain provider secrets.
      child.stderr?.resume();
      child.on('error', error => resolve(failed(`Escalation executor could not start: ${error.message}`)));
      child.on('close', code => {
        if (exceeded) return resolve(failed('Escalation executor output exceeded limit'));
        if (code !== 0) return resolve(failed(`Escalation executor failed (exit ${code ?? 'signal'})`));
        let parsed: unknown;
        try { parsed = JSON.parse(stdout.trim()); }
        catch { return resolve(failed('Escalation executor returned invalid JSON')); }
        if (!parsed || typeof parsed !== 'object' || !('status' in parsed) ||
            !['resolved', 'failed', 'needs_user'].includes(String(parsed.status)) ||
            !('summary' in parsed) || typeof parsed.summary !== 'string' || !parsed.summary.trim())
          return resolve(failed('Escalation executor returned invalid result contract'));
        resolve(parsed as EscalationResult);
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
  const outcome = await runEscalationGraph(request, { invoke: runConfiguredEscalation });
  console.log(JSON.stringify({ state: outcome.state, ...outcome.result }, null, 2));
  if (outcome.state === 'technical_failure') process.exitCode = 2;
}
