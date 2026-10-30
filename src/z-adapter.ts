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

function zBootstrap(accessToken: string): string {
  return [
    '[Agents Relay Z worker — live Neo MCP access]',
    'You are a real autonomous worker, not a simulated/demo agent. All tools exposed by Neo MCP are authorized for this task.',
    'Use your real Bash tool to call https://neoy.qili2.com/mcp as JSON-RPC over HTTPS.',
    'MCP access token (one-hour OAuth credential): ' + accessToken,
    'This token is NOT the operator/master secret. Do not echo the token, add it to git, or include it in task output.',
    'IMPORTANT: Every Z Bash invocation starts a fresh shell. In EVERY single Bash tool invocation, assign NEO_ACCESS_TOKEN again and run curl in that SAME invocation. An export from a previous Bash tool call does not persist.',
    'In Bash, set NEO_ACCESS_TOKEN inside the same command as the curl call, then use:',
    'curl -sS --max-time 30 https://neoy.qili2.com/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -H "Authorization: Bearer $NEO_ACCESS_TOKEN" --data-binary JSON',
    'To discover tools, POST {"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}.',
    'To call a tool, POST {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"TOOL_NAME","arguments":{...}}}.',
    'The Neo events tool accepts {"command":"publish","args":{"type":"task.started","source":"EXACT_SOURCE","data":{}}}.',
    'Use tools/call with name "events" and this object as arguments.',
    'Publish task.started for the exact execution source specified below before work.',
    'Perform the real work using Neo MCP shell, fs, or other exposed tools. Preserve unrelated changes.',
    'After proving the required output, publish task.completed with evidence, or task.failed with a concrete error.',
    'Do not report completion based on message submission or guesses. Do not invent tool outputs or event IDs.',
    'If the token expires before a terminal event, report the limitation; do not use the master token.',
    '[End Neo MCP bootstrap]',
  ].join('\n');
}

function zRunner(): ChatGptAgentRunner {
  return (_definition, request: BrowserWorkerRequest, _route, signal): AgentRun => {
    const promise = (async (): Promise<string> => {
      if (signal.aborted) throw new Error('Z worker submission aborted');
      const token = await issueZWorkerCredential();
      const cli = process.env.AGENTS_RELAY_WEBHELM_COMMAND || join(homedir(), '.local/bin/webhelm');
      const config = join(process.env.TMPDIR || '/tmp', 'agents-relay-z-' + randomUUID() + '.json');
      const platformDir = process.env.AGENTS_RELAY_Z_WEBHELM_PLATFORM_DIR;
      const env = platformDir ? { ...process.env, WEBHELM_PLATFORM_DIR: platformDir } : process.env;
      let sessionId: string | undefined;
      const command = async (args: string[]): Promise<Record<string, unknown>> => {
        const result = await execFileAsync(cli, args, { env, signal, timeout: 180_000, maxBuffer: 2_000_000 });
        return lastJson(result.stdout);
      };
      try {
        const attachments = request.files?.length
          ? '\n\nReference paths accessible through Neo MCP fs:\n' + request.files.join('\n') : '';
        await writeFile(config, JSON.stringify({
          message: zBootstrap(token) + '\n\n' + request.prompt + attachments,
          timeout_seconds: 90,
        }), { mode: 0o600, flag: 'wx' });
        const session = await command(['session', 'start']);
        if (typeof session.session_id !== 'string' || !session.session_id) {
          throw new Error('WebHelm Z session start returned no session ID');
        }
        sessionId = session.session_id;
        const receipt = await command([
          'platform', 'run', 'z', 'new-thread', '--session-id', sessionId, '--config', config,
        ]);
        // Only a durable, verifiable submitted receipt may acknowledge launch.
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
      } finally {
        if (sessionId) {
          await execFileAsync(cli, ['session', 'stop', sessionId], {
            env, timeout: 12_000, maxBuffer: 200_000,
          }).catch(() => {});
        }
        await unlink(config).catch(() => {});
      }
    })();
    return { promise, submitted: promise, cancel: () => {} };
  };
}

export class ZAdapter extends ChatGptAdapter {
  override readonly name = 'z' as const;
  override readonly id = 'z/webhelm';
  override readonly capabilities: readonly string[] = ['model', 'z', 'webhelm', 'coding', 'filesystem', 'neo-mcp'];
  constructor() { super({ agentRunner: zRunner(), tabClosePolicy: 'after-start' }); }
}
