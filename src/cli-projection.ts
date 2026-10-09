import { arg, integerArg, relayControlCommand } from './cli-support.js';

export async function runProjectionCommand(action: string, args: string[]): Promise<void> {
  const jobId = arg(args, '--id');
  if (!jobId) throw new Error('projection commands require --id JOB_ID');
  if (action === 'conflicts' || action === 'list') { console.log(JSON.stringify(await relayControlCommand(args, { command: 'projection.conflicts', jobId }), null, 2)); return; }
  if (action === 'resolve') {
    const id = integerArg(args, '--projection-id', 0); if (id <= 0) throw new Error('projection resolve requires --projection-id ID');
    const raw = arg(args, '--action', 'requeue'); if (!['requeue','discard-local','discard_local'].includes(raw)) throw new Error('--action must be requeue or discard-local');
    const resolution = raw === 'requeue' ? 'requeue' : 'discard_local';
    const note = arg(args, '--note') || undefined;
    const result = await relayControlCommand(args, { command: 'projection.resolve', jobId, projectionId: id, action: resolution, ...(note ? { note } : {}) });
    console.log(JSON.stringify(result, null, 2)); return;
  }
  throw new Error(`projection ${action || '<action>'} is not supported; use conflicts or resolve`);
}

export function projectionHelp(action?: string): string {
  if (action === 'resolve') return `Explicitly repair one classified projection conflict.\n\nRequired: --repo OWNER/REPO --id JOB_ID --projection-id ID --action requeue|discard-local.`;
  return `Inspect and explicitly repair deterministic V2 GitHub projection conflicts.\n\nUsage:\n  npx agents-relay projection conflicts --repo OWNER/REPO --id JOB_ID\n  npx agents-relay projection resolve --repo OWNER/REPO --id JOB_ID --projection-id ID --action requeue|discard-local`;
}
