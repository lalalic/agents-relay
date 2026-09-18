import { spawn } from 'node:child_process';

export interface GitHubGatewayClient {
  request(path: string, init?: RequestInit): Promise<unknown>;
}

export class GitHubRequestError extends Error {
  readonly status: number;
  readonly bodyText: string;
  constructor(status: number, message: string, bodyText: string) {
    super(message);
    this.name = 'GitHubRequestError';
    this.status = status;
    this.bodyText = bodyText;
  }
}

export class GitHubUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubUnavailableError';
  }
}

export function isNotFound(error: unknown): boolean {
  return error instanceof GitHubRequestError && error.status === 404;
}

export function isConflict(error: unknown): boolean {
  return error instanceof GitHubRequestError && (error.status === 422 || error.status === 409);
}

const STATUS_PATTERN = /^HTTP\/[\d.]+ (\d{3})/m;

function apiMessage(bodyText: string): string | undefined {
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    return typeof parsed.message === 'string' ? parsed.message : undefined;
  } catch {
    return undefined;
  }
}

type CommandResult = { code: number | null; stdout: string; stderr: string };

/**
 * GitHub client for the gateway. Unlike `GhApiClient`, this variant keeps the HTTP status so
 * callers can distinguish "branch not found" (404) from "branch already exists" (422).
 */
export class GhCliClient implements GitHubGatewayClient {
  constructor(private readonly command = 'gh') {}

  async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const args = ['api', path, '--include'];
    const method = String(init.method ?? 'GET');
    if (method !== 'GET') args.push('--method', method);
    const payload = typeof init.body === 'string' ? init.body : undefined;
    if (payload !== undefined) args.push('--input', '-');
    const result = await this.run(args, payload);
    const crlfIndex = result.stdout.indexOf('\r\n\r\n');
    const lfIndex = result.stdout.indexOf('\n\n');
    const separator = crlfIndex >= 0 ? crlfIndex : lfIndex;
    const separatorLength = crlfIndex >= 0 ? 4 : 2;
    const headerText = separator >= 0 ? result.stdout.slice(0, separator) : '';
    const bodyText = separator >= 0 ? result.stdout.slice(separator + separatorLength) : result.stdout;
    const statusMatch = STATUS_PATTERN.exec(headerText);
    const status = statusMatch ? Number(statusMatch[1]) : 0;
    if (status === 0) {
      if (result.code !== 0) throw new GitHubUnavailableError(result.stderr.trim() || `gh api exited ${result.code}`);
      return null;
    }
    if (status >= 400) {
      const message = apiMessage(bodyText) ?? (result.stderr.trim() || `GitHub responded ${status}`);
      throw new GitHubRequestError(status, message, bodyText);
    }
    const trimmed = bodyText.trim();
    if (trimmed === '') return null;
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return trimmed;
    }
  }

  private run(args: string[], input: string | undefined): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(this.command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('error', error => reject(new GitHubUnavailableError(`gh is unavailable: ${error.message}`)));
      if (input !== undefined) child.stdin?.write(input);
      child.stdin?.end();
      child.on('close', code => resolve({ code, stdout, stderr }));
    });
  }
}
