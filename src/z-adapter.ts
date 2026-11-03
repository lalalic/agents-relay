import { randomUUID } from 'node:crypto';
import { ChatGptAdapter, type ChatGptAgentRunner } from './adapters.js';
import { pooledWebHelmRun } from './browser-worker-runtime.js';
import { issueZWorkerCredential } from './z-oauth.js';

/** The worker must use the exact server-issued execution source, never invent one. */
export function zExecutionSource(prompt: string): string {
  const explicit = [...prompt.matchAll(/^Execution source: (job\/[^\s/]+\/task\/[^\s/]+\/execution\/[0-9a-f-]{36})$/gm)];
  if (explicit.length === 1) return explicit[0][1];
  if (explicit.length > 1) throw new Error('Z worker prompt contains multiple execution sources');
  const job=[...prompt.matchAll(/^Job: ([^\s]+)$/gm)];
  const task=[...prompt.matchAll(/^Task: ([^\s]+)$/gm)];
  const execution=[...prompt.matchAll(/^Execution: ([0-9a-f-]{36})$/gm)];
  if (job.length !== 1 || task.length !== 1 || execution.length !== 1)
    throw new Error('Z worker prompt requires exactly one Graph-issued execution source');
  return `job/${job[0][1]}/task/${task[0][1]}/execution/${execution[0][1]}`;
}

/** A compact executable prompt avoids Z.ai's silent long-message persistence failures. */
export function zTaskBrief(prompt: string): string {
  if (!prompt.startsWith('[Relay agent: worker; adapter: z]')) return prompt;
  const local = prompt.match(/Treat the following durable task input as the authoritative work contract; do not query GitHub\.\n\n([\s\S]*?)\n\n\[Authoritative execution context\]/)?.[1];
  if (!local) return prompt; // For GitHub and specialised roles keep their full source contract.
  const output = prompt.match(/\[Output contract\]\n([\s\S]*?)\n\[Required event contracts\]/)?.[1];
  if (!output) throw new Error('Z worker missing authoritative output contract');
  const objective = prompt.match(/^Job objective: (.+)$/m)?.[1];
  return '[LOCAL SQLite Job — no GitHub lookup]\nThe Task brief is complete and authoritative. Do not query GitHub issues or PRs for Relay state; use the version-matched Relay CLI. Read Neo bootstrap and the pinned contracts, retrieve Task context with Relay CLI, then execute the Task.\n[Durable Job objective]\n' + (objective ?? '(see task)') +
    '\n[Authoritative Task input]\n' + local +
    '\n[Output contract]\n' + output;
}

/** Insert only the short-lived credential into the Graph Action's single Bootstrap section. */
export function zBootstrap(accessToken: string, prompt: string): string {
  zExecutionSource(prompt); // Reject an unbound worker before sending credentials.
  if (!accessToken.trim() || /[\r\n]/.test(accessToken)) throw new Error('Invalid Z worker credential');
  const credential = `Neo OAuth access token: ${accessToken}`;
  const marker = '\n## Bootstrap\n';
  return prompt.startsWith('# Role\n') && prompt.includes(marker)
    ? prompt.replace(marker, `${marker}${credential}\n`)
    : `${credential}\n\n${prompt}`; // Legacy prompts lack a Bootstrap section.
}

function zRunner(): ChatGptAgentRunner {
  return (_definition, request, _route, signal, context) => pooledWebHelmRun({
    provider:'z',executionId:request.execution?.executionId ?? randomUUID(),
    timeoutMs:request.execution?.timeoutMs ?? 900_000,
    onActivity:context?.onObservedWorkerActivity,
    build: async()=>{
      const token=await issueZWorkerCredential();
      const actualFiles=(request.files??[]).filter(path=>!path.includes('/agents-relay/prompt-references/'));
      const attachments=actualFiles.length?'\n\nReference paths accessible through Neo MCP fs:\n'+actualFiles.join('\n'):'';
      return {action:'new-thread',config:{
        message:zBootstrap(token,zTaskBrief(request.prompt))+attachments,
        timeout_seconds:90,wait:false,
      }};
    },
    recover:async threadId=>{
      const token=await issueZWorkerCredential();
      const source=zExecutionSource(request.prompt);
      return {thread_id:threadId,wait:false,timeout_seconds:90,
        message:`[Relay terminal recovery — original execution ${source}]\nThe previous worker did not publish a terminal event. Verify Neo event history and the durable Task output using Neo MCP at https://neoy.qili2.com/mcp. Temporary access token: ${token}. Never print this token or store it in files. If output is verifiably complete, publish task.completed for this exact execution. Otherwise continue and publish real task.progress, or task.failed when impossible. Never invent success or start another execution.`};
    },
  },signal);
}

export class ZAdapter extends ChatGptAdapter {
  override readonly name = 'z' as const;
  override readonly id = 'z/webhelm';
  override readonly capabilities: readonly string[] = ['model', 'z', 'webhelm', 'coding', 'filesystem', 'neo-mcp'];
  constructor() { super({ agentRunner: zRunner(), tabClosePolicy: 'after-terminal' }); }
}
