import test from './test-runtime.js';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pooledWebHelmRun,browserWorkerPool} from '../dist/browser-worker-runtime.js';
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
    "if(a[0]==='platform'&&a[1]==='profile')console.log(JSON.stringify({platform:a[2]}));",
    "else if(a[0]==='session'&&a[1]==='start')console.log(JSON.stringify({session_id:'owned-pool'}));",
    "else if(a[0]==='session'&&a[1]==='exec'&&stdin.includes('const url=')){",
    "const p=process.env.POOL_TEST_LOG+'.count';let count=0;try{count=Number(fs.readFileSync(p,'utf8'))}catch{}fs.writeFileSync(p,String(++count));",
    "console.log(JSON.stringify({session_id:'owned-pool',ok:true,stdout:JSON.stringify({url:'https://chat.z.ai/c/thread-live',state:{text:process.env.POOL_TEST_MODE==='idle'?'':count>1?'new assistant output':'',generating:false,streamLength:0}})}));",
    "} else if(a[0]==='session'&&a[1]==='exec')console.log(JSON.stringify({ok:true}));",
    "else if(a[0]==='platform'&&a[1]==='run'){",
    "if(process.env.POOL_TEST_MODE==='uncertain')process.exit(19);",
    "console.log(JSON.stringify({result:{ok:true,stdout:JSON.stringify({status:'submitted',mode:a[3],thread_id:'thread-live',thread_url:'https://chat.z.ai/c/thread-live',verified_by:'matching-user-turn'})}}));",
    "}else if(a[0]==='session'&&a[1]==='stop')console.log(JSON.stringify({stopped:true}));",
    "else process.exit(22);",
  ].join('\n'),{mode:0o700});
  const previous={cmd:process.env.AGENTS_RELAY_WEBHELM_COMMAND,log:process.env.POOL_TEST_LOG,mode:process.env.POOL_TEST_MODE};
  process.env.AGENTS_RELAY_WEBHELM_COMMAND=cli;process.env.POOL_TEST_LOG=log;process.env.POOL_TEST_MODE=mode;
  try {await run(log);}finally{
    for(const [name,key] of [['AGENTS_RELAY_WEBHELM_COMMAND','cmd'],['POOL_TEST_LOG','log'],['POOL_TEST_MODE','mode']]){
      if(previous[key]===undefined)delete process.env[name];else process.env[name]=previous[key];
    }
    await rm(root,{recursive:true,force:true});
  }
}

test('a live pooled Z worker keeps its slot, observes real output, and releases only on terminal',async()=>{
  await fakeWebHelm('normal',async log=>{
    const activities=[];
    const run=pooledWebHelmRun({provider:'z',executionId:'runtime-progress',timeoutMs:80000,
      monitorIntervalMs:20,heartbeatIntervalMs:15,recoveryMinMs:100000,
      onActivity:message=>activities.push(message),
      build:async()=>({action:'new-thread',config:{message:'inert runtime test',wait:false}})},new AbortController().signal);
    const response=JSON.parse(await run.submitted);
    assert.equal(response.status,'submitted');
    assert.equal(browserWorkerPool().snapshot('z').leased,1);
    await wait(1300);
    assert.ok(activities.some(message=>message.includes('new assistant output')),JSON.stringify(activities));
    assert.equal(browserWorkerPool().snapshot('z').leased,1);
    const before=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(before.filter(row=>row.a[1]==='stop').length,0);
    assert.ok(before.some(row=>row.a[1]==='exec'&&row.stdin.includes('activate_tab')));
    await run.release();
    assert.equal(browserWorkerPool().snapshot('z').leased,0);
    const after=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(after.filter(row=>row.a[1]==='stop').length,1);
  });
});

test('ambiguous Z submission is quarantined; no automatic resend or slot reuse',async()=>{
  await fakeWebHelm('uncertain',async log=>{
    const run=pooledWebHelmRun({provider:'z',executionId:'runtime-ambiguous',timeoutMs:900000,
      build:async()=>({action:'new-thread',config:{message:'test unknown',wait:false}})},new AbortController().signal);
    await assert.rejects(run.submitted,/exited 19/);
    run.cancel();
    assert.equal(browserWorkerPool().snapshot('z').quarantined,1);
    const calls=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(calls.filter(row=>row.a[1]==='run').length,1);
    assert.equal(calls.filter(row=>row.a[1]==='stop').length,0);
  });
});

test('idle thread requests at most two same-thread terminal recovery turns, never marks browser heartbeat as model progress',async()=>{
  await fakeWebHelm('idle',async log=>{
    const activities=[];
    const run=pooledWebHelmRun({provider:'z',executionId:'runtime-idle-recovery',timeoutMs:100,
      monitorIntervalMs:20,recoveryMinMs:40,heartbeatIntervalMs:15,
      onActivity:message=>activities.push(message),
      build:async()=>({action:'new-thread',config:{message:'start',wait:false}}),
      recover:async id=>({thread_id:id,message:'Check terminal event',wait:false}),
    },new AbortController().signal);
    await run.submitted;await wait(800);
    const entries=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
    const turns=entries.filter(row=>row.a.slice(0,4).join(' ')==='platform run z new-turn');
    assert.equal(turns.length,2,'auto recovery is bounded');
    assert.ok(turns.every(row=>row.cfg.thread_id==='thread-live'));
    assert.ok(activities.every(s=>s.includes('recovery')));
    assert.equal(activities.length,2);
    await run.release();
  });
});
