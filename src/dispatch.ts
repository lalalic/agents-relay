import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { Execution, WorkerAdapter } from './adapters.js';
import { discoverAgents } from './registry.js';
import { AgentRegistration, Result, Task } from './types.js';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function assertAgentEligible(agent: AgentRegistration, task: Task): void {
  if (agent.availability === 'offline') throw new Error(`Registered agent ${agent.id} is offline`);
  const requirements = task.agentRequirements ?? {};
  if (discoverAgents([agent], {
    capabilities: task.capabilities,
    requiredBoundaries: requirements.requiredBoundaries,
    trustDomains: requirements.trustDomains,
    regions: requirements.regions,
    availability: ['available', 'degraded'],
  }).length === 0) throw new Error(`Registered agent ${agent.id} no longer satisfies task dispatch constraints`);
}

class CommandEndpointAdapter implements WorkerAdapter {
  readonly name = 'command' as const;
  readonly id: string;
  readonly capabilities = ['command'] as const;

  constructor(private readonly target: string) {
    if (!isAbsolute(target)) throw new Error('Registered command endpoint must be an absolute executable path');
    this.id = `command:${target}`;
  }

  launch(task: Task, signal: AbortSignal): Execution {
    const env = Object.fromEntries(['HOME', 'TMPDIR', 'LANG', 'LC_ALL'].flatMap(key => process.env[key] ? [[key, process.env[key] as string]] : []));
    const child = spawn(this.target, [task.input], { shell: false, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout?.on('data', chunk => { output += chunk.toString(); });
    child.stderr?.on('data', chunk => { output += chunk.toString(); });
    const promise = new Promise<Result>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', code => code === 0
        ? resolve({ summary: output.trim() || 'Command completed' })
        : reject(new Error(output.trim() || `Command exited ${code}`)));
      signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
    });
    return { id: randomUUID(), promise, cancel: () => child.kill('SIGTERM') };
  }
}

class HttpEndpointAdapter implements WorkerAdapter {
  readonly name = 'http' as const;
  readonly id: string;
  readonly capabilities = ['http'] as const;

  constructor(private readonly endpoint: AgentRegistration['endpoint'], private readonly fetchImpl: FetchLike = fetch) {
    const url = new URL(endpoint.target);
    const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
      throw new Error('Registered HTTP endpoint must use HTTPS unless it is loopback-only');
    }
    if (!loopback && !endpoint.authEnv) throw new Error('Remote registered HTTP endpoint requires authEnv');
    this.id = `http:${url.origin}`;
  }

  launch(task: Task, signal: AbortSignal): Execution {
    const id = randomUUID();
    const promise = (async (): Promise<Result> => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.endpoint.authEnv) {
        const token = process.env[this.endpoint.authEnv];
        if (!token) throw new Error(`Missing HTTP agent credential in ${this.endpoint.authEnv}`);
        headers.authorization = `Bearer ${token}`;
      }
      const response = await this.fetchImpl(this.endpoint.target, {
        method: 'POST',
        headers,
        signal,
        redirect: 'error',
        body: JSON.stringify({
          jobId: task.jobId,
          taskId: task.id,
          parentTaskId: task.parentTaskId,
          projectName: task.projectName,
          input: task.input,
          attempt: task.attempt,
        }),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(text || `Registered HTTP agent returned ${response.status}`);
      let payload: Record<string, unknown> = {};
      try { payload = text ? JSON.parse(text) as Record<string, unknown> : {}; }
      catch { return { summary: text || 'HTTP agent completed' }; }
      return {
        summary: typeof payload.summary === 'string' ? payload.summary : 'HTTP agent completed',
        artifacts: Array.isArray(payload.artifacts) ? payload.artifacts.filter((value): value is string => typeof value === 'string') : undefined,
        data: typeof payload.data === 'object' && payload.data !== null && !Array.isArray(payload.data)
          ? payload.data as Record<string, unknown>
          : undefined,
      };
    })();
    return { id, promise, cancel: () => {} };
  }
}

export function agentAdapter(agent: AgentRegistration, configured: readonly WorkerAdapter[]): WorkerAdapter {
  if (agent.endpoint.kind === 'adapter') {
    if (agent.endpoint.target !== agent.runtime.adapter) throw new Error(`Registered agent ${agent.id} endpoint/runtime adapter mismatch`);
    const adapter = configured.find(candidate => candidate.name === agent.endpoint.target || candidate.id === agent.endpoint.target);
    if (!adapter) throw new Error(`No configured adapter for registered agent ${agent.id}: ${agent.endpoint.target}`);
    return adapter;
  }
  if (agent.endpoint.kind === 'command') return new CommandEndpointAdapter(agent.endpoint.target);
  return new HttpEndpointAdapter(agent.endpoint);
}
