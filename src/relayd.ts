#!/usr/bin/env node
import { createService, isEntrypoint, startService } from './cli.js';

export interface DaemonArguments { repository: string; pullRequest: number; jobId: string; serviceArguments: string[]; }

function value(args: readonly string[], name: string, fallback = ''): string {
  const index = args.indexOf(name); return index >= 0 ? args[index + 1] ?? fallback : fallback;
}

export function normalizeDaemonArguments(argv: readonly string[]): DaemonArguments {
  const repository = value(argv, '--repo'); if (!repository) throw new Error('--repo is required');
  const pullRequest = Number(value(argv, '--pr'));
  if (!Number.isInteger(pullRequest) || pullRequest <= 0) throw new Error('--pr is required');
  const jobId = value(argv, '--id'); if (!jobId) throw new Error('--id is required');
  return { repository, pullRequest, jobId, serviceArguments: [...argv] };
}

export async function runDaemon(argv: readonly string[]): Promise<void> {
  normalizeDaemonArguments(argv);
  await startService([...argv]);
}

if (isEntrypoint(import.meta.url)) {
  runDaemon(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
