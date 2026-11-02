import test from './test-runtime.js';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pooledWebHelmRun} from '../dist/browser-worker-runtime.js';
import {ChatGptAdapter} from '../dist/adapters.js';
import {BrowserWorkerPoolManager} from '../dist/browser-worker-pool.js';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function fakeWebHelm(mode,run){
  const root=await mkdtemp(join(tmpdir(),'relay-pooled-driver-'));
  const cli=join(root,'fake-webhelm'); const log=join(root,'actions.jsonl');
  await writeFile(cli,[
    '#!/usr/bin/env node',
    "const fs=require('node:fs'),a=process.argv.slice(2);",
    "fs.appendFileSync(process.env.POOL_TEST_LOG,JSON.stringify({a})+'\\n');",
    "if(a[0]==='platform'&&a[1]==='profile'){if(process.env.POOL_TEST_MODE==='profile-outage')process.exit(23);console.log(JSON.stringify({platform:a[2]}));}",
    "else if(a[0]==='ensure')console.log(JSON.stringify({ok:true}));",
    "else process.exit(22);",
  ].join('\n'),{mode:0o700});
  const socketPath=join(root,'webhelm.sock');
  let sessionSeq=0;
  const activeSessions=new Set(),stopAttempts=new Map();
  const server=createServer(conn=>{
    let input='';
    conn.setEncoding('utf8');
    conn.on('data',chunk=>{
      input+=chunk;
      if(!input.includes('\n'))return;
      const request=JSON.parse(input.split('\n')[0]);
      const op=request.op;
      const mode=process.env.POOL_TEST_MODE;
      const a=op==='platform-run' ? ['platform','run',request.platform,request.action] : op==='workspace-create' ? ['workspace','create'] : ['session',op];
      const stdin=request.code||'';
      const cfg=request.config||null;
      const event={a,cfg,stdin,request};
      const add=()=>import('node:fs').then(({appendFileSync})=>appendFileSync(process.env.POOL_TEST_LOG,JSON.stringify(event)+'\n'));
      void add().then(async()=>{
        let result={ok:true};
        if(op==='workspace-create') {
          result={name:request.name,initialized:true,poolSize:request.pool_size};
        }else if(op==='start'){const id='owned-pool-'+(++sessionSeq);activeSessions.add(id);result={session_id:id,workspace:'Neo',workspace_supported:true};}
        else if(op==='heartbeat')result={session_id:request.session_id,alive:true,last_used_at:Date.now()};
        else if(op==='list')result={sessions:[...activeSessions].map(session_id=>({session_id,workspace:'Neo'}))};
        else if(op==='exec'&&stdin.includes('const url=')){
          if(mode==='slow-observe')await new Promise(resolve=>setTimeout(resolve,250));
          const counter=process.env.POOL_TEST_LOG+'.count';
          const fs=requireFakeFs;
          let count=0;try{count=Number(fs.readFileSync(counter,'utf8'))}catch{}
          fs.writeFileSync(counter,String(++count));
          result={ok:true,stdout:JSON.stringify({url:'https://chat.z.ai/c/thread-live',state:{text:mode==='idle'?'':mode==='spinner'?'unchanged output':count>1?'new assistant output':'',generating:mode==='spinner',streamLength:0}})};
        }else if(op==='platform-run'){
          if(mode==='uncertain'||((mode==='recovery-uncertain'||mode==='recovery-uncertain-completed')&&request.action==='new-turn')) {
            conn.end(JSON.stringify({error:'exited 19'})+'\n');return;
          }
          result={result:{ok:true,stdout:JSON.stringify({status:mode.includes('completed')&&request.action==='new-thread'?'completed':'submitted',mode:request.action,thread_id:'thread-live',thread_url:request.platform==='chatgpt'?'https://chatgpt.com/c/thread-live':'https://chat.z.ai/c/thread-live',verified_by:'matching-user-turn'})}};
         }else if(op==='stop'){
          const tries=(stopAttempts.get(request.session_id)||0)+1;
          stopAttempts.set(request.session_id,tries);
          if(mode==='stop-fail'||(mode==='stop-transient'&&tries===1))result={error:'transient stop failure'};
          else{activeSessions.delete(request.session_id);result={returned_to_idle:true};}
        }
        conn.end(JSON.stringify(result)+'\n');
      });
    });
  });
  const requireFakeFs=await import('node:fs');
  await new Promise((resolve,reject)=>server.listen(socketPath,resolve).once('error',reject));
  const previous={cmd:process.env.AGENTS_RELAY_WEBHELM_COMMAND,log:process.env.POOL_TEST_LOG,mode:process.env.POOL_TEST_MODE,socket:process.env.WEBHELM_SOCKET};
  process.env.AGENTS_RELAY_WEBHELM_COMMAND=cli;process.env.POOL_TEST_LOG=log;process.env.POOL_TEST_MODE=mode;process.env.WEBHELM_SOCKET=socketPath;
  const pool=new BrowserWorkerPoolManager({path:join(root,'pool.sqlite'),queueWaitMs:1000,pollMs:5});
  try {await run(log,pool);}finally{
    pool.close();
    await new Promise(resolve=>server.close(resolve));
    for(const [name,key] of [['AGENTS_RELAY_WEBHELM_COMMAND','cmd'],['POOL_TEST_LOG','log'],['POOL_TEST_MODE','mode'],['WEBHELM_SOCKET','socket']]){
      if(previous[key]===undefined)delete process.env[name];else process.env[name]=previous[key];
    }
    await rm(root,{recursive:true,force:true});
  }
}

test('a live pooled Z worker keeps its slot, observes real output, and releases only on terminal',async()=>{
  await fakeWebHelm('normal',async(log,pool)=>{
    const activities=[];
    const run=pooledWebHelmRun({pool,provider:'z',executionId:'runtime-progress',timeoutMs:80000,
      monitorIntervalMs:20,heartbeatIntervalMs:15,recoveryMinMs:100000,
      onActivity:message=>activities.push(message),
      build:async()=>({action:'new-thread',config:{message:'inert runtime test',wait:false}})},new AbortController().signal);
    const response=JSON.parse(await run.submitted);
    assert.equal(response.status,'submitted');
    assert.equal(pool.snapshot('z').leased,1);
    await wait(1300);
    assert.ok(activities.some(message=>message.includes('new assistant output')),JSON.stringify(activities));
    assert.equal(pool.snapshot('z').leased,1);
    const before=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(before.filter(row=>row.a[1]==='stop').length,0);
    assert.ok(before.some(row=>row.a[1]==='heartbeat'),'A leased Session must remain live even without model activity');
    await run.release();
    assert.equal(pool.snapshot('z').leased,0);
    const after=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(after.filter(row=>row.a[1]==='stop').length,1);
  });
});

test('release waits for an already running browser probe before closing its session',async()=>{
  await fakeWebHelm('slow-observe',async(log,pool)=>{
    const run=pooledWebHelmRun({pool,provider:'z',executionId:'drain-probe',
      timeoutMs:90000,monitorIntervalMs:10,heartbeatIntervalMs:20000,
      build:async()=>({action:'new-thread',config:{message:'probe drain',wait:false}})},
    new AbortController().signal);
    await run.submitted;
    let probing=false;
    for(let i=0;i<150;i++){
      const lines=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
      if(lines.some(row=>row.a[0]==='session'&&row.a[1]==='exec'&&row.stdin.includes('const url='))){probing=true;break;}
      await wait(10);
    }
    assert.equal(probing,true,'Must exercise release while a probe is running');
    await run.release();
    assert.equal(pool.snapshot('z').leased,0);
    const logAtRelease=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
    const countAtRelease=Number(await readFile(log+'.count','utf8'));
    await wait(80);
    const after=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(after,logAtRelease,'No worker subprocess may write after release');
    assert.equal(Number(await readFile(log+'.count','utf8')),countAtRelease);
    assert.equal(after.filter(row=>row.a[1]==='stop').length,1);
  });
});

test('Z WebHelm pool receipt passes through shared adapter and releases after terminal', async () => {
  await fakeWebHelm('normal', async (log,pool) => {
    class ZReceiptAdapter extends ChatGptAdapter { name = 'z'; }
    let completeTerminal;
    const terminal = new Promise(resolve => { completeTerminal=resolve; });
    const adapter = new ZReceiptAdapter({tabClosePolicy:'after-terminal',agentRunner:(_agent,request,_route,signal)=>
      pooledWebHelmRun({pool,provider:'z',executionId:'integrated-z-receipt',timeoutMs:90000,
        build:async()=>({action:'new-thread',config:{message:request.prompt,wait:false}})},signal),
    });
    const task = {id:'integrated-z-receipt',input:'inert Z receipt test',routing:{provider:'z',model:'GLM-5.3-Flash'}};
    const execution = adapter.launch(task,new AbortController().signal,{waitForTerminal:terminal});
    await execution.launched;
    assert.equal(pool.snapshot('z').leased,1,'keep lease after verified submission');
    completeTerminal();
    const result=await execution.promise;
    assert.equal(result.data.threadId,'thread-live');
    assert.equal(result.data.submitted,true);
    assert.match(result.summary,/Z.ai task submitted/);
    for(let i=0;i<30&&pool.snapshot('z').leased!==0;i++)await wait(50);
    assert.equal(pool.snapshot('z').leased,0,'release only after terminal barrier');
    const calls=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(calls.filter(row=>row.a.slice(0,4).join(' ')==='platform run z new-thread').length,1);
    assert.equal(calls.filter(row=>row.a[1]==='stop').length,1);
  });
});

test('ambiguous Z submission is quarantined; no automatic resend or slot reuse',async()=>{
  await fakeWebHelm('uncertain',async(log,pool)=>{
    const run=pooledWebHelmRun({pool,provider:'z',executionId:'runtime-ambiguous',timeoutMs:900000,
      build:async()=>({action:'new-thread',config:{message:'test unknown',wait:false}})},new AbortController().signal);
    await assert.rejects(run.submitted,/exited 19/);
    run.cancel();
    assert.equal(pool.snapshot('z').quarantined,1);
    const calls=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(calls.filter(row=>row.a[1]==='run').length,1);
    assert.equal(calls.filter(row=>row.a[1]==='stop').length,0);
  });
});

test('cancelled uncertain lease quarantines but stops its heartbeat and monitoring',async()=>{
  await fakeWebHelm('idle',async(log,pool)=>{
    const run=pooledWebHelmRun({pool,provider:'z',executionId:'cancelled-active-lease',
      timeoutMs:900000,heartbeatIntervalMs:1000,monitorIntervalMs:60,
      build:async()=>({action:'new-thread',config:{message:'inert cancellation'}}),
    },new AbortController().signal);
    await run.submitted;
    run.cancel();
    await wait(160);
    const before=(await readFile(log,'utf8')).trim().split('\n').length;
    await wait(1200);
    const after=(await readFile(log,'utf8')).trim().split('\n').length;
    assert.equal(after,before,'No heartbeat or output probe after cancel');
    assert.equal(pool.snapshot('z').quarantined,1);
    assert.equal(pool.snapshot('z').leased,0);
  });
});

test('idle thread requests at most two same-thread terminal recovery turns, never marks browser heartbeat as model progress',async()=>{
  await fakeWebHelm('idle',async(log,pool)=>{
    const activities=[];const recoveries=[];
    const run=pooledWebHelmRun({pool,provider:'z',executionId:'runtime-idle-recovery',timeoutMs:100,
      monitorIntervalMs:20,recoveryMinMs:40,heartbeatIntervalMs:15,
      onActivity:message=>activities.push(message),
      onRecovery:(thread,verifiedBy)=>recoveries.push({thread,verifiedBy}),
      build:async()=>({action:'new-thread',config:{message:'start',wait:false}}),
      recover:async id=>({thread_id:id,message:'Check terminal event',wait:false}),
    },new AbortController().signal);
    await run.submitted;await wait(800);
    const entries=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
    const turns=entries.filter(row=>row.a.slice(0,4).join(' ')==='platform run z new-turn');
    assert.equal(turns.length,2,'auto recovery is bounded');
    assert.ok(turns.every(row=>row.cfg.thread_id==='thread-live'));
    assert.ok(activities.every(s=>s.includes('recovery')));
    assert.equal(activities.length,0,'recovery submission must not extend inactivity timeout');
    assert.equal(recoveries.length,2);
    assert.ok(recoveries.every(x=>x.thread==='thread-live'&&x.verifiedBy));
    await run.release();
  });
});

test('uncertain recovery turn is never automatically resent',async()=>{
  await fakeWebHelm('recovery-uncertain',async(log,pool)=>{
    const run=pooledWebHelmRun({pool,provider:'z',executionId:'recovery-uncertain',timeoutMs:100,
      monitorIntervalMs:20,recoveryMinMs:40,heartbeatIntervalMs:15,
      build:async()=>({action:'new-thread',config:{message:'start',wait:false}}),
      recover:async id=>({thread_id:id,message:'Check terminal event',wait:false}),
    },new AbortController().signal);
    await run.submitted;await wait(950);
    const entries=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
    const turns=entries.filter(row=>row.a.slice(0,4).join(' ')==='platform run z new-turn');
    assert.equal(turns.length,1,'uncertain recovery must not be resent');
    await run.release();
  });
});

test('provider preflight failure trips breaker and healed probe permits next submission',async()=>{
  await fakeWebHelm('profile-outage',async(log,pool)=>{
    const run=pooledWebHelmRun({pool,provider:'chatgpt',executionId:'profile-outage',timeoutMs:90000,
      build:async()=>({action:'new-thread',config:{message:'safe inert'}})},new AbortController().signal);
    await assert.rejects(run.submitted,error=>error.code==='PROVIDER_UNAVAILABLE');
    assert.equal(pool.snapshot('chatgpt').health,'UNAVAILABLE');
    assert.equal(pool.snapshot('chatgpt').leased,0);
    await assert.rejects(pool.acquire('chatgpt','next-after-outage'),error=>error.code==='PROVIDER_UNAVAILABLE');
    pool.reportHealthy('chatgpt'); // Independent proof of provider health.
    assert.equal(pool.snapshot('chatgpt').health,'HEALTHY');
    const rows=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(rows.filter(row=>row.a[1]==='start').length,0,'no browser session when profile cannot be loaded');
  });
});
test('failure to stop actual session quarantines slot until independently verified stopped',async()=>{
  await fakeWebHelm('stop-fail',async(log,pool)=>{
    const previousQuarantine=pool.snapshot('z').quarantined;
    const run=pooledWebHelmRun({pool,provider:'z',executionId:'failed-stop',timeoutMs:90000,
      build:async()=>({action:'new-thread',config:{message:'safe inert'}})},new AbortController().signal);
    await run.submitted;
    await run.release();
    assert.equal(pool.snapshot('z').quarantined,previousQuarantine+1);
    assert.equal(pool.snapshot('z').leased,0);
  });
});
test('transient stop failure is retried and independently verified before lease release',async()=>{
  await fakeWebHelm('stop-transient',async(log,pool)=>{
    const run=pooledWebHelmRun({pool,provider:'z',executionId:'verified-stop',
      timeoutMs:90000,build:async()=>({action:'new-thread',config:{message:'transient stop test'}}),
    },new AbortController().signal);
    await run.submitted;
    await run.release();
    const entries=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(entries.filter(e=>e.a[1]==='stop').length,2);
    assert.ok(entries.some(e=>e.a[1]==='list'));
    assert.equal(pool.snapshot('z').idle,3);
    assert.equal(pool.snapshot('z').quarantined,0);
  });
});

test('spinner-only browser activity never extends deadline or sends a recovery turn',async()=>{
  await fakeWebHelm('spinner',async(log,pool)=>{
    const activities=[];const recoveries=[];
    const run=pooledWebHelmRun({pool,provider:'z',executionId:'spinner-inert',timeoutMs:100,
      monitorIntervalMs:20,heartbeatIntervalMs:15,recoveryMinMs:40,
      build:async()=>({action:'new-thread',config:{message:'safe inert'}}),
      recover:async thread_id=>({thread_id,message:'recovery'}),
      onActivity:message=>activities.push(message),onRecovery:(id)=>recoveries.push(id),
    },new AbortController().signal);
    await run.submitted;await wait(500);
    assert.equal(activities.length,0);
    assert.equal(recoveries.length,0);
    const entries=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(entries.some(row=>row.a[1]==='heartbeat'),false,'Short test need not reach heartbeat deadline');
    await run.release();
  });
});

test('verified SSE completion enables terminal recovery even if CDP observation cannot progress',async()=>{
  await fakeWebHelm('completed',async(log,pool)=>{
    const progress=[];const recovered=[];
    const run=pooledWebHelmRun({pool,provider:'z',executionId:'completed-no-terminal',timeoutMs:4000,
      monitorIntervalMs:9000,completionRecoveryGraceMs:20,
      build:async()=>({action:'new-thread',config:{message:'safe completion',wait:true}}),
      recover:async thread_id=>({thread_id,message:'terminal recovery',wait:false}),
      onActivity:msg=>progress.push(msg),onRecovery:(threadId,verifiedBy)=>recovered.push({threadId,verifiedBy}),
    },new AbortController().signal);
    const receipt=JSON.parse(await run.submitted);assert.equal(receipt.status,'completed');
    await wait(450);
    assert.equal(progress.length,0,'recovery receipt must not be model progress');
    assert.equal(recovered.length,1);
    assert.equal(recovered[0].threadId,'thread-live');
    const turns=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse).filter(row=>row.a.slice(0,4).join(' ')==='platform run z new-turn');
    assert.equal(turns.length,1);
    assert.equal(turns[0].cfg.thread_id,receipt.thread_id);
    await run.release();
  });
});
test('uncertain terminal-recovery send quarantines and is never retried',async()=>{
  await fakeWebHelm('recovery-uncertain-completed',async(log,pool)=>{
    const prior=pool.snapshot('z').quarantined;
    const run=pooledWebHelmRun({pool,provider:'z',executionId:'completed-ambiguous-recovery',timeoutMs:4000,
      monitorIntervalMs:9000,completionRecoveryGraceMs:20,
      build:async()=>({action:'new-thread',config:{message:'safe completion',wait:true}}),
      recover:async thread_id=>({thread_id,message:'terminal recovery',wait:false}),
    },new AbortController().signal);
    await run.submitted;await wait(500);
    assert.equal(pool.snapshot('z').quarantined,prior+1);
    await run.release();
    const turns=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse).filter(row=>row.a.slice(0,4).join(' ')==='platform run z new-turn');
    assert.equal(turns.length,1);
  });
});

test('ChatGPT and Z share the Neo group via daemon IPC; heartbeats update leased sessions only',async()=>{
  await fakeWebHelm('idle',async(log,pool)=>{
    const activity=[];
    const make=(provider,executionId)=>pooledWebHelmRun({
      pool,provider,executionId,timeoutMs:180000,
      heartbeatIntervalMs:1000,monitorIntervalMs:50,
      onActivity:msg=>activity.push(msg),
      build:async()=>({action:'new-thread',config:{message:'inert shared workspace test'}}),
    },new AbortController().signal);
    const chat=make('chatgpt','chat-group'), z=make('z','z-group');
    await Promise.all([chat.submitted,z.submitted]);
    await wait(1250);
    const events=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
    const starts=events.filter(e=>e.a[1]==='start');
    assert.equal(starts.length,2);
    assert.ok(starts.every(e=>e.request.workspace==='Neo'));
    assert.ok(events.some(e=>e.a.join(' ')==='workspace create'&&e.request.pool_size===6));
    assert.equal(events.filter(e=>e.a[1]==='heartbeat').length>=2,true);
    assert.equal(activity.length,0,'Heartbeat must not be counted as model progress');
    assert.equal(events.some(e=>e.a.includes('--workspace')),false,'No custom CLI workspace override');
    await Promise.all([chat.release(),z.release()]);
    const before=(await readFile(log,'utf8')).trim().split('\n').length;
    await wait(1150);
    const after=(await readFile(log,'utf8')).trim().split('\n');
    assert.equal(after.length,before,'No heartbeat after lease release');
    assert.equal(pool.snapshot('chatgpt').leased+pool.snapshot('z').leased,0);
  });
});
