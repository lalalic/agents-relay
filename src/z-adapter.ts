import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ChatGptAdapter, type ChatGptAgentRunner, type BrowserWorkerRequest, type AgentRun } from './adapters.js';
import { issueZWorkerCredential } from './z-oauth.js';

const execFileAsync = promisify(execFile);

function lastJson(stdout: string): Record<string, unknown> {
  const lines = stdout.trim().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]) as Record<string, unknown>; } catch { /* diagnostic output */ }
  }
  throw new Error('WebHelm Z did not return JSON');
}

/** The same Graph-owned task binding in the Action output is used for Z events. */
export function zExecutionSource(prompt: string): string {
  const jobs=[...prompt.matchAll(/^Job: ([^\s]+)$/gm)],
    tasks=[...prompt.matchAll(/^Task: ([^\s]+)$/gm)],
    executions=[...prompt.matchAll(/^Execution: ([0-9a-f-]{36})$/gm)];
  if(jobs.length!==1 || tasks.length!==1 || executions.length!==1)
    throw new Error('Z worker requires exactly one Graph-issued Task execution identity');
  return `job/${jobs[0][1]}/task/${tasks[0][1]}/execution/${executions[0][1]}`;
}

/** No Task Brief rewrite: the message produced by the Graph Action is authoritative. */
export function zTaskBrief(prompt: string): string { return prompt; }

/**
 * Same Neo bootstrap entry as interactive Z Chat. The OAuth credential is a
 * transport secret injected only when launching; it is never in the action's
 * printable Task Prompt. It must not change that Prompt's contents.
 */
export function zBootstrap(accessToken: string, prompt: string): string {
  const source = zExecutionSource(prompt);
  const makeEvent = (type: string, message: string) => JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'events', arguments:
      {command: 'publish', args: {type, source, data: {message}}}},
  });
  return [
    '# Z.ai Relay runtime bootstrap (transport only)',
    'This worker uses the same Neo bootstrap entry as manually initialized Z.ai Chat:',
    'https://neoy.qili2.com/files/z-chat/bootstrap.md',
    'Read that URL using a real Z web/Bash tool. Do not treat Z cloud files as Neo Master files.',
    'The adapter has already authorized a short-lived Neo OAuth session for this Task.',
    'Use only this runtime access token inside Z Bash calls; never expose it in final replies, logs or artifacts:',
    `NEO_ACCESS_TOKEN=${JSON.stringify(accessToken)}`,
    'Neo MCP endpoint: https://neoy.qili2.com/mcp',
    'Each Z Bash invocation must set the current NEO_ACCESS_TOKEN inside the same call; shell variables do not persist.',
    'FIRST ACTION before any Task work: publish task.started by making a real HTTPS POST to the Neo MCP events tool and verify its JSON-RPC result.',
    `curl -sS --max-time 20 https://neoy.qili2.com/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H \"Authorization: Bearer $NEO_ACCESS_TOKEN\" --data-binary '${makeEvent('task.started', 'Z worker started')}'`,
    'Then follow the manual Z Chat Neo MCP bootstrap sequence (tools/list, shell exec neo bootstrap, relevant Neo skills), using the already-issued OAuth credential. Continue this Relay Task rather than waiting for a next user turn.',
    'Use the exactly supplied Graph Action Task Prompt below. Read every listed Agent/Contract/Context path via Neo MCP fs. Use the agents-relay skill and CLI for the authoritative task details.',
    'Verify output and all acceptance criteria through Neo Master fs/shell before publishing a terminal event.',
    `Publish task.completed or task.failed using the SAME ${source} through the Neo MCP events tool; Relay owns durable state transitions.`,
    '', '# Graph Action Task Prompt (unaltered)',
  ].join('\n');
}

function zRunner(): ChatGptAgentRunner {
  return (_definition, request: BrowserWorkerRequest, _route, signal): AgentRun => {
    const cli = process.env.AGENTS_RELAY_WEBHELM_COMMAND || join(homedir(), '.local/bin/webhelm');
    const platformDir = process.env.AGENTS_RELAY_Z_WEBHELM_PLATFORM_DIR;
    const env = platformDir ? { ...process.env, WEBHELM_PLATFORM_DIR: platformDir } : process.env;
    let sessionId: string | undefined;
    let releaseRequested = false;
    let stopped = false;
    const closeIfReady = (): void => {
      if (!releaseRequested || !sessionId || stopped) return;
      stopped = true;
      void execFileAsync(cli, ['session', 'stop', sessionId], {
        env, timeout: 12_000, maxBuffer: 200_000,
      }).catch(() => {});
    };
    const release = (): void => {
      // Cancellation can race session start; close it as soon as its ID exists.
      releaseRequested = true;
      closeIfReady();
      signal.removeEventListener('abort', release);
    };
    if (signal.aborted) release();
    else signal.addEventListener('abort', release, { once: true });
    const promise = (async (): Promise<string> => {
      if (signal.aborted) throw new Error('Z worker submission aborted');
      const token = await issueZWorkerCredential();
      const config = join(process.env.TMPDIR || '/tmp', 'agents-relay-z-' + randomUUID() + '.json');
      const command = async (args: string[]): Promise<Record<string, unknown>> => {
        const result = await execFileAsync(cli, args, { env, signal, timeout: 180_000, maxBuffer: 2_000_000 });
        return lastJson(result.stdout);
      };
      try {
        // File references belong to the Graph-owned Task Context, not a Z-only Prompt appendix.
        await writeFile(config, JSON.stringify({
          message: zBootstrap(token, request.prompt) + '\n' + zTaskBrief(request.prompt),
          timeout_seconds: 90,
        }), { mode: 0o600, flag: 'wx' });
        const session = await command(['session', 'start']);
        if (typeof session.session_id !== 'string' || !session.session_id) {
          throw new Error('WebHelm Z session start returned no session ID');
        }
        sessionId = session.session_id;
        closeIfReady();
        if (releaseRequested) throw new Error('Z worker cancelled before browser submission');
        const receipt = await command([
          'platform', 'run', 'z', 'new-thread', '--session-id', sessionId, '--config', config,
        ]);
        const envelope = receipt.result as { ok?: boolean; stdout?: string } | undefined;
        if (envelope?.ok !== true || typeof envelope.stdout !== 'string') throw new Error('Z action did not succeed');
        const response = lastJson(envelope.stdout);
        if (response.status !== 'submitted' || response.mode !== 'new-thread'
          || typeof response.thread_url !== 'string'
          || !/^https:\/\/chat\.z\.ai\/c\/[A-Za-z0-9_-]+$/.test(response.thread_url)
          || !response.verified_by) {
          throw new Error('WebHelm Z did not provide an independently verified durable submission receipt');
        }
        return JSON.stringify({ ...response, temporary: false });
      } catch (error) {
        release();
        throw error;
      } finally {
        await unlink(config).catch(() => {});
      }
    })();
    return { promise, submitted: promise, release, cancel: release };
  };
}

export class ZAdapter extends ChatGptAdapter {
  override readonly name = 'z' as const;
  override readonly id = 'z/webhelm';
  override readonly capabilities: readonly string[] = ['model', 'z', 'webhelm', 'coding', 'filesystem', 'neo-mcp'];
  constructor() { super({ agentRunner: zRunner(), tabClosePolicy: 'after-terminal' }); }
}
