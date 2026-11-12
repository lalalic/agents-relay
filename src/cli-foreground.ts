import type { DurableStore } from './store.js';
import type { EventRecord, Job } from './types.js';
import type { EventBus } from './events.js';
import type { Reconciler } from './reconciler.js';

/** Foreground is a CLI attachment to the ordinary durable Reconciler, not an execution mode. */
export type ForegroundReporter = ((message: string) => void) & { event?: (event: EventRecord) => void };

export function foregroundEventLine(event: EventRecord, tasks: ReadonlyMap<string,string> = new Map()): string {
  const stamp = event.timestamp.slice(11, 19);
  const actor = tasks.get(event.task_id) ?? event.task_id;
  return `${stamp}  ${actor}  ${event.type} ${event.message}`.trimEnd();
}

export async function runForegroundCoordinator(options: {
  store: DurableStore;
  reconciler: Reconciler;
  bus?: EventBus;
  jobId: string;
  taskId: string;
  reporter: ForegroundReporter;
  pollMs?: number;
  signal?: AbortSignal;
}): Promise<Job> {
  const {store,reconciler,bus,jobId,taskId,reporter} = options;
  const names = new Map<string,string>();
  const seen = new Set<string>();
  const emit = (event: EventRecord): void => {
    if(event.job_id!==jobId || seen.has(event.event_id))return;
    seen.add(event.event_id);
    // Bound memory if an agent publishes an unusually large number of progress events.
    if(seen.size>4096)seen.clear();
    reporter(foregroundEventLine(event,names));
  };
  reporter.event = emit;
  const stopWatch = await reconciler.watch(jobId);
  let stopOutput: () => Promise<void> = async()=>{};
  try { if(bus)stopOutput = await bus.subscribe(jobId,async event=>emit(event)); }
  catch(error){await stopWatch();await reconciler.close();throw error;}
  const controller = new AbortController();
  const onInterrupt = (): void => {process.exitCode=130;controller.abort();};
  const onTerminate = (): void => {process.exitCode=143;controller.abort();};
  process.on('SIGINT',onInterrupt);
  process.on('SIGTERM',onTerminate);
  const refreshNames = (job: Job): void => { for(const task of job.tasks)names.set(task.id,task.agentName??task.title??task.id); };
  const delay = options.pollMs ?? 1000;
  let pausedReported = false;
  reporter(`Coordinator job ${jobId}, task ${taskId}: foreground execution (Ctrl+C stops local execution; durable Job stays recoverable)`);
  try {
    while(true){
      if(options.signal?.aborted || controller.signal.aborted){
        reporter(`Leaving foreground for Job ${jobId}; in-flight local workers are interrupted and Relay recovers their durable Tasks.`);
        return store.load(jobId);
      }
      const job=await store.load(jobId);
      refreshNames(job);
      if(job.state==='COMPLETED'||job.state==='CANCELLED'){
        reporter(`Job ${jobId}: ${job.state}`);
        if(job.state==='CANCELLED')process.exitCode=1;
        return job;
      }
      if(job.pause && !pausedReported){reporter(`Job ${jobId}: PAUSED (waiting for resume)`);pausedReported=true;}
      if(!job.pause)pausedReported=false;
      await reconciler.reconcile(jobId);
      const updated=await store.load(jobId);
      refreshNames(updated);
      if(updated.state==='COMPLETED'||updated.state==='CANCELLED')continue;
      await new Promise<void>(resolve=>{
        const timer=setTimeout(done,delay);
        function done():void{clearTimeout(timer);controller.signal.removeEventListener('abort',done);options.signal?.removeEventListener('abort',done);resolve();}
        controller.signal.addEventListener('abort',done,{once:true});
        options.signal?.addEventListener('abort',done,{once:true});
      });
    }
  }finally{
    process.off('SIGINT',onInterrupt);
    process.off('SIGTERM',onTerminate);
    await stopOutput();
    await stopWatch();
    await reconciler.close();
    reporter.event=undefined;
  }
}
