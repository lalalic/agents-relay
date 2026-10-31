import type { WorkerAdapter } from './adapters.js';
import type { AgentRegistration, Task } from './types.js';
import type { AccountUsageOverview } from './usage.js';
import { workerCandidates, eligibleWorkerCandidates } from './worker-routing.js';
import { browserWorkerPool } from './browser-worker-runtime.js';

/** Admission evidence for a graph-authorized pre-submission reroute. */
export function hasSafeAlternativeWorker(
  task:Task | undefined, adapters:readonly WorkerAdapter[], agents:readonly AgentRegistration[], usage?:AccountUsageOverview,
):boolean {
  if(!task || task.adapter==='orchestrator' || task.chatgptThreadDelivery || task.workerRequirements?.runtime===task.adapter)return false;
  return eligibleWorkerCandidates(workerCandidates(adapters,agents,usage), task.workerRequirements??{capabilities:[]}, {strictCapabilities:true})
    .some(candidate=>candidate.adapter!==task.adapter &&
      (candidate.adapter!=='chatgpt'&&candidate.adapter!=='z' || browserWorkerPool().snapshot(candidate.adapter).health==='HEALTHY'));
}
