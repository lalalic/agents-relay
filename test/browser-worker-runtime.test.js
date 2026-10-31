import test from './test-runtime.js';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pooledWebHelmRun} from '../dist/browser-worker-runtime.js';
import {BrowserWorkerPoolManager} from '../dist/browser-worker-pool.js';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function fakeWebHelm(mode,run){
  const root=await mkdtemp(join(tmpdir(),'relay-pooled-driver-'));
  const cli=join(root,'fake-webhelm'); const log=join(root,'actions.jsonl');
  await writeFile(cli,[
    '#!/usr/bin/env node',
    "const fs=require('node:fs'),a=process.argv.slice(2);",
    "const cfg=a.includes('--config')?JSON.parse(fs.readFileSync(a[a.indexOf('--config')+1],'utf8')):null;",
    "const stdin=fs.readFileSync(0,'utf8');",
    "fs.appendFileSync(process.env.POOL_TEST_LOG,JSON.stringify({a,cfg,stdin})+'\\n');",
    "if(a[0]==='platform'&&a[1]==='profile'){if(process.env.POOL_TEST_MODE==='profile-outage')process.exit(23);console.log(JSON.stringify({platform:a[2]}));}",
    "else if(a[0]==='session'&&a[1]==='start')console.log(JSON.stringify({session_id:'owned-pool'}));",
    "else if(a[0]==='session'&&a[1]==='exec'&&stdin.includes('const url=')){",
    "const p=process.env.POOL_TEST_LOG+'.count';let count=0;try{count=Number(fs.readFileSync(p,'utf8'))}catch{}fs.writeFileSync(p,String(++count));",
    "console.log(JSON.stringify({session_id:'owned-pool',ok:true,stdout:JSON.stringify({url:'https://chat.z.ai/c/thread-live',state:{text:process.env.POOL_TEST_MODE==='idle'?'':process.env.POOL_TEST_MODE==='spinner'?'unchanged output':count>1?'new assistant output':'',generating:process.env.POOL_TEST_MODE==='spinner',streamLength:0}})}));",
    "} else if(a[0]==='session'&&a[1]==='exec')console.log(JSON.stringify({ok:true}));",
    "else if(a[0]==='platform'&&a[1]==='run'){",
    "if(process.env.POOL_TEST_MODE==='uncertain'||((process.env.POOL_TEST_MODE==='recovery-uncertain'||process.env.POOL_TEST_MODE==='recovery-uncertain-completed')&&a[3]==='new-turn'))process.exit(19);",
    "console.log(JSON.stringify({result:{ok:true,stdout:JSON.stringify({status:process.env.POOL_TEST_MODE.includes('completed')&&a[3]==='new-thread'?'completed':'submitted',mode:a[3],thread_id:'thread-live',thread_url:'https://chat.z.ai/c/thread-live',verified_by:'matching-user-turn'})}}));",
    "}else if(a[0]==='session'&&a[1]==='stop'){if(process.env.POOL_TEST_MODE==='stop-fail')process.exit(24);console.log(JSON.stringify({stopped:true}));}",
    "else process.exit(22);",
  ].join('\n'),{mode:0o700});
  const previous={cmd:process.env.AGENTS_RELAY_WEBHELM_COMMAND,log:process.env.POOL_TEST_LOG,mode:process.env.POOL_TEST_MODE};
  process.env.AGENTS_RELAY_WEBHELM_COMMAND=cli;process.env.POOL_TEST_LOG=log;process.env.POOL_TEST_MODE=mode;
  const pool=new BrowserWorkerPoolManager({path:join(root,'pool.sqlite'),queueWaitMs:1000,pollMs:5});
  try {await run(log,pool);}finally{
    pool.close();
    for(const [name,key] of [['AGENTS_RELAY_WEBHELM_COMMAND','cmd'],['POOL_TEST_LOG','log'],['POOL_TEST_MODE','mode']]){
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
    assert.ok(before.some(row=>row.a[1]==='exec'&&row.stdin.includes('activate_tab')));
    await run.release();
    assert.equal(pool.snapshot('z').leased,0);
    const after=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(after.filter(row=>row.a[1]==='stop').length,1);
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
    assert.ok(entries.some(row=>row.a[1]==='exec'&&row.stdin.includes('activate_tab')));
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
