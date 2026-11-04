import { randomUUID } from 'node:crypto';
import type { Continuation, Result, Task } from './types.js';
import type { Execution, LaunchContext, WorkerAdapter } from './adapters.js';
import { ZCodeDesktopCDPTransport, type ZCodeDesktopTransport, type ZCodeSubmission } from './zcode-desktop-cdp.js';

/** Preserve the persisted adapter name 'z' while replacing its WebHelm implementation. */
export class ZAdapter implements WorkerAdapter {
  readonly name = 'z' as const;
  readonly id = 'zcode/desktop';
  readonly capabilities: readonly string[] = ['model','z','zcode','desktop','coding','filesystem','neo-mcp'];
  constructor(private readonly transport: ZCodeDesktopTransport = new ZCodeDesktopCDPTransport()) {}

  launch(task: Task, signal: AbortSignal, context: LaunchContext = {}): Execution {
    if (!task.routing) throw new Error('Task ' + task.id + ' requires routing metadata before ZCode launch');
    const controller = new AbortController();
    const abort = ():void => controller.abort();
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, {once:true});
    let receipt: ZCodeSubmission | undefined;
    let launchedResolve!: () => void;
    let launchedReject!: (error: Error) => void;
    const launched = new Promise<void>((resolve,reject)=>{ launchedResolve=resolve; launchedReject=reject; });
    launched.catch(()=>{});
    const execution: Execution = {
      id: randomUUID(),
      promise: Promise.resolve({summary:''}),
      launched,
      cancel: () => {
        abort();
        // Do not stop someone else's foreground turn. Only a confirmed queued item
        // is safe to withdraw without inspecting the authoritative active work.
        if (receipt?.queueItemId) void this.transport.stop?.(receipt.sessionId, receipt.queueItemId).catch(()=>{});
      },
    };
    execution.promise = (async():Promise<Result>=>{
      try {
        // A previously submitted execution cannot be blindly replayed after a crash.
        // Relay must reconcile the original V4 session or send a deliberate continuation.
        if (task.threadId && task.attempt > 0 && !task.chatgptThreadDelivery)
          throw new Error('ZCode existing session is not replay-safe; use a correlated zcode-thread continuation');
        const persistedSession = task.threadId && /^sess_[a-z0-9-]+$/.test(task.threadId) ? task.threadId : undefined;
        const explicitSession = task.chatgptThreadDelivery?.threadId ?? persistedSession;
        const prompt = task.input.startsWith('# Role') ? zDesktopPrompt(task.input) : task.input;
        if (!prompt.trim()) throw new Error('Empty ZCode worker prompt');
        const submission = await this.transport.submit(prompt, {
          ...(explicitSession ? {sessionId:explicitSession}:{}),
          ...(task.routing?.cwd ? {cwd:task.routing.cwd}:{}),
          ...(task.routing?.model ? {model:task.routing.model}:{}),
          signal:controller.signal,
        });
        if (explicitSession && submission.sessionId !== explicitSession)
          throw new Error('ZCode session mismatch after send; delivery uncertain');
        receipt = submission;
        execution.threadId = submission.sessionId;
        execution.deliveryReceipt = {
          status:'submitted',
          runtime:'zcode/desktop',
          mode:submission.mode,
          thread_id:submission.sessionId,
          delivery:submission.delivery,
          verified_by:submission.verifiedBy,
          ...(submission.queueItemId ? {queue_item_id:submission.queueItemId}:{}),
        };
        execution.onThreadStarted?.(submission.sessionId);
        launchedResolve();
        if (context.waitForTerminal) await context.waitForTerminal;
        return {
          summary: 'ZCode Desktop ' + submission.delivery + ' input; Relay event owns terminal task state',
          data:{submitted:true,mode:submission.mode,threadId:submission.sessionId,
            delivery:submission.delivery,queueItemId:submission.queueItemId??null,verifiedBy:submission.verifiedBy},
        };
      } catch(error) {
        const err=error instanceof Error?error:new Error(String(error));
        launchedReject(err);
        throw err;
      } finally {
        signal.removeEventListener('abort',abort);
      }
    })();
    execution.promise.catch(()=>{});
    return execution;
  }
}

export class ZCodeThreadContinuation {
  readonly kind = 'zcode-thread' as const;
  constructor(private readonly transport: ZCodeDesktopTransport = new ZCodeDesktopCDPTransport()) {}
  async continue(input:string, continuation:Continuation):Promise<void> {
    if (continuation.kind!==this.kind) throw new Error('Continuation must be a ZCode thread');
    if (!/^sess_[a-z0-9-]+$/.test(continuation.target)) throw new Error('Invalid ZCode session id');
    const receipt = await this.transport.submit(input,{sessionId:continuation.target});
    if (receipt.sessionId!==continuation.target) throw new Error('ZCode continuation session mismatch');
    // sendText may queue behind a running turn. This receipt is admission, not execution success.
  }
}


/** Immutable graph identity is retained when switching away from browser Z. */
export function zExecutionSource(prompt: string): string {
  const explicit = [...prompt.matchAll(/^Execution source: (job\/[^\s/]+\/task\/[^\s/]+\/execution\/[0-9a-f-]{36})$/gm)];
  if (explicit.length === 1) return explicit[0][1];
  if (explicit.length > 1) throw new Error('ZCode prompt has multiple execution sources');
  const job = [...prompt.matchAll(/^Job: ([^\s]+)$/gm)];
  const task = [...prompt.matchAll(/^Task: ([^\s]+)$/gm)];
  const execution = [...prompt.matchAll(/^Execution: ([0-9a-f-]{36})$/gm)];
  if (job.length!==1 || task.length!==1 || execution.length!==1)
    throw new Error('ZCode worker prompt requires exactly one Graph-issued execution source');
  return 'job/'+job[0][1]+'/task/'+task[0][1]+'/execution/'+execution[0][1];
}
export function zTaskBrief(prompt: string):string { return prompt; }
export function zDesktopPrompt(prompt: string):string {
  zExecutionSource(prompt);
  return prompt;
}
