import { homedir } from 'node:os';
import { join } from 'node:path';
import { SQLiteRelayStore, relayStorePath } from './relay-store.js';
import { arg, hasArg, integerArg, pullRequest, repository } from './cli-support.js';

const DEFAULT_STORE_DIR = join(homedir(), '.agents-relay', 'stores');

function storePath(args: string[]): string {
  const explicit = arg(args, '--store');
  if (explicit) return explicit;
  return relayStorePath(arg(args, '--store-dir', DEFAULT_STORE_DIR), repository(args), pullRequest(args));
}

export async function runProjectionCommand(action: string, args: string[]): Promise<void> {
  const store = new SQLiteRelayStore(storePath(args));
  try {
    if (action === 'conflicts' || action === 'list') {
      const conflicts = await store.listProjectionConflicts();
      console.log(JSON.stringify(conflicts, null, 2));
      return;
    }
    if (action === 'resolve') {
      const id = integerArg(args, '--projection-id', 0);
      if (id <= 0) throw new Error('projection resolve requires --projection-id ID');
      const raw = arg(args, '--action', 'requeue');
      if (raw !== 'requeue' && raw !== 'discard-local' && raw !== 'discard_local') throw new Error('--action must be requeue or discard-local');
      const resolution = raw === 'requeue' ? 'requeue' : 'discard_local';
      const note = arg(args, '--note') || undefined;
      const resolved = await store.resolveProjectionConflict(id, { action: resolution, ...(note ? { note } : {}) });
      if (!resolved) throw new Error(`Projection ${id} is not in a resolvable conflict state`);
      console.log(`Resolved projection ${id} with ${resolution}`);
      return;
    }
    throw new Error(`projection ${action || '<action>'} is not supported; use conflicts or resolve`);
  } finally {
    store.close();
  }
}

export function projectionHelp(action?: string): string {
  if (action === 'resolve') {
    return `Explicitly repair one classified projection conflict.

Required: --projection-id ID --action requeue|discard-local, plus --store PATH or --repo OWNER/REPO --pr NUMBER.
Actions:
  requeue        Re-arm the recorded projection after the divergent side is reconciled
  discard-local  Drop the blocked local mutation so a fresh one can be enqueued

Never silently overwrites either side. The recorded diagnostic remains until resolution.`;
  }
  return `Inspect and explicitly repair deterministic V2 GitHub projection conflicts.

Usage:
  npx agents-relay projection conflicts --repo OWNER/REPO --pr NUMBER [--store PATH]
  npx agents-relay projection resolve --repo OWNER/REPO --pr NUMBER --projection-id ID --action requeue|discard-local

A deterministic same-id/different-definition append conflict is classified once, stops
consuming retry budget, and retains structured diagnostic evidence. It is never
auto-overwritten: an operator resolves it after reconciling the divergent definition.`;
}
