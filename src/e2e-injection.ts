/** Internal method-level E2E injection. No dynamic code or shell execution. */
import type { Execution } from './adapters.js';
import type { RelayStore } from './relay-store.js';

export type InjectionMethod = 'worker.codex.launch' | 'github.projectLocalMerge' | 'browserWorkspace.command';
export type InjectionConfig = {
  method: InjectionMethod;
  action: 'throw' | 'return' | 'pass';
  execution: 'skip' | 'after' | 'run';
  error?: { code: string; message: string; status?: number };
  mock?: 'worker_quota' | 'worker_model_not_found' | 'worker_provider_unavailable';
};
const legacy: Record<string, InjectionConfig> = {
  quota_exceeded: {method:'worker.codex.launch',action:'return',execution:'skip',mock:'worker_quota'},
  model_not_found: {method:'worker.codex.launch',action:'return',execution:'skip',mock:'worker_model_not_found'},
  provider_unavailable: {method:'worker.codex.launch',action:'return',execution:'skip',mock:'worker_provider_unavailable'},
  github_projection_failure: {method:'github.projectLocalMerge',action:'throw',execution:'skip',error:{code:'SERVICE_UNAVAILABLE',message:'E2E transient GitHub projection transport failure',status:503}},
};
export function parseTestInjection(value: unknown): InjectionConfig | undefined {
  if (typeof value === 'string') return legacy[value];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v=value as Record<string,unknown>;
  if (v.method!=='worker.codex.launch' && v.method!=='github.projectLocalMerge' && v.method!=='browserWorkspace.command') return undefined;
  if (v.action!=='throw' && v.action!=='return' && v.action!=='pass') return undefined;
  if (v.execution!=='skip' && v.execution!=='after' && v.execution!=='run') return undefined;
  const error=v.error;
  if (v.action==='throw' && (!error || typeof error!=='object' || typeof (error as any).message!=='string' || typeof (error as any).code!=='string')) return undefined;
  const mock=v.mock;
  if (v.action==='return' && (v.method!=='worker.codex.launch' || !['worker_quota','worker_model_not_found','worker_provider_unavailable'].includes(String(mock)))) return undefined;
  if (v.method==='worker.codex.launch' && v.action!=='pass' && (v.action!=='return' || v.execution!=='skip')) return undefined;
  if (v.action==='pass' && v.execution!=='run') return undefined;
  if (v.action!=='pass' && v.execution==='run') return undefined;
  return {method:v.method,action:v.action,execution:v.execution,error:error as InjectionConfig['error'],mock:mock as InjectionConfig['mock']};
}
export function authorizedInjection(repository:string, raw:unknown, env:NodeJS.ProcessEnv=process.env):InjectionConfig|undefined {
  return env.E2E_REPO && repository===env.E2E_REPO ? parseTestInjection(raw) : undefined;
}
function mockWorker(name:NonNullable<InjectionConfig['mock']>):Execution {
  const message=name==='worker_quota'?'rate_limit_exceeded: usage limit reached':name==='worker_model_not_found'?'model_not_found: model is unavailable':'provider_unavailable: provider refused the request';
  const promise=Promise.reject(new Error(message));promise.catch(()=>{});
  return {id:'e2e-injected',launched:Promise.resolve(),promise,cancel:()=>{},processExit:{exitCode:1,signal:null,stderr:message,terminationReason:null}};
}
/** Caller must supply a configuration already consumed durably before this invocation. */
export function withTestInjection<T>(method:InjectionMethod,config:InjectionConfig|undefined,execute:()=>Promise<T>|T):Promise<T>|T {
  if (!config || config.method!==method || config.action==='pass') return execute();
  const apply=(original?:T):T=>{
  if (config.action==='throw') {
    const error=Object.assign(new Error(config.error!.message),{code:config.error!.code,status:config.error!.status});
    throw error;
  }
  if (method==='worker.codex.launch' && config.mock) return mockWorker(config.mock) as T;
  return original as T;
  };
  return config.execution==='after'?Promise.resolve(execute()).then(apply):apply();
}
/** Shared atomic consumer, scoped solely by E2E_REPO and exact method. */
export async function consumeMethodInjection(relay:RelayStore, repository:string,jobId:string,method:InjectionMethod):Promise<InjectionConfig|undefined> {
  if (!process.env.E2E_REPO || process.env.E2E_REPO!==repository || !relay.mutateJob) return undefined;
  let config:InjectionConfig|undefined;
  await relay.mutateJob(jobId,job=>{
    if(job.repository!==repository)return job;
    const task=job.tasks.find(t=>authorizedInjection(job.repository,t.testInjection)?.method===method);
    if(!task)return job;
    config=authorizedInjection(job.repository,task.testInjection);
    delete task.testInjection;
    task.updatedAt=new Date(Math.max(Date.now(),Date.parse(task.updatedAt)+1)).toISOString();
    return job;
  });
  if(config && (await relay.loadJob(jobId))?.tasks.some(t=>authorizedInjection(repository,t.testInjection)?.method===method))
    throw Error(`E2E injection consumption not committed: ${jobId}`);
  return config;
}
