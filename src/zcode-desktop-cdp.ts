import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Drives the existing ZCode.app Electron renderer; never starts a second Agent runtime. */
export type ZCodeSubmission = {
  sessionId: string;
  mode: 'new-thread' | 'new-turn';
  delivery: 'started' | 'queued';
  queueItemId?: string;
  verifiedBy: string;
};
export interface ZCodeDesktopTransport {
  submit(prompt: string, options: { sessionId?: string; cwd?: string; model?: string; signal?: AbortSignal }): Promise<ZCodeSubmission>;
  stop?(sessionId: string, queueItemId?: string): Promise<void>;
}
type CDPResponse = { id?: number; result?: Record<string, unknown>; error?: { message: string } };
export type ZCodeSnapshot = {
  sessionId: string | null;
  draft: string;
  model: string;
  queue: { id: string; text: string }[];
  busy: boolean;
  hasEditor: boolean;
  hasSend: boolean;
  tasks: string[];
  text: string;
};
const LOCK = join(homedir(), '.agents-relay', 'zcode-desktop-ui.lock');
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('ZCode desktop operation aborted');
}

/** Cross-process UI mutex; never let two Relay executions type into one composer. */
export async function withZCodeUILease<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  await mkdir(join(homedir(), '.agents-relay'), { recursive: true, mode: 0o700 });
  const identity = String(process.pid) + ':' + randomUUID();
  const deadline = Date.now() + 20000;
  while (true) {
    checkAbort(signal);
    try {
      await mkdir(LOCK, { mode: 0o700 });
      await writeFile(join(LOCK, 'owner'), JSON.stringify({ identity, pid: process.pid }), { mode: 0o600 });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const data = await readFile(join(LOCK, 'owner'), 'utf8').then(x => JSON.parse(x) as {pid:number}).catch(() => null);
      const age = await stat(LOCK).then(s => Date.now()-s.mtimeMs).catch(() => 0);
      let alive = true;
      if (data?.pid) try { process.kill(data.pid, 0); } catch { alive = false; }
      if (age > 3000 && ((!data && age > 20000) || (data && !alive))) {
        await rm(LOCK, { recursive: true, force: true }); continue;
      }
      if (Date.now() > deadline) throw new Error('ZCode UI lease busy: submission not attempted');
      await sleep(150);
    }
  }
  try { return await run(); }
  finally {
    const holder = await readFile(join(LOCK, 'owner'), 'utf8').then(x => JSON.parse(x) as {identity:string}).catch(() => null);
    if (holder?.identity === identity) await rm(LOCK, { recursive: true, force: true });
  }
}

/** Deliberately accepts only the local signed-app renderer, not an arbitrary browser page. */
export class ZCodeDesktopCDP {
  private socket!: WebSocket;
  private id = 0;
  private pending = new Map<number, { done: (value: CDPResponse) => void; fail: (error: Error) => void; timer: NodeJS.Timeout }>();
  static async connect(signal?: AbortSignal): Promise<ZCodeDesktopCDP> {
    checkAbort(signal);
    if (typeof WebSocket === 'undefined') throw new Error('ZCode Desktop requires Node 22+ WebSocket');
    const port = Number(process.env.AGENTS_RELAY_ZCODE_CDP_PORT ?? '9237');
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid ZCode CDP port');
    let response: Response;
    try { response = await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(4000) }); }
    catch { throw new Error('Start ZCode.app with --remote-debugging-port=' + port + ' (localhost only)'); }
    if (!response.ok) throw new Error('ZCode CDP returned ' + response.status);
    const targets = await response.json() as {type?:string;title?:string;url?:string;webSocketDebuggerUrl?:string}[];
    const pages = targets.filter(t => t.type === 'page' && t.title === 'ZCode' &&
      /\/ZCode\.app\/Contents\/Resources\/app\.asar\/out\/renderer\//.test(t.url ?? ''));
    if (pages.length !== 1) throw new Error('Expected exactly one ZCode Desktop renderer; got ' + pages.length);
    const uri = pages[0].webSocketDebuggerUrl;
    if (!uri || !/^ws:\/\/(127\.0\.0\.1|localhost):\d+\/devtools\/page\//.test(uri)) throw new Error('Unsafe ZCode CDP endpoint');
    const c = new ZCodeDesktopCDP();
    c.socket = new WebSocket(uri);
    await Promise.race([
      new Promise<void>((ok, fail) => {
        c.socket.addEventListener('open', () => ok(), {once:true});
        c.socket.addEventListener('error', () => fail(new Error('ZCode CDP connection failed')), {once:true});
      }),
      sleep(4000).then(() => { throw new Error('ZCode CDP connection timed out'); }),
    ]).catch(err => { c.socket.close(); throw err; });
    c.socket.addEventListener('message', event => {
      let message: CDPResponse;
      try { message = JSON.parse(String(event.data)) as CDPResponse; } catch { return; }
      if (message.id === undefined) return;
      const p = c.pending.get(message.id);
      if (!p) return;
      c.pending.delete(message.id); clearTimeout(p.timer); p.done(message);
    });
    c.socket.addEventListener('close', () => {
      for (const [id, p] of c.pending) { clearTimeout(p.timer); p.fail(new Error('ZCode CDP closed')); c.pending.delete(id); }
    });
    return c;
  }
  close(): void { this.socket.close(); }
  async call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error('ZCode CDP disconnected');
    const id = ++this.id;
    const reply = await new Promise<CDPResponse>((done, fail) => {
      const timer = setTimeout(() => { this.pending.delete(id); fail(new Error('ZCode CDP call timed out: ' + method)); }, 8000);
      this.pending.set(id, {done, fail, timer});
      this.socket.send(JSON.stringify({id, method, params}));
    });
    if (reply.error) throw new Error('ZCode CDP ' + method + ': ' + reply.error.message);
    return reply.result ?? {};
  }
  async evaluate<T>(expression: string): Promise<T> {
    const r = await this.call('Runtime.evaluate', {expression, awaitPromise:true, returnByValue:true, userGesture:true});
    if (r.exceptionDetails) throw new Error('ZCode renderer evaluation failed');
    return (r.result as {value?:T}|undefined)?.value as T;
  }
  async click(selector: string): Promise<void> {
    const expression = '(()=>{const e=document.querySelector(' + JSON.stringify(selector) +
      ');if(!e||e.hasAttribute("disabled")||e.getAttribute("aria-disabled")==="true")return null;const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.left+r.width/2,y:r.top+r.height/2}:null})()';
    const point = await this.evaluate<{x:number;y:number}|null>(expression);
    if (!point || point.x < 0 || point.y < 0) throw new Error('ZCode UI element not available: ' + selector);
    await this.call('Input.dispatchMouseEvent', {type:'mouseMoved',x:point.x,y:point.y});
    await this.call('Input.dispatchMouseEvent', {type:'mousePressed',x:point.x,y:point.y,button:'left',clickCount:1});
    await this.call('Input.dispatchMouseEvent', {type:'mouseReleased',x:point.x,y:point.y,button:'left',clickCount:1});
  }
  async type(text: string): Promise<void> {
    await this.click('[data-testid="v4-composer-input"]');
    for(let i=0;i<text.length;i+=4096) await this.call('Input.insertText', {text:text.slice(i,i+4096)});
  }
  snapshot(): Promise<ZCodeSnapshot> {
    return this.evaluate<ZCodeSnapshot>([
      '(()=>{const p=document.querySelector("[data-session-id]");',
      'const e=document.querySelector("[data-testid=v4-composer-input]");',
      'return {sessionId:p?.getAttribute("data-session-id")??null,draft:e?.innerText??"",',
      'busy:!!document.querySelector("[data-testid=v4-stop]"),',
      'hasEditor:!!e,hasSend:!!document.querySelector("[data-testid=v4-composer-send]"),',
      'model:document.querySelector("[data-testid=chat-model-select-trigger]")?.innerText??"",',
      'queue:[...document.querySelectorAll("[data-queue-item-id][data-dispatch-state]")].map(x=>({id:x.getAttribute("data-queue-item-id")||"",text:x.innerText||""})),',
      'tasks:[...document.querySelectorAll("[data-testid^=task-item-sess_]")].map(x=>(x.getAttribute("data-testid")||"").replace("task-item-","")),',
      'text:(p?.innerText??"").slice(-15000)};',
      '})()',
    ].join(''));
  }
  async until(accept: (value: ZCodeSnapshot) => boolean, timeout=8000, signal?:AbortSignal):Promise<ZCodeSnapshot> {
    const end = Date.now()+timeout;
    do { checkAbort(signal); const view = await this.snapshot(); if(accept(view)) return view; await sleep(140); } while(Date.now()<end);
    throw new Error('ZCode UI confirmation timed out');
  }
}

/** All queue admission is performed by the app's existing V4 runtime, not Relay. */
export class ZCodeDesktopCDPTransport implements ZCodeDesktopTransport {
  async submit(input: string, options: {sessionId?:string;cwd?:string;model?:string;signal?:AbortSignal}): Promise<ZCodeSubmission> {
    if (!input.trim() || input.length > 180000) throw new Error('Invalid ZCode prompt length');
    return withZCodeUILease(async () => {
      const c = await ZCodeDesktopCDP.connect(options.signal);
      try {
        const first = await c.snapshot();
        if (!first.hasEditor || !first.hasSend) throw new Error('ZCode Desktop composer unavailable');
        if(options.sessionId) {
          if(first.sessionId !== options.sessionId) {
            await c.click('[data-testid=' + JSON.stringify('task-item-'+options.sessionId) + ']');
            await c.until(v=>v.sessionId===options.sessionId, 5000, options.signal);
          }
        } else {
          await c.click('[data-testid=task-new-button]');
          await c.until(v=>v.sessionId==='draft', 5000, options.signal);
        }
        const before = await c.snapshot();
        if(before.draft.trim()) throw new Error('Refusing to overwrite a ZCode user draft');
        if (options.model) {
          const m = options.model.toLowerCase().replace(/\[1m\]$/, '');
          const target = m.includes('glm-5.3-flash') ? 'GLM-5.3-Flash'
            : m.includes('glm-5.3') ? 'GLM-5.3' : null;
          if (!target) throw new Error('ZCode Desktop cannot verify requested model ' + options.model);
          if (!before.model.toLowerCase().includes(target.toLowerCase()) ||
              (target==='GLM-5.3' && before.model.includes('Flash'))) {
            await c.click('[data-testid=chat-model-select-trigger]');
            await c.click('[data-testid='+JSON.stringify('chat-model-select-item-custom:account%3Azai-individual-coding-plan:'+target)+']');
            await c.until(v => v.model.toLowerCase().includes(target.toLowerCase()), 4000, options.signal);
          }
        }
        const prompt = options.cwd
          ? 'Relay working directory (absolute): ' + options.cwd + '\nAll repository operations must use this directory. Do not write outside it.\n\n' + input
          : input;
        await c.type(prompt);
        // Lexical commits its editor state asynchronously after native CDP text input.
        // A synchronous snapshot can incorrectly report an empty draft.
        const prefix = prompt.slice(0, Math.min(60, prompt.length));
        await c.until(v => v.draft.includes(prefix), 2000, options.signal)
          .catch(() => { throw new Error('Text entry not verified, no send attempted'); });
        checkAbort(options.signal);
        await c.click('[data-testid=v4-composer-send]');
        // This boundary is UNCERTAIN after clicking Send. Never automatically resubmit.
        const after = await c.until(v=>v.draft.trim()==='' && !!v.sessionId && v.sessionId!=='draft', 10000, options.signal)
          .catch(()=>{throw new Error('ZCode submission uncertain: inspect the original session before retrying');});
        if(options.sessionId && after.sessionId !== options.sessionId) throw new Error('ZCode submission went to an unexpected session');
        const queued = after.queue.find(q=>q.text.includes(prompt.slice(0,Math.min(60,prompt.length))));
        if (!queued && !after.text.includes(prefix)) {
          throw new Error('ZCode submission uncertain: input not in conversation or queue');
        }
        return {
          sessionId:after.sessionId!,mode:options.sessionId?'new-turn':'new-thread',
          delivery:queued?'queued':'started',
          ...(queued?{queueItemId:queued.id}:{}),
          verifiedBy:queued?'v4-queue-projection':'composer-cleared-session-bound',
        };
      } finally { c.close(); }
    }, options.signal);
  }
  async stop(sessionId:string,queueItemId?:string):Promise<void> {
    return withZCodeUILease(async()=>{
      const c=await ZCodeDesktopCDP.connect();
      try {
        if((await c.snapshot()).sessionId!==sessionId){
          await c.click('[data-testid='+JSON.stringify('task-item-'+sessionId)+']');
          await c.until(v=>v.sessionId===sessionId,5000);
        }
        if(queueItemId){
          const q=(await c.snapshot()).queue.find(x=>x.id===queueItemId);
          if(!q)return;
          await c.click('[data-testid='+JSON.stringify('v4-queue-item-delete-'+queueItemId)+']');
        }else{
          await c.click('[data-testid=v4-stop]');
        }
      }finally{c.close();}
    });
  }
}
