import { createConnection } from 'node:net';
import { join } from 'node:path';
import { homedir } from 'node:os';

export type WebHelmDaemonRequest = {
  op: 'workspace-create' | 'start' | 'exec' | 'stop' | 'heartbeat' | 'platform-run' | 'capacity' | 'list';
  name?: string;
  pool_size?: number;
  workspace?: string;
  session_id?: string;
  url?: string;
  code?: string;
  platform?: string;
  action?: string;
  config?: Record<string, unknown>;
  auto_session?: boolean;
};

const daemonSocket = (): string => process.env.WEBHELM_SOCKET ||
  join(process.env.WEBHELM_RUNTIME_DIR ||
    join(process.env.WEBHELM_CONFIG_ROOT || join(homedir(), '.config', 'webhelm'), 'runtime'),
  'session-node.sock');

/** Application-owned WebHelm IPC: never provision custom Workspaces via the agent CLI. */
export function webHelmDaemonRequest(
  payload: WebHelmDaemonRequest,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({path: daemonSocket()});
    const timeoutMs = options.timeoutMs ?? 45_000;
    let buffer = '';
    let settled = false;
    const settle = (error?: Error, value?: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      if (error) reject(error);
      else resolve(value ?? {});
    };
    const onAbort = (): void => settle(new Error('WebHelm daemon request aborted'));
    if (options.signal?.aborted) { onAbort(); return; }
    options.signal?.addEventListener('abort', onAbort, {once: true});
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs, () => settle(new Error('WebHelm daemon ' + payload.op + ' timed out')));
    socket.once('connect', () => socket.write(JSON.stringify(payload)+'\n'));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 2_000_000) return settle(new Error('WebHelm daemon response exceeds limit'));
      const delimiter = buffer.indexOf('\n');
      if (delimiter < 0) return;
      try {
        const result = JSON.parse(buffer.slice(0, delimiter)) as Record<string, unknown>;
        if (result.error || result.ok === false)
          return settle(new Error(String(result.error || 'WebHelm daemon rejected request')));
        settle(undefined, result);
      } catch (error) { settle(error instanceof Error ? error : new Error(String(error))); }
    });
    socket.once('error', (error: Error) => settle(error));
    socket.once('end', () => {
      if (!settled) settle(new Error('WebHelm daemon closed without a response'));
    });
  });
}
